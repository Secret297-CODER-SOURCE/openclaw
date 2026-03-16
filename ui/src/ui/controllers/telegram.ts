import type { GatewayBrowserClient } from "../gateway.ts";

// ─── Types (mirror extensions/files/src/types.ts) ────────────────────────────

export type AgentType = "userbot" | "bot";
export type AgentStatus = "stopped" | "starting" | "running" | "error";

export type TelegramAgentRecord = {
  id: string;
  name: string;
  type: AgentType;
  status: AgentStatus;
  /** Credentials are masked by the backend — token/sessionString are never returned in full */
  credentials: {
    type: string;
    phoneNumber?: string;
    token?: string;
  };
  behaviors: unknown[];
  stats: { sent: number; received: number; parsed: number };
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type TelegramAgentEvent = {
  agentId: string;
  agentName: string;
  type: "message_in" | "message_out" | "parsed_item" | "status_change" | "error";
  payload: Record<string, unknown>;
  timestamp: string;
};

export type TelegramState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  telegramLoading: boolean;
  telegramError: string | null;
  telegramAgents: TelegramAgentRecord[];
  telegramSelectedId: string | null;
  telegramBusy: boolean;
  telegramBusyAgentId: string | null;
  telegramAuthStep: "idle" | "awaiting_code" | "done" | "error";
  telegramAuthError: string | null;
  telegramRecentEvents: TelegramAgentEvent[];
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isReady(state: TelegramState): boolean {
  return !!(state.client && state.connected);
}

/** Set busy state for a specific agent, run the action, then clear busy */
async function withBusy<T>(
  state: TelegramState,
  agentId: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  if (state.telegramBusy) {
    return undefined;
  }
  state.telegramBusy = true;
  state.telegramBusyAgentId = agentId;
  try {
    return await fn();
  } finally {
    state.telegramBusy = false;
    state.telegramBusyAgentId = null;
  }
}

/** Reload the agent list after a mutation */
async function reload(state: TelegramState): Promise<void> {
  await loadTelegramAgents(state);
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function loadTelegramAgents(state: TelegramState): Promise<void> {
  if (!isReady(state) || state.telegramLoading) {
    return;
  }
  state.telegramLoading = true;
  state.telegramError = null;
  try {
    const res = await state.client!.request<TelegramAgentRecord[]>("telegram.agent.list", {});
    state.telegramAgents = res ?? [];
  } catch (err) {
    state.telegramError = String(err);
  } finally {
    state.telegramLoading = false;
  }
}

export async function loadTelegramEvents(
  state: TelegramState,
  agentId: string,
): Promise<TelegramAgentEvent[]> {
  if (!isReady(state)) {
    return [];
  }
  try {
    const res = await state.client!.request<TelegramAgentEvent[]>("telegram.events.get", {
      agentId,
      limit: 100,
    });
    return res ?? [];
  } catch {
    return [];
  }
}

// ─── Create / Delete ──────────────────────────────────────────────────────────

export async function createTelegramAgent(
  state: TelegramState,
  name: string,
  credentials: { type: "userbot"; phoneNumber: string } | { type: "bot"; token: string },
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  await withBusy(state, "new", async () => {
    await state.client!.request("telegram.agent.create", {
      name,
      credentials,
      behaviors: [],
    });
    await reload(state);
  });
}

export async function deleteTelegramAgent(state: TelegramState, agentId: string): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  await withBusy(state, agentId, async () => {
    await state.client!.request("telegram.agent.delete", { agentId });
    await reload(state);
  });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export async function startTelegramAgent(state: TelegramState, agentId: string): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  await withBusy(state, agentId, async () => {
    await state.client!.request("telegram.agent.start", { agentId });
    await reload(state);
  });
}

export async function stopTelegramAgent(state: TelegramState, agentId: string): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  await withBusy(state, agentId, async () => {
    await state.client!.request("telegram.agent.stop", { agentId });
    await reload(state);
  });
}

export async function restartTelegramAgent(state: TelegramState, agentId: string): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  await withBusy(state, agentId, async () => {
    await state.client!.request("telegram.agent.restart", { agentId });
    await reload(state);
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function authStartTelegramAgent(state: TelegramState, agentId: string): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramAuthError = null;
  await withBusy(state, agentId, async () => {
    await state.client!.request("telegram.agent.authStart", { agentId });
  });
}

export async function authSubmitTelegramAgent(
  state: TelegramState,
  agentId: string,
  code: string,
  password?: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramAuthError = null;
  await withBusy(state, agentId, async () => {
    try {
      await state.client!.request("telegram.agent.authSubmit", {
        agentId,
        code,
        ...(password ? { password } : {}),
      });
      await reload(state);
    } catch (err) {
      state.telegramAuthError = String(err);
      throw err;
    }
  });
}

// ─── Behaviors ────────────────────────────────────────────────────────────────

export async function setBehaviorsTelegramAgent(
  state: TelegramState,
  agentId: string,
  behaviors: unknown[],
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  await withBusy(state, agentId, async () => {
    await state.client!.request("telegram.agent.setBehaviors", { agentId, behaviors });
    await reload(state);
  });
}

// ─── Credentials config ───────────────────────────────────────────────────────

type TelegramConfigState = TelegramState & {
  telegramApiIdConfigured: boolean | null;
  telegramSetupSaving: boolean;
  telegramSetupError: string | null;
  telegramProxyConfigured: boolean;
  telegramProxyIp: string;
  telegramProxyPort: string;
  telegramProxySaving: boolean;
  telegramProxyError: string | null;
};

export async function loadTelegramConfig(state: TelegramConfigState): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  try {
    const res = await state.client!.request<{
      configured: boolean;
      apiId: number | null;
      apiHashSet: boolean;
      proxyConfigured: boolean;
      proxyIp: string | null;
      proxyPort: number | null;
      proxyUsername: string | null;
    }>("telegram.config.get", {});
    state.telegramApiIdConfigured = res?.configured ?? false;
    state.telegramProxyConfigured = res?.proxyConfigured ?? false;
    // Pre-fill proxy fields with current values so the form shows them
    if (res?.proxyIp) {
      state.telegramProxyIp = res.proxyIp;
    }
    if (res?.proxyPort) {
      state.telegramProxyPort = String(res.proxyPort);
    }
  } catch {
    // Plugin may not be loaded yet — treat as unknown
    state.telegramApiIdConfigured = null;
  }
}

export async function saveTelegramCredentials(
  state: TelegramConfigState & {
    telegramSetupApiId: string;
    telegramSetupApiHash: string;
    telegramSetupProxyIp: string;
    telegramSetupProxyPort: string;
    telegramSetupProxyUsername: string;
    telegramSetupProxyPassword: string;
  },
  apiId: string,
  apiHash: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramSetupSaving = true;
  state.telegramSetupError = null;
  try {
    const proxyIp = state.telegramSetupProxyIp.trim();
    const proxyPort = parseInt(state.telegramSetupProxyPort.trim(), 10);
    await state.client!.request("telegram.config.set", {
      apiId: parseInt(apiId, 10),
      apiHash: apiHash.trim(),
      ...(proxyIp && proxyPort
        ? {
            proxyIp,
            proxyPort,
            ...(state.telegramSetupProxyUsername
              ? { proxyUsername: state.telegramSetupProxyUsername }
              : {}),
            ...(state.telegramSetupProxyPassword
              ? { proxyPassword: state.telegramSetupProxyPassword }
              : {}),
          }
        : {}),
    });
    state.telegramApiIdConfigured = true;
    state.telegramProxyConfigured = !!(proxyIp && proxyPort);
    if (proxyIp) {
      state.telegramProxyIp = proxyIp;
    }
    if (proxyPort) {
      state.telegramProxyPort = String(proxyPort);
    }
    await loadTelegramAgents(state);
  } catch (err) {
    state.telegramSetupError = String(err);
    throw err;
  } finally {
    state.telegramSetupSaving = false;
  }
}

/** Update proxy settings without changing API credentials. */
export async function saveTelegramProxy(
  state: TelegramConfigState,
  proxyIp: string,
  proxyPort: string,
  proxyUsername: string,
  proxyPassword: string,
  clear = false,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramProxySaving = true;
  state.telegramProxyError = null;
  try {
    if (clear) {
      await state.client!.request("telegram.config.setProxy", { clear: true });
      state.telegramProxyConfigured = false;
      state.telegramProxyIp = "";
      state.telegramProxyPort = "";
    } else {
      const port = parseInt(proxyPort.trim(), 10);
      await state.client!.request("telegram.config.setProxy", {
        proxyIp: proxyIp.trim(),
        proxyPort: port,
        ...(proxyUsername ? { proxyUsername } : {}),
        ...(proxyPassword ? { proxyPassword } : {}),
      });
      state.telegramProxyConfigured = true;
      state.telegramProxyIp = proxyIp.trim();
      state.telegramProxyPort = String(port);
    }
  } catch (err) {
    state.telegramProxyError = String(err);
    throw err;
  } finally {
    state.telegramProxySaving = false;
  }
}

// ─── Tool calls ───────────────────────────────────────────────────────────────

export async function callTelegramTool(
  state: TelegramState,
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!isReady(state)) {
    return null;
  }
  return state.client!.request("telegram.tool.call", { agentId, tool, args });
}

// ─── Task sessions ────────────────────────────────────────────────────────────

export type TaskSession = {
  id: string;
  chatId: string;
  task: string;
  systemPrompt?: string;
  status: "active" | "completed" | "paused";
  startedAt: string;
  completedAt?: string;
  initiatedBy?: string;
};

type TaskSessionState = TelegramState & {
  telegramTaskSessions: TaskSession[];
  telegramTasksLoading: boolean;
  telegramTasksError: string | null;
  telegramTasksBusy: boolean;
};

export async function loadTelegramTaskSessions(
  state: TaskSessionState,
  agentId: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramTasksLoading = true;
  state.telegramTasksError = null;
  try {
    const res = await state.client!.request<TaskSession[]>("telegram.agent.listTaskSessions", {
      agentId,
    });
    state.telegramTaskSessions = res ?? [];
  } catch (err) {
    state.telegramTasksError = String(err);
  } finally {
    state.telegramTasksLoading = false;
  }
}

export async function assignTelegramTask(
  state: TaskSessionState,
  agentId: string,
  chatId: string,
  task: string,
  systemPrompt?: string,
  openingMessage?: string,
): Promise<string | null> {
  if (!isReady(state) || state.telegramTasksBusy) {
    return null;
  }
  state.telegramTasksBusy = true;
  state.telegramTasksError = null;
  try {
    const res = await state.client!.request<{ ok: boolean; sessionId: string }>(
      "telegram.agent.assignTask",
      {
        agentId,
        chatId,
        task,
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(openingMessage ? { openingMessage } : {}),
      },
    );
    await loadTelegramTaskSessions(state, agentId);
    return res?.sessionId ?? null;
  } catch (err) {
    state.telegramTasksError = String(err);
    return null;
  } finally {
    state.telegramTasksBusy = false;
  }
}

export async function completeTelegramTaskSession(
  state: TaskSessionState,
  agentId: string,
  sessionId: string,
): Promise<void> {
  if (!isReady(state) || state.telegramTasksBusy) {
    return;
  }
  state.telegramTasksBusy = true;
  state.telegramTasksError = null;
  try {
    await state.client!.request("telegram.agent.completeTaskSession", { agentId, sessionId });
    await loadTelegramTaskSessions(state, agentId);
  } catch (err) {
    state.telegramTasksError = String(err);
  } finally {
    state.telegramTasksBusy = false;
  }
}

// ─── Missions (inter-agent communication) ─────────────────────────────────────

export type AgentMissionRecord = {
  id: string;
  masterAgentId: string;
  title: string;
  goal: string;
  systemPrompt?: string;
  participantAgentIds: string[];
  status: "active" | "completed" | "paused";
  createdAt: string;
  completedAt?: string;
};

export type AgentCommMessageRecord = {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  content: string;
  missionId: string;
  timestamp: string;
  replyToId?: string;
};

type TelegramMissionsState = TelegramState & {
  telegramMissions: AgentMissionRecord[];
  telegramMissionsLoading: boolean;
  telegramMissionsError: string | null;
  telegramMissionsBusy: boolean;
  telegramMissionMessages: AgentCommMessageRecord[];
};

export async function loadTelegramMissions(state: TelegramMissionsState): Promise<void> {
  if (!isReady(state) || state.telegramMissionsLoading) {
    return;
  }
  state.telegramMissionsLoading = true;
  state.telegramMissionsError = null;
  try {
    const res = await state.client!.request<AgentMissionRecord[]>("telegram.mission.list", {});
    state.telegramMissions = res ?? [];
  } catch (err) {
    state.telegramMissionsError = String(err);
  } finally {
    state.telegramMissionsLoading = false;
  }
}

export async function createTelegramMission(
  state: TelegramMissionsState,
  masterAgentId: string,
  title: string,
  goal: string,
  participantIds: string[],
  systemPrompt?: string,
): Promise<AgentMissionRecord | null> {
  if (!isReady(state) || state.telegramMissionsBusy) {
    return null;
  }
  state.telegramMissionsBusy = true;
  state.telegramMissionsError = null;
  try {
    const res = await state.client!.request<AgentMissionRecord>("telegram.mission.create", {
      masterAgentId,
      title,
      goal,
      participantIds,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    await loadTelegramMissions(state);
    return res ?? null;
  } catch (err) {
    state.telegramMissionsError = String(err);
    return null;
  } finally {
    state.telegramMissionsBusy = false;
  }
}

export async function completeTelegramMission(
  state: TelegramMissionsState,
  missionId: string,
): Promise<void> {
  if (!isReady(state) || state.telegramMissionsBusy) {
    return;
  }
  state.telegramMissionsBusy = true;
  state.telegramMissionsError = null;
  try {
    await state.client!.request("telegram.mission.complete", { missionId });
    await loadTelegramMissions(state);
  } catch (err) {
    state.telegramMissionsError = String(err);
  } finally {
    state.telegramMissionsBusy = false;
  }
}

export async function loadTelegramMissionMessages(
  state: TelegramMissionsState,
  missionId: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramMissionsError = null;
  try {
    const res = await state.client!.request<AgentCommMessageRecord[]>("telegram.mission.messages", {
      missionId,
    });
    state.telegramMissionMessages = res ?? [];
  } catch (err) {
    state.telegramMissionsError = String(err);
  }
}

export async function sendTelegramAgentMessage(
  state: TelegramMissionsState,
  fromAgentId: string,
  toAgentId: string,
  missionId: string,
  content: string,
): Promise<AgentCommMessageRecord | null> {
  if (!isReady(state) || state.telegramMissionsBusy) {
    return null;
  }
  state.telegramMissionsBusy = true;
  state.telegramMissionsError = null;
  try {
    const res = await state.client!.request<AgentCommMessageRecord>(
      "telegram.agent.sendMessage_to_agent",
      { fromAgentId, toAgentId, missionId, content },
    );
    // Refresh messages for this mission
    await loadTelegramMissionMessages(state, missionId);
    return res ?? null;
  } catch (err) {
    state.telegramMissionsError = String(err);
    return null;
  } finally {
    state.telegramMissionsBusy = false;
  }
}

// ─── Telegram-specific file operations ────────────────────────────────────────
//
// These adapter functions provide the same interface as the main agent file
// operations (loadAgentFiles / loadAgentFileContent / saveAgentFile) but route
// through the Telegram-specific WS endpoints. The results are stored in the
// same agentFilesList / agentFileContents / agentFileSaving state slots so that
// the existing renderAgentFiles view component renders them without changes.
//
// Background: Telegram agent IDs are UUIDs stored in the plugin's SQLite DB
// and are NOT known to the main OpenClaw gateway. Calling agents.files.list
// with a Telegram agent UUID results in "unknown agent id" (INVALID_REQUEST).

import type { AgentFileEntry, AgentsFilesListResult } from "../types.ts";

// Minimal subset of AgentFilesState fields we need to populate
type TelegramAgentFilesState = TelegramState & {
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFilesList: AgentsFilesListResult | null;
  agentFileContents: Record<string, string>;
  agentFileSaving: boolean;
};

/** Load a Telegram agent's core files into the standard agentFilesList state slot */
export async function loadTelegramAgentFiles(
  state: TelegramAgentFilesState,
  agentId: string,
): Promise<void> {
  // Note: do NOT guard on state.agentFilesLoading — the caller (onSelectPanel)
  // pre-sets it to true to suppress the "click to load" flash, then calls us.
  if (!isReady(state)) {
    return;
  }
  state.agentFilesLoading = true;
  state.agentFilesError = null;
  try {
    const res = await state.client!.request<{
      files: Array<{ name: string; sizeBytes?: number; updatedAt?: string; missing: boolean }>;
      workspacePath?: string;
    }>("telegram.agent.getCoreFiles", { agentId });
    if (res) {
      const workspacePath = res.workspacePath ?? "";
      const files: AgentFileEntry[] = (res.files ?? []).map((f) => ({
        name: f.name,
        path: workspacePath ? `${workspacePath}/${f.name}` : f.name,
        missing: !!f.missing,
        size: f.sizeBytes,
        updatedAtMs: f.updatedAt ? new Date(f.updatedAt).getTime() : undefined,
      }));
      state.agentFilesList = { agentId, workspace: workspacePath, files };
    }
  } catch (err) {
    state.agentFilesError = String(err);
  } finally {
    state.agentFilesLoading = false;
  }
}

/** Load the content of one Telegram agent core file into agentFileContents */
export async function loadTelegramAgentFileContent(
  state: TelegramAgentFilesState,
  agentId: string,
  name: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.agentFilesLoading = true;
  state.agentFilesError = null;
  try {
    const res = await state.client!.request<{ filename: string; content: string }>(
      "telegram.agent.getCoreFileContent",
      { agentId, filename: name },
    );
    if (res?.content !== undefined) {
      state.agentFileContents = { ...state.agentFileContents, [name]: res.content };
    }
  } catch (err) {
    state.agentFilesError = String(err);
  } finally {
    state.agentFilesLoading = false;
  }
}

// ─── Scenario types (mirror extensions/telegram-manager/src/types.ts) ────────

export type ChatNode = {
  id: string;
  agentId: string;
  role: "manager" | "client";
  text: string;
  nextNodeId?: string;
  branches?: { keyword: string; nextNodeId: string }[];
  position?: { x: number; y: number };
  createdAt: string;
};

export type FlowNode = {
  id: string;
  agentId: string;
  title: string;
  description?: string;
  chatNodeIds: string[];
  nextFlowNodeIds: string[];
  position?: { x: number; y: number };
  createdAt: string;
};

export type TrainingPair = {
  id: string;
  agentId: string;
  input: string;
  response: string;
  sourceFile: string;
  createdAt: string;
};

// ─── Scenario controller ──────────────────────────────────────────────────────

/** One conversation (personal chat) extracted from a Telegram export */
export type TrainingGroup = {
  chatId: string;
  participantName: string;
  firstDate: string; // ISO date-time of first message in chat
  lastDate: string; // ISO date-time of last message in chat
  pairs: Array<{ input: string; response: string }>;
};

type TelegramScenarioState = TelegramState & {
  telegramChatNodes: ChatNode[];
  telegramChatNodesLoading: boolean;
  telegramChatNodesError: string | null;
  telegramFlowNodes: FlowNode[];
  telegramFlowNodesLoading: boolean;
  telegramTrainingPairs: TrainingPair[];
  telegramTrainingGroups: TrainingGroup[];
  telegramTrainingLoading: boolean;
  telegramTrainingError: string | null;
  telegramShowCreateNodesPrompt: boolean;
};

export async function loadTelegramChatNodes(
  state: TelegramScenarioState,
  agentId: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramChatNodesLoading = true;
  state.telegramChatNodesError = null;
  try {
    const res = await state.client!.request<ChatNode[]>("telegram.scenario.getChatNodes", {
      agentId,
    });
    state.telegramChatNodes = res ?? [];
  } catch (err) {
    const msg = String(err);
    // Silently ignore "unknown method" — handlers may not be deployed yet;
    // nodes are managed in-memory and remain intact.
    if (!msg.includes("unknown method")) {
      state.telegramChatNodesError = msg;
    }
  } finally {
    state.telegramChatNodesLoading = false;
  }
}

export async function loadTelegramFlowNodes(
  state: TelegramScenarioState,
  agentId: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramFlowNodesLoading = true;
  try {
    const res = await state.client!.request<FlowNode[]>("telegram.scenario.getFlowNodes", {
      agentId,
    });
    state.telegramFlowNodes = res ?? [];
  } catch {
    // non-fatal
  } finally {
    state.telegramFlowNodesLoading = false;
  }
}

export async function addTelegramChatNode(
  state: TelegramScenarioState,
  agentId: string,
  role: "manager" | "client",
): Promise<void> {
  const now = new Date().toISOString();
  const node: ChatNode = {
    id: `${agentId}-${role}-${Date.now()}`,
    agentId,
    role,
    text: role === "manager" ? "Сообщение менеджера" : "Сообщение клиента",
    createdAt: now,
  };

  // Persist to gateway when available; usable in-memory regardless
  if (isReady(state)) {
    try {
      await state.client!.request("telegram.scenario.saveChatNode", { agentId, node });
    } catch {
      // Gateway handler not yet deployed — in-memory only
    }
  }

  state.telegramChatNodes = [...state.telegramChatNodes, node];
}

export async function deleteTelegramChatNode(
  state: TelegramScenarioState,
  agentId: string,
  nodeId: string,
): Promise<void> {
  // Remove from in-memory state immediately
  state.telegramChatNodes = state.telegramChatNodes.filter((n) => n.id !== nodeId);

  // Also try gateway; ignore errors (handler may not be deployed)
  if (isReady(state)) {
    try {
      await state.client!.request("telegram.scenario.deleteChatNode", { agentId, nodeId });
    } catch {
      // non-fatal
    }
  }
}

// ─── Client-side Telegram export parser ──────────────────────────────────────

type TgExportMsg = {
  type: string;
  from: string | null;
  from_id: string;
  text: string | unknown[];
  date?: string; // ISO date-time, e.g. "2026-01-23T15:08:29"
};

type TgChat = { type: string; id?: number | string; name?: string; messages?: TgExportMsg[] };

function flattenText(t: string | unknown[]): string {
  if (typeof t === "string") {
    return t.trim();
  }
  return (t as Array<string | { text?: string }>)
    .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
    .join("")
    .trim();
}

/** Parse a Telegram Desktop JSON export and return pairs grouped by conversation. */
function extractGroupedPairs(json: string): TrainingGroup[] {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error("Файл не является корректным JSON.");
  }

  // Supported formats:
  // 1. Single-chat export:  { name, type, id, messages: [...] }
  // 2. Full account export: { about, chats: { list: [ { type, id, messages }, ... ] } }
  let chats: TgChat[] = [];
  let managerFromId: string | null = null;

  if (Array.isArray(data.messages)) {
    // Format 1: wrap as a single chat
    chats = [
      {
        type: "personal_chat",
        id: typeof data.id === "number" ? data.id : 0,
        name: typeof data.name === "string" ? data.name : "",
        messages: data.messages as TgExportMsg[],
      },
    ];
  } else if (data.chats && typeof data.chats === "object") {
    // Format 2: full account export — identify manager via saved_messages
    const list = ((data.chats as Record<string, unknown>).list ?? []) as TgChat[];
    const saved = list.find((c) => c.type === "saved_messages");
    const ownerMsg = (saved?.messages ?? []).find((m) => m.type === "message" && m.from_id);
    if (ownerMsg) {
      managerFromId = ownerMsg.from_id;
    }
    chats = list.filter(
      (c) => c.type === "personal_chat" && Array.isArray(c.messages) && c.messages.length > 0,
    );
  }

  if (chats.length === 0) {
    return [];
  }

  // For single-chat format: detect manager by from === null or most-frequent sender
  if (!managerFromId) {
    const freq: Record<string, number> = {};
    outer: for (const chat of chats) {
      for (const m of chat.messages ?? []) {
        if (m.type !== "message") {
          continue;
        }
        if (m.from === null) {
          managerFromId = m.from_id;
          break outer;
        }
        freq[m.from_id] = (freq[m.from_id] ?? 0) + 1;
      }
    }
    if (!managerFromId) {
      managerFromId = Object.entries(freq).toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
  }

  const groups: TrainingGroup[] = [];

  for (const chat of chats) {
    const messages = chat.messages ?? [];
    const pairs: Array<{ input: string; response: string }> = [];
    const dates: string[] = [];
    let pendingClient: string | null = null;
    let participantName = chat.name ?? "";

    for (const m of messages) {
      if (m.type !== "message") {
        continue;
      }
      const text = flattenText(m.text);
      if (!text) {
        continue;
      }

      const isManager = m.from_id === managerFromId || m.from === null;

      // Capture the client's display name from the first non-manager message
      if (!isManager && !participantName && m.from) {
        participantName = m.from;
      }

      if (m.date) {
        dates.push(m.date);
      }

      if (!isManager) {
        pendingClient = text;
      } else if (pendingClient) {
        pairs.push({ input: pendingClient, response: text });
        pendingClient = null;
      }
    }

    if (pairs.length > 0) {
      const sortedDates = [...dates].toSorted();
      groups.push({
        chatId: String(chat.id ?? groups.length),
        participantName: participantName || "Неизвестный",
        firstDate: sortedDates[0] ?? "",
        lastDate: sortedDates.at(-1) ?? "",
        pairs,
      });
    }
  }

  return groups;
}

export async function processTelegramTrainingFile(
  state: TelegramScenarioState,
  agentId: string,
  json: string,
  fileName: string,
): Promise<void> {
  // No gateway required — parse fully in-browser to avoid WS size limits and
  // dependency on new plugin handlers that may not be deployed yet.
  state.telegramTrainingLoading = true;
  state.telegramTrainingError = null;
  state.telegramShowCreateNodesPrompt = false;
  state.telegramTrainingPairs = [];
  state.telegramTrainingGroups = [];
  try {
    // Yield to the event loop so "Обработка…" renders before the blocking parse
    await new Promise<void>((r) => setTimeout(r, 32));
    const groups = extractGroupedPairs(json);

    if (groups.length === 0) {
      state.telegramTrainingError = "Пары диалога не найдены в файле.";
      return;
    }

    // Store groups + flat pairs in state — no gateway round-trip needed
    state.telegramTrainingGroups = groups;
    const now = new Date().toISOString();
    let idx = 0;
    state.telegramTrainingPairs = groups.flatMap((g) =>
      g.pairs.map((p) => ({
        id: String(idx++),
        agentId,
        input: p.input,
        response: p.response,
        sourceFile: fileName,
        createdAt: now,
      })),
    );
  } catch (err) {
    state.telegramTrainingError = String(err);
  } finally {
    state.telegramTrainingLoading = false;
  }
}

/** Build ChatNodes from a single training group's pairs and append to node list. */
export async function createNodesFromTelegramTraining(
  state: TelegramScenarioState,
  agentId: string,
  group: TrainingGroup,
): Promise<void> {
  const { pairs, chatId } = group;
  if (pairs.length === 0) {
    return;
  }

  const now = new Date().toISOString();
  const nodes: ChatNode[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const clientId = `${chatId}-c-${i}`;
    const managerId = `${chatId}-m-${i}`;
    nodes.push({
      id: clientId,
      agentId,
      role: "client",
      text: pair.input,
      nextNodeId: managerId,
      createdAt: now,
    });
    nodes.push({
      id: managerId,
      agentId,
      role: "manager",
      text: pair.response,
      nextNodeId: i + 1 < pairs.length ? `${chatId}-c-${i + 1}` : undefined,
      createdAt: now,
    });
  }

  // Try to persist to gateway; nodes usable in-memory regardless
  if (isReady(state)) {
    try {
      for (const node of nodes) {
        await state.client!.request("telegram.scenario.saveChatNode", { agentId, node });
      }
    } catch {
      // Gateway handler not yet deployed
    }
  }

  // Append new group's nodes to existing node list
  state.telegramChatNodes = [...state.telegramChatNodes, ...nodes];
}

/** Save a Telegram agent core file via telegram.agent.setCoreFile */
export async function saveTelegramAgentFile(
  state: TelegramAgentFilesState,
  agentId: string,
  name: string,
  content: string,
): Promise<void> {
  if (!isReady(state) || state.agentFileSaving) {
    return;
  }
  state.agentFileSaving = true;
  state.agentFilesError = null;
  try {
    await state.client!.request("telegram.agent.setCoreFile", {
      agentId,
      filename: name,
      content,
    });
    // Update in-memory cache so the editor reflects the saved content immediately
    state.agentFileContents = { ...state.agentFileContents, [name]: content };
    // Reload the file list to refresh timestamps
    await loadTelegramAgentFiles(state, agentId);
  } catch (err) {
    state.agentFilesError = String(err);
    throw err;
  } finally {
    state.agentFileSaving = false;
  }
}
