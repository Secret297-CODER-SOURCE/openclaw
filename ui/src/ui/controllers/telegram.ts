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
  /** Schema scope: "personal" (per-agent) or "shared" (across all agents). */
  scope?: "personal" | "shared";
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

// ─── Visual Diagram types ─────────────────────────────────────────────────────

export type DiagramNodeType = "start" | "end" | "process" | "decision";

export type DiagramNode = {
  id: string;
  type: DiagramNodeType;
  text: string;
  x: number;
  y: number;
  groupId?: string;
};

export type DiagramEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  label?: string;
};

export type DiagramGroup = {
  id: string;
  label: string;
  color: "blue" | "green" | "orange" | "purple";
  x: number;
  y: number;
  w: number;
  h: number;
};

export type FlowDiagram = {
  id: string;
  agentId: string;
  scope: TrainingScope;
  title: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  createdAt: string;
  updatedAt: string;
};

/** Lightweight summary used in the collections panel list. */
export type DiagramSummary = {
  id: string;
  title: string;
  nodeCount: number;
  updatedAt: string;
};

// ─── Agent settings ───────────────────────────────────────────────────────────

/** Mirrors AgentSettings from the extension's types.ts. */
export type AgentSettings = {
  activeDiagramId?: string;
  /** "always" | "schedule" | "schema" */
  workMode: "always" | "schedule" | "schema";
  scheduleFrom?: string; // HH:MM
  scheduleTo?: string; // HH:MM
};

// ─── Scenario controller ──────────────────────────────────────────────────────

/** One conversation (personal chat) extracted from a Telegram export */
export type TrainingGroup = {
  chatId: string;
  participantName: string;
  firstDate: string; // ISO date-time of first message in chat
  lastDate: string; // ISO date-time of last message in chat
  pairs: Array<{ input: string; response: string }>;
  /** Manual label: did this chat result in a sale/conversion? */
  label?: "success" | "fail" | "neutral";
};

/** Label assigned to a training chat */
export type TrainingLabel = "success" | "fail" | "neutral";

/** Per-dialog AI analysis result */
export type DialogAnalysisResult = {
  status: TrainingLabel;
  score: number; // 0–100
  reason: string;
  analyzedAt: string; // ISO timestamp
};

type TelegramScenarioState = TelegramState & {
  telegramChatNodes: ChatNode[];
  telegramChatNodesLoading: boolean;
  telegramChatNodesError: string | null;
  telegramFlowNodes: FlowNode[];
  telegramFlowNodesLoading: boolean;
  /** Schema scope: "personal" (per-agent) or "shared" (across all agents). */
  telegramSchemaScope: TrainingScope;
  telegramTrainingPairs: TrainingPair[];
  telegramTrainingGroups: TrainingGroup[];
  telegramTrainingLoading: boolean;
  telegramTrainingError: string | null;
  telegramShowCreateNodesPrompt: boolean;
  // Labels (success/fail/neutral) assigned to each training chat by chatId
  telegramTrainingLabels: Record<string, TrainingLabel>;
  // Whole-dataset AI analysis (freeform text result)
  telegramAnalysisResult: string | null;
  telegramAnalysisLoading: boolean;
  telegramAnalysisError: string | null;
  // Per-dialog AI analysis results
  telegramAnalysisResults: Record<string, DialogAnalysisResult>;
  telegramBatchRunning: boolean;
  telegramBatchProgress: number;
  telegramBatchTotal: number;
  telegramBatchError: string | null;
  /** Non-reactive abort ref — set by runBatchAnalysis, read by cancelBatchAnalysis */
  _telegramBatchAbort?: { cancelled: boolean };
  /** Training scope: personal (per-agentId) or shared (global across agents) */
  telegramTrainingScope: "personal" | "shared";
  /** Visual flowchart diagram for the current agent+scope. */
  telegramDiagram: FlowDiagram | null;
  telegramDiagramLoading: boolean;
  /** All saved diagrams for the current agent+scope. */
  telegramDiagramList: DiagramSummary[];
  telegramDiagramListLoading: boolean;
  /** Coaching tips per chatId (generated on demand, persisted to DB). */
  telegramCoachingTips: Record<string, CoachingTips>;
  /** Set of chatIds for which coaching tips are currently loading. */
  telegramCoachingLoading: Set<string>;
  /** Set of chatIds whose coaching card is currently collapsed. */
  telegramCoachingCollapsed: Set<string>;
  /** Agent work-mode settings (loaded on agent select). */
  telegramAgentSettings: AgentSettings | null;
  telegramAgentSettingsLoading: boolean;
  telegramAgentSettingsSaving: boolean;
  /** Knowledge base distributed from training data to diagram nodes. */
  telegramKnowledgeBase: DiagramKnowledgeBase | null;
  telegramKnowledgeBaseLoading: boolean;
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
  scope: TrainingScope = "personal",
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramFlowNodesLoading = true;
  try {
    const res = await state.client!.request<FlowNode[]>("telegram.scenario.getFlowNodes", {
      agentId,
      scope,
    });
    state.telegramFlowNodes = res ?? [];
  } catch {
    // non-fatal
  } finally {
    state.telegramFlowNodesLoading = false;
  }
}

export async function loadTelegramDiagram(
  state: TelegramScenarioState,
  agentId: string,
  scope: TrainingScope = "personal",
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramDiagramLoading = true;
  try {
    const res = await state.client!.request<FlowDiagram | null>("telegram.scenario.getDiagram", {
      agentId,
      scope,
    });
    state.telegramDiagram = res ?? null;
  } catch {
    // non-fatal — handler may not be deployed yet
  } finally {
    state.telegramDiagramLoading = false;
  }
}

export async function saveTelegramDiagram(
  state: TelegramScenarioState,
  diagram: FlowDiagram,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  try {
    const saved = await state.client!.request<FlowDiagram>("telegram.scenario.saveDiagram", {
      diagram,
    });
    if (saved) {
      state.telegramDiagram = saved;
      // Update the matching entry in the list (or prepend if new)
      const summary: DiagramSummary = {
        id: saved.id,
        title: saved.title,
        nodeCount: saved.nodes.length,
        updatedAt: saved.updatedAt,
      };
      const idx = state.telegramDiagramList.findIndex((s) => s.id === saved.id);
      if (idx >= 0) {
        const next = [...state.telegramDiagramList];
        next[idx] = summary;
        state.telegramDiagramList = next;
      } else {
        state.telegramDiagramList = [summary, ...state.telegramDiagramList];
      }
    }
  } catch {
    // non-fatal
  }
}

/** Load the list of diagram summaries for the current agent+scope. */
export async function loadTelegramDiagramList(
  state: TelegramScenarioState,
  agentId: string,
  scope: TrainingScope,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramDiagramListLoading = true;
  try {
    const list = await state.client!.request<FlowDiagram[]>("telegram.scenario.listDiagrams", {
      agentId,
      scope,
    });
    state.telegramDiagramList = (list ?? []).map((d) => ({
      id: d.id,
      title: d.title,
      nodeCount: d.nodes.length,
      updatedAt: d.updatedAt,
    }));
  } catch {
    // non-fatal
  } finally {
    state.telegramDiagramListLoading = false;
  }
}

/**
 * Load diagrams from BOTH personal and shared scopes and merge them into one
 * flat list for display in the overview settings panel. Shared diagrams are
 * tagged "(общ.)" so the user can distinguish them.
 * Used on agent-select so the active-diagram dropdown is always populated.
 */
export async function loadDiagramListAllScopes(
  state: TelegramScenarioState,
  agentId: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramDiagramListLoading = true;
  try {
    const [personal, shared] = await Promise.all([
      state
        .client!.request<FlowDiagram[]>("telegram.scenario.listDiagrams", {
          agentId,
          scope: "personal",
        })
        .catch(() => [] as FlowDiagram[]),
      state
        .client!.request<FlowDiagram[]>("telegram.scenario.listDiagrams", {
          agentId,
          scope: "shared",
        })
        .catch(() => [] as FlowDiagram[]),
    ]);
    const sharedIds = new Set((shared ?? []).map((d) => d.id));
    const all = [...(personal ?? []), ...(shared ?? [])];
    state.telegramDiagramList = all.map((d) => ({
      id: d.id,
      title: sharedIds.has(d.id) ? `${d.title} (общ.)` : d.title,
      nodeCount: d.nodes.length,
      updatedAt: d.updatedAt,
    }));
  } catch {
    // non-fatal
  } finally {
    state.telegramDiagramListLoading = false;
  }
}

/** Load a specific diagram by ID and set it as the active diagram. */
export async function selectTelegramDiagramById(
  state: TelegramScenarioState,
  agentId: string,
  id: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  // We can re-use saveDiagram with getDiagram or just load the full list and find by id.
  // Simplest: request the full list and find the matching entry.
  try {
    const list = await state.client!.request<FlowDiagram[]>("telegram.scenario.listDiagrams", {
      agentId,
      scope: state.telegramSchemaScope,
    });
    const found = (list ?? []).find((d) => d.id === id) ?? null;
    if (found) {
      state.telegramDiagram = found;
    }
  } catch {
    // non-fatal
  }
}

/** Delete a diagram by ID; also updates the in-memory list and resets active if needed. */
export async function deleteTelegramDiagramById(
  state: TelegramScenarioState,
  id: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  try {
    await state.client!.request("telegram.scenario.deleteDiagram", { id });
    state.telegramDiagramList = state.telegramDiagramList.filter((s) => s.id !== id);
    // If the deleted diagram was active, activate the next one (or clear)
    if (state.telegramDiagram?.id === id) {
      const next = state.telegramDiagramList[0];
      if (next) {
        // Load the full diagram from the server
        await selectTelegramDiagramById(state, state.telegramDiagram.agentId, next.id);
      } else {
        state.telegramDiagram = null;
      }
    }
  } catch {
    // non-fatal
  }
}

/** Rename a diagram title in DB and update in-memory list + active diagram. */
export async function renameTelegramDiagram(
  state: TelegramScenarioState,
  id: string,
  title: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  try {
    await state.client!.request("telegram.scenario.renameDiagram", { id, title });
    // Update list entry
    state.telegramDiagramList = state.telegramDiagramList.map((s) =>
      s.id === id ? { ...s, title } : s,
    );
    // Update active diagram if it's the renamed one
    if (state.telegramDiagram?.id === id) {
      state.telegramDiagram = { ...state.telegramDiagram, title };
    }
  } catch {
    // non-fatal
  }
}

/** Create a new blank diagram, save it to DB, add to list, and activate it. */
export async function createNewTelegramDiagram(
  state: TelegramScenarioState,
  agentId: string,
  scope: TrainingScope,
  title = "Новая схема",
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  const now = new Date().toISOString();
  const blank: FlowDiagram = {
    id: crypto.randomUUID(),
    agentId,
    scope,
    title,
    nodes: [],
    edges: [],
    groups: [],
    createdAt: now,
    updatedAt: now,
  };
  await saveTelegramDiagram(state, blank);
}

/**
 * Send a base64-encoded image to the plugin for AI-powered diagram generation.
 * Returns the generated FlowDiagram on success, null on failure.
 */
export async function importTelegramDiagramFromImage(
  state: TelegramScenarioState,
  agentId: string,
  scope: TrainingScope,
  imageBase64: string,
  mediaType: string,
): Promise<FlowDiagram | null> {
  if (!isReady(state)) {
    throw new Error("Нет соединения с сервером");
  }
  const result = await state.client!.request<FlowDiagram>("telegram.scenario.diagramFromImage", {
    agentId,
    scope,
    imageBase64,
    mediaType,
  });
  if (result) {
    state.telegramDiagram = result;
  }
  return result ?? null;
}

/**
 * Generate a new diagram from a text description, or modify the current diagram
 * based on user instructions. The gateway uses the same AI adapter as the bot.
 *
 * @param prompt   Natural-language description or correction request.
 * @param current  Existing diagram to modify; omit / pass null to generate fresh.
 */
export async function generateDiagramFromText(
  state: TelegramScenarioState,
  agentId: string,
  scope: TrainingScope,
  prompt: string,
  current: FlowDiagram | null,
): Promise<FlowDiagram | null> {
  if (!isReady(state)) {
    throw new Error("Нет соединения с сервером");
  }
  const result = await state.client!.request<FlowDiagram>("telegram.scenario.diagramFromText", {
    agentId,
    scope,
    prompt,
    ...(current && current.nodes.length > 0 ? { currentDiagram: current } : {}),
  });
  if (result) {
    state.telegramDiagram = result;
  }
  return result ?? null;
}

/**
 * Request AI coaching tips for a specific training conversation.
 * Tips are cached in state by chatId so repeated requests are instant.
 */
export async function getCoachingTips(
  state: TelegramScenarioState,
  agentId: string,
  chatId: string,
  pairs: Array<{ input: string; response: string }>,
): Promise<CoachingTips | null> {
  if (!isReady(state)) {
    throw new Error("Нет соединения с сервером");
  }
  if (pairs.length === 0) {
    return null;
  }

  // Mark as loading (use a new Set to trigger reactivity)
  const loadingSet = new Set(state.telegramCoachingLoading);
  loadingSet.add(chatId);
  state.telegramCoachingLoading = loadingSet;

  try {
    const result = await state.client!.request<CoachingTips>("telegram.scenario.getCoachingTips", {
      agentId,
      chatId,
      pairs,
    });
    if (result) {
      state.telegramCoachingTips = { ...state.telegramCoachingTips, [chatId]: result };
    }
    return result ?? null;
  } finally {
    const done = new Set(state.telegramCoachingLoading);
    done.delete(chatId);
    state.telegramCoachingLoading = done;
  }
}

/**
 * Load all persisted coaching tips for an agent from the gateway DB.
 * Merges with any already-in-memory tips so nothing is lost.
 */
export async function loadCoachingTips(
  state: TelegramScenarioState,
  agentId: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  try {
    const result = await state.client!.request<Record<string, CoachingTips>>(
      "telegram.scenario.loadCoachingTips",
      { agentId },
    );
    if (result && typeof result === "object") {
      // Merge: in-memory tips are more recent; DB fills in missing ones
      state.telegramCoachingTips = { ...result, ...state.telegramCoachingTips };
    }
  } catch {
    // Non-fatal — tips are optional
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
  try {
    // Yield to the event loop so "Обработка…" renders before the blocking parse
    await new Promise<void>((r) => setTimeout(r, 32));
    const newGroups = extractGroupedPairs(json);

    if (newGroups.length === 0) {
      state.telegramTrainingError = "Пары диалога не найдены в файле.";
      return;
    }

    // Merge with existing groups: deduplicate by chatId.
    // New file wins on conflict (fresh data), existing groups not in new file are kept.
    const newChatIds = new Set(newGroups.map((g) => g.chatId));
    const merged = [
      ...state.telegramTrainingGroups.filter((g) => !newChatIds.has(g.chatId)),
      ...newGroups,
    ];

    state.telegramTrainingGroups = merged;

    // Rebuild flat pairs list from merged groups
    const now = new Date().toISOString();
    let idx = 0;
    state.telegramTrainingPairs = merged.flatMap((g) =>
      g.pairs.map((p) => ({
        id: String(idx++),
        agentId,
        input: p.input,
        response: p.response,
        sourceFile: newChatIds.has(g.chatId) ? fileName : "(кэш)",
        createdAt: now,
      })),
    );

    // Persist merged groups to gateway + localStorage cache (reads current state)
    await saveTrainingToGateway(state, agentId, state.telegramTrainingScope);
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

// ─── Per-dialog AI Analysis (batch) ───────────────────────────────────────────

/**
 * Prompt sent with every dialog to instruct the AI on evaluation criteria.
 * Returned JSON must match { status, score, reason }.
 */
const DIALOG_ANALYSIS_PROMPT = `Ты анализируешь диалоги менеджеров с клиентами.
Определи успешность диалога.

Критерии успешного диалога:
- менеджер проявляет инициативу
- задаёт уточняющие вопросы
- выявляет потребность клиента
- предлагает решение
- клиент продолжает диалог
- есть признаки движения к сделке

Неуспешный диалог:
- менеджер отвечает односложно
- менеджер не задаёт вопросов
- клиент теряет интерес
- диалог быстро заканчивается
- отсутствует предложение решения

Нейтральный диалог:
- мало сообщений
- диалог не завершён
- недостаточно данных

Ответ верни строго в JSON:
{"status": "success" | "fail" | "neutral", "score": 0-100, "reason": "краткая причина"}

Диалог:`;

/** True if the text is blank, emoji-only, or too short to be meaningful */
function isEmptyOrTrivial(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return true;
  }
  // Strip common emoji unicode blocks; if nothing meaningful remains → trivial
  const stripped = t.replace(/\p{Emoji_Presentation}/gu, "").replace(/\s/g, "");
  return stripped.length === 0;
}

/** Truncate a single message to keep prompts short and AI responses fast */
const MAX_MSG_CHARS = 200;

/**
 * Convert a TrainingGroup's pairs into a formatted dialog string for the AI.
 * Uses the last 10 pairs (enough signal for classification); skips blank /
 * emoji-only turns and truncates long messages to reduce token count.
 */
function formatDialogForAnalysis(group: TrainingGroup): string {
  const pairs = group.pairs.slice(-10);
  const lines: string[] = [];
  for (const pair of pairs) {
    if (!isEmptyOrTrivial(pair.input)) {
      const t = pair.input.trim();
      lines.push(`Клиент: ${t.length > MAX_MSG_CHARS ? t.slice(0, MAX_MSG_CHARS) + "…" : t}`);
    }
    if (!isEmptyOrTrivial(pair.response)) {
      const t = pair.response.trim();
      lines.push(`Менеджер: ${t.length > MAX_MSG_CHARS ? t.slice(0, MAX_MSG_CHARS) + "…" : t}`);
    }
  }
  return lines.join("\n");
}

/** Parse a gateway response into a DialogAnalysisResult, or null if unparseable */
function parseAnalysisResponse(
  res: Record<string, unknown> | null | undefined,
): DialogAnalysisResult | null {
  if (!res) {
    return null;
  }

  // Case 1: fields are top-level on the response object
  if (typeof res.status === "string" && typeof res.score === "number") {
    const status = (
      ["success", "fail", "neutral"].includes(res.status) ? res.status : "neutral"
    ) as TrainingLabel;
    return {
      status,
      score: Math.min(100, Math.max(0, res.score)),
      reason: typeof res.reason === "string" ? res.reason : "",
      analyzedAt: new Date().toISOString(),
    };
  }

  // Case 2: result/text/content field holds a JSON string (AI free-text wrapper)
  const raw = res.result ?? res.text ?? res.content ?? null;
  if (typeof raw === "string") {
    try {
      // Extract the first JSON object from the string (AI may add surrounding text)
      const match = raw.match(/\{[\s\S]*?"status"[\s\S]*?\}/);
      const parsed = JSON.parse(match ? match[0] : raw) as {
        status?: string;
        score?: number;
        reason?: string;
      };
      const status = (
        ["success", "fail", "neutral"].includes(parsed.status ?? "") ? parsed.status : "neutral"
      ) as TrainingLabel;
      return {
        status,
        score: Math.min(100, Math.max(0, parsed.score ?? 50)),
        reason: parsed.reason ?? "",
        analyzedAt: new Date().toISOString(),
      };
    } catch {
      // Unparseable — fall through
    }
  }
  return null;
}

/**
 * Analyze a single dialog via the gateway (used for re-check of individual chats).
 * Calls telegram.tool.call → analyze_dialog.
 */
export async function analyzeDialogChat(
  state: TelegramScenarioState,
  agentId: string,
  group: TrainingGroup,
): Promise<DialogAnalysisResult | null> {
  if (!isReady(state)) {
    return null;
  }
  const dialog = formatDialogForAnalysis(group);
  if (!dialog.trim()) {
    return null;
  }
  try {
    const res = await state.client!.request<Record<string, unknown>>("telegram.tool.call", {
      agentId,
      tool: "analyze_dialog",
      args: { dialog, chatId: group.chatId, prompt: DIALOG_ANALYSIS_PROMPT },
    });
    // Plugin wraps results as { ok: true, data: actualResult }; unwrap before use
    const inner = (res?.data ?? res) as Record<string, unknown>;
    const result = parseAnalysisResponse(inner);
    // Fire-and-forget: generate coaching tips alongside the analysis result
    if (result && group.pairs.length >= 2) {
      void getCoachingTips(state, agentId, group.chatId, group.pairs);
    }
    return result;
  } catch {
    return null;
  }
}

// ─── Batch API (multi-dialog per round-trip) ──────────────────────────────────

type BatchResultItem = {
  chatId: string;
  status: TrainingLabel;
  score: number;
  reason: string;
} | null;

/**
 * Check whether the server-side plugin has a direct AI adapter available
 * (ANTHROPIC_API_KEY / OPENAI_API_KEY). Returns true when inner batch calls
 * bypass the gateway lane and can run in parallel safely.
 * Returns false on any error (safe default → single-dialog mode).
 */
async function checkBatchCapability(
  state: TelegramScenarioState,
  agentId: string,
): Promise<boolean> {
  if (!isReady(state)) {
    return false;
  }
  try {
    const res = await state.client!.request<{ directAdapter: boolean }>("telegram.tool.call", {
      agentId,
      tool: "check_batch_capability",
      args: {},
    });
    // Plugin wraps results as { ok: true, data: actualResult }; unwrap before use
    const inner: { directAdapter?: boolean } = ((res as Record<string, unknown>)?.data ?? res) as {
      directAdapter?: boolean;
    };
    return inner.directAdapter ?? false;
  } catch {
    return false;
  }
}

/**
 * Send N dialogs in ONE AI call (mega-batch).
 * The server packs all dialogs into a single prompt and parses a JSON array response.
 * Works in gateway mode (no direct API key needed) — 1 lane slot for N dialogs → N× faster.
 */
async function analyzeMegaBatch(
  state: TelegramScenarioState,
  agentId: string,
  groups: TrainingGroup[],
): Promise<BatchResultItem[]> {
  if (!isReady(state) || groups.length === 0) {
    return [];
  }
  const dialogs = groups.map((g) => ({
    chatId: g.chatId,
    dialog: formatDialogForAnalysis(g),
  }));
  try {
    const res = await state.client!.request<{ results: BatchResultItem[] }>("telegram.tool.call", {
      agentId,
      tool: "analyze_mega_batch",
      args: { dialogs, prompt: DIALOG_ANALYSIS_PROMPT },
    });
    const inner: { results?: BatchResultItem[] } = ((res as Record<string, unknown>)?.data ??
      res) as { results?: BatchResultItem[] };
    return inner.results ?? [];
  } catch {
    return groups.map(() => null);
  }
}

/**
 * Send a batch of dialogs in ONE WebSocket round-trip.
 * Only effective when isDirectAdapter=true (server uses direct API, no lane).
 */
async function analyzeDialogsBatch(
  state: TelegramScenarioState,
  agentId: string,
  groups: TrainingGroup[],
): Promise<BatchResultItem[]> {
  if (!isReady(state) || groups.length === 0) {
    return [];
  }
  const dialogs = groups.map((g) => ({
    chatId: g.chatId,
    dialog: formatDialogForAnalysis(g),
  }));
  try {
    const res = await state.client!.request<{ results: BatchResultItem[] }>("telegram.tool.call", {
      agentId,
      tool: "analyze_dialogs_batch",
      args: { dialogs, prompt: DIALOG_ANALYSIS_PROMPT },
    });
    // Plugin wraps results as { ok: true, data: actualResult }; unwrap before use
    const inner: { results?: BatchResultItem[] } = ((res as Record<string, unknown>)?.data ??
      res) as { results?: BatchResultItem[] };
    return inner.results ?? [];
  } catch {
    return groups.map(() => null);
  }
}

/**
 * Run batch AI analysis over all (or only un-analyzed) training groups.
 *
 * Strategy is chosen automatically:
 *  • Direct adapter available (ANTHROPIC_API_KEY etc.) →
 *    3 workers × 6 dialogs/request = 18 truly-parallel AI calls, ~10× faster
 *  • Gateway adapter only →
 *    2 workers × 1 dialog/request — safe, no lane congestion, 2× faster
 *
 * Lesson learned: server-side parallelism (inner batching) doesn't help —
 * every AI call (HTTP or WS) goes through the same gateway main lane,
 * so piling up requests only increases queue depth and slows each call.
 *
 * @param force — when true, re-analyzes even already-analyzed chats
 */
// Strategy constants: chosen based on server capability
// Direct adapter (ANTHROPIC_API_KEY etc.) → parallel AI calls per dialog
// Gateway adapter → mega-batch: N dialogs in ONE AI call = N× speedup
const STRATEGY_DIRECT = { concurrency: 5, innerBatch: 8, mega: false, flushEvery: 40 };
const STRATEGY_GATEWAY = { concurrency: 4, innerBatch: 15, mega: true, flushEvery: 60 };

export async function runBatchAnalysis(
  state: TelegramScenarioState,
  agentId: string,
  force = false,
): Promise<void> {
  if (!isReady(state) || state.telegramBatchRunning) {
    return;
  }

  const groups = state.telegramTrainingGroups;
  const candidates = force
    ? groups
    : groups.filter((g) => !state.telegramAnalysisResults[g.chatId]);

  // Fast-path: auto-mark single-pair dialogs as neutral (not enough signal for AI analysis)
  const trivialNow = new Date().toISOString();
  const trivial = candidates.filter((g) => g.pairs.length < 2);
  const toAnalyze = candidates.filter((g) => g.pairs.length >= 2);
  for (const g of trivial) {
    state.telegramAnalysisResults = {
      ...state.telegramAnalysisResults,
      [g.chatId]: {
        status: "neutral",
        score: 0,
        reason: "Слишком мало сообщений",
        analyzedAt: trivialNow,
      },
    };
  }

  if (toAnalyze.length === 0) {
    return;
  }

  const abortRef = { cancelled: false };
  state._telegramBatchAbort = abortRef;
  state.telegramBatchRunning = true;
  state.telegramBatchProgress = 0;
  state.telegramBatchTotal = toAnalyze.length;
  state.telegramBatchError = null;

  // Auto-detect strategy: one round-trip to ask the server if direct API is available
  const hasDirect = await checkBatchCapability(state, agentId);
  const { concurrency, innerBatch, mega, flushEvery } = hasDirect
    ? STRATEGY_DIRECT
    : STRATEGY_GATEWAY;

  // Mutable accumulators — avoid O(n²) spread on every single result
  const accumulated: Record<string, DialogAnalysisResult> = {
    ...state.telegramAnalysisResults,
  };
  const accumulatedLabels: Record<string, TrainingLabel> = {
    ...state.telegramTrainingLabels,
  };

  // Pre-slice into chunks of innerBatch (chunk array is read-only, so index is shared safely)
  const chunks: TrainingGroup[][] = [];
  for (let i = 0; i < toAnalyze.length; i += innerBatch) {
    chunks.push(toAnalyze.slice(i, i + innerBatch));
  }

  let nextChunkIdx = 0;
  let completedCount = 0;

  const flush = async () => {
    state.telegramAnalysisResults = { ...accumulated };
    state.telegramTrainingLabels = { ...accumulatedLabels };
    // Persist incremental results so progress survives a page reload (reads current state)
    void saveTrainingToGateway(state, agentId, state.telegramTrainingScope);
    await new Promise<void>((r) => setTimeout(r, 0));
  };

  const processResult = (group: TrainingGroup, result: DialogAnalysisResult | null) => {
    if (result) {
      accumulated[group.chatId] = result;
      if (!accumulatedLabels[group.chatId]) {
        accumulatedLabels[group.chatId] = result.status;
      }
    }
    completedCount++;
    state.telegramBatchProgress = completedCount;
  };

  // Helper: process a batch of results (shared between mega and direct batch paths)
  const processBatchResults = (chunk: TrainingGroup[], batchResults: BatchResultItem[]) => {
    const now = new Date().toISOString();
    for (let j = 0; j < chunk.length; j++) {
      const item = batchResults[j] ?? null;
      const result: DialogAnalysisResult | null = item
        ? { status: item.status, score: item.score, reason: item.reason, analyzedAt: now }
        : null;
      processResult(chunk[j], result);
    }
  };

  // Worker: pulls chunks from the shared queue (JS single-thread → chunkIdx++ is atomic)
  const worker = async () => {
    while (nextChunkIdx < chunks.length && !abortRef.cancelled) {
      const ci = nextChunkIdx++;
      if (ci >= chunks.length) {
        break;
      }
      const chunk = chunks[ci];

      if (mega) {
        // Mega-batch: all N dialogs in ONE AI call → N× fewer lane slots used
        const batchResults = await analyzeMegaBatch(state, agentId, chunk);
        processBatchResults(chunk, batchResults);
      } else if (innerBatch > 1) {
        // Direct: parallel AI calls per dialog (bypasses gateway lane)
        const batchResults = await analyzeDialogsBatch(state, agentId, chunk);
        processBatchResults(chunk, batchResults);
      } else {
        // Single-dialog fallback
        const result = await analyzeDialogChat(state, agentId, chunk[0]);
        processResult(chunk[0], result);
      }

      if (completedCount % flushEvery === 0) {
        await flush();
      }
    }
  };

  try {
    await Promise.allSettled(Array.from({ length: concurrency }, worker));
  } catch (err) {
    state.telegramBatchError = String(err);
  } finally {
    await flush();
    state.telegramBatchRunning = false;
  }

  // Background: generate coaching tips for dialogs that were just analyzed (concurrency=2)
  // Runs after batch so it doesn't compete with the analysis lane.
  if (!abortRef.cancelled && isReady(state)) {
    const tipsNeeded = toAnalyze.filter(
      (g) => accumulated[g.chatId] && !state.telegramCoachingTips[g.chatId] && g.pairs.length >= 2,
    );
    if (tipsNeeded.length > 0) {
      const TIPS_CONCURRENCY = 2;
      let tipIdx = 0;
      const tipsWorker = async () => {
        while (tipIdx < tipsNeeded.length && !abortRef.cancelled) {
          const ci = tipIdx++;
          if (ci >= tipsNeeded.length) {
            break;
          }
          const g = tipsNeeded[ci];
          try {
            await getCoachingTips(state, agentId, g.chatId, g.pairs);
          } catch {
            // Non-fatal — keep generating for others
          }
        }
      };
      // Fire-and-forget so the function returns immediately
      void Promise.allSettled(Array.from({ length: TIPS_CONCURRENCY }, tipsWorker));
    }
  }
}

/** Cancel a running batch analysis. Safe to call even when not running. */
export function cancelBatchAnalysis(state: TelegramScenarioState): void {
  if (state._telegramBatchAbort) {
    state._telegramBatchAbort.cancelled = true;
  }
  state.telegramBatchRunning = false;
}

// ─── AI Analysis (whole-dataset freeform) ─────────────────────────────────────

/**
 * Send labeled training pairs to the gateway for AI analysis.
 * Builds a structured JSON payload and calls telegram.tool.call →
 * analyze_training_data. Returns the AI's text response.
 */
export async function analyzeTrainingData(
  state: TelegramScenarioState,
  agentId: string,
): Promise<void> {
  if (!isReady(state) || state.telegramAnalysisLoading) {
    return;
  }

  const groups = state.telegramTrainingGroups;
  const labels = state.telegramTrainingLabels;

  const labeled = groups.filter((g) => labels[g.chatId] && labels[g.chatId] !== "neutral");
  if (labeled.length === 0 && groups.length === 0) {
    state.telegramAnalysisError = "Нет чатов для анализа. Загрузите экспорт переписки.";
    return;
  }

  state.telegramAnalysisLoading = true;
  state.telegramAnalysisError = null;
  state.telegramAnalysisResult = null;

  try {
    // Build compact payload: success and fail chats with their pairs
    const payload: {
      success: Array<{ name: string; pairs: Array<{ q: string; a: string }> }>;
      fail: Array<{ name: string; pairs: Array<{ q: string; a: string }> }>;
      total: number;
      labeled: number;
    } = {
      success: [],
      fail: [],
      total: groups.length,
      labeled: 0,
    };

    for (const g of groups) {
      const label = labels[g.chatId] ?? "neutral";
      if (label === "success" || label === "fail") {
        payload.labeled++;
        const entry = {
          name: g.participantName,
          pairs: g.pairs.slice(0, 20).map((p) => ({ q: p.input, a: p.response })),
        };
        if (label === "success") {
          payload.success.push(entry);
        } else {
          payload.fail.push(entry);
        }
      }
    }

    if (payload.labeled === 0) {
      // Still allow analysis — pass all as "unclassified" for general review
      for (const g of groups.slice(0, 10)) {
        payload.success.push({
          name: g.participantName,
          pairs: g.pairs.slice(0, 10).map((p) => ({ q: p.input, a: p.response })),
        });
        payload.labeled++;
      }
    }

    const res = await state.client!.request<{ result?: string; text?: string; content?: string }>(
      "telegram.tool.call",
      {
        agentId,
        tool: "analyze_training_data",
        args: payload,
      },
    );

    // Plugin wraps results as { ok: true, data: actualResult }; unwrap before use
    const inner = ((res as Record<string, unknown>)?.data ?? res) as Record<string, unknown> | null;
    // Accept result from various response shapes
    const text = inner?.["result"] ?? inner?.["text"] ?? inner?.["content"] ?? null;
    if (typeof text === "string") {
      state.telegramAnalysisResult = text;
    } else {
      // Gateway handler may not exist yet — show raw response for debugging
      state.telegramAnalysisResult = JSON.stringify(inner, null, 2);
    }
  } catch (err) {
    state.telegramAnalysisError = String(err);
  } finally {
    state.telegramAnalysisLoading = false;
  }
}

// ─── Webchat (Telegram-Web-like) ──────────────────────────────────────────────

/** A single dialog entry returned by get_dialogs tool */
export type TelegramDialog = {
  id: string;
  name: string;
  type: "user" | "group" | "channel";
  username: string | null;
  lastMessage: string;
  lastMessageDate: string | null;
  unreadCount: number;
  lastMessageOut: boolean;
};

/** A single message returned by getMessages tool (with out field) */
export type TelegramWebMessage = {
  id: string;
  text: string;
  date: string | null;
  out: boolean;
  hasMedia: boolean;
  mediaType: string | null;
};

type WebchatState = TelegramState & {
  telegramWebchatDialogs: TelegramDialog[];
  telegramWebchatDialogsLoading: boolean;
  telegramWebchatDialogsError: string | null;
  telegramWebchatSelectedId: string | null;
  telegramWebchatMessages: TelegramWebMessage[];
  telegramWebchatMessagesLoading: boolean;
  telegramWebchatInput: string;
  telegramWebchatSending: boolean;
  telegramWebchatSearchQuery: string;
};

/** Load recent dialogs from the userbot agent */
export async function loadWebchatDialogs(state: WebchatState, agentId: string): Promise<void> {
  if (!isReady(state) || state.telegramWebchatDialogsLoading) {
    return;
  }
  state.telegramWebchatDialogsLoading = true;
  state.telegramWebchatDialogsError = null;
  try {
    const res = await state.client!.request<TelegramDialog[]>("telegram.tool.call", {
      agentId,
      tool: "get_dialogs",
      args: { limit: 30 },
    });
    // Plugin wraps results as { ok: true, data: actualResult }; unwrap before use
    const dialogs = ((res as unknown as Record<string, unknown>)?.data ?? res) as unknown;
    state.telegramWebchatDialogs = Array.isArray(dialogs) ? (dialogs as TelegramDialog[]) : [];
  } catch (err) {
    state.telegramWebchatDialogsError = String(err);
  } finally {
    state.telegramWebchatDialogsLoading = false;
  }
}

/** Load message history for a dialog */
export async function loadWebchatMessages(
  state: WebchatState,
  agentId: string,
  dialogId: string,
  silent = false,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  if (!silent) {
    state.telegramWebchatMessagesLoading = true;
  }
  try {
    const res = await state.client!.request<TelegramWebMessage[]>("telegram.tool.call", {
      agentId,
      tool: "getMessages",
      args: { target: dialogId, limit: 50 },
    });
    // Plugin wraps results as { ok: true, data: actualResult }; unwrap before use
    const msgs = ((res as unknown as Record<string, unknown>)?.data ?? res) as unknown;
    if (Array.isArray(msgs)) {
      // GramJS returns newest-first; reverse so oldest is on top
      state.telegramWebchatMessages = ([...msgs] as TelegramWebMessage[]).toReversed();
    }
  } catch {
    // Silent fail during polling
  } finally {
    if (!silent) {
      state.telegramWebchatMessagesLoading = false;
    }
  }
}

/** Send a message to the selected dialog */
export async function sendWebchatMessage(
  state: WebchatState,
  agentId: string,
  dialogId: string,
  message: string,
): Promise<void> {
  if (!isReady(state) || !message.trim() || state.telegramWebchatSending) {
    return;
  }
  state.telegramWebchatSending = true;
  try {
    await state.client!.request("telegram.tool.call", {
      agentId,
      tool: "sendMessage",
      args: { target: dialogId, message: message.trim() },
    });
    // Refresh messages after successful send
    await loadWebchatMessages(state, agentId, dialogId, true);
  } catch {
    // Non-fatal
  } finally {
    state.telegramWebchatSending = false;
  }
}

// ─── Training persistence (gateway + localStorage fallback) ───────────────────

const LS_TRAINING_PREFIX = "openclaw_tg_training_";
const LS_SCOPE_PREFIX = "openclaw_tg_scope_";

/** Training data scope — personal keeps data per-agent; shared is readable by all agents. */
export type TrainingScope = "personal" | "shared";

// ─── Coaching tips ────────────────────────────────────────────────────────────

/** AI-generated coaching tips for a single training conversation. */
export type CoachingTips = {
  chatId: string;
  /** Formatted text with numbered tips from the AI (already in Russian). */
  content: string;
  generatedAt: string;
};

// ─── Diagram knowledge base types ────────────────────────────────────────────

/** A single training pair with quality score (3=success, 2=neutral, 1=fail). */
export type DiagramKnowledgePair = {
  input: string;
  response: string;
  score: number;
  label?: "success" | "fail" | "neutral";
};

/** Training pairs assigned to one diagram node. */
export type DiagramNodeKnowledge = {
  nodeId: string;
  nodeText: string;
  pairs: DiagramKnowledgePair[];
};

/**
 * Full knowledge base: training pairs distributed across diagram nodes via AI.
 * Stored per (agentId, scope) and injected into the bot system prompt so it
 * follows the conversation flow and uses grounded examples.
 */
export type DiagramKnowledgeBase = {
  agentId: string;
  scope: TrainingScope;
  entries: DiagramNodeKnowledge[];
  updatedAt: string;
};

/**
 * Persist the selected scope for a given tab + agent so it survives page reloads.
 * Tab is "training" or "schema"; agentId identifies which agent the choice belongs to.
 */
export function saveAgentScope(
  tab: "training" | "schema",
  agentId: string,
  scope: TrainingScope,
): void {
  try {
    localStorage.setItem(`${LS_SCOPE_PREFIX}${tab}_${agentId}`, scope);
  } catch {
    // Non-fatal — localStorage may be unavailable in some browsers/contexts.
  }
}

/**
 * Restore the last-saved scope for a given tab + agent.
 * Returns "personal" as the default if nothing is persisted yet.
 */
export function loadAgentScope(tab: "training" | "schema", agentId: string): TrainingScope {
  try {
    const val = localStorage.getItem(`${LS_SCOPE_PREFIX}${tab}_${agentId}`);
    if (val === "personal" || val === "shared") {
      return val;
    }
  } catch {
    // Non-fatal
  }
  return "personal";
}

export type TrainingSnapshot = {
  groups: TrainingGroup[];
  labels: Record<string, TrainingLabel>;
  analysisResults: Record<string, DialogAnalysisResult>;
  savedAt: string;
};

/** Derive the localStorage key for a given scope (shared uses a single well-known key). */
function trainingLsKey(scope: TrainingScope, agentId: string): string {
  return scope === "shared" ? "shared" : agentId;
}

/**
 * Build the flat TrainingPair list from groups.
 * The flat list is used for aggregate counts; individual display uses groups directly.
 */
export function buildFlatPairs(groups: TrainingGroup[], agentId: string): TrainingPair[] {
  const now = new Date().toISOString();
  let idx = 0;
  return groups.flatMap((g) =>
    g.pairs.map((p) => ({
      id: String(idx++),
      agentId,
      input: p.input,
      response: p.response,
      sourceFile: "(кэш)",
      createdAt: now,
    })),
  );
}

/** Apply a deserialized snapshot into reactive state and rebuild the flat pairs list. */
export function applyTrainingSnapshot(
  state: TelegramScenarioState,
  agentId: string,
  saved: TrainingSnapshot,
): void {
  state.telegramTrainingGroups = saved.groups;
  state.telegramTrainingLabels = saved.labels ?? {};
  state.telegramAnalysisResults = saved.analysisResults ?? {};
  state.telegramTrainingPairs = buildFlatPairs(saved.groups, agentId);
}

/**
 * Save the current training state to the gateway (primary) and localStorage (fast local cache).
 * Reads groups/labels/results directly from state — callers must update state first.
 * The gateway is the source of truth when connected; localStorage provides instant reads offline.
 */
export async function saveTrainingToGateway(
  state: TelegramScenarioState,
  agentId: string,
  scope: TrainingScope,
): Promise<void> {
  const snapshot: TrainingSnapshot = {
    groups: state.telegramTrainingGroups,
    labels: state.telegramTrainingLabels,
    analysisResults: state.telegramAnalysisResults,
    savedAt: new Date().toISOString(),
  };
  // Write to localStorage immediately as a fast local cache (non-critical)
  try {
    localStorage.setItem(
      `${LS_TRAINING_PREFIX}${trainingLsKey(scope, agentId)}`,
      JSON.stringify(snapshot),
    );
  } catch {
    // Quota exceeded or unavailable — skip silently
  }
  // Persist to gateway if connected
  if (!isReady(state)) {
    return;
  }
  try {
    await state.client!.request("telegram.scenario.saveTrainingSnapshot", {
      agentId,
      scope,
      snapshot: snapshot as unknown as Record<string, unknown>,
    });
  } catch {
    // Non-fatal — localStorage cache is still available
  }
}

/**
 * Parse a raw JSON string, apply it as a training snapshot, and persist to gateway + localStorage.
 * Used by the inline JSON editor — throws on invalid JSON or missing groups array.
 */
export async function applyTrainingEditorSave(
  state: TelegramScenarioState,
  agentId: string,
  scope: TrainingScope,
  json: string,
): Promise<void> {
  const parsed = JSON.parse(json) as TrainingSnapshot;
  if (!Array.isArray(parsed.groups)) {
    throw new Error("Неверный формат: ожидается объект с массивом groups");
  }
  applyTrainingSnapshot(state, agentId, parsed);
  await saveTrainingToGateway(state, agentId, scope);
}

/**
 * Load training snapshot: tries the gateway first (authoritative), falls back to
 * localStorage so data is always shown even when offline.
 */
export async function loadTrainingFromGateway(
  state: TelegramScenarioState,
  agentId: string,
  scope: TrainingScope,
): Promise<void> {
  // Try gateway first when connected
  if (isReady(state)) {
    try {
      const raw = await state.client!.request<TrainingSnapshot | null>(
        "telegram.scenario.getTrainingSnapshot",
        { agentId, scope },
      );
      if (raw && Array.isArray(raw.groups) && raw.groups.length > 0) {
        applyTrainingSnapshot(state, agentId, raw);
        return;
      }
    } catch {
      // Gateway unavailable — fall through to localStorage
    }
  }
  // Fallback: localStorage cache
  try {
    const raw = localStorage.getItem(`${LS_TRAINING_PREFIX}${trainingLsKey(scope, agentId)}`);
    if (!raw) {
      return;
    }
    const saved = JSON.parse(raw) as TrainingSnapshot;
    if (!Array.isArray(saved.groups) || saved.groups.length === 0) {
      return;
    }
    applyTrainingSnapshot(state, agentId, saved);
    // Write-back: sync localStorage data into gateway SQLite so subsequent
    // restarts find the data in the authoritative store (not just the local cache).
    if (isReady(state)) {
      void saveTrainingToGateway(state, agentId, scope);
    }
  } catch {
    // Corrupt data — silently ignore
  }
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

// ─── Knowledge base controllers ──────────────────────────────────────────────

/** Load the stored knowledge base for the given agent + scope. */
export async function loadKnowledgeBase(
  state: TelegramScenarioState,
  agentId: string,
  scope: TrainingScope,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramKnowledgeBaseLoading = true;
  try {
    const result = await state.client!.request<DiagramKnowledgeBase | null>(
      "telegram.scenario.getKnowledgeBase",
      { agentId, scope },
    );
    state.telegramKnowledgeBase = result ?? null;
  } catch {
    state.telegramKnowledgeBase = null;
  } finally {
    state.telegramKnowledgeBaseLoading = false;
  }
}

/**
 * Ask the AI to distribute training pairs from the given scope to diagram nodes.
 * Updates the stored knowledge base and returns it.
 *
 * Strategy for finding training data:
 *   1. If the current training-tab scope matches `scope`, the groups are already
 *      loaded in memory — pass them directly so no gateway snapshot is required.
 *   2. Otherwise load the training snapshot for the target scope from the gateway
 *      first, then pass the groups along with the request.
 *   3. The gateway will use the provided groups when present and fall back to its
 *      own saved snapshot only as a last resort.
 */
export async function distributeTrainingToNodes(
  state: TelegramScenarioState,
  agentId: string,
  scope: TrainingScope,
): Promise<DiagramKnowledgeBase | null> {
  if (!isReady(state)) {
    throw new Error("Нет соединения с сервером");
  }
  state.telegramKnowledgeBaseLoading = true;
  try {
    // Collect training groups for the matching scope.
    let groups: TrainingGroup[] | undefined;
    if (state.telegramTrainingScope === scope && state.telegramTrainingGroups.length > 0) {
      // Happy path: the right scope is already active in the training tab.
      groups = state.telegramTrainingGroups;
    } else {
      // Different scope active — try to load the snapshot from the gateway.
      try {
        const snap = await state.client!.request<{
          groups?: TrainingGroup[];
          labels?: Record<string, TrainingLabel>;
        } | null>("telegram.scenario.getTrainingSnapshot", { agentId, scope });
        if (snap?.groups && snap.groups.length > 0) {
          groups = snap.groups;
        }
      } catch {
        // Non-fatal: gateway will attempt to read its own snapshot.
      }
      // Also try localStorage as a further fallback.
      if (!groups || groups.length === 0) {
        try {
          const lsKey = `${LS_TRAINING_PREFIX}${scope === "shared" ? "shared" : agentId}`;
          const raw = localStorage.getItem(lsKey);
          if (raw) {
            const parsed = JSON.parse(raw) as { groups?: TrainingGroup[] };
            if (parsed.groups && parsed.groups.length > 0) {
              groups = parsed.groups;
            }
          }
        } catch {
          // Non-fatal
        }
      }
    }

    const result = await state.client!.request<DiagramKnowledgeBase>(
      "telegram.scenario.distributeTrainingToNodes",
      {
        agentId,
        scope,
        // Send the groups so the gateway doesn't need a saved snapshot.
        ...(groups && groups.length > 0 ? { groups } : {}),
      },
    );
    if (result) {
      state.telegramKnowledgeBase = result;
    }
    return result ?? null;
  } finally {
    state.telegramKnowledgeBaseLoading = false;
  }
}

// ─── Agent settings ───────────────────────────────────────────────────────────

/** Load agent work-mode settings from the gateway. */
export async function loadAgentSettings(
  state: TelegramScenarioState,
  agentId: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramAgentSettingsLoading = true;
  try {
    const res = await state.client!.request<AgentSettings>("telegram.agent.getSettings", {
      agentId,
    });
    state.telegramAgentSettings = res ?? { workMode: "always" };
  } catch {
    state.telegramAgentSettings = { workMode: "always" };
  } finally {
    state.telegramAgentSettingsLoading = false;
  }
}

/** Persist agent work-mode settings to the gateway. */
export async function saveAgentSettings(
  state: TelegramScenarioState,
  agentId: string,
  settings: AgentSettings,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramAgentSettingsSaving = true;
  try {
    await state.client!.request<{ ok: boolean; settings: AgentSettings }>(
      "telegram.agent.setSettings",
      { agentId, settings },
    );
    state.telegramAgentSettings = settings;
  } catch {
    // non-fatal
  } finally {
    state.telegramAgentSettingsSaving = false;
  }
}
