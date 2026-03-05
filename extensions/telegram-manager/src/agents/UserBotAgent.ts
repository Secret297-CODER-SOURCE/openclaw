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

// WeakMap stores TelegramClient outside the instance so that structuredClone
// (called by the pi-agent framework in emitContext) never traverses into it.
// TelegramClient holds PromisedNetSockets which contains a live Promise and
// cannot be cloned, causing DataCloneError. WeakMap is invisible to structuredClone.
const clientStore = new WeakMap<UserBotAgent, TelegramClient>();

export class UserBotAgent extends BaseAgent {
  private creds: UserbotCredentials;

  constructor(record: AgentRecord, storage: TelegramStorage, logger: ILogger) {
    super(record, storage, logger);
    this.creds = record.credentials as UserbotCredentials;
  }

  private get client(): TelegramClient | null {
    return clientStore.get(this) ?? null;
  }

  private set client(v: TelegramClient | null) {
    if (v === null) {
      clientStore.delete(this);
    } else {
      clientStore.set(this, v);
    }
  }

  // --- Lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (this.record.status === "running") return;
    // Disconnect any leftover client (e.g. auth client from authStart/authSubmit)
    // before creating a new one; reusing the same session on an already-connected
    // client causes DC to reject the duplicate connection.
    if (this.client) {
      await this.client.disconnect().catch(() => {});
      this.client = null;
    }
    this.setStatus("starting");

    try {
      const apiCfg = this.storage.loadPluginConfig();
      if (!apiCfg) {
        throw new Error(
          "Telegram API credentials not configured. " +
            "Set them in the Telegram Agents tab or via TG_API_ID / TG_API_HASH env vars.",
        );
      }
      const { apiId, apiHash } = apiCfg;

      const session = new StringSession(this.creds.sessionString ?? "");
      // Note: do not pass baseLogger — the mock { log: () => {} } lacks .info()/.debug()
      // and crashes gramjs on construction. Let gramjs use its default logger.
      this.client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        // Route through SOCKS5 proxy when configured (fixes ENETUNREACH for blocked DCs)
        ...(apiCfg.proxy ? { proxy: apiCfg.proxy } : {}),
      });

      this.suppressGramjsTimeoutNoise(this.client);
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

  // --- Auth flow ------------------------------------------------------------

  async authStart(): Promise<void> {
    const apiCfg = this.storage.loadPluginConfig();
    if (!apiCfg) {
      throw new Error(
        "Telegram API credentials not configured. Set them in the Telegram Agents tab.",
      );
    }
    const { apiId, apiHash } = apiCfg;
    this.client = new TelegramClient(new StringSession(""), apiId, apiHash, {
      connectionRetries: 3,
      // Use proxy during auth if configured
      ...(apiCfg.proxy ? { proxy: apiCfg.proxy } : {}),
    });
    this.suppressGramjsTimeoutNoise(this.client);
    await this.client.connect();
    await this.client.sendCode({ apiId, apiHash }, this.creds.phoneNumber);
  }

  async authSubmit(code: string, password?: string): Promise<void> {
    if (!this.client) throw new Error("Call authStart first");
    const apiCfg = this.storage.loadPluginConfig();
    if (!apiCfg) throw new Error("Telegram API credentials not configured.");
    await this.client.signInUser(
      { apiId: apiCfg.apiId, apiHash: apiCfg.apiHash },
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

  // --- Tool calls (imperative, from WS) -------------------------------------

  async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error("Agent not running");

    switch (tool) {
      case "sendMessage": {
        const { target, message, parseMode } = args as any;
        return this.client.sendMessage(target, { message, parseMode });
      }

      // scheduledSendMessage — delayed send via setTimeout, outside the agent-loop.
      //
      // When the AI agent receives a request like "send hello in 5 minutes", it must
      // NOT hold `await delay(5min)` inside its own loop: that keeps the loop alive
      // and causes the pi-agent framework to repeatedly call emitContext →
      // structuredClone during the wait, which throws DataCloneError because
      // PromisedNetSockets inside TelegramClient cannot be serialized.
      //
      // Instead, the agent calls scheduledSendMessage which returns immediately
      // (scheduled: true) and dispatches the real send via setTimeout — outside
      // the agent-loop, with no cloning involved.
      case "scheduledSendMessage": {
        const { target, message, delayMs, parseMode } = args as any;
        if (!target) throw new Error("scheduledSendMessage requires target");
        if (!message) throw new Error("scheduledSendMessage requires message");
        const delay = Math.max(0, Number(delayMs) || 0);
        const agentRef = this; // capture for closure
        setTimeout(() => {
          const client = clientStore.get(agentRef);
          if (!client) {
            agentRef.logger.warn(
              `[TG:${agentRef.name}] scheduledSendMessage: agent stopped before send`,
            );
            return;
          }
          client
            .sendMessage(target, { message, parseMode })
            .then(() => {
              agentRef.trackMessage("out", String(message), String(target));
            })
            .catch((e: unknown) => {
              agentRef.logger.warn(`[TG:${agentRef.name}] scheduledSendMessage failed`, {
                e: String(e),
              });
            });
        }, delay);
        return { ok: true, scheduled: true, delayMs: delay, target };
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

  // --- Behaviors ------------------------------------------------------------

  protected async onBehaviorsChanged(behaviors: BehaviorConfig[]): Promise<void> {
    if (this.record.status !== "running" || !this.client) return;
    this.clearCron();
    // Remove existing event handlers by reconnecting (simplest safe approach)
    await this.client.disconnect();
    await this.client.connect();
    await this.registerBehaviors(behaviors);
  }

  private async registerBehaviors(behaviors: BehaviorConfig[]): Promise<void> {
    // Always register task session handler — it checks dynamically for active
    // sessions at message-handling time, so it works even for sessions assigned
    // after start() without requiring a reconnect.
    this.setupTaskSessionHandler();
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

  /** Always-on handler that intercepts messages for active task sessions. */
  private setupTaskSessionHandler(): void {
    if (!this.client) return;

    this.client.addEventHandler(
      async (event: any) => {
        const msg = event.message;
        if (!msg || msg.out) return;
        const chatId = String(msg.chatId || "");
        // Dynamically look up the session at message-handling time so that
        // sessions assigned after start() are picked up without reconnecting.
        const taskSession = this.getTaskSession(chatId);
        if (!taskSession) return;

        const text = msg.message || "";
        this.trackMessage("in", text, chatId);
        const systemPrompt =
          taskSession.systemPrompt ?? this.buildTaskSystemPrompt(taskSession.task);
        try {
          const reply = await aiReply(
            text,
            `${this.id}:${chatId}:task:${taskSession.id}`,
            systemPrompt,
          );
          if (reply) {
            await msg.reply({ message: reply });
            this.trackMessage("out", reply, chatId);
          }
        } catch (e) {
          this.logger.warn(`[TG:${this.name}] task session reply failed`, { e: String(e) });
        }
      },
      new NewMessage({ incoming: true }),
    );

    this.logger.info(`[TG:${this.name}] task session handler active`);
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
        // Skip chats that are being handled by an active task session
        if (this.getTaskSession(chatId)) return;

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
          this.logger.warn(`[TG:${this.name}] broadcast failed -> ${target}`, { e: String(e) });
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

  // gramjs's _updateLoop fires TIMEOUT every ~40s when there are no incoming
  // updates (normal long-poll behaviour). It calls console.error(err) directly
  // when client._log.canSend("error") is true, causing log noise.
  // Fix: gate console.error at "error" level, and route other errors through
  // our logger while silently dropping expected TIMEOUT.
  //
  // IMPORTANT: use Object.defineProperty with enumerable:false for function
  // overrides. A plain assignment (log.canSend = fn) creates an OWN ENUMERABLE
  // property that shadows the prototype method. When the pi-agent framework calls
  // structuredClone(agentContext) and the context references this TelegramClient
  // through the plugin -> manager -> agent chain, structuredClone traverses _log,
  // hits the enumerable function, and throws DataCloneError. Non-enumerable
  // properties are skipped by structuredClone.
  private suppressGramjsTimeoutNoise(client: TelegramClient): void {
    const c = client as unknown as Record<string, unknown>;
    const log = c._log as { canSend: (level: string) => boolean } | undefined;
    if (log && typeof log.canSend === "function") {
      const orig = log.canSend.bind(log);
      Object.defineProperty(log, "canSend", {
        value: (level: string) => level !== "error" && orig(level),
        writable: true,
        configurable: true,
        enumerable: false, // non-enumerable -> skipped by structuredClone
      });
    }
    // _errorHandler may not be an own property yet; define as non-enumerable
    Object.defineProperty(c, "_errorHandler", {
      value: async (err: unknown) => {
        if (err instanceof Error && err.message === "TIMEOUT") return;
        this.logger.warn(`[TG:${this.name}] gramjs error`, { e: String(err) });
      },
      writable: true,
      configurable: true,
      enumerable: false, // non-enumerable -> skipped by structuredClone
    });
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
