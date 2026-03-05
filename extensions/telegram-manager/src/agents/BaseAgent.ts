// plugins/telegram/src/agents/BaseAgent.ts
import EventEmitter from "events";
import { TelegramStorage } from "../storage/TelegramStorage";
import {
  AgentRecord,
  BehaviorConfig,
  TelegramEvent,
  AgentStatus,
  AutoReplyBehavior,
  TaskSession,
  TaskSessionBehavior,
  ILogger,
} from "../types";

export abstract class BaseAgent extends EventEmitter {
  readonly id: string;
  readonly name: string;
  protected record: AgentRecord;
  protected storage: TelegramStorage;
  protected logger: ILogger;
  // cronJobs is declared here only for TypeScript — the actual value is set as
  // non-enumerable in the constructor so that structuredClone (called by the
  // pi-agent framework in emitContext) never traverses into cron.ScheduledTask
  // objects, which contain internal timers/Promises that cannot be cloned.
  protected cronJobs!: Map<string, any>;

  constructor(record: AgentRecord, storage: TelegramStorage, logger: ILogger) {
    super();
    this.id = record.id;
    this.name = record.name;
    this.record = { ...record };
    this.storage = storage;
    this.logger = logger;
    // IMPORTANT: define cronJobs as non-enumerable so structuredClone skips it.
    // cron.ScheduledTask holds internal Node.js timers that are not cloneable.
    // A plain `this.cronJobs = new Map()` would create an enumerable own property
    // that structuredClone traverses, causing DataCloneError when the pi-agent
    // framework calls emitContext during delayed/scheduled operations.
    Object.defineProperty(this, "cronJobs", {
      value: new Map<string, any>(),
      writable: true,
      configurable: true,
      enumerable: false, // non-enumerable → skipped by structuredClone
    });
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  /** Call a named tool imperatively (e.g. from WS tool.call) */
  abstract callTool(tool: string, args: Record<string, unknown>): Promise<unknown>;

  getRecord(): AgentRecord {
    return { ...this.record };
  }
  getStatus(): AgentStatus {
    return this.record.status;
  }

  protected setStatus(status: AgentStatus, error?: string) {
    this.record.status = status;
    this.storage.updateStatus(this.id, status, error);
    this.pushEvent("status_change", { status, error });
    this.logger.info(`[TG:${this.name}] → ${status}`, { error });
  }

  async updateBehaviors(behaviors: BehaviorConfig[]): Promise<void> {
    this.record.behaviors = behaviors;
    this.storage.updateBehaviors(this.id, behaviors);
    await this.onBehaviorsChanged(behaviors);
    this.logger.info(`[TG:${this.name}] behaviors updated`, { count: behaviors.length });
  }

  protected abstract onBehaviorsChanged(b: BehaviorConfig[]): Promise<void>;

  getBehavior<T extends BehaviorConfig>(type: T["type"]): T | undefined {
    return this.record.behaviors.find((b) => b.type === type) as T | undefined;
  }

  // ─── Task session management ───────────────────────────────────────────────

  /** Find an active task session for the given chat, if any. */
  protected getTaskSession(chatId: string): TaskSession | undefined {
    const b = this.getBehavior<TaskSessionBehavior>("task_session");
    return b?.sessions.find((s) => s.chatId === chatId && s.status === "active");
  }

  /** Return all task sessions (all statuses). */
  listTaskSessions(): TaskSession[] {
    const b = this.getBehavior<TaskSessionBehavior>("task_session");
    return b?.sessions ?? [];
  }

  /**
   * Insert or update a task session directly in the behaviors array and
   * persist to storage — intentionally does NOT call onBehaviorsChanged so
   * that running bot/userbot connections are not disrupted.
   */
  upsertTaskSession(session: TaskSession): void {
    const b = this.getBehavior<TaskSessionBehavior>("task_session");
    if (b) {
      const idx = b.sessions.findIndex((s) => s.id === session.id);
      if (idx >= 0) {
        b.sessions[idx] = session;
      } else {
        b.sessions.push(session);
      }
    } else {
      const newBehavior: TaskSessionBehavior = {
        type: "task_session",
        enabled: true,
        sessions: [session],
      };
      this.record.behaviors = [...this.record.behaviors, newBehavior];
    }
    this.storage.updateBehaviors(this.id, this.record.behaviors);
  }

  /** Mark a task session as completed and persist. */
  completeTaskSession(sessionId: string): void {
    const b = this.getBehavior<TaskSessionBehavior>("task_session");
    if (!b) return;
    const session = b.sessions.find((s) => s.id === sessionId);
    if (session) {
      session.status = "completed";
      session.completedAt = new Date().toISOString();
      this.storage.updateBehaviors(this.id, this.record.behaviors);
    }
  }

  /** Build a default system prompt for a task session. */
  protected buildTaskSystemPrompt(task: string): string {
    return (
      `You are a Telegram assistant. You have been assigned the following task:\n\n${task}\n\n` +
      `Conduct a helpful, focused conversation to complete this task. ` +
      `Once the task is complete, clearly inform the user.`
    );
  }

  protected pushEvent(type: TelegramEvent["type"], payload: Record<string, unknown>) {
    const event: TelegramEvent = {
      agentId: this.id,
      agentName: this.name,
      type,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.storage.saveEvent(event);
    this.emit("event", event);
  }

  protected trackMessage(direction: "in" | "out", text: string, chat?: string) {
    this.storage.incrementStat(this.id, direction === "in" ? "received" : "sent");
    this.pushEvent(direction === "in" ? "message_in" : "message_out", {
      text: text.slice(0, 500),
      chat,
    });
  }

  protected shouldAutoReply(cfg: AutoReplyBehavior, text: string, chatId?: string): boolean {
    if (!cfg.enabled) return false;
    if (cfg.onlyInChats?.length && chatId && !cfg.onlyInChats.includes(chatId)) return false;
    if (cfg.triggerKeywords?.length) {
      const low = text.toLowerCase();
      return cfg.triggerKeywords.some((k) => low.includes(k.toLowerCase()));
    }
    return true;
  }

  protected delay(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
