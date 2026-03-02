// plugins/telegram/src/agents/BaseAgent.ts
import EventEmitter from "events";
import { TelegramStorage } from "../storage/TelegramStorage";
import {
  AgentRecord,
  BehaviorConfig,
  TelegramEvent,
  AgentStatus,
  AutoReplyBehavior,
  ILogger,
} from "../types";

export abstract class BaseAgent extends EventEmitter {
  readonly id: string;
  readonly name: string;
  protected record: AgentRecord;
  protected storage: TelegramStorage;
  protected logger: ILogger;
  protected cronJobs: Map<string, any> = new Map();

  constructor(record: AgentRecord, storage: TelegramStorage, logger: ILogger) {
    super();
    this.id = record.id;
    this.name = record.name;
    this.record = { ...record };
    this.storage = storage;
    this.logger = logger;
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
