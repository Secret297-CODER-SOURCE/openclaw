// plugins/telegram/src/agents/AgentManager.ts
import { randomUUID } from "crypto";
import { TelegramStorage } from "../storage/TelegramStorage";
import { AgentRecord, BehaviorConfig, TelegramEvent, ILogger, AgentCredentials } from "../types";
import { BaseAgent } from "./BaseAgent";
import { BotAgent } from "./BotAgent";
import { UserBotAgent } from "./UserBotAgent";

export class AgentManager {
  private pool = new Map<string, BaseAgent>();
  private eventListeners: ((e: TelegramEvent) => void)[] = [];

  constructor(
    private storage: TelegramStorage,
    private logger: ILogger,
  ) {}

  async init(): Promise<void> {
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
    await agent.authSubmit(code, password);
    await agent.start();
  }

  // ─── Tools ────────────────────────────────────────────────────────────────

  async callTool(id: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    return this.get_or_throw(id).callTool(tool, args);
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

  // ─── Shutdown ─────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.pool.values()].map((a) => a.stop()));
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private spawn(record: AgentRecord): BaseAgent {
    const agent =
      record.type === "userbot"
        ? new UserBotAgent(record, this.storage, this.logger)
        : new BotAgent(record, this.storage, this.logger);

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
