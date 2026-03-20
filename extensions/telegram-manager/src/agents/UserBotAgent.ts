import cron from "node-cron";
// plugins/telegram/src/agents/UserBotAgent.ts
import { TelegramClient } from "telegram";
import type { EntityLike } from "telegram/define";
import { NewMessage } from "telegram/events";
import { StringSession } from "telegram/sessions";
import { aiReply } from "../behaviors/AiReplyEngine";
import { MasterControlHandler } from "../behaviors/MasterControlHandler";
import { TelegramStorage } from "../storage/TelegramStorage";
import { createWorkspaceTools } from "../tools/TelegramTools";
import {
  AgentRecord,
  UserbotCredentials,
  BehaviorConfig,
  IAgentManager,
  ILogger,
  MasterControlBehavior,
} from "../types";
import { BaseAgent } from "./BaseAgent";

const cooldowns = new Map<string, number>();

// Minimum ms between consecutive outbound messages to the same peer.
// Sending too rapidly to one peer triggers PEER_FLOOD on userbot accounts.
const MIN_SEND_INTERVAL_MS = 3_000;
// How long to back off after a PEER_FLOOD before retrying (ms).
const PEER_FLOOD_RETRY_MS = 60_000;
// Map of chatId → timestamp of last outbound send (module-level, per agent instance key).
const lastSentAt = new Map<string, number>();

// WeakMap stores TelegramClient outside the instance so that structuredClone
// (called by the pi-agent framework in emitContext) never traverses into it.
// TelegramClient holds PromisedNetSockets which contains a live Promise and
// cannot be cloned, causing DataCloneError. WeakMap is invisible to structuredClone.
const clientStore = new WeakMap<UserBotAgent, TelegramClient>();

export class UserBotAgent extends BaseAgent {
  private creds: UserbotCredentials;
  /** Manager reference — injected by AgentManager.spawn(); used by master_control. */
  private managerRef: IAgentManager | null;

  constructor(
    record: AgentRecord,
    storage: TelegramStorage,
    logger: ILogger,
    managerRef?: IAgentManager,
  ) {
    super(record, storage, logger);
    this.creds = record.credentials as UserbotCredentials;
    this.managerRef = managerRef ?? null;
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

      await this.ensureWorkspaceFiles();
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

  /**
   * Disconnect the userbot without changing its DB status to "stopped".
   * Used by AgentManager.shutdown() so the agent is auto-restarted on the
   * next gateway start (AgentManager.init() restarts agents with status="running").
   */
  override async gracefulShutdown(): Promise<void> {
    this.clearCron();
    await this.client?.disconnect().catch(() => {});
    this.client = null;
    // Intentionally NOT calling setStatus("stopped") — preserve "running" in DB.
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

      case "get_dialogs": {
        const limit = typeof args.limit === "number" ? args.limit : 30;
        const dialogs = await this.client.getDialogs({ limit });
        return (dialogs as any[]).map((d: any) => {
          const entity = d.entity;
          let name = "Unknown";
          if (entity) {
            const first = entity.firstName || "";
            const last = entity.lastName || "";
            if (first || last) {
              name = [first, last].filter(Boolean).join(" ");
            } else if (entity.title) {
              name = entity.title;
            }
          }
          return {
            id: String(d.id),
            name,
            type: d.isUser ? "user" : d.isGroup ? "group" : "channel",
            username: entity?.username ?? null,
            lastMessage: d.message?.message || "",
            lastMessageDate: d.message?.date ? new Date(d.message.date * 1000).toISOString() : null,
            unreadCount: d.unreadCount ?? 0,
            lastMessageOut: !!d.message?.out,
          };
        });
      }
      case "getMessages": {
        const { target, limit } = args as any;
        const msgs = await this.client.getMessages(target, { limit: limit ?? 50 });
        return msgs.map((m: any) => ({
          id: String(m.id),
          text: m.message ?? "",
          date: m.date ? new Date(m.date * 1000).toISOString() : null,
          hasMedia: !!m.media,
          out: !!m.out,
          mediaType: m.media ? (m.media.className ?? "media") : null,
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
      case "resolveEntityId": {
        // Resolve a username or identifier to its numeric Telegram peer ID.
        // gramjs caches resolved entities, so this is lightweight after the first call.
        const { target } = args as { target: string };
        const entity = await this.client.getEntity(target);
        // gramjs entities (User, Chat, Channel) all have a BigInt `id` property.
        // Cast through `unknown` because gramjs Entity union doesn't expose `id` directly.
        const id = (entity as unknown as { id?: bigint | number }).id;
        return { id: id != null ? String(id) : null };
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
      if (b.type === "master_control") this.setupMasterControl();
      if (b.type === "auto_reply") this.setupAutoReply();
      if (b.type === "monitor") this.setupMonitor();
      if (b.type === "broadcast") this.setupBroadcast();
      if (b.type === "parser")
        this.runParser().catch((e) =>
          this.logger.warn(`[TG:${this.name}] parser error`, { e: String(e) }),
        );
    }
  }

  /**
   * Always-on handler for the master_control behavior.
   * Messages from authorized chat IDs are routed to the agentic management
   * loop — the AI can then start/stop agents, send messages, assign tasks, etc.
   * Registered first so it intercepts before task_session and auto_reply.
   */
  private setupMasterControl(): void {
    const mc = this.getBehavior<MasterControlBehavior>("master_control");
    if (!mc?.enabled || !this.client || !this.managerRef) return;

    const mgr = this.managerRef;
    this.client.addEventHandler(
      async (event: any) => {
        const msg = event.message;
        if (!msg || msg.out) return;
        const chatId = String(msg.chatId || "");
        if (!mc.allowedChatIds.includes(chatId)) return;

        // Capture the resolved InputPeer before any async gap.
        // Try msg.inputChat first (fast path: entity already in session cache).
        // Fall back to event.getInputChat() which uses InputUserFromMessage internally
        // and can resolve the access_hash even for users not yet in the session cache.
        let msgPeer: EntityLike | undefined;
        try {
          const ic = msg.inputChat as any;
          if (ic?.className?.startsWith("InputPeer")) {
            msgPeer = ic as EntityLike;
          } else if (typeof (event as any).getInputChat === "function") {
            msgPeer = (await (event as any).getInputChat()) as EntityLike;
          }
        } catch {
          /* will fall back to BigInt in sendWithFloodGuard */
        }

        const text = msg.message || "";
        this.trackMessage("in", text, chatId);
        try {
          const handler = new MasterControlHandler(mgr, this.logger);
          const reply = await handler.handle(text, mc.systemPrompt);
          if (reply) {
            await this.sendWithFloodGuard(chatId, reply, msg.id, msgPeer);
            this.trackMessage("out", reply, chatId);
          }
        } catch (e) {
          this.logger.error(`[TG:${this.name}] master_control error`, { e: String(e) });
        }
      },
      new NewMessage({ incoming: true }),
    );

    this.logger.info(`[TG:${this.name}] master_control handler active`);
  }

  /** Always-on handler that intercepts messages for active task sessions. */
  private setupTaskSessionHandler(): void {
    if (!this.client) return;

    this.client.addEventHandler(
      async (event: any) => {
        const msg = event.message;
        if (!msg || msg.out) return;
        const chatId = String(msg.chatId || "");

        // Skip master_control authorized chats — handled by setupMasterControl.
        const mc = this.getBehavior<MasterControlBehavior>("master_control");
        if (mc?.enabled && mc.allowedChatIds.includes(chatId)) return;

        // Dynamically look up the session at message-handling time so that
        // sessions assigned after start() are picked up without reconnecting.
        const taskSession = this.getTaskSession(chatId);
        if (!taskSession) return;

        // Capture the resolved InputPeer before any async gap.
        // Try msg.inputChat first (fast path: entity already in session cache).
        // Fall back to event.getInputChat() which uses InputUserFromMessage internally
        // and can resolve the access_hash even for users not yet in the session cache.
        let msgPeer: EntityLike | undefined;
        try {
          const ic = msg.inputChat as any;
          if (ic?.className?.startsWith("InputPeer")) {
            msgPeer = ic as EntityLike;
          } else if (typeof (event as any).getInputChat === "function") {
            msgPeer = (await (event as any).getInputChat()) as EntityLike;
          }
        } catch {
          /* will fall back to BigInt in sendWithFloodGuard */
        }

        const text = msg.message || "";
        // Use a stable per-chat key so history is shared with auto_reply —
        // continuous dialogue is preserved when the task session ends.
        const chatKey = `${this.id}:${chatId}`;

        // Schema mode overrides task session: when the agent is configured to
        // follow a diagram script, ALL conversations go through that script —
        // including task-session chats — so the operator gets a consistent flow.
        const agentSettings = this.getAgentSettings();
        if (agentSettings.useSchema && agentSettings.activeDiagramId) {
          this.trackMessage("in", text, chatId);
          try {
            const scriptReply = await this.runScriptStep(chatId, text, chatKey);
            if (scriptReply) {
              await this.sendWithFloodGuard(chatId, scriptReply, msg.id, msgPeer);
              this.trackMessage("out", scriptReply, chatId);
            } else {
              this.logger.warn(
                `[TG:${this.name}] schema reply null for task-session chat ${chatId}`,
              );
            }
          } catch (e) {
            this.logger.warn(`[TG:${this.name}] schema step (task-session) failed: ${String(e)}`);
          }
          return;
        }

        this.trackMessage("in", text, chatId);
        // Fetch the partner's writing style from real Telegram history for new chats.
        const storedHistory = this.storage.loadConversationHistory(chatKey);
        const styleContext = storedHistory.length < 4 ? await this.fetchStyleContext(chatId) : "";
        // Use custom system prompt if provided, otherwise build from workspace files.
        // Pass chatKey so the prompt includes a brief recap of prior exchanges.
        const systemPrompt =
          taskSession.systemPrompt ??
          (await this.buildRichSystemPrompt(taskSession.task, chatKey, styleContext));
        // Tools scoped to this agent's workspace — cannot access other agents' files.
        const workspaceTools = createWorkspaceTools(this.storage.getAgentWorkspaceDir(this.id));
        try {
          const reply = await aiReply(text, chatKey, systemPrompt, this.storage, workspaceTools);
          if (reply) {
            await this.sendWithFloodGuard(chatId, reply, msg.id, msgPeer);
            this.trackMessage("out", reply, chatId);
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          this.logger.warn(`[TG:${this.name}] task session reply failed: ${errMsg}`);
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
        // Skip master_control authorized chats and active task sessions.
        const mc = this.getBehavior<MasterControlBehavior>("master_control");
        if (mc?.enabled && mc.allowedChatIds.includes(chatId)) return;
        if (this.getTaskSession(chatId)) return;

        const key = `${this.id}:${chatId}`;
        const now = Date.now();
        const cd = (cfg.cooldownSeconds ?? 5) * 1000;

        if (cooldowns.has(key) && now - cooldowns.get(key)! < cd) return;
        // Respect work-mode settings: skip reply outside scheduled window.
        const agentSettings = this.getAgentSettings();
        if (!this.isWithinSchedule(agentSettings)) return;

        // replyTo: "tasks" — only engage with chats that have an active task session.
        if (!this.isAllowedChat(chatId, agentSettings)) return;

        // Capture the resolved InputPeer before any async gap.
        // Try msg.inputChat first (fast path: entity already in session cache).
        // Fall back to event.getInputChat() which uses InputUserFromMessage internally
        // and can resolve the access_hash even for users not yet in the session cache.
        let msgPeer: EntityLike | undefined;
        try {
          const ic = msg.inputChat as any;
          if (ic?.className?.startsWith("InputPeer")) {
            msgPeer = ic as EntityLike;
          } else if (typeof (event as any).getInputChat === "function") {
            msgPeer = (await (event as any).getInputChat()) as EntityLike;
          }
        } catch {
          /* will fall back to BigInt in sendWithFloodGuard */
        }

        // Schema mode: follow the active diagram as a strict script.
        // Bypasses keyword/trigger requirements so every message in the
        // conversation advances through the script steps.
        // IMPORTANT: always return from this block — never fall through to auto_reply.
        if (agentSettings.useSchema && agentSettings.activeDiagramId) {
          this.trackMessage("in", text, chatId);
          try {
            const scriptReply = await this.runScriptStep(chatId, text, key);
            if (scriptReply) {
              await this.sendWithFloodGuard(chatId, scriptReply, msg.id, msgPeer);
              cooldowns.set(key, Date.now());
              this.trackMessage("out", scriptReply, chatId);
            } else {
              this.logger.warn(
                `[TG:${this.name}] schema reply is null for chat ${chatId} — check diagram has a start node`,
              );
            }
          } catch (e) {
            this.logger.warn(`[TG:${this.name}] schema step failed: ${String(e)}`);
          }
          return; // schema mode: never fall through to auto_reply
        }

        if (!this.shouldAutoReply(cfg, text, chatId)) return;

        this.trackMessage("in", text, chatId);

        let reply = "";
        if (cfg.replyMode === "ai") {
          // Fetch partner's writing style from Telegram history for new conversations.
          const storedHistory = this.storage.loadConversationHistory(key);
          const styleContext = storedHistory.length < 4 ? await this.fetchStyleContext(chatId) : "";
          // Use configured system prompt if present, otherwise build from workspace files.
          // Pass goal (if set) so the agent has a clear objective in every conversation.
          const systemPrompt =
            cfg.aiSystemPrompt ?? (await this.buildRichSystemPrompt(cfg.goal, key, styleContext));
          // Tools scoped to this agent's workspace — cannot access other agents' files.
          const workspaceTools = createWorkspaceTools(this.storage.getAgentWorkspaceDir(this.id));
          try {
            reply = await aiReply(text, key, systemPrompt, this.storage, workspaceTools);
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
          await this.sendWithFloodGuard(chatId, reply, msg.id, msgPeer);
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

  /**
   * Send a reply message to a chat, enforcing a minimum inter-send delay and
   * retrying once on PEER_FLOOD (Telegram's userbot rate-limit per peer).
   *
   * @param chatId        Numeric string chat/peer ID (used only for flood-guard key).
   * @param message       Text to send.
   * @param replyToMsgId  Optional message to thread-reply to.
   * @param resolvedPeer  Pre-resolved InputPeer from the incoming event. When present
   *                      it is used directly (it embeds the access_hash, so no entity
   *                      cache lookup is needed). Falls back to BigInt reconstruction
   *                      when absent (e.g. proactive sends not triggered by an event).
   */
  private async sendWithFloodGuard(
    chatId: string,
    message: string,
    replyToMsgId?: number,
    resolvedPeer?: EntityLike,
  ): Promise<void> {
    // Enforce minimum inter-send delay to the same peer.
    const sendKey = `${this.id}:${chatId}`;
    const now = Date.now();
    const last = lastSentAt.get(sendKey) ?? 0;
    const wait = MIN_SEND_INTERVAL_MS - (now - last);
    if (wait > 0) await this.delay(wait);

    // Prefer the InputPeer captured from the incoming event — it contains the
    // access_hash inline, so GramJS does not need to look it up in the session
    // entity cache (which may not have the peer if the user is new).
    // Fall back to BigInt for numeric IDs when no pre-resolved peer is given.
    const peer: EntityLike =
      resolvedPeer ?? ((/^-?\d+$/.test(chatId) ? BigInt(chatId) : chatId) as EntityLike);
    const doSend = () =>
      this.client!.sendMessage(peer, {
        message,
        ...(replyToMsgId ? { replyTo: replyToMsgId } : {}),
      });

    try {
      await doSend();
      lastSentAt.set(sendKey, Date.now());
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // PEER_FLOOD: Telegram's anti-spam per-peer rate limit — back off and retry once.
      if (errMsg.includes("PEER_FLOOD")) {
        this.logger.warn(
          `[TG:${this.name}] PEER_FLOOD for ${chatId}, retrying in ${PEER_FLOOD_RETRY_MS / 1000}s`,
        );
        await this.delay(PEER_FLOOD_RETRY_MS);
        await doSend();
        lastSentAt.set(sendKey, Date.now());
      } else if (
        errMsg.includes("input entity") ||
        errMsg.includes("Cannot find") ||
        errMsg.includes("PEER_ID_INVALID")
      ) {
        // Entity resolution failed — the provided peer had no access_hash or was stale.
        // Retry by resolving the entity. If it's not in the session cache, force a
        // refresh via getDialogs (which fetches full User objects with access_hash
        // for all recent conversations from the Telegram API).
        this.logger.warn(
          `[TG:${this.name}] entity error for ${chatId}, retrying via getInputEntity`,
        );
        try {
          // Pass a BigInt so GramJS resolves by numeric peer ID (not username/phone).
          const numId: EntityLike | undefined = /^-?\d+$/.test(chatId)
            ? (BigInt(chatId) as unknown as EntityLike)
            : undefined;
          if (!numId || !this.client) throw new Error("cannot resolve numeric chatId");

          let resolved: EntityLike;
          try {
            resolved = (await this.client.getInputEntity(numId)) as EntityLike;
          } catch {
            // Entity not in session cache — force refresh via getDialogs.
            // getDialogs fetches recent conversations from Telegram's API and
            // populates the entity cache with full User objects (with access_hash).
            this.logger.warn(
              `[TG:${this.name}] entity cache miss for ${chatId}, refreshing via getDialogs`,
            );
            await this.client.getDialogs({ limit: 100 });
            resolved = (await this.client.getInputEntity(numId)) as EntityLike;
          }

          await this.client.sendMessage(resolved, {
            message,
            ...(replyToMsgId ? { replyTo: replyToMsgId } : {}),
          });
          lastSentAt.set(sendKey, Date.now());
        } catch (e2) {
          throw e2; // both attempts failed
        }
      } else {
        throw e;
      }
    }
  }

  /**
   * Fetch recent messages from a Telegram chat and build a style-context section
   * describing how the conversation partner writes. Used to help the AI mimic
   * the other person's tone, vocabulary, and sentence structure.
   *
   * Only called when the stored conversation history is short (new chat) so we
   * don't redundantly re-fetch once the AI already has enough context.
   */
  private async fetchStyleContext(chatId: string): Promise<string> {
    if (!this.client) return "";
    try {
      const msgs = await this.client.getMessages(chatId, { limit: 25 });
      const me = (await this.client.getMe()) as unknown as { id?: bigint | number };
      const myId = me?.id?.toString();
      // Collect the other person's messages only (exclude our own outbound messages).
      const theirTexts = (
        msgs as unknown as Array<{ message?: string; senderId?: { toString(): string } }>
      )
        .filter((m) => m.message && m.senderId?.toString() !== myId)
        .map((m) => m.message!.trim())
        .filter((t) => t.length > 0)
        .slice(0, 15);
      if (theirTexts.length === 0) return "";
      return (
        `## Conversation partner's writing style\n` +
        `Study how this person writes based on their recent messages:\n` +
        theirTexts.map((t) => `- "${t}"`).join("\n") +
        `\n\nMimic their style: match their vocabulary, sentence length, formality level, ` +
        `emoji usage, and punctuation habits. Write as naturally as they do.`
      );
    } catch {
      return "";
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
