// plugins/telegram/src/agents/BotAgent.ts
import { Bot, Context } from "grammy";
import cron from "node-cron";
import { aiReply } from "../behaviors/AiReplyEngine";
import { MasterControlHandler } from "../behaviors/MasterControlHandler";
import { TelegramStorage } from "../storage/TelegramStorage";
import { createWorkspaceTools } from "../tools/TelegramTools";
import {
  AgentRecord,
  BotCredentials,
  BehaviorConfig,
  ILogger,
  IAgentManager,
  MasterControlBehavior,
  TaskSession,
  TaskSessionBehavior,
} from "../types";
import { BaseAgent } from "./BaseAgent";

export class BotAgent extends BaseAgent {
  private bot: Bot | null = null;
  private creds: BotCredentials;
  /** Manager reference — used for owner commands and master_control behavior. */
  private managerRef: IAgentManager | null;
  /** Owner chat ID from TG_OWNER_CHAT_ID env var — required for management commands */
  private ownerChatId: string | null;
  /** Counts consecutive polling crashes for exponential back-off restarts. */
  private restartAttempts = 0;

  constructor(
    record: AgentRecord,
    storage: TelegramStorage,
    logger: ILogger,
    managerRef?: IAgentManager,
  ) {
    super(record, storage, logger);
    this.creds = record.credentials as BotCredentials;
    this.managerRef = managerRef ?? null;
    this.ownerChatId = process.env.TG_OWNER_CHAT_ID ?? null;
  }

  async start(): Promise<void> {
    // Guard against concurrent start() calls (e.g. auto-restart + manual start racing).
    if (this.record.status === "running" || this.record.status === "starting") return;
    this.setStatus("starting");

    try {
      this.bot = new Bot(this.creds.token);
      await this.ensureWorkspaceFiles();
      await this.registerBehaviors(this.record.behaviors);
      this.setupBaseHandlers();

      this.bot
        .start({
          onStart: () => {
            this.setStatus("running");
            this.logger.info(`[TG:${this.name}] bot polling started`);
          },
        })
        .catch((err) => {
          const msg = this.maskToken(String(err));
          this.logger.error(`[TG:${this.name}] polling crashed`, { e: msg });
          // Only auto-restart if agent wasn't manually stopped
          if (this.record.status !== "stopped") {
            this.setStatus("error", msg);
            void this.scheduleRestart();
          }
        });
    } catch (err) {
      this.setStatus("error", String(err));
      throw err;
    }
  }

  async stop(): Promise<void> {
    // Reset back-off counter so the next manual start is treated as fresh.
    this.restartAttempts = 0;
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
      case "resolveEntityId": {
        // Resolve a username/chat identifier to its numeric Telegram chat ID.
        // For bots, getChat works for groups/channels and any user who has
        // previously started the bot.
        const { target } = args as { target: string };
        const chat = await this.bot.api.getChat(target);
        return { id: String(chat.id) };
      }
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
    if (this.record.status === "running") {
      this.bot!.start().catch((err) => {
        const msg = this.maskToken(String(err));
        this.logger.error(`[TG:${this.name}] polling crashed after behavior update`, { e: msg });
        if (this.record.status !== "stopped") {
          this.setStatus("error", msg);
          void this.scheduleRestart();
        }
      });
    }
  }

  /** Returns true if the message sender is the configured owner */
  private isOwner(ctx: Context): boolean {
    if (!this.ownerChatId) return false;
    return String(ctx.chat?.id) === this.ownerChatId;
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

    // ── Owner-only management commands ────────────────────────────────────────
    // Set TG_OWNER_CHAT_ID env var to enable these commands.

    this.bot.command("listagents", (ctx) => {
      if (!this.isOwner(ctx)) return;
      const mgr = this.managerRef;
      if (!mgr) {
        ctx.reply("Agent manager not available.");
        return;
      }
      const records = mgr.list();
      if (records.length === 0) {
        ctx.reply("No agents configured.");
        return;
      }
      const lines = records.map(
        (r) =>
          `• <b>${r.name}</b> [${r.type}] — ${r.status}${r.lastError ? `\n  ⚠️ ${r.lastError}` : ""}`,
      );
      ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    });

    this.bot.command("startagent", async (ctx) => {
      if (!this.isOwner(ctx)) return;
      const mgr = this.managerRef;
      if (!mgr) {
        ctx.reply("Agent manager not available.");
        return;
      }
      const name = ctx.message?.text?.split(" ").slice(1).join(" ").trim();
      if (!name) {
        ctx.reply("Usage: /startagent <name>");
        return;
      }
      const record = mgr.list().find((r) => r.name === name);
      if (!record) {
        ctx.reply(`Agent "${name}" not found.`);
        return;
      }
      try {
        await mgr.start(record.id);
        ctx.reply(`✅ Agent <b>${name}</b> started.`, { parse_mode: "HTML" });
      } catch (e) {
        ctx.reply(`❌ Failed: ${String(e)}`);
      }
    });

    this.bot.command("stopagent", async (ctx) => {
      if (!this.isOwner(ctx)) return;
      const mgr = this.managerRef;
      if (!mgr) {
        ctx.reply("Agent manager not available.");
        return;
      }
      const name = ctx.message?.text?.split(" ").slice(1).join(" ").trim();
      if (!name) {
        ctx.reply("Usage: /stopagent <name>");
        return;
      }
      const record = mgr.list().find((r) => r.name === name);
      if (!record) {
        ctx.reply(`Agent "${name}" not found.`);
        return;
      }
      try {
        await mgr.stop(record.id);
        ctx.reply(`✅ Agent <b>${name}</b> stopped.`, { parse_mode: "HTML" });
      } catch (e) {
        ctx.reply(`❌ Failed: ${String(e)}`);
      }
    });

    this.bot.on("message:text", (ctx) => this.handleText(ctx));
    this.bot.catch((err) =>
      this.logger.error(`[TG:${this.name}] bot error`, {
        err: this.maskToken(err.message),
      }),
    );
  }

  /**
   * Find an active task session by the sender's Telegram username.
   * Called when the exact numeric chatId lookup misses — which happens when
   * the session was stored with a username (e.g. "worker_297") before the bot
   * received an update from that user and learned their numeric Telegram ID.
   */
  private findTaskSessionByUsername(ctx: Context): TaskSession | undefined {
    const username = ctx.message?.from?.username;
    if (!username) return undefined;
    const b = this.getBehavior<TaskSessionBehavior>("task_session");
    if (!b) return undefined;
    const lower = username.toLowerCase();
    return b.sessions.find(
      (s) => s.status === "active" && s.chatId.replace(/^@/, "").toLowerCase() === lower,
    );
  }

  private async handleText(ctx: Context) {
    const text = ctx.message?.text ?? "";
    const chatId = String(ctx.chat?.id ?? "");
    this.trackMessage("in", text, chatId);

    // master_control: highest priority — if this chat is an authorized control
    // channel, route to the agentic management loop and skip normal handling.
    const mc = this.getBehavior<MasterControlBehavior>("master_control");
    if (mc?.enabled && mc.allowedChatIds.includes(chatId) && this.managerRef) {
      await ctx.replyWithChatAction("typing");
      const handler = new MasterControlHandler(this.managerRef, this.logger);
      const reply = await handler
        .handle(text, mc.systemPrompt)
        .catch((e: unknown) => `⚠️ Error: ${e instanceof Error ? e.message : String(e)}`);
      if (reply) {
        await ctx.reply(reply);
        this.trackMessage("out", reply, chatId);
      }
      return;
    }

    // Use a single, stable conversation key per chat so that context is shared
    // across task sessions and auto_reply — enabling continuous dialogue even
    // when the mode switches or the agent restarts.
    const chatKey = `${this.id}:${chatId}`;

    // Task sessions take priority over auto_reply.
    // First try an exact numeric chatId match; fall back to username matching
    // for sessions created before the bot knew the user's numeric Telegram ID.
    let taskSession = this.getTaskSession(chatId);
    if (!taskSession) {
      const byUsername = this.findTaskSessionByUsername(ctx);
      if (byUsername) {
        // Upgrade the stored chatId to the numeric value so all future
        // lookups hit the fast path without needing username resolution.
        byUsername.chatId = chatId;
        this.upsertTaskSession(byUsername);
        taskSession = byUsername;
      }
    }
    // Tools scoped to this agent's workspace — cannot access other agents' files.
    const workspaceTools = createWorkspaceTools(this.storage.getAgentWorkspaceDir(this.id));

    if (taskSession) {
      await ctx.replyWithChatAction("typing");
      // Use custom system prompt if provided, otherwise build from workspace files.
      const systemPrompt =
        taskSession.systemPrompt ?? (await this.buildRichSystemPrompt(taskSession.task, chatKey));
      try {
        const reply = await aiReply(text, chatKey, systemPrompt, this.storage, workspaceTools);
        if (reply) {
          await ctx.reply(reply);
          this.trackMessage("out", reply, chatId);
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`[TG:${this.name}] task session reply failed: ${errMsg}`);
      }
      return;
    }

    const cfg = this.getBehavior<any>("auto_reply");
    if (!cfg?.enabled || !this.shouldAutoReply(cfg, text, chatId)) return;

    let reply = "";
    if (cfg.replyMode === "ai") {
      await ctx.replyWithChatAction("typing");
      // Use configured system prompt if present, otherwise build from workspace files.
      const systemPrompt =
        cfg.aiSystemPrompt ?? (await this.buildRichSystemPrompt(undefined, chatKey));
      try {
        reply = await aiReply(text, chatKey, systemPrompt, this.storage, workspaceTools);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`[TG:${this.name}] auto_reply AI failed: ${errMsg}`);
        return;
      }
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

  // ─── Stability helpers ─────────────────────────────────────────────────────

  /**
   * Replace bot token in any string before it reaches logs.
   * Telegram tokens follow the pattern <8-10 digits>:<35 chars>, e.g.
   * "123456789:AAHk..." → "<token>".
   */
  private maskToken(s: string): string {
    return s.replace(/\d{8,10}:[A-Za-z0-9_-]{35}/g, "<token>");
  }

  /**
   * Auto-restart polling after a crash, using exponential back-off.
   * Delay: 5 s → 10 s → 20 s → 40 s → 60 s (capped).
   * Aborts if the agent has been manually stopped.
   */
  private async scheduleRestart(): Promise<void> {
    const delayMs = Math.min(2 ** this.restartAttempts * 5_000, 60_000);
    this.restartAttempts += 1;
    this.logger.info(
      `[TG:${this.name}] scheduling restart in ${delayMs / 1000}s (attempt ${this.restartAttempts})`,
    );
    await this.delay(delayMs);
    // Abort if agent was manually stopped while we were waiting.
    if (this.record.status === "stopped") return;
    try {
      await this.start();
      this.restartAttempts = 0; // reset on successful start
    } catch (e) {
      this.logger.error(`[TG:${this.name}] restart failed`, {
        e: this.maskToken(String(e)),
      });
      void this.scheduleRestart();
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
