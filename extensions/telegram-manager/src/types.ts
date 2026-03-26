// plugins/telegram/src/types.ts

// ─── OpenClaw Gateway interface (subset we depend on) ─────────────────────────

export interface IGatewayContext {
  /** The gateway auth token — same as OPENCLAW_GATEWAY_TOKEN */
  gatewayToken: string;
  /** Logger compatible with OpenClaw's winston instance */
  logger: ILogger;
  /** Path to the shared data dir (e.g. ~/.openclaw/data) */
  dataDir: string;
  /** Broadcast a message to ALL connected WebSocket clients */
  broadcast(message: GatewayMessage): void;
}

export interface ILogger {
  info(msg: string, meta?: object): void;
  warn(msg: string, meta?: object): void;
  error(msg: string, meta?: object): void;
  debug(msg: string, meta?: object): void;
}

export interface GatewayMessage {
  method: string;
  id?: number;
  params?: unknown;
  result?: unknown;
  error?: string;
}

export interface GatewayPlugin {
  /** Unique namespace, e.g. "telegram" */
  readonly namespace: string;
  /** Called once when Gateway starts */
  init(ctx: IGatewayContext): Promise<void>;
  /** Handle an incoming WS message. Return true if handled. */
  handleMessage(msg: GatewayMessage, reply: (r: GatewayMessage) => void): Promise<boolean>;
  /** Called on Gateway shutdown */
  destroy(): Promise<void>;
  /** Optional HTTP route handlers [{method, path, handler}] */
  httpRoutes?(): HttpRoute[];
}

export interface HttpRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  handler: (req: any, res: any) => Promise<void> | void;
}

// ─── Telegram Agent types ─────────────────────────────────────────────────────

export type AgentType = "userbot" | "bot";
export type AgentStatus = "stopped" | "starting" | "running" | "error";

export interface UserbotCredentials {
  type: "userbot";
  phoneNumber: string;
  sessionString?: string;
}

export interface BotCredentials {
  type: "bot";
  token: string;
}

export type AgentCredentials = UserbotCredentials | BotCredentials;

// ─── Behaviors ────────────────────────────────────────────────────────────────

export interface AutoReplyBehavior {
  type: "auto_reply";
  enabled: boolean;
  replyMode: "ai" | "template";
  aiSystemPrompt?: string;
  /** Persistent objective for the agent across all auto-reply conversations. */
  goal?: string;
  triggerKeywords?: string[];
  templates?: { trigger: string; response: string }[];
  onlyInChats?: string[];
  cooldownSeconds?: number;
}

export interface MonitorBehavior {
  type: "monitor";
  enabled: boolean;
  targets: string[];
  filters?: { keywords?: string[]; hasMedia?: boolean };
  webhookUrl?: string;
  saveToDb?: boolean;
}

export interface BroadcastBehavior {
  type: "broadcast";
  enabled: boolean;
  targets: string[];
  message: string;
  schedule?: string;
  parseMode?: "html" | "markdown";
  delayBetweenMs?: number;
  onlyOnce?: boolean;
}

export interface ParserBehavior {
  type: "parser";
  enabled: boolean;
  targets: string[];
  parseMessages?: boolean;
  parseMembers?: boolean;
  limit?: number;
  webhookUrl?: string;
  saveToDb?: boolean;
}

export interface TaskSession {
  id: string;
  /** Telegram chat ID this session is bound to */
  chatId: string;
  /** The goal or task description for the AI */
  task: string;
  /** Optional custom system prompt (overrides default task prompt) */
  systemPrompt?: string;
  status: "active" | "completed" | "paused";
  startedAt: string;
  completedAt?: string;
  /** ID of the initiating agent or system */
  initiatedBy?: string;
}

export interface TaskSessionBehavior {
  type: "task_session";
  enabled: boolean;
  sessions: TaskSession[];
}

// ─── Inter-agent communication ────────────────────────────────────────────────

export interface AgentCommunicationMessage {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  content: string;
  /** The shared mission/goal this message relates to */
  missionId: string;
  timestamp: string;
  /** Optional reply to another message */
  replyToId?: string;
}

export interface AgentMission {
  id: string;
  /** The master agent that created and owns this mission */
  masterAgentId: string;
  /** Human-readable title */
  title: string;
  /** The goal/instructions all participating agents receive */
  goal: string;
  /** Optional system prompt override for sub-agents */
  systemPrompt?: string;
  /** Agents participating in this mission */
  participantAgentIds: string[];
  status: "active" | "completed" | "paused";
  createdAt: string;
  completedAt?: string;
}

export interface CommunicationBehavior {
  type: "communication";
  enabled: boolean;
  /** Missions this agent participates in */
  activeMissionIds: string[];
}

export interface MasterControlBehavior {
  type: "master_control";
  enabled: boolean;
  /**
   * Telegram chat IDs (numeric string) that are authorized to send control
   * commands to the master agent. Usually just the operator's personal chat ID.
   */
  allowedChatIds: string[];
  /** Optional system prompt override for the master control AI. */
  systemPrompt?: string;
}

export type BehaviorConfig =
  | AutoReplyBehavior
  | MonitorBehavior
  | BroadcastBehavior
  | ParserBehavior
  | TaskSessionBehavior
  | CommunicationBehavior
  | MasterControlBehavior;

// ─── Agent settings (work mode, schedule, active diagram) ────────────────────

/**
 * Persistent per-agent settings controlling when and how the agent replies.
 * Stored in tg_agent_settings table.
 */
export interface AgentSettings {
  /**
   * Whether to automatically start this agent when the gateway boots.
   * Defaults to true (existing behavior preserved for all agents).
   */
  autoStartEnabled?: boolean;

  /** ID of the diagram the agent follows when useSchema is true. */
  activeDiagramId?: string;

  /**
   * Master AI kill-switch. When false, the agent receives messages but does
   * NOT send any AI replies (schema, auto-reply, catch-up, follow-ups, etc.).
   * Default: true (enabled).
   */
  aiEnabled?: boolean;

  /**
   * Whether the agent follows the selected diagram as a strict conversation
   * script.  When true and activeDiagramId is set, every incoming message
   * advances through the flowchart steps instead of using free-form AI reply.
   */
  useSchema: boolean;

  /**
   * "always"   — reply at any time (default)
   * "schedule" — reply only within scheduleFrom..scheduleTo window (local time)
   */
  scheduleMode: "always" | "schedule";

  /** HH:MM — start of the reply window (scheduleMode: "schedule") */
  scheduleFrom?: string;
  /** HH:MM — end of the reply window (scheduleMode: "schedule") */
  scheduleTo?: string;

  /**
   * "all"   — reply to every chat (default)
   * "tasks" — reply only to chats that have an active Task Session assigned
   */
  replyTo: "all" | "tasks";

  /**
   * Whether schema mode uses strict enforcement:
   *   true  (strict)   — KB top responses are used as primary templates; the
   *                       generated reply is validated against script rules and
   *                       automatically rebuilt when it violates them.
   *   false (flexible) — Standard AI generation with KB context injected into
   *                       the system prompt (default / legacy behaviour).
   */
  schemaStrictMode?: boolean;

  /**
   * When true and scheduleMode === "schedule", the AI continues chatting and
   * processing leads while the manager is offline.  The AI knows the manager's
   * working hours ({от}/{до}) and focuses on qualifying the lead and collecting
   * a convenient callback time.  Agent replies to every message as usual.
   */
  offlineReplyEnabled?: boolean;

  /**
   * Extra task instructions injected into the AI system prompt for offline mode.
   * Supports {от} (scheduleFrom) and {до} (scheduleTo) placeholders.
   * Leave empty for the built-in default goal.
   */
  offlineReplyTemplate?: string;

  /**
   * Explicit manager working hours shown to the AI in offline mode so it can
   * tell clients "the manager is available from HH:MM to HH:MM".
   * Falls back to scheduleFrom/scheduleTo when not set.
   */
  managerWorkFrom?: string;
  managerWorkTo?: string;

  /**
   * Telegram group/channel link (e.g. https://t.me/+xxxx or @groupname) where
   * the agent will push a formatted lead card each time a new lead is captured.
   * Works for both private (invite-link) and public groups.
   */
  leadsGroupLink?: string;

  /** Links that have already received the one-time welcome message. */
  leadsGroupWelcomedLinks?: string[];

  // ── Re-engagement (cold outreach to dormant contacts) ──────────────────────

  /** When true, the agent periodically writes to contacts who haven't replied in N days. */
  reEngagementEnabled?: boolean;

  /**
   * Days-after-last-client-message thresholds at which to send a re-engagement message.
   * Example: [1, 2, 3, 5] sends at day 1, day 2, day 3, and day 5 of silence.
   * @deprecated prefer reEngagementDelayFrom / reEngagementDelayTo
   */
  reEngagementDelays?: number[];

  /** Start of the silence-range in days (inclusive). Default 1. */
  reEngagementDelayFrom?: number;

  /** End of the silence-range in days (inclusive). Default 7. */
  reEngagementDelayTo?: number;

  /**
   * When true, also send to contacts who have been silent for MORE than
   * reEngagementDelayTo days (once per contact, after the range ends).
   */
  reEngagementDelayMore?: boolean;

  /**
   * Message template. Supports placeholders:
   *   {имя}        — first name
   *   {фамилия}    — last name
   *   {имя_полное} — first + last
   * Example: "Привет {имя}! Горит сделка с профитом 37%, ты с нами? 🔥"
   */
  reEngagementTemplate?: string;

  /** When true, only send re-engagement if the contact's first name is known. */
  reEngagementNameOnly?: boolean;

  /** Previously saved re-engagement templates the user can pick from. */
  reEngagementSavedTemplates?: string[];
}

// ─── Lead record ──────────────────────────────────────────────────────────────

/** A lead collected from a conversation (auto-extracted or manually created). */
export interface TelegramLead {
  id: string;
  agentId: string;
  chatId: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  /** e.g. "Tg" | "Tel" | "Tg/Tel" | "WhatsApp" */
  contactMethod?: string;
  country?: string;
  age?: number;
  /** e.g. "24.03 / 14:05 TR" */
  preferredContactTime?: string;
  /** e.g. "Баер - Менеджер" */
  role?: string;
  telegramLink?: string;
  agentName?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Agent manager interface (used by master_control to avoid circular imports) ─

export interface IAgentManager {
  list(): AgentRecord[];
  get(id: string): AgentRecord | null;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  callTool(id: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  getEvents(agentId?: string, limit?: number): unknown[];
  assignTaskSession(id: string, session: TaskSession): Promise<void>;
  listTaskSessions(id: string): TaskSession[];
  completeTaskSession(id: string, sessionId: string): Promise<void>;
  setBehaviors(id: string, behaviors: BehaviorConfig[]): Promise<void>;
}

// ─── Agent record ─────────────────────────────────────────────────────────────

export interface AgentRecord {
  id: string;
  name: string;
  type: AgentType;
  status: AgentStatus;
  credentials: AgentCredentials;
  behaviors: BehaviorConfig[];
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  stats: { sent: number; received: number; parsed: number };
}

// ─── Tool call types (OpenClaw tool protocol) ─────────────────────────────────

export type ToolName =
  | "sendMessage"
  | "getMessages"
  | "getMembers"
  | "joinChat"
  | "leaveChat"
  | "getMe";

export interface ToolCallParams {
  agentId: string;
  tool: ToolName;
  args: Record<string, unknown>;
}

export interface ToolCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ─── Conversation scenario (Chat Nodes + Flow Nodes) ──────────────────────────

/** A single message node in a conversation scenario */
export interface ChatNode {
  id: string;
  agentId: string;
  /** Who speaks this message */
  role: "manager" | "client";
  text: string;
  /** Default next node id (linear flow) */
  nextNodeId?: string;
  /** Conditional branches — if client input matches keyword, go to nextNodeId */
  branches?: { keyword: string; nextNodeId: string }[];
  /** Optional position hint for graph layout */
  position?: { x: number; y: number };
  createdAt: string;
}

// ─── Visual Flowchart Diagram ────────────────────────────────────────────────

export type DiagramNodeType = "start" | "end" | "process" | "decision";

/** A single node on the visual flowchart canvas. */
export interface DiagramNode {
  id: string;
  type: DiagramNodeType;
  text: string;
  x: number;
  y: number;
  /** Optional group (block) this node belongs to. */
  groupId?: string;
}

/** A directed connection between two diagram nodes. */
export interface DiagramEdge {
  id: string;
  sourceId: string;
  targetId: string;
  /** Optional short label displayed near the midpoint. */
  label?: string;
}

/** A colored block container grouping related nodes. */
export interface DiagramGroup {
  id: string;
  label: string;
  color: "blue" | "green" | "orange" | "purple";
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A full visual flowchart diagram stored per agent+scope. */
export interface FlowDiagram {
  id: string;
  agentId: string;
  scope: "personal" | "shared";
  title: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  createdAt: string;
  updatedAt: string;
}

/** A named conversation stage that groups multiple ChatNodes */
export interface FlowNode {
  id: string;
  agentId: string;
  /** Schema scope: "personal" (per-agent) or "shared" (across all agents). */
  scope?: "personal" | "shared";
  title: string;
  description?: string;
  chatNodeIds: string[];
  nextFlowNodeIds: string[];
  position?: { x: number; y: number };
  createdAt: string;
}

/** A dialogue pair extracted from a real conversation (for training) */
export interface TrainingPair {
  id: string;
  agentId: string;
  /** Client message (input) */
  input: string;
  /** Manager response */
  response: string;
  sourceFile: string;
  createdAt: string;
}

// ─── Telegram export format (for training data import) ────────────────────────

export interface TelegramExportMessage {
  id: number;
  type: string;
  date: string;
  from: string | null;
  from_id: string;
  /** Set when the message was sent via an inline bot (e.g. @gif, @sticker bots). */
  via_bot?: string;
  /** Text can be a plain string or an array of string/formatting objects */
  text: string | (string | { type: string; text: string })[];
}

export interface TelegramExportChat {
  name: string | null;
  type: string;
  id: number;
  messages: TelegramExportMessage[];
}

// ─── Events (push from agent → Gateway → clients) ─────────────────────────────

export interface TelegramEvent {
  agentId: string;
  agentName: string;
  type: "message_in" | "message_out" | "parsed_item" | "status_change" | "error" | "agent_message";
  payload: Record<string, unknown>;
  timestamp: string;
}
