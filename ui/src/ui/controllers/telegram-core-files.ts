import type { GatewayBrowserClient } from "../gateway.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TelegramCoreFile = {
  name: string;
  sizeBytes?: number;
  updatedAt?: string;
  missing?: boolean;
};

export type TelegramCoreFilesState = {
  client?: GatewayBrowserClient | null;
  telegramCoreFiles: TelegramCoreFile[] | null;
  telegramCoreFilesLoading: boolean;
  telegramCoreFilesError: string | null;
  telegramCoreFilesSelectedFile: string | null;
  telegramCoreFileContent: string | null;
  telegramCoreFileSaving: boolean;
};

export const TELEGRAM_CORE_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isReady(state: TelegramCoreFilesState): boolean {
  return !!state.client;
}

// ─── Load core files ──────────────────────────────────────────────────────────

export async function loadTelegramAgentCoreFiles(
  state: TelegramCoreFilesState,
  agentId: string,
): Promise<void> {
  if (!isReady(state) || state.telegramCoreFilesLoading) {
    return;
  }
  state.telegramCoreFilesLoading = true;
  state.telegramCoreFilesError = null;
  try {
    const res = await state.client!.request<{ files: TelegramCoreFile[]; workspacePath?: string }>(
      "telegram.agent.getCoreFiles",
      { agentId },
    );
    state.telegramCoreFiles = res?.files ?? [];
  } catch (err) {
    state.telegramCoreFilesError = String(err);
  } finally {
    state.telegramCoreFilesLoading = false;
  }
}

// ─── Load file content ────────────────────────────────────────────────────────

export async function getTelegramCoreFileContent(
  state: TelegramCoreFilesState,
  agentId: string,
  filename: string,
): Promise<void> {
  if (!isReady(state)) {
    return;
  }
  state.telegramCoreFilesSelectedFile = filename;
  state.telegramCoreFileContent = null;
  state.telegramCoreFilesError = null;
  try {
    const res = await state.client!.request<{
      ok: boolean;
      data?: { filename: string; content: string };
    }>("telegram.tool.call", {
      agentId,
      tool: "getCoreFile",
      args: { filename },
    });
    // Fall back to HTTP endpoint if tool call doesn't work
    const content =
      (res as unknown as { data?: { content?: string }; content?: string })?.data?.content ??
      (res as unknown as { content?: string })?.content ??
      "";
    state.telegramCoreFileContent = content;
  } catch (err) {
    state.telegramCoreFilesError = String(err);
  }
}

// ─── Save file content ────────────────────────────────────────────────────────

export async function saveTelegramAgentCoreFile(
  state: TelegramCoreFilesState,
  agentId: string,
  filename: string,
  content: string,
): Promise<void> {
  if (!isReady(state) || state.telegramCoreFileSaving) {
    return;
  }
  state.telegramCoreFileSaving = true;
  state.telegramCoreFilesError = null;
  try {
    await state.client!.request("telegram.agent.setCoreFile", {
      agentId,
      filename,
      content,
    });
    // Reload the file list to get updated timestamps
    await loadTelegramAgentCoreFiles(state, agentId);
  } catch (err) {
    state.telegramCoreFilesError = String(err);
    throw err;
  } finally {
    state.telegramCoreFileSaving = false;
  }
}
