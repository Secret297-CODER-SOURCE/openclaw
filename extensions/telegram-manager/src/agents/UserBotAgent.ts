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
// Map of agentId:chatId → timestamp of last INCOMING message (for inactivity follow-up).
const lastIncomingAt = new Map<string, number>();
// Map of agentId:chatId → timestamp of last follow-up sent (prevents repeated pings).
const followUpSentAt = new Map<string, number>();
// Set of "agentId:chatId:msgId" already processed this session — prevents double-reply
// when catchUpUnread and the live NewMessage handler race for the same message.
const processedMsgIds = new Set<string>();

/**
 * Per-chat reply lock: "agentId:chatId" → Promise resolving when current reply is done.
 * Ensures rapid burst messages from the same client are processed one at a time.
 * Without this, two messages arriving within milliseconds could both load the same
 * conversation history, generate independent AI replies, and both send responses —
 * resulting in near-identical duplicate messages from the agent.
 */
const chatLocks = new Map<string, Promise<void>>();

/**
 * Serialize async work per chat. `fn` runs only after any in-progress reply for
 * `lockKey` has finished. If `fn` is already queued/running, the second call waits.
 */
function withChatLock(lockKey: string, fn: () => Promise<void>): Promise<void> {
  const prev = chatLocks.get(lockKey) ?? Promise.resolve();
  const next = prev
    .then(() => fn())
    .catch(() => {
      /* individual handlers log their own errors */
    });
  chatLocks.set(lockKey, next);
  // Auto-clean: once `next` settles, remove from map if nothing else was chained.
  next.finally(() => {
    if (chatLocks.get(lockKey) === next) chatLocks.delete(lockKey);
  });
  return next;
}

/**
 * Split an AI reply into multiple Telegram messages.
 *
 * Priority:
 *   1. Explicit [MSG] marker injected by the AI via system-prompt instruction.
 *   2. Paragraph breaks (double newline).
 *   3. Sentence grouping — 2–3 sentences per message.
 *   4. Single message for very short texts (< 80 chars).
 *
 * Maximum 4 parts to avoid flooding the chat.
 */
/**
 * Split an AI reply into 1–3 natural Telegram messages.
 *
 * Decision tree (human-like):
 *  1. [MSG] marker  — explicit AI split, always respected (max 3 parts).
 *  2. ≤ 200 chars   — single bubble, never split.
 *  3. Double newline — split only when BOTH parts are ≥ 60 chars (real ideas, not noise).
 *  4. Very long (> 600 chars) — split at sentence boundary near the midpoint.
 *  5. Everything else — single bubble (better to send one clean message).
 *
 * Max 3 parts — more than that feels spammy.
 */
function splitMessage(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 1. Explicit [MSG] marker — highest priority.
  if (trimmed.includes("[MSG]")) {
    const parts = trimmed
      .split(/\[MSG\]/gi)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts.slice(0, 3);
  }

  // 2. Very short — always single bubble.
  if (trimmed.length <= 200) return [trimmed];

  // 3. Paragraph split — only when both parts are substantial ideas.
  const paragraphs = trimmed
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length >= 2 && paragraphs.length <= 3 && paragraphs.every((p) => p.length >= 60)) {
    return paragraphs.slice(0, 3);
  }

  // 4. Very long single block — split near midpoint at a sentence end.
  if (trimmed.length > 600) {
    const mid = Math.floor(trimmed.length / 2);
    // Find the nearest sentence-ending punctuation after the midpoint.
    const after = trimmed.slice(mid).search(/[.!?]\s/);
    if (after !== -1) {
      const splitAt = mid + after + 1;
      const first = trimmed.slice(0, splitAt).trim();
      const second = trimmed.slice(splitAt).trim();
      if (first.length >= 60 && second.length >= 60) return [first, second];
    }
  }

  // 5. Default — single message.
  return [trimmed];
}

/** Instruction appended to every system prompt so the AI splits its reply. */
const MULTI_MSG_INSTRUCTION =
  `\n\n## Формат ответа\n` +
  `ЯЗЫК: Отвечай СТРОГО на том языке, на котором написал клиент (русский, турецкий, английский и т.д.).\n` +
  `Пиши ответ как 2–3 отдельных коротких сообщения, разделяя их маркером [MSG].\n` +
  `Каждое сообщение — 1–2 предложения. Не пиши сам маркер в тексте — только между частями.\n` +
  `Пример: "Привет! Как дела? [MSG] Расскажи подробнее. [MSG] Буду рад помочь."`;

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

  // ── AI folder (Telegram dialog filter) ────────────────────────────────────

  /** In-memory cache: filter ID of the "AI" folder, null = not yet created. */
  private aiFolderFilterId: number | null = null;

  /**
   * Ensure the "AI" Telegram folder (dialog filter) exists.
   * Creates it if absent, caches its ID for subsequent peer additions.
   * Called once on registerBehaviors — silently no-ops on error.
   */
  private async initAiFolder(): Promise<void> {
    const c = this.client;
    if (!c) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tl = require("telegram/tl") as any;
      const result = await c.invoke(new tl.functions.messages.GetDialogFilters());
      const filters: any[] = Array.isArray(result) ? result : ((result as any).filters ?? []);

      // Find existing "AI" folder.
      const existing = filters.find(
        (f: any) => f.className === "DialogFilter" && f.title?.trim() === "AI",
      );
      if (existing) {
        this.aiFolderFilterId = existing.id as number;
        this.logger.info(`[TG:${this.name}] AI folder found (id=${existing.id})`);
        return;
      }

      // Pick an unused filter ID in the 2–255 range.
      const usedIds = new Set<number>(filters.map((f: any) => f.id as number));
      let newId = 2;
      while (usedIds.has(newId) && newId < 255) newId++;

      await c.invoke(
        new tl.functions.messages.UpdateDialogFilter({
          id: newId,
          filter: new tl.types.DialogFilter({
            id: newId,
            title: "AI",
            pinnedPeers: [],
            includedPeers: [],
            excludedPeers: [],
            contacts: false,
            nonContacts: false,
            groups: false,
            broadcasts: false,
            bots: false,
            excludeArchived: false,
            excludeMuted: false,
            excludeRead: false,
          }),
        }),
      );
      this.aiFolderFilterId = newId;
      this.logger.info(`[TG:${this.name}] AI folder created (id=${newId})`);
    } catch (e) {
      this.logger.warn(`[TG:${this.name}] initAiFolder failed: ${String(e)}`);
    }
  }

  /**
   * Add a chat to the "AI" folder if it isn't already there.
   * Reads the current filter, appends the peer, and writes it back.
   * Silently no-ops on any error.
   */
  private async addChatToAiFolder(chatId: string): Promise<void> {
    const c = this.client;
    if (!c || this.aiFolderFilterId === null) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tl = require("telegram/tl") as any;
      const result = await c.invoke(new tl.functions.messages.GetDialogFilters());
      const filters: any[] = Array.isArray(result) ? result : ((result as any).filters ?? []);

      const filter = filters.find(
        (f: any) => f.className === "DialogFilter" && f.id === this.aiFolderFilterId,
      );
      if (!filter) return; // folder was deleted externally

      // Resolve the InputPeer for this chatId.
      let inputPeer: any;
      try {
        inputPeer = await c.getInputEntity(chatId);
      } catch {
        return; // cannot resolve peer, skip silently
      }

      // Check if already in the folder (compare serialised peer).
      const included: any[] = filter.includedPeers ?? [];
      const alreadyIn = included.some(
        (p: any) => String(p.userId ?? p.channelId ?? p.chatId ?? "") === String(chatId),
      );
      if (alreadyIn) return;

      // Append and update.
      await c.invoke(
        new tl.functions.messages.UpdateDialogFilter({
          id: this.aiFolderFilterId,
          filter: new tl.types.DialogFilter({
            id: filter.id,
            title: filter.title,
            pinnedPeers: filter.pinnedPeers ?? [],
            includedPeers: [...included, inputPeer],
            excludedPeers: filter.excludedPeers ?? [],
            contacts: filter.contacts ?? false,
            nonContacts: filter.nonContacts ?? false,
            groups: filter.groups ?? false,
            broadcasts: filter.broadcasts ?? false,
            bots: filter.bots ?? false,
            excludeArchived: filter.excludeArchived ?? false,
            excludeMuted: filter.excludeMuted ?? false,
            excludeRead: filter.excludeRead ?? false,
          }),
        }),
      );
      this.logger.info(`[TG:${this.name}] chat ${chatId} added to AI folder`);
    } catch (e) {
      this.logger.warn(`[TG:${this.name}] addChatToAiFolder failed: ${String(e)}`);
    }
  }

  /** Hook: called by BaseAgent.trackMessage on every outgoing message. */
  protected override onOutgoingMessage(chatId: string): void {
    void this.addChatToAiFolder(chatId);
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
      // Process any messages that arrived while the agent was offline.
      this.catchUpUnread().catch((e) =>
        this.logger.warn(`[TG:${this.name}] catch-up error`, { e: String(e) }),
      );
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

  /**
   * After restart, scan dialogs for unread incoming messages and route each
   * through the same handler (schema / task-session / auto_reply) as live messages.
   * Only processes dialogs where the last message is incoming (not sent by us).
   */
  private async catchUpUnread(): Promise<void> {
    if (!this.client) return;
    const agentSettings = this.getAgentSettings();
    const mc = this.getBehavior<MasterControlBehavior>("master_control");
    const autoReplyCfg = this.getBehavior<any>("auto_reply");

    let dialogs: any[];
    try {
      dialogs = await this.client.getDialogs({ limit: 50 });
    } catch (e) {
      this.logger.warn(`[TG:${this.name}] catch-up: getDialogs failed`, { e: String(e) });
      return;
    }

    const unread = dialogs.filter((d: any) => d.unreadCount > 0 && d.message && !d.message.out);

    if (unread.length === 0) return;
    this.logger.info(`[TG:${this.name}] catch-up: ${unread.length} dialog(s) with unread messages`);

    for (const dialog of unread) {
      const chatId = String(dialog.id);
      // Skip master_control chats — they have their own handler.
      if (mc?.enabled && mc.allowedChatIds.includes(chatId)) continue;

      const taskSession = this.getTaskSession(chatId);
      const hasAutoReply = autoReplyCfg?.enabled;
      const hasSchema = agentSettings.useSchema && !!agentSettings.activeDiagramId;

      // Only process if this chat would be handled by schema, task_session, or auto_reply.
      if (!hasSchema && !taskSession && !hasAutoReply) continue;
      if (!hasSchema && !taskSession && hasAutoReply && !this.isAllowedChat(chatId, agentSettings))
        continue;

      // Fetch the last few messages to find the latest incoming one.
      let msgs: any[];
      try {
        msgs = await this.client.getMessages(chatId, { limit: 5 });
      } catch (e) {
        this.logger.warn(`[TG:${this.name}] catch-up: getMessages failed for ${chatId}`, {
          e: String(e),
        });
        continue;
      }

      // If the most recent message is already outgoing, we replied in this session — skip.
      if (msgs[0]?.out) {
        this.logger.info(`[TG:${this.name}] catch-up: ${chatId} already answered, skipping`);
        continue;
      }

      // Find the most recent incoming message (not sent by us).
      const incomingMsg = msgs.find((m: any) => !m.out);
      if (!incomingMsg) continue;

      const text = incomingMsg.message || "";
      if (!text) continue;

      // Deduplicate: skip if a live handler already processed this exact message.
      const msgKey = `${this.id}:${chatId}:${incomingMsg.id}`;
      if (processedMsgIds.has(msgKey)) {
        this.logger.info(
          `[TG:${this.name}] catch-up: ${chatId} msg ${incomingMsg.id} already handled, skipping`,
        );
        continue;
      }
      processedMsgIds.add(msgKey);

      const chatKey = `${this.id}:${chatId}`;
      lastIncomingAt.set(chatKey, Date.now());
      followUpSentAt.delete(chatKey);

      this.trackMessage("in", text, chatId);
      this.detectFollowupRequest(chatId, chatKey, text);
      this.logger.info(`[TG:${this.name}] catch-up: processing unread from ${chatId}`);

      try {
        if (agentSettings.useSchema && agentSettings.activeDiagramId) {
          const scriptReply = await this.runScriptStep(chatId, text, chatKey);
          if (scriptReply) {
            await this.sendAsChunks(chatId, scriptReply, incomingMsg.id);
            this.trackMessage("out", scriptReply, chatId);
          }
        } else if (taskSession) {
          // Task session: use the task session AI reply path.
          const systemPrompt =
            (await this.buildRichSystemPrompt(undefined, chatKey, "")) + MULTI_MSG_INSTRUCTION;
          const workspaceTools = createWorkspaceTools(this.storage.getAgentWorkspaceDir(this.id));
          const reply = await aiReply(text, chatKey, systemPrompt, this.storage, workspaceTools);
          if (reply) {
            await this.sendAsChunks(chatId, reply, incomingMsg.id);
            this.trackMessage("out", reply, chatId);
          }
        } else if (hasAutoReply && this.shouldAutoReply(autoReplyCfg, text, chatId)) {
          const systemPrompt =
            (autoReplyCfg.aiSystemPrompt ??
              (await this.buildRichSystemPrompt(autoReplyCfg.goal, chatKey, ""))) +
            MULTI_MSG_INSTRUCTION;
          const workspaceTools = createWorkspaceTools(this.storage.getAgentWorkspaceDir(this.id));
          const reply = await aiReply(text, chatKey, systemPrompt, this.storage, workspaceTools);
          if (reply) {
            await this.sendAsChunks(chatId, reply, incomingMsg.id);
            this.trackMessage("out", reply, chatId);
          }
        }
      } catch (e) {
        this.logger.warn(`[TG:${this.name}] catch-up: reply failed for ${chatId}`, {
          e: String(e),
        });
      }

      // Small delay between chats to avoid rate limits.
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

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
    // Always register the schema handler — it activates when useSchema is on,
    // independent of auto_reply being configured. Handles ALL chats (not just
    // task sessions) so new contacts also get a reply in schema mode.
    this.setupSchemaHandler();
    // Always start the inactivity follow-up watcher regardless of behaviors —
    // it covers both task-session chats and schema-mode conversations.
    this.setupInactivityFollowup();
    // Restore any scheduled follow-ups that survived a gateway restart.
    this.restorePendingFollowups();
    // Initialize leads group (join + one-time welcome) if configured.
    void this.initLeadsGroup();
    // Create or find the "AI" Telegram folder for chats the agent works with.
    void this.initAiFolder();
    // Start periodic re-engagement outreach to dormant contacts.
    this.startReEngagementCron();
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
   * Always-on schema handler — registered regardless of whether auto_reply
   * is configured.  Activates only when the agent has useSchema + activeDiagramId.
   *
   * Covers the gap where a new contact (no task session assigned) writes to the
   * userbot and auto_reply is disabled or replyTo="tasks" would block them.
   */
  private setupSchemaHandler(): void {
    if (!this.client) return;

    this.client.addEventHandler(
      async (event: any) => {
        const msg = event.message;
        if (!msg || msg.out) return;
        // Never reply to other bots (gramjs User.bot flag).
        if ((msg as any).sender?.bot) return;
        const chatId = String(msg.chatId || "");

        // Skip master_control chats — handled by setupMasterControl.
        const mc = this.getBehavior<MasterControlBehavior>("master_control");
        if (mc?.enabled && mc.allowedChatIds.includes(chatId)) return;

        // Skip task-session chats — handled by setupTaskSessionHandler.
        if (this.getTaskSession(chatId)) return;

        const agentSettings = this.getAgentSettings();

        // Only active when schema mode is on.
        if (!agentSettings.useSchema || !agentSettings.activeDiagramId) return;

        // Capture resolved InputPeer before any async gap (needed for offline reply too).
        let msgPeer: EntityLike | undefined;
        try {
          const ic = msg.inputChat as any;
          if (ic?.className?.startsWith("InputPeer")) {
            msgPeer = ic as EntityLike;
          } else if (typeof (event as any).getInputChat === "function") {
            msgPeer = (await (event as any).getInputChat()) as EntityLike;
          }
        } catch {
          /* fall back to BigInt in sendWithFloodGuard */
        }

        const text = msg.message || "";
        if (!text) return;

        // Outside schedule: AI continues lead-processing in offline mode,
        // OR silent mode but this chat replied to a re-engagement message.
        if (!this.isWithinSchedule(agentSettings)) {
          const shouldReply =
            this.isOfflineLeadMode(agentSettings) ||
            this.isReEngagementReply(chatId, agentSettings);

          if (shouldReply) {
            const key = `${this.id}:${chatId}`;
            const msgKey = `${this.id}:${chatId}:${msg.id}`;
            if (processedMsgIds.has(msgKey)) return;
            processedMsgIds.add(msgKey);
            const lockKey = `${this.id}:${chatId}`;
            withChatLock(lockKey, async () => {
              try {
                const diagram = agentSettings.activeDiagramId
                  ? (this.storage.getDiagramById(agentSettings.activeDiagramId) ?? undefined)
                  : undefined;
                const reply = await this.runOfflineLeadMode(
                  chatId,
                  text,
                  key,
                  agentSettings,
                  diagram,
                );
                if (reply) {
                  await this.sendAsChunks(chatId, reply, msg.id, msgPeer);
                  this.trackMessage("out", reply, chatId);
                }
              } catch (e) {
                this.logger.warn(
                  `[TG:${this.name}] offline-lead/re-engagement reply failed: ${String(e)}`,
                );
              }
            });
          }
          // All other contacts: stay silent.
          return;
        }

        if (!text) return;

        // Deduplicate: skip if catchUpUnread already processed this message.
        const msgKey = `${this.id}:${chatId}:${msg.id}`;
        if (processedMsgIds.has(msgKey)) return;
        processedMsgIds.add(msgKey);

        const key = `${this.id}:${chatId}`;
        lastIncomingAt.set(key, Date.now());
        followUpSentAt.delete(key);
        this.trackMessage("in", text, chatId);
        this.saveContactInfo(chatId, {
          firstName: (msg as any).sender?.firstName,
          lastName: (msg as any).sender?.lastName,
          username: (msg as any).sender?.username,
        });
        this.detectFollowupRequest(chatId, key, text);

        // Serialize per-chat: rapid bursts of messages from the same client must
        // be processed one at a time so AI calls see up-to-date history and
        // don't produce duplicate/identical responses.
        const lockKey = `${this.id}:${chatId}`;
        withChatLock(lockKey, async () => {
          try {
            const scriptReply = await this.runScriptStep(chatId, text, key);
            if (scriptReply) {
              await this.sendAsChunks(chatId, scriptReply, msg.id, msgPeer);
              this.trackMessage("out", scriptReply, chatId);
            } else {
              this.logger.warn(
                `[TG:${this.name}] schema reply null for chat ${chatId} — check diagram has a start node`,
              );
            }
          } catch (e) {
            this.logger.warn(`[TG:${this.name}] schema handler failed for ${chatId}: ${String(e)}`);
          }
        });
      },
      new NewMessage({ incoming: true }),
    );

    this.logger.info(`[TG:${this.name}] schema handler active`);
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
        // Never reply to other bots.
        if ((msg as any).sender?.bot) return;
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

        // Deduplicate: skip if catchUpUnread already processed this message.
        const msgKey = `${this.id}:${chatId}:${msg.id}`;
        if (processedMsgIds.has(msgKey)) return;
        processedMsgIds.add(msgKey);

        // Track incoming message time for inactivity follow-up; reset follow-up cooldown.
        lastIncomingAt.set(chatKey, Date.now());
        followUpSentAt.delete(chatKey);
        this.trackMessage("in", text, chatId);
        this.saveContactInfo(chatId, {
          firstName: (msg as any).sender?.firstName,
          lastName: (msg as any).sender?.lastName,
          username: (msg as any).sender?.username,
        });
        this.detectFollowupRequest(chatId, chatKey, text);

        // Serialize per-chat to prevent concurrent AI calls for rapid bursts.
        const lockKey = `${this.id}:${chatId}`;
        withChatLock(lockKey, async () => {
          const agentSettings = this.getAgentSettings();
          if (agentSettings.useSchema && agentSettings.activeDiagramId) {
            try {
              const scriptReply = await this.runScriptStep(chatId, text, chatKey);
              if (scriptReply) {
                await this.sendAsChunks(chatId, scriptReply, msg.id, msgPeer);
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

          // Fetch the partner's writing style from real Telegram history for new chats.
          const storedHistory = this.storage.loadConversationHistory(chatKey);
          const styleContext = storedHistory.length < 4 ? await this.fetchStyleContext(chatId) : "";
          // Use custom system prompt if provided, otherwise build from workspace files.
          const systemPrompt =
            (taskSession.systemPrompt ??
              (await this.buildRichSystemPrompt(taskSession.task, chatKey, styleContext))) +
            MULTI_MSG_INSTRUCTION;
          const workspaceTools = createWorkspaceTools(this.storage.getAgentWorkspaceDir(this.id));
          try {
            const reply = await aiReply(text, chatKey, systemPrompt, this.storage, workspaceTools);
            if (reply) {
              await this.sendAsChunks(chatId, reply, msg.id, msgPeer);
              this.trackMessage("out", reply, chatId);
            }
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            this.logger.warn(`[TG:${this.name}] task session reply failed: ${errMsg}`);
          }
        });
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
        // Never reply to other bots.
        if ((msg as any).sender?.bot) return;
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

        // Capture the resolved InputPeer before any async gap (needed for offline reply too).
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

        // Outside schedule: AI continues lead-processing in offline mode,
        // OR silent mode but this chat replied to a re-engagement message.
        if (!this.isWithinSchedule(agentSettings)) {
          const shouldReply2 =
            this.isOfflineLeadMode(agentSettings) ||
            this.isReEngagementReply(chatId, agentSettings);

          if (shouldReply2) {
            const msgKey2 = `${this.id}:${chatId}:${msg.id}`;
            if (processedMsgIds.has(msgKey2)) return;
            processedMsgIds.add(msgKey2);
            const lockKey2 = `${this.id}:${chatId}`;
            withChatLock(lockKey2, async () => {
              try {
                const diagram = agentSettings.activeDiagramId
                  ? (this.storage.getDiagramById(agentSettings.activeDiagramId) ?? undefined)
                  : undefined;
                const reply = await this.runOfflineLeadMode(
                  chatId,
                  text,
                  key,
                  agentSettings,
                  diagram,
                );
                if (reply) {
                  await this.sendAsChunks(chatId, reply, msg.id, msgPeer);
                  cooldowns.set(key, Date.now());
                  this.trackMessage("out", reply, chatId);
                }
              } catch (e) {
                this.logger.warn(
                  `[TG:${this.name}] offline-lead/re-engagement (auto_reply) failed: ${String(e)}`,
                );
              }
            });
          }
          // All other contacts: stay silent.
          return;
        }

        // replyTo: "tasks" — only engage with chats that have an active task session.
        if (!this.isAllowedChat(chatId, agentSettings)) return;

        // Deduplicate: skip if already processed by another handler or catchUpUnread.
        const msgKey = `${this.id}:${chatId}:${msg.id}`;
        if (processedMsgIds.has(msgKey)) return;
        processedMsgIds.add(msgKey);

        // Track incoming message for inactivity follow-up; reset follow-up cooldown.
        lastIncomingAt.set(key, Date.now());
        followUpSentAt.delete(key);

        // Schema mode is handled by the dedicated setupSchemaHandler — skip here
        // to avoid double-processing the same message.
        if (agentSettings.useSchema && agentSettings.activeDiagramId) return;

        if (!this.shouldAutoReply(cfg, text, chatId)) return;

        this.trackMessage("in", text, chatId);

        // Serialize per-chat to prevent concurrent AI calls for rapid bursts.
        const lockKey = `${this.id}:${chatId}`;
        withChatLock(lockKey, async () => {
          let reply = "";
          if (cfg.replyMode === "ai") {
            const storedHistory = this.storage.loadConversationHistory(key);
            const styleContext =
              storedHistory.length < 4 ? await this.fetchStyleContext(chatId) : "";
            const systemPrompt =
              (cfg.aiSystemPrompt ??
                (await this.buildRichSystemPrompt(cfg.goal, key, styleContext))) +
              MULTI_MSG_INSTRUCTION;
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
            await this.sendAsChunks(chatId, reply, msg.id, msgPeer);
            cooldowns.set(key, Date.now());
            this.trackMessage("out", reply, chatId);
          }
        });
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

  /**
   * Split `text` into natural chunks and send each with a 3–7 s human-like
   * delay. Only the first chunk uses replyToMsgId / resolvedPeer — subsequent
   * parts are independent messages so they don't create a thread inside the
   * first one (Telegram UI stacks them naturally as a conversation).
   */
  private async sendAsChunks(
    chatId: string,
    text: string,
    replyToMsgId?: number,
    resolvedPeer?: EntityLike,
  ): Promise<void> {
    const parts = splitMessage(text);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        // Human-like delay: scales with the length of the previous part
        // (longer message → longer "typing" time), plus random jitter.
        const prevLen = parts[i - 1].length;
        // ~50 ms per character to simulate typing, capped at 5 s base + 2 s jitter.
        const typingBase = Math.min(prevLen * 50, 5000);
        const delayMs = typingBase + 1000 + Math.random() * 2000;
        await this.delay(delayMs);
      }
      await this.sendWithFloodGuard(
        chatId,
        parts[i],
        i === 0 ? replyToMsgId : undefined,
        i === 0 ? resolvedPeer : undefined,
      );
    }
  }

  /**
   * Cron-based inactivity follow-up: fires every minute and sends a
   * context-aware re-engagement message to chats that have been silent for
   * more than FOLLOWUP_TIMEOUT_MS (default 10 min).
   *
   * Follows the active schema script step when schema mode is enabled, so the
   * follow-up stays on-track with the current conversation stage.
   * Only one follow-up per chat per FOLLOWUP_COOLDOWN_MS (default 1 h).
   */
  private setupInactivityFollowup(): void {
    if (!this.client) return;

    const FOLLOWUP_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes of silence
    const FOLLOWUP_COOLDOWN_MS = 60 * 60 * 1000; // 1 h cooldown between follow-ups

    const check = async () => {
      if (this.record.status !== "running" || !this.client) return;
      const now = Date.now();

      // Collect candidate chatIds: active task sessions + schema-tracked chats.
      const chatIds = new Set<string>();
      for (const s of this.listTaskSessions()) {
        if (s.status === "active") chatIds.add(s.chatId);
      }

      for (const chatId of chatIds) {
        const chatKey = `${this.id}:${chatId}`;
        const last = lastIncomingAt.get(chatKey);
        if (!last) continue; // never received a message — skip
        if (now - last < FOLLOWUP_TIMEOUT_MS) continue; // not inactive enough
        const lastFU = followUpSentAt.get(chatKey) ?? 0;
        if (now - lastFU < FOLLOWUP_COOLDOWN_MS) continue; // cooldown active

        try {
          const agentSettings = this.getAgentSettings();
          let followUpText: string | null = null;

          if (agentSettings.useSchema && agentSettings.activeDiagramId) {
            // Schema mode: generate follow-up that fits the current script step.
            followUpText = await this.runScriptStep(chatId, "__FOLLOWUP__", chatKey);
          } else {
            // Free-form: build a contextual re-engagement prompt.
            const taskSession = this.getTaskSession(chatId);
            const basePrompt = taskSession
              ? await this.buildRichSystemPrompt(taskSession.task, chatKey)
              : await this.buildRichSystemPrompt(undefined, chatKey);
            const followUpPrompt =
              basePrompt +
              `\n\n## Ситуация\nСобеседник не отвечает уже ${Math.round((now - last) / 60000)} мин. ` +
              `Напиши ОДНО короткое, ненавязчивое follow-up сообщение, чтобы мягко продолжить диалог. ` +
              `Не упоминай, что прошло время. Продолжай как будто разговор продолжается естественно.`;
            followUpText = await aiReply(
              "__FOLLOWUP__",
              chatKey,
              followUpPrompt,
              this.storage,
              undefined,
            );
          }

          if (followUpText) {
            // Send as chunks with natural delays (same as regular replies).
            await this.sendAsChunks(chatId, followUpText);
            followUpSentAt.set(chatKey, Date.now());
            this.trackMessage("out", followUpText, chatId);
            this.logger.info(
              `[TG:${this.name}] follow-up sent to ${chatId} after ${Math.round((now - last) / 60000)} min`,
            );
          }
        } catch (e) {
          this.logger.warn(`[TG:${this.name}] follow-up failed for ${chatId}: ${String(e)}`);
        }
      }
    };

    // Check every minute.
    this.cronJobs.set(
      "inactivity_followup",
      cron.schedule("* * * * *", () => void check()),
    );
    this.logger.info(`[TG:${this.name}] inactivity follow-up watcher active`);
  }

  private clearCron() {
    for (const j of this.cronJobs.values()) j.stop();
    this.cronJobs.clear();
  }
}
