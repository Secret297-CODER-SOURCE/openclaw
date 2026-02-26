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

export type BehaviorConfig =
  | AutoReplyBehavior
  | MonitorBehavior
  | BroadcastBehavior
  | ParserBehavior;

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

// ─── Events (push from agent → Gateway → clients) ─────────────────────────────

export interface TelegramEvent {
  agentId: string;
  agentName: string;
  type: "message_in" | "message_out" | "parsed_item" | "status_change" | "error";
  payload: Record<string, unknown>;
  timestamp: string;
}
