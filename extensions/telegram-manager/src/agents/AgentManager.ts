// plugins/telegram/src/agents/AgentManager.ts
import { randomUUID } from "crypto";
import {
  analyzeOnce,
  analyzeOnceDirect,
  isDirectAdapterAvailable,
} from "../behaviors/AiReplyEngine";
import { TelegramStorage } from "../storage/TelegramStorage";
import {
  AgentRecord,
  AgentMission,
  AgentCommunicationMessage,
  BehaviorConfig,
  TelegramEvent,
  ILogger,
  IAgentManager,
  AgentCredentials,
  TaskSession,
} from "../types";
import { AgentCommunicationBus } from "./AgentCommunicationBus";
import { BaseAgent } from "./BaseAgent";
import { BotAgent } from "./BotAgent";
import { UserBotAgent } from "./UserBotAgent";

export class AgentManager {
  private pool = new Map<string, BaseAgent>();
  private eventListeners: ((e: TelegramEvent) => void)[] = [];
  private commBus!: AgentCommunicationBus;

  constructor(
    private storage: TelegramStorage,
    private logger: ILogger,
  ) {}

  async init(): Promise<void> {
    // Initialize communication bus with callbacks into this manager
    this.commBus = new AgentCommunicationBus(
      this.storage,
      (agentId: string, tool: string, args: Record<string, unknown>) =>
        this.callTool(agentId, tool, args),
      (agentId: string) => {
        const record = this.pool.get(agentId)?.getRecord();
        return record?.name ?? agentId;
      },
      this.logger,
    );
    // Forward comm bus events to all listeners
    this.commBus.onEvent((e: TelegramEvent) => {
      this.eventListeners.forEach((fn) => fn(e));
    });

    const records = this.storage.getAllAgents();
    this.logger.info(`[TG] Loading ${records.length} agents on gateway boot`);
    for (const r of records) {
      const agent = this.spawn(r);
      this.pool.set(r.id, agent);
      // Respect per-agent autoStartEnabled setting (defaults to true when absent).
      const settings = this.storage.getAgentSettings(r.id);
      const shouldAutoStart = settings.autoStartEnabled !== false;
      if (shouldAutoStart) {
        agent
          .start()
          .catch((e) => this.logger.error(`[TG] Auto-start failed: ${r.name}`, { e: String(e) }));
      } else {
        this.logger.info(`[TG] Auto-start skipped for ${r.name} (autoStartEnabled=false)`);
      }
    }
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  create(
    name: string,
    credentials: AgentCredentials,
    behaviors: BehaviorConfig[] = [],
  ): AgentRecord {
    const now = new Date().toISOString();
    const record: AgentRecord = {
      id: randomUUID(),
      name,
      type: credentials.type,
      status: "stopped",
      credentials,
      behaviors,
      createdAt: now,
      updatedAt: now,
      stats: { sent: 0, received: 0, parsed: 0 },
    };
    this.storage.saveAgent(record);
    const agent = this.spawn(record);
    this.pool.set(record.id, agent);
    this.logger.info(`[TG] Created agent: ${name} (${credentials.type})`);
    return record;
  }

  get(id: string): AgentRecord | null {
    return this.pool.get(id)?.getRecord() ?? this.storage.getAgent(id);
  }

  list(): AgentRecord[] {
    return [...this.pool.values()].map((a) => a.getRecord());
  }

  async delete(id: string): Promise<void> {
    await this.pool.get(id)?.stop();
    this.pool.delete(id);
    this.storage.deleteAgent(id);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async start(id: string) {
    await this.get_or_throw(id).start();
  }
  async stop(id: string) {
    await this.get_or_throw(id).stop();
  }
  async restart(id: string) {
    await this.stop(id);
    await this.delay(800);
    await this.start(id);
  }

  // ─── Behaviors ────────────────────────────────────────────────────────────

  async setBehaviors(id: string, behaviors: BehaviorConfig[]): Promise<void> {
    await this.get_or_throw(id).updateBehaviors(behaviors);
  }

  // ─── Auth (userbots) ──────────────────────────────────────────────────────

  async authStart(id: string): Promise<void> {
    const agent = this.get_or_throw(id);
    if (!(agent instanceof UserBotAgent)) throw new Error("Only userbot agents support auth");
    await agent.authStart();
  }

  async authSubmit(id: string, code: string, password?: string): Promise<void> {
    const agent = this.get_or_throw(id);
    if (!(agent instanceof UserBotAgent)) throw new Error("Only userbot agents support auth");
    // Auth itself: throws on bad code / 2FA required / network error during sign-in.
    await agent.authSubmit(code, password);
    // Best-effort start: session is already saved, so a connectivity failure here
    // must not be reported back as an auth failure. The user can start the agent
    // manually once the network is reachable.
    agent.start().catch((e) =>
      this.logger.warn(`[TG:${id}] auto-start after auth failed (will need manual start)`, {
        e: String(e),
      }),
    );
  }

  // ─── Tools ────────────────────────────────────────────────────────────────

  async callTool(id: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    // analyze_dialog / analyze_dialogs_batch are handled at manager level —
    // they only need AI, not an agent-specific Telegram connection.
    if (tool === "analyze_dialog") {
      return this.runAnalyzeDialog(args);
    }
    if (tool === "analyze_dialogs_batch") {
      return this.runAnalyzeDialogsBatch(args);
    }
    if (tool === "analyze_mega_batch") {
      return this.runAnalyzeMegaBatch(args);
    }
    if (tool === "check_batch_capability") {
      // Report whether direct (non-gateway) AI adapter is available.
      // Client uses this to decide batch size: large batches only help when
      // inner AI calls bypass the gateway lane.
      return { directAdapter: isDirectAdapterAvailable() };
    }
    return this.get_or_throw(id).callTool(tool, args);
  }

  /**
   * Parse the raw AI text response into a structured result.
   * Extracts the first JSON object, normalises status and score.
   */
  private parseDialogResult(text: string): {
    status: "success" | "fail" | "neutral";
    score: number;
    reason: string;
  } | null {
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const rawStatus = parsed["status"];
      const status = (
        ["success", "fail", "neutral"].includes(rawStatus as string) ? rawStatus : "neutral"
      ) as "success" | "fail" | "neutral";
      const rawScore = parsed["score"];
      const score = typeof rawScore === "number" ? Math.max(0, Math.min(100, rawScore)) : 50;
      const reason = typeof parsed["reason"] === "string" ? (parsed["reason"] as string) : "";
      return { status, score, reason };
    } catch {
      return null;
    }
  }

  /**
   * Analyze a single dialog text via the configured AI adapter.
   * Expects args: { dialog: string; prompt?: string }
   * Returns: { status; score; reason }
   */
  private async runAnalyzeDialog(args: Record<string, unknown>): Promise<{
    status: "success" | "fail" | "neutral";
    score: number;
    reason: string;
  }> {
    const { dialog, prompt } = args as { dialog?: string; prompt?: string };
    if (!dialog?.trim()) {
      return { status: "neutral", score: 0, reason: "Empty dialog" };
    }
    const fullPrompt = prompt ? `${prompt}\n${dialog}` : dialog;
    const text = await analyzeOnce(fullPrompt);
    const result = this.parseDialogResult(text);
    if (result) return result;
    this.logger.warn("[TG] analyze_dialog: unexpected AI response", {
      snippet: text.slice(0, 120),
    });
    throw new Error(`analyze_dialog: failed to parse AI response: ${text.slice(0, 120)}`);
  }

  /**
   * Analyze a BATCH of dialogs in one WebSocket round-trip.
   * All AI calls run in parallel server-side — only one lane slot consumed.
   *
   * Expects args: {
   *   dialogs: Array<{ chatId: string; dialog: string }>;
   *   prompt?: string;
   * }
   * Returns: {
   *   results: Array<{ chatId; status; score; reason } | null>
   * }
   */
  private async runAnalyzeDialogsBatch(args: Record<string, unknown>): Promise<{
    results: Array<{
      chatId: string;
      status: "success" | "fail" | "neutral";
      score: number;
      reason: string;
    } | null>;
  }> {
    const { dialogs, prompt } = args as {
      dialogs: Array<{ chatId: string; dialog: string }>;
      prompt?: string;
    };

    if (!Array.isArray(dialogs) || dialogs.length === 0) {
      return { results: [] };
    }

    // Use analyzeOnceDirect() which bypasses the gateway lane when env-var API
    // keys (ANTHROPIC_API_KEY / OPENAI_API_KEY) are available. This allows all
    // dialogs in the batch to run truly in parallel without lane congestion.
    // Falls back to the gateway adapter (lane-limited) when no direct key exists.
    const settled = await Promise.allSettled(
      dialogs.map(async ({ chatId, dialog }) => {
        if (!dialog?.trim()) {
          return { chatId, status: "neutral" as const, score: 0, reason: "Empty dialog" };
        }
        const fullPrompt = prompt ? `${prompt}\n${dialog}` : dialog;
        const text = await analyzeOnceDirect(fullPrompt);
        const parsed = this.parseDialogResult(text);
        if (!parsed) return null;
        return { chatId, ...parsed };
      }),
    );

    return {
      results: settled.map((r) => (r.status === "fulfilled" ? r.value : null)),
    };
  }

  /**
   * Analyze a MEGA-BATCH of dialogs in a SINGLE AI call.
   * All N dialogs are packed into one prompt; AI returns a JSON array.
   * One gateway lane slot for N dialogs → up to N× faster than single-dialog mode.
   *
   * Expects args: { dialogs: Array<{ chatId: string; dialog: string }>; prompt?: string }
   * Returns: { results: Array<{ chatId; status; score; reason } | null> }
   */
  private async runAnalyzeMegaBatch(args: Record<string, unknown>): Promise<{
    results: Array<{
      chatId: string;
      status: "success" | "fail" | "neutral";
      score: number;
      reason: string;
    } | null>;
  }> {
    const { dialogs, prompt } = args as {
      dialogs: Array<{ chatId: string; dialog: string }>;
      prompt?: string;
    };
    if (!Array.isArray(dialogs) || dialogs.length === 0) {
      return { results: [] };
    }

    // Build one prompt with all dialogs clearly separated.
    // Strip the single-dialog format line ("Ответ верни строго в JSON: {...}") from
    // the criteria prompt — it conflicts with our array instruction below and causes
    // models to return a single JSON object instead of an array (all results → null).
    const criteriaOnly = (prompt ?? "").replace(/\nОтвет верни строго в JSON[\s\S]*/i, "").trim();

    const dialogsText = dialogs
      .map((d, i) => `=== Диалог ${i + 1} (chatId: ${d.chatId}) ===\n${d.dialog}`)
      .join("\n\n");

    const megaPrompt = `${criteriaOnly}

Проанализируй каждый из ${dialogs.length} диалогов ниже и верни ТОЛЬКО JSON-массив (без лишнего текста):
[{"chatId":"...","status":"success"|"fail"|"neutral","score":0-100,"reason":"кратко"},...]

${dialogsText}

Верни строго JSON-массив из ${dialogs.length} объектов, по одному на каждый диалог.`;

    const text = await analyzeOnce(megaPrompt);

    // Parse the JSON array from AI response
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const arr = JSON.parse(match[0]) as Array<Record<string, unknown>>;
        return {
          results: dialogs.map((d, i) => {
            // Try chatId lookup first, fall back to positional index
            const item = arr.find((r) => r["chatId"] === d.chatId) ?? arr[i];
            if (!item) return null;
            const rawStatus = item["status"];
            const status = (
              ["success", "fail", "neutral"].includes(rawStatus as string) ? rawStatus : "neutral"
            ) as "success" | "fail" | "neutral";
            const rawScore = item["score"];
            const score = typeof rawScore === "number" ? Math.max(0, Math.min(100, rawScore)) : 50;
            const reason = typeof item["reason"] === "string" ? (item["reason"] as string) : "";
            return { chatId: d.chatId, status, score, reason };
          }),
        };
      }
    } catch {
      // Fall through → return nulls, client marks as unanalyzed
    }

    this.logger.warn("[TG] analyze_mega_batch: failed to parse AI array response", {
      snippet: text.slice(0, 200),
    });
    return { results: dialogs.map(() => null) };
  }

  // ─── Task sessions ────────────────────────────────────────────────────────

  /** Assign (or update) a task session on an agent. Does not cause reconnect. */
  async assignTaskSession(id: string, session: TaskSession): Promise<void> {
    this.get_or_throw(id).upsertTaskSession(session);
  }

  listTaskSessions(id: string): TaskSession[] {
    return this.get_or_throw(id).listTaskSessions();
  }

  async completeTaskSession(id: string, sessionId: string): Promise<void> {
    this.get_or_throw(id).completeTaskSession(sessionId);
  }

  // ─── Events & data ────────────────────────────────────────────────────────

  onEvent(fn: (e: TelegramEvent) => void) {
    this.eventListeners.push(fn);
  }
  getEvents(agentId?: string, limit?: number) {
    return this.storage.getEvents(agentId, limit);
  }
  getParsed(agentId: string, limit?: number) {
    return this.storage.getParsed(agentId, limit);
  }

  // ─── Missions & inter-agent communication ─────────────────────────────────

  createMission(
    masterAgentId: string,
    title: string,
    goal: string,
    participantIds: string[],
    systemPrompt?: string,
  ): AgentMission {
    return this.commBus.createMission(masterAgentId, title, goal, participantIds, systemPrompt);
  }

  completeMission(missionId: string): void {
    this.commBus.completeMission(missionId);
  }

  async sendAgentMessage(
    fromAgentId: string,
    toAgentId: string,
    missionId: string,
    content: string,
  ): Promise<AgentCommunicationMessage> {
    return this.commBus.sendAgentMessage(fromAgentId, toAgentId, missionId, content);
  }

  getMissionMessages(missionId: string, limit?: number): AgentCommunicationMessage[] {
    return this.commBus.getMissionMessages(missionId, limit);
  }

  getMissions(): AgentMission[] {
    return this.commBus.getMissions();
  }

  getMission(id: string): AgentMission | null {
    return this.commBus.getMission(id);
  }

  // ─── Shutdown ─────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    // Use gracefulShutdown (not stop) so agents that were "running" keep their
    // DB status intact. AgentManager.init() auto-restarts agents with
    // status="running" on the next gateway start — this makes auto-restart work
    // correctly after a normal server shutdown/restart.
    // User-initiated stops (via telegram.agent.stop handler) call agent.stop()
    // directly, which does write "stopped" to the DB as expected.
    await Promise.allSettled([...this.pool.values()].map((a) => a.gracefulShutdown()));
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private spawn(record: AgentRecord): BaseAgent {
    // Full manager ref — passed to both userbots and bots so they can use
    // master_control behavior (agentic loop with full agent management tools).
    const managerRef: IAgentManager = {
      list: () => this.list(),
      get: (id: string) => this.get(id),
      start: (id: string) => this.start(id),
      stop: (id: string) => this.stop(id),
      restart: (id: string) => this.restart(id),
      callTool: (id: string, tool: string, args: Record<string, unknown>) =>
        this.callTool(id, tool, args),
      getEvents: (agentId?: string, limit?: number) => this.getEvents(agentId, limit) as unknown[],
      assignTaskSession: (id: string, session: TaskSession) => this.assignTaskSession(id, session),
      listTaskSessions: (id: string) => this.listTaskSessions(id),
      completeTaskSession: (id: string, sessionId: string) =>
        this.completeTaskSession(id, sessionId),
      setBehaviors: (id: string, behaviors: BehaviorConfig[]) => this.setBehaviors(id, behaviors),
    };

    const agent =
      record.type === "userbot"
        ? new UserBotAgent(record, this.storage, this.logger, managerRef)
        : new BotAgent(record, this.storage, this.logger, managerRef);

    agent.on("event", (e: TelegramEvent) => {
      this.eventListeners.forEach((fn) => fn(e));
    });
    return agent;
  }

  private get_or_throw(id: string): BaseAgent {
    const a = this.pool.get(id);
    if (!a) throw new Error(`Agent not found: ${id}`);
    return a;
  }

  private delay(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
