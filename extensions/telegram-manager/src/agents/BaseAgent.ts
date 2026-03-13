import EventEmitter from "events";
// plugins/telegram/src/agents/BaseAgent.ts
import fs from "fs";
import path from "path";
import { TelegramStorage } from "../storage/TelegramStorage";
import {
  AgentRecord,
  BehaviorConfig,
  TelegramEvent,
  AgentStatus,
  AutoReplyBehavior,
  TaskSession,
  TaskSessionBehavior,
  CommunicationBehavior,
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

  /**
   * Add a mission ID to this agent's CommunicationBehavior.activeMissionIds,
   * creating the behavior entry if it does not yet exist.
   * Does NOT call onBehaviorsChanged so running connections are not disrupted.
   */
  addMissionToCommunicationBehavior(missionId: string): void {
    const b = this.getBehavior<CommunicationBehavior>("communication");
    if (b) {
      if (b.activeMissionIds.includes(missionId)) return;
      b.activeMissionIds.push(missionId);
    } else {
      this.record.behaviors = [
        ...this.record.behaviors,
        { type: "communication", enabled: true, activeMissionIds: [missionId] } satisfies CommunicationBehavior,
      ];
    }
    this.storage.updateBehaviors(this.id, this.record.behaviors);
  }

  /**
   * Remove a mission ID from this agent's CommunicationBehavior.activeMissionIds.
   * Does NOT call onBehaviorsChanged so running connections are not disrupted.
   */
  removeMissionFromCommunicationBehavior(missionId: string): void {
    const b = this.getBehavior<CommunicationBehavior>("communication");
    if (!b) return;
    const idx = b.activeMissionIds.indexOf(missionId);
    if (idx < 0) return;
    b.activeMissionIds.splice(idx, 1);
    this.storage.updateBehaviors(this.id, this.record.behaviors);
  }

  /**
   * Build a rich system prompt for this agent by loading its workspace files
   * (SOUL.md, AGENTS.md, IDENTITY.md, USER.md, MEMORY.md). Falls back to a
   * minimal default when no workspace files exist.
   *
   * @param task  Optional task description appended as a "## Task" section.
   */
  /**
   * Ensure default workspace files exist for this agent.
   * Called on agent start so the agent has a personality from the first message
   * even before the operator manually edits the files through the UI.
   * Existing files are never overwritten.
   */
  async ensureWorkspaceFiles(): Promise<void> {
    const workspaceDir = this.storage.getAgentWorkspaceDir(this.id);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const defaults: Record<string, string> = {
      "IDENTITY.md": `# Identity\n\nName: ${this.name}\n\nDescribe who ${this.name} is here — their personality, background, and role.`,
      "SOUL.md": `# Persona\n\nDescribe ${this.name}'s personality, values, and communication style here.`,
      "AGENTS.md": `# Instructions\n\n- Speak naturally and conversationally, as a real person would.\n- Remember what the user has told you earlier in the conversation and refer back to it.\n- Ask clarifying questions when something is unclear.\n- Keep responses concise unless the user needs a detailed explanation.\n- Never say you are an AI or a bot unless directly asked.\n- Adapt your tone to match the user — casual with casual people, more structured with technical ones.`,
      "USER.md": `# User Notes\n\n(Update this file with what you learn about the people you regularly talk with — their preferences, context, and ongoing topics.)`,
      "MEMORY.md": `# Memory\n\n(Use this file to store important facts, recurring topics, and key context that you want to remember across sessions.)`,
      // Placeholder files kept empty so they don't show as MISSING in the Files UI.
      // They are not read by buildRichSystemPrompt but are listed in TelegramPlugin.CORE_FILE_NAMES.
      "TOOLS.md": `# Tools\n\n(List any tool instructions here if needed.)`,
      "HEARTBEAT.md": `# Heartbeat\n\n(Use this file for periodic reminders or scheduled behavior instructions.)`,
      "BOOTSTRAP.md": `# Bootstrap\n\n(One-time initialization notes go here.)`,
    };

    for (const [filename, content] of Object.entries(defaults)) {
      const filePath = path.join(workspaceDir, filename);
      try {
        await fs.promises.access(filePath);
        // File already exists — do not overwrite operator's edits.
      } catch {
        await fs.promises.writeFile(filePath, content, "utf-8");
        this.logger.info(`[TG:${this.name}] created default workspace file: ${filename}`);
      }
    }
  }

  /**
   * Build a rich system prompt for this agent by loading its workspace files
   * (SOUL.md, AGENTS.md, IDENTITY.md, USER.md, MEMORY.md). Falls back to a
   * minimal default when no workspace files exist.
   *
   * @param task         Optional task description appended as a "## Task" section.
   * @param chatKey      Optional per-user chat key; when provided, injects the
   *                     last N turns of that user's conversation history so the
   *                     agent can reference prior exchanges in its replies.
   * @param extraContext Optional extra section to append (e.g. writing-style
   *                     examples fetched from real Telegram message history).
   */
  protected async buildRichSystemPrompt(
    task?: string,
    chatKey?: string,
    extraContext?: string,
  ): Promise<string> {
    const workspaceDir = this.storage.getAgentWorkspaceDir(this.id);
    const sections: string[] = [];

    const identity = await this.readWorkspaceFile(workspaceDir, "IDENTITY.md");
    if (identity) sections.push(`## Identity\n${identity}`);

    const soul = await this.readWorkspaceFile(workspaceDir, "SOUL.md");
    if (soul) sections.push(`## Persona\n${soul}`);

    const agents = await this.readWorkspaceFile(workspaceDir, "AGENTS.md");
    if (agents) sections.push(`## Instructions\n${agents}`);

    const user = await this.readWorkspaceFile(workspaceDir, "USER.md");
    if (user) sections.push(`## User\n${user}`);

    const memory = await this.readWorkspaceFile(workspaceDir, "MEMORY.md");
    if (memory) sections.push(`## Memory\n${memory}`);

    // Inject a brief summary of the most recent exchanges with this user so the
    // agent can reference them naturally (e.g. "as I mentioned earlier…").
    // We include only the last 6 turns to keep the prompt compact.
    if (chatKey) {
      const history = this.storage.loadConversationHistory(chatKey);
      if (history.length > 0) {
        const recent = history.slice(-6);
        const lines = recent.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.content}`);
        sections.push(`## Recent conversation with this user\n${lines.join("\n")}`);
      }
    }

    // Inject extra context supplied by the caller (e.g. partner's writing style).
    if (extraContext) {
      sections.push(extraContext);
    }

    if (task) {
      sections.push(
        `## Task\n${task}\n\n` +
          `Conduct a helpful, focused conversation to complete this task. ` +
          `Once the task is complete, clearly inform the user.`,
      );
    }

    if (sections.length === 0) {
      // No workspace files configured — use sensible fallbacks.
      return task
        ? `You are a Telegram assistant. You have been assigned the following task:\n\n${task}\n\n` +
            `Conduct a helpful, focused conversation to complete this task. ` +
            `Once the task is complete, clearly inform the user.`
        : "You are a helpful Telegram assistant. Be concise and friendly.";
    }

    return `You are a Telegram agent.\n\n${sections.join("\n\n")}`;
  }

  /** Read a file from the agent workspace directory, returning "" when absent. */
  private async readWorkspaceFile(workspaceDir: string, name: string): Promise<string> {
    try {
      const content = await fs.promises.readFile(path.join(workspaceDir, name), "utf-8");
      return content.trim();
    } catch (err: unknown) {
      // Silently skip missing files; log anything unexpected.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn(`[TG:${this.name}] could not read workspace file ${name}`, {
          e: err instanceof Error ? err.message : String(err),
        });
      }
      return "";
    }
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
