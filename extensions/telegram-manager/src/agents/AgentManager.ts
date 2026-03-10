// plugins/telegram/src/agents/AgentManager.ts
import { randomUUID } from "crypto";
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
    this.logger.info(`[TG] Loading ${records.length} agents`);
    for (const r of records) {
      const agent = this.spawn(r);
      this.pool.set(r.id, agent);
      if (r.status === "running") {
        agent
          .start()
          .catch((e) => this.logger.error(`[TG] Auto-start failed: ${r.name}`, { e: String(e) }));
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
    return this.get_or_throw(id).callTool(tool, args);
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
    await Promise.allSettled([...this.pool.values()].map((a) => a.stop()));
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
