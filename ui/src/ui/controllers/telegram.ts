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
