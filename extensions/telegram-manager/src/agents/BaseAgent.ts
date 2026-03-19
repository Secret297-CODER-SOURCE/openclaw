import EventEmitter from "events";
// plugins/telegram/src/agents/BaseAgent.ts
import fs from "fs";
import path from "path";
import { aiReply } from "../behaviors/AiReplyEngine";
import { TelegramStorage } from "../storage/TelegramStorage";
import { createWorkspaceTools } from "../tools/TelegramTools";
import {
  AgentRecord,
  AgentSettings,
  BehaviorConfig,
  DiagramEdge,
  DiagramNode,
  FlowDiagram,
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

  /**
   * Load the persisted agent settings (work mode, schedule, active diagram).
   * Returns defaults when no settings have been saved yet.
   */
  protected getAgentSettings(): AgentSettings {
    return this.storage.getAgentSettings(this.id);
  }

  /**
   * Returns true if the agent is allowed to reply right now according to its
   * work-mode settings.  Always returns true for modes other than "schedule".
   */
  protected isWithinSchedule(settings: AgentSettings): boolean {
    if (settings.workMode !== "schedule") return true;
    const from = settings.scheduleFrom;
    const to = settings.scheduleTo;
    if (!from || !to) return true;

    const now = new Date();
    const hhmm =
      String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");

    // Compare as strings — works for same-day windows (e.g. "09:00" – "18:00").
    // For overnight windows (e.g. "22:00" – "06:00") use OR logic.
    if (from <= to) {
      return hhmm >= from && hhmm <= to;
    } else {
      return hhmm >= from || hhmm <= to;
    }
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

    // Inject diagram flow + knowledge base so the agent strictly follows the
    // sales/conversation script and uses grounded training examples in replies.
    const kbSection = await this.buildKnowledgeBaseSection();
    if (kbSection) sections.push(kbSection);

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

  /**
   * Build a system-prompt section that injects the diagram flow and its
   * knowledge base (training examples per node) into the conversation context.
   *
   * Priority: personal KB first; falls back to shared KB when personal is empty.
   * Returns an empty string when no diagram or knowledge base is configured.
   */
  private async buildKnowledgeBaseSection(): Promise<string> {
    // When the operator has pinned a specific diagram via agent settings, load
    // that diagram directly instead of scanning by scope.
    const agentSettings = this.getAgentSettings();
    if (agentSettings.activeDiagramId) {
      const pinned = this.storage.getDiagramById(agentSettings.activeDiagramId);
      if (pinned && pinned.nodes.length > 0) {
        return this._buildKBFromDiagram(pinned);
      }
    }

    // Try personal scope first, then shared
    for (const scope of ["personal", "shared"] as const) {
      const diagram = this.storage.getDiagram(this.id, scope);
      if (!diagram || diagram.nodes.length === 0) continue;
      const section = this._buildKBFromDiagram(diagram);
      if (section) return section;
    }
    return "";
  }

  /**
   * Convert a FlowDiagram + its associated knowledge base into a system-prompt
   * section string. Returns "" when the KB is empty or missing.
   */
  private _buildKBFromDiagram(diagram: FlowDiagram): string {
    const raw = this.storage.getKnowledgeBase(
      diagram.agentId,
      diagram.scope as "personal" | "shared",
    );
    if (!raw) return "";

    const entries = raw.entries as
      | Array<{
          nodeId: string;
          nodeText: string;
          pairs: Array<{ input: string; response: string; score: number; label?: string }>;
        }>
      | undefined;
    if (!entries || entries.length === 0) return "";

    const scoreLabel = (s: number) => (s === 3 ? "★★★" : s === 2 ? "★★" : "★");
    const nodeLines: string[] = [];
    for (const node of diagram.nodes) {
      nodeLines.push(`• [${node.type.toUpperCase()}] ${node.text}`);
    }
    const edgeLines = diagram.edges
      .map((e) => {
        const src = diagram.nodes.find((n) => n.id === e.sourceId)?.text ?? e.sourceId;
        const tgt = diagram.nodes.find((n) => n.id === e.targetId)?.text ?? e.targetId;
        return `  ${src} → ${tgt}${e.label ? ` (${e.label})` : ""}`;
      })
      .join("\n");

    const kbParts: string[] = [];
    for (const entry of entries) {
      if (!entry.pairs || entry.pairs.length === 0) continue;
      const pairLines = entry.pairs
        .slice(0, 5)
        .map((pr) => `  Q: ${pr.input}\n  A: ${pr.response} ${scoreLabel(pr.score)}`)
        .join("\n");
      kbParts.push(`### ${entry.nodeText}\n${pairLines}`);
    }
    if (kbParts.length === 0) return "";

    const scopeLabel = diagram.scope === "shared" ? "Shared" : "Personal";
    return (
      `## Conversation Flow (${scopeLabel})\n` +
      `Follow this flow strictly during the conversation:\n` +
      nodeLines.join("\n") +
      (edgeLines ? `\nTransitions:\n${edgeLines}` : "") +
      `\n\n## Knowledge Base — Example Dialogues by Step\n` +
      `Use these verified examples as a guide for your responses. Higher ★ = better outcome.\n\n` +
      kbParts.join("\n\n")
    );
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

  // ─── Schema work-mode: strict script execution ───────────────────────────

  /**
   * Execute the current step of the active conversation script (schema mode).
   *
   * Called on every incoming message when workMode === "schema". Looks up (or
   * initialises) the per-chat position in the active diagram, builds a strict
   * step-execution prompt, generates the AI reply, then advances the state
   * machine to the next node.
   *
   * Returns the reply string, or null if schema mode is not active / no
   * diagram is configured.
   */
  protected async runScriptStep(
    chatId: string,
    userText: string,
    chatKey: string,
  ): Promise<string | null> {
    const settings = this.getAgentSettings();
    if (settings.workMode !== "schema" || !settings.activeDiagramId) return null;

    const diagram = this.storage.getDiagramById(settings.activeDiagramId);
    if (!diagram || diagram.nodes.length === 0) return null;

    // Entry point: find the start node
    const startNode = diagram.nodes.find((n) => n.type === "start");
    if (!startNode) return null;

    // Resolve current position (null → first message → start node)
    const savedNodeId = this.storage.getConversationNodeId(this.id, chatId);
    const currentNode: DiagramNode =
      (savedNodeId ? diagram.nodes.find((n) => n.id === savedNodeId) : null) ?? startNode;

    // Outgoing edges and their target nodes
    const outEdges = diagram.edges.filter((e) => e.sourceId === currentNode.id);
    const nextNodes = outEdges
      .map((e) => ({ edge: e, node: diagram.nodes.find((n) => n.id === e.targetId) }))
      .filter((x): x is { edge: DiagramEdge; node: DiagramNode } => x.node !== undefined);

    // Build a step-focused system prompt
    const isDecision = currentNode.type === "decision";
    const isEnd = currentNode.type === "end";

    let systemPrompt =
      `Ты ведёшь разговор строго по заданному скрипту. Не отклоняйся от него.\n\n` +
      `## ТЕКУЩИЙ ШАГ\n` +
      `[${currentNode.type.toUpperCase()}] "${currentNode.text}"\n\n`;

    if (isEnd) {
      systemPrompt += `Инструкция: Это последний шаг — завершай разговор согласно скрипту.\n`;
    } else if (isDecision) {
      systemPrompt +=
        `Инструкция: Это точка выбора. Задай вопрос или сделай предложение, ` +
        `чтобы определить дальнейший путь.\n`;
    } else {
      systemPrompt += `Инструкция: Выполни этот шаг — ответь согласно инструкции.\n`;
    }

    if (nextNodes.length > 0) {
      systemPrompt += `\n## СЛЕДУЮЩИЕ ШАГИ\n`;
      for (const x of nextNodes) {
        systemPrompt += `- ${x.edge.label ? `[${x.edge.label}] ` : ""}${x.node.text}\n`;
      }
    }

    // For decision nodes with multiple branches, embed a BRANCH: tag instruction
    // so the AI signals which path to take without a second round-trip.
    if (nextNodes.length > 1) {
      const labels = nextNodes.map((x) => x.edge.label ?? x.node.text).join(" | ");
      systemPrompt +=
        `\nПосле своего ответа добавь ОТДЕЛЬНОЙ новой строкой: BRANCH:<вариант>\n` +
        `Где <вариант> — ТОЧНО одно из: ${labels}\n` +
        `(Эта строка будет удалена перед отправкой пользователю.)\n`;
    }

    systemPrompt +=
      `\n${this.buildScriptContext(diagram)}\n\n` +
      `ВАЖНО: Отвечай ТОЛЬКО по текущему шагу. Не перескакивай вперёд и не возвращайся назад.`;

    const workspaceTools = createWorkspaceTools(this.storage.getAgentWorkspaceDir(this.id));
    const rawReply = await aiReply(userText, chatKey, systemPrompt, this.storage, workspaceTools);

    // Strip the BRANCH: decision tag from the visible reply
    let reply = rawReply;
    let chosenNextNodeId: string | undefined;

    if (nextNodes.length > 1) {
      const branchMatch = rawReply.match(/\nBRANCH:\s*(.+)$/im);
      if (branchMatch) {
        reply = rawReply.replace(/\nBRANCH:\s*.+$/im, "").trim();
        const chosenLabel = branchMatch[1].trim().toLowerCase();
        // Case-insensitive partial match on edge label or target node text
        const matched = nextNodes.find(
          (x) =>
            x.edge.label?.toLowerCase().includes(chosenLabel) ||
            chosenLabel.includes((x.edge.label ?? "").toLowerCase()) ||
            x.node.text.toLowerCase().includes(chosenLabel) ||
            chosenLabel.includes(x.node.text.toLowerCase()),
        );
        chosenNextNodeId = matched?.node.id ?? nextNodes[0].node.id;
      } else {
        // AI didn't include a tag — fall back to the first branch
        chosenNextNodeId = nextNodes[0].node.id;
      }
    }

    // Advance the state machine
    if (nextNodes.length === 0 || isEnd) {
      // Script complete — clear state so the next message restarts from the top
      this.storage.deleteConversationState(this.id, chatId);
    } else if (nextNodes.length === 1) {
      this.storage.setConversationNodeId(this.id, chatId, nextNodes[0].node.id);
    } else {
      this.storage.setConversationNodeId(this.id, chatId, chosenNextNodeId!);
    }

    return reply || null;
  }

  /**
   * Render the full diagram as a numbered plain-text script for use in the
   * system prompt. BFS-traversal from the start node preserves the natural
   * reading order. Decision branches are shown inline with their edge labels.
   */
  private buildScriptContext(diagram: FlowDiagram): string {
    if (diagram.nodes.length === 0) return "";
    const lines: string[] = ["## ПОЛНЫЙ СКРИПТ (для справки)"];

    const startNode = diagram.nodes.find((n) => n.type === "start");
    if (!startNode) {
      // Fallback: flat list
      for (const n of diagram.nodes) lines.push(`• [${n.type.toUpperCase()}] ${n.text}`);
      return lines.join("\n");
    }

    // BFS through nodes, building numbered steps with branch annotations
    const visited = new Set<string>();
    const queue: string[] = [startNode.id];
    let step = 1;

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = diagram.nodes.find((n) => n.id === nodeId);
      if (!node) continue;

      const outs = diagram.edges.filter((e) => e.sourceId === nodeId);
      const branchStr = outs
        .map((e) => {
          const target = diagram.nodes.find((n) => n.id === e.targetId);
          return `→ ${e.label ? `[${e.label}] ` : ""}${target?.text ?? "?"}`;
        })
        .join("  ");

      lines.push(
        `${step}. [${node.type.toUpperCase()}] ${node.text}${branchStr ? `  ${branchStr}` : ""}`,
      );
      step++;

      for (const e of outs) {
        if (!visited.has(e.targetId)) queue.push(e.targetId);
      }
    }

    // Append any nodes disconnected from the start (shouldn't happen in a well-formed diagram)
    for (const n of diagram.nodes) {
      if (!visited.has(n.id)) lines.push(`${step++}. [${n.type.toUpperCase()}] ${n.text}`);
    }

    return lines.join("\n");
  }
}
