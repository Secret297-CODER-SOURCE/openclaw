// plugins/telegram/src/agents/BotAgent.ts
import { Bot, Context } from "grammy";
import cron from "node-cron";
import { aiReply } from "../behaviors/AiReplyEngine";
import { TelegramStorage } from "../storage/TelegramStorage";
import { AgentRecord, BotCredentials, BehaviorConfig, ILogger } from "../types";
import { BaseAgent } from "./BaseAgent";

export class BotAgent extends BaseAgent {
  private bot: Bot | null = null;
  private creds: BotCredentials;

  constructor(record: AgentRecord, storage: TelegramStorage, logger: ILogger) {
    super(record, storage, logger);
    this.creds = record.credentials as BotCredentials;
  }

  async start(): Promise<void> {
    if (this.record.status === "running") return;
    this.setStatus("starting");

    try {
      this.bot = new Bot(this.creds.token);
      await this.registerBehaviors(this.record.behaviors);
      this.setupBaseHandlers();

      this.bot.start({
        onStart: () => {
          this.setStatus("running");
          this.logger.info(`[TG:${this.name}] bot polling started`);
        },
      });
    } catch (err) {
      this.setStatus("error", String(err));
      throw err;
    }
  }

  async stop(): Promise<void> {
    for (const j of this.cronJobs.values()) j.stop();
    this.cronJobs.clear();
    await this.bot?.stop();
    this.bot = null;
    this.setStatus("stopped");
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.bot) throw new Error("Agent not running");
    switch (tool) {
      case "sendMessage": {
        const { target, message, parseMode } = args as any;
        return this.bot.api.sendMessage(target, message, {
          parse_mode: parseMode === "markdown" ? "Markdown" : "HTML",
        });
      }
      case "getMe":
        return this.bot.api.getMe();
      case "getMessages":
        throw new Error("Bot API does not support getMessages — use a userbot agent");
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  protected async onBehaviorsChanged(behaviors: BehaviorConfig[]): Promise<void> {
    // grammy doesn't support hot-swapping handlers cleanly — restart polling
    if (this.bot) {
      await this.bot.stop();
      this.bot = new Bot(this.creds.token);
    }
    for (const j of this.cronJobs.values()) j.stop();
    this.cronJobs.clear();
    await this.registerBehaviors(behaviors);
    this.setupBaseHandlers();
    if (this.record.status === "running") this.bot!.start();
  }

  private setupBaseHandlers() {
    if (!this.bot) return;
    this.bot.command("start", (ctx) => ctx.reply("👋 Online and ready."));
    this.bot.command("status", (ctx) => {
      const s = this.record.stats;
      ctx.reply(
        `📊 <b>${this.name}</b>\nStatus: ${this.record.status}\nSent: ${s.sent} | Received: ${s.received}`,
        { parse_mode: "HTML" },
      );
    });
    this.bot.on("message:text", (ctx) => this.handleText(ctx));
    this.bot.catch((err) => this.logger.error(`[TG:${this.name}] bot error`, { err: err.message }));
  }

  private async handleText(ctx: Context) {
    const text = ctx.message?.text ?? "";
    const chatId = String(ctx.chat?.id ?? "");
    this.trackMessage("in", text, chatId);

    const cfg = this.getBehavior<any>("auto_reply");
    if (!cfg?.enabled || !this.shouldAutoReply(cfg, text, chatId)) return;

    let reply = "";
    if (cfg.replyMode === "ai") {
      await ctx.replyWithChatAction("typing");
      reply = await aiReply(text, `${this.id}:${chatId}`, cfg.aiSystemPrompt);
    } else {
      const tpl = cfg.templates?.find((t: any) =>
        text.toLowerCase().includes(t.trigger.toLowerCase()),
      );
      reply = tpl?.response ?? "";
    }

    if (reply) {
      await ctx.reply(reply);
      this.trackMessage("out", reply, chatId);
    }
  }

  private async registerBehaviors(behaviors: BehaviorConfig[]): Promise<void> {
    for (const b of behaviors) {
      if (b.type === "broadcast") this.setupBroadcast();
      if (b.type === "monitor") this.setupMonitorViaUpdates();
    }
  }

  private setupBroadcast() {
    const cfg = this.getBehavior<any>("broadcast");
    if (!cfg?.enabled || !this.bot) return;

    const run = async () => {
      for (const target of cfg.targets) {
        try {
          await this.bot!.api.sendMessage(target, cfg.message, {
            parse_mode: cfg.parseMode === "markdown" ? "Markdown" : "HTML",
          });
          this.trackMessage("out", cfg.message, String(target));
          await this.delay(cfg.delayBetweenMs ?? 1000);
        } catch (e) {
          this.logger.warn(`[TG:${this.name}] broadcast failed → ${target}`);
        }
      }
      if (cfg.onlyOnce) {
        cfg.enabled = false;
        await this.updateBehaviors(this.record.behaviors);
      }
    };

    if (cfg.schedule) {
      this.cronJobs.set("broadcast", cron.schedule(cfg.schedule, run));
    } else {
      run();
    }
  }

  private setupMonitorViaUpdates() {
    const cfg = this.getBehavior<any>("monitor");
    if (!cfg?.enabled || !this.bot) return;
    const targets = new Set(cfg.targets?.map(String) ?? []);

    this.bot.on("channel_post", (ctx) => {
      const chatId = String(ctx.chat?.id ?? "");
      if (targets.size && !targets.has(chatId)) return;
      const text = ctx.channelPost?.text ?? "";
      const item = { chatId, messageId: ctx.channelPost?.message_id, text };
      if (cfg.saveToDb) {
        this.storage.saveParsed(this.id, chatId, "channel_post", item);
        this.storage.incrementStat(this.id, "parsed");
      }
      if (cfg.webhookUrl) {
        fetch(cfg.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: this.id, agentName: this.name, item }),
        }).catch(() => {});
      }
      this.pushEvent("parsed_item", { source: chatId, item });
    });
  }
}
