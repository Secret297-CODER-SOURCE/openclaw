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
