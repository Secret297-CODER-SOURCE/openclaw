import cron from "node-cron";
// plugins/telegram/src/agents/UserBotAgent.ts
import { TelegramClient } from "telegram";
import { NewMessage } from "telegram/events";
import { StringSession } from "telegram/sessions";
import { aiReply } from "../behaviors/AiReplyEngine";
import { TelegramStorage } from "../storage/TelegramStorage";
import { AgentRecord, UserbotCredentials, BehaviorConfig, ILogger } from "../types";
import { BaseAgent } from "./BaseAgent";

const cooldowns = new Map<string, number>();

export class UserBotAgent extends BaseAgent {
  private client: TelegramClient | null = null;
  private creds: UserbotCredentials;

  constructor(record: AgentRecord, storage: TelegramStorage, logger: ILogger) {
    super(record, storage, logger);
    this.creds = record.credentials as UserbotCredentials;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.record.status === "running") return;
    this.setStatus("starting");

    try {
      const apiId = parseInt(process.env.TG_API_ID ?? "0");
      const apiHash = process.env.TG_API_HASH ?? "";
      if (!apiId || !apiHash) throw new Error("TG_API_ID / TG_API_HASH not configured");

      const session = new StringSession(this.creds.sessionString ?? "");
      this.client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        baseLogger: { levels: [], log: () => {} } as any,
      });

      await this.client.connect();

      if (!(await this.client.isUserAuthorized())) {
        this.setStatus("error", "Not authorized — call telegram.agent.authStart then authSubmit");
        return;
      }

      // Persist refreshed session
      const saved = this.client.session.save() as unknown as string;
      if (saved && saved !== this.creds.sessionString) {
        this.creds.sessionString = saved;
        this.storage.updateSession(this.id, saved);
      }

      await this.registerBehaviors(this.record.behaviors);
      this.setStatus("running");
      this.logger.info(`[TG:${this.name}] userbot online (${this.creds.phoneNumber})`);
    } catch (err) {
      this.setStatus("error", String(err));
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.clearCron();
    await this.client?.disconnect();
    this.client = null;
    this.setStatus("stopped");
  }

  // ─── Auth flow ────────────────────────────────────────────────────────────

  async authStart(): Promise<void> {
    const apiId = parseInt(process.env.TG_API_ID ?? "0");
    const apiHash = process.env.TG_API_HASH ?? "";
    this.client = new TelegramClient(new StringSession(""), apiId, apiHash, {
      connectionRetries: 3,
    });
    await this.client.connect();
    await this.client.sendCode({ apiId, apiHash }, this.creds.phoneNumber);
  }

  async authSubmit(code: string, password?: string): Promise<void> {
    if (!this.client) throw new Error("Call authStart first");
    await this.client.signInUser(
      { apiId: parseInt(process.env.TG_API_ID!), apiHash: process.env.TG_API_HASH! },
      {
        phoneNumber: this.creds.phoneNumber,
        phoneCode: async () => code,
        password: password ? async () => password : undefined,
        onError: async (e) => {
          throw e;
        },
      },
    );
    const session = this.client.session.save() as unknown as string;
    this.creds.sessionString = session;
    this.storage.updateSession(this.id, session);
  }

  // ─── Tool calls (imperative, from WS) ─────────────────────────────────────

  async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error("Agent not running");

    switch (tool) {
      case "sendMessage": {
        const { target, message, parseMode } = args as any;
        return this.client.sendMessage(target, { message, parseMode });
      }
      case "getMessages": {
        const { target, limit } = args as any;
        const msgs = await this.client.getMessages(target, { limit: limit ?? 50 });
        return msgs.map((m: any) => ({
          id: m.id,
          text: m.message,
          date: new Date(m.date * 1000).toISOString(),
          hasMedia: !!m.media,
        }));
      }
      case "getMembers": {
        const { target, limit } = args as any;
        const parts = await this.client.getParticipants(target, { limit: limit ?? 200 });
        return parts.map((p: any) => ({
          id: p.id?.toString(),
          username: p.username,
          firstName: p.firstName,
          lastName: p.lastName,
        }));
      }
      case "joinChat": {
        return this.client.invoke(
          new (require("telegram/tl").functions.channels.JoinChannelRequest)({
            channel: await this.client.getInputEntity(args.target as string),
          }),
        );
      }
      case "leaveChat": {
        return this.client.invoke(
          new (require("telegram/tl").functions.channels.LeaveChannelRequest)({
            channel: await this.client.getInputEntity(args.target as string),
          }),
        );
      }
      case "getMe": {
        return this.client.getMe();
      }
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  // ─── Behaviors ────────────────────────────────────────────────────────────

  protected async onBehaviorsChanged(behaviors: BehaviorConfig[]): Promise<void> {
    if (this.record.status !== "running" || !this.client) return;
    this.clearCron();
    // Remove existing event handlers by reconnecting (simplest safe approach)
    await this.client.disconnect();
    await this.client.connect();
    await this.registerBehaviors(behaviors);
  }

  private async registerBehaviors(behaviors: BehaviorConfig[]): Promise<void> {
    for (const b of behaviors) {
      if (b.type === "auto_reply") this.setupAutoReply();
      if (b.type === "monitor") this.setupMonitor();
      if (b.type === "broadcast") this.setupBroadcast();
      if (b.type === "parser")
        this.runParser().catch((e) =>
          this.logger.warn(`[TG:${this.name}] parser error`, { e: String(e) }),
        );
    }
  }

  private setupAutoReply(): void {
    const cfg = this.getBehavior<any>("auto_reply");
    if (!cfg?.enabled || !this.client) return;

    this.client.addEventHandler(
      async (event: any) => {
        const msg = event.message;
        if (!msg || msg.out) return;
        const text = msg.message || "";
        const chatId = String(msg.chatId || "");
        const key = `${this.id}:${chatId}`;
        const now = Date.now();
        const cd = (cfg.cooldownSeconds ?? 5) * 1000;

        if (cooldowns.has(key) && now - cooldowns.get(key)! < cd) return;
        if (!this.shouldAutoReply(cfg, text, chatId)) return;

        this.trackMessage("in", text, chatId);

        let reply = "";
        if (cfg.replyMode === "ai") {
          reply = await aiReply(text, key, cfg.aiSystemPrompt);
        } else {
          const tpl = cfg.templates?.find((t: any) =>
            text.toLowerCase().includes(t.trigger.toLowerCase()),
          );
          reply = tpl?.response ?? "";
        }

        if (reply) {
          await msg.reply({ message: reply });
          cooldowns.set(key, Date.now());
          this.trackMessage("out", reply, chatId);
        }
      },
      new NewMessage({ incoming: true }),
    );

    this.logger.info(`[TG:${this.name}] auto_reply active`, { mode: cfg.replyMode });
  }

  private setupMonitor(): void {
    const cfg = this.getBehavior<any>("monitor");
    if (!cfg?.enabled || !this.client) return;
    const targets = new Set(cfg.targets?.map(String) ?? []);

    this.client.addEventHandler(async (event: any) => {
      const msg = event.message;
      if (!msg) return;
      const chatId = String(msg.chatId || "");
      if (targets.size && !targets.has(chatId)) return;

      const text = msg.message || "";
      if (cfg.filters?.keywords?.length) {
        const low = text.toLowerCase();
        if (!cfg.filters.keywords.some((k: string) => low.includes(k.toLowerCase()))) return;
      }

      const item = {
        chatId,
        messageId: msg.id,
        text: text.slice(0, 4096),
        date: new Date(msg.date * 1000).toISOString(),
        hasMedia: !!msg.media,
      };
      if (cfg.saveToDb) {
        this.storage.saveParsed(this.id, chatId, "message", item);
        this.storage.incrementStat(this.id, "parsed");
      }
      if (cfg.webhookUrl) this.postWebhook(cfg.webhookUrl, { type: "monitor", item });
      this.pushEvent("parsed_item", { source: chatId, item });
    }, new NewMessage({}));
  }

  private setupBroadcast(): void {
    const cfg = this.getBehavior<any>("broadcast");
    if (!cfg?.enabled || !this.client) return;

    const run = async () => {
      for (const target of cfg.targets) {
        try {
          await this.client!.sendMessage(target, {
            message: cfg.message,
            parseMode: cfg.parseMode ?? "html",
          });
          this.trackMessage("out", cfg.message, String(target));
          this.pushEvent("message_out", { target, broadcast: true });
          await this.delay(cfg.delayBetweenMs ?? 2000);
        } catch (e) {
          this.logger.warn(`[TG:${this.name}] broadcast failed → ${target}`, { e: String(e) });
        }
      }
      if (cfg.onlyOnce) {
        cfg.enabled = false;
        await this.updateBehaviors(this.record.behaviors);
      }
    };

    if (cfg.schedule) {
      this.cronJobs.set("broadcast", cron.schedule(cfg.schedule, run));
      this.logger.info(`[TG:${this.name}] broadcast scheduled`, { cron: cfg.schedule });
    } else {
      run();
    }
  }

  private async runParser(): Promise<void> {
    const cfg = this.getBehavior<any>("parser");
    if (!cfg?.enabled || !this.client) return;

    for (const target of cfg.targets) {
      if (cfg.parseMessages) {
        const msgs = await this.client.getMessages(target, { limit: cfg.limit ?? 100 });
        for (const m of msgs) {
          const item = {
            messageId: (m as any).id,
            text: ((m as any).message ?? "").slice(0, 4096),
            date: new Date((m as any).date * 1000).toISOString(),
          };
          if (cfg.saveToDb) {
            this.storage.saveParsed(this.id, target, "message", item);
            this.storage.incrementStat(this.id, "parsed");
          }
          if (cfg.webhookUrl)
            this.postWebhook(cfg.webhookUrl, { type: "message", source: target, item });
        }
      }
      if (cfg.parseMembers) {
        const parts = await this.client.getParticipants(target, { limit: cfg.limit ?? 500 });
        for (const p of parts) {
          const item = {
            id: (p as any).id?.toString(),
            username: (p as any).username,
            firstName: (p as any).firstName,
            lastName: (p as any).lastName,
          };
          if (cfg.saveToDb) {
            this.storage.saveParsed(this.id, target, "member", item);
            this.storage.incrementStat(this.id, "parsed");
          }
          if (cfg.webhookUrl)
            this.postWebhook(cfg.webhookUrl, { type: "member", source: target, item });
        }
      }
    }
  }

  private postWebhook(url: string, body: unknown) {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: this.id, agentName: this.name, ...(body as any) }),
    }).catch(() => {});
  }

  private clearCron() {
    for (const j of this.cronJobs.values()) j.stop();
    this.cronJobs.clear();
  }
}
