import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  TelegramAgentEvent,
  TelegramAgentRecord,
  TaskSession,
  AgentMissionRecord,
  AgentCommMessageRecord,
} from "../controllers/telegram.ts";
import {
  formatCronPayload,
  formatCronSchedule,
  formatCronState,
  formatNextRun,
} from "../presenter.ts";
import type { AgentsFilesListResult, CronJob, CronStatus } from "../types.ts";
import { renderAgentFiles } from "./agents-panels-status-files.ts";
import { formatRelativeTimestamp } from "../format.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TelegramPanel =
  | "overview"
  | "auth"
  | "chat"
  | "schemas"
  | "behaviors"
  | "events"
  | "cron"
  | "files"
  | "tasks"
  | "communication";

export type TelegramProps = {
  loading: boolean;
  error: string | null;
  agents: TelegramAgentRecord[];
  selectedAgentId: string | null;
  activePanel: TelegramPanel;
  busy: boolean;
  busyAgentId: string | null;
  authStep: "idle" | "awaiting_code" | "done" | "error";
  authError: string | null;
  recentEvents: TelegramAgentEvent[];
  // Create form
  createName: string;
  createType: "userbot" | "bot";
  createPhone: string;
  createToken: string;
  // OTP auth
  otpCode: string;
  otpPassword: string;
  // Behavior editor (raw JSON)
  behaviorsJson: string;
  behaviorsJsonError: string | null;
  // Credentials setup (null = not yet loaded, false = not configured, true = ok)
  apiIdConfigured: boolean | null;
  setupApiId: string;
  setupApiHash: string;
  // Proxy fields on the credentials card (used during initial setup)
  setupProxyIp: string;
  setupProxyPort: string;
  setupProxyUsername: string;
  setupProxyPassword: string;
  setupSaving: boolean;
  setupError: string | null;
  // Proxy settings (accessible after initial setup via empty-state panel)
  proxyConfigured: boolean;
  proxyIp: string;
  proxyPort: string;
  proxyEditIp: string;
  proxyEditPort: string;
  proxyEditUsername: string;
  proxyEditPassword: string;
  proxySaving: boolean;
  proxyError: string | null;
  // Callbacks
  onRefresh: () => void;
  onSelectAgent: (id: string | null) => void;
  onSelectPanel: (panel: TelegramPanel) => void;
  onCreateNameChange: (v: string) => void;
  onCreateTypeChange: (v: "userbot" | "bot") => void;
  onCreatePhoneChange: (v: string) => void;
  onCreateTokenChange: (v: string) => void;
  onCreateSubmit: () => void;
  onDelete: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onRestart: (id: string) => void;
  onAuthStart: (id: string) => void;
  onOtpCodeChange: (v: string) => void;
  onOtpPasswordChange: (v: string) => void;
  onAuthSubmit: (id: string) => void;
  onBehaviorsJsonChange: (v: string) => void;
  onBehaviorsSave: (id: string) => void;
  onSetupApiIdChange: (v: string) => void;
  onSetupApiHashChange: (v: string) => void;
  onSetupProxyIpChange: (v: string) => void;
  onSetupProxyPortChange: (v: string) => void;
  onSetupProxyUsernameChange: (v: string) => void;
  onSetupProxyPasswordChange: (v: string) => void;
  onSetupSave: () => void;
  onProxyEditIpChange: (v: string) => void;
  onProxyEditPortChange: (v: string) => void;
  onProxyEditUsernameChange: (v: string) => void;
  onProxyEditPasswordChange: (v: string) => void;
  onProxySave: () => void;
  onProxyClear: () => void;
  // Cron panel
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  cronLoading: boolean;
  cronError: string | null;
  onCronRefresh: () => void;
  // Files panel (core files)
  agentFilesList: AgentsFilesListResult | null;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFileActive: string | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileSaving: boolean;
  onLoadFiles: (agentId: string) => void;
  onSelectFile: (name: string) => void;
  onFileDraftChange: (name: string, content: string) => void;
  onFileReset: (name: string) => void;
  onFileSave: (name: string) => void;
  // Tasks panel
  taskSessions: TaskSession[];
  tasksLoading: boolean;
  tasksError: string | null;
  tasksBusy: boolean;
  taskFormChatId: string;
  taskFormTask: string;
  taskFormSystemPrompt: string;
  taskFormOpeningMessage: string;
  onTasksRefresh: (agentId: string) => void;
  onTaskFormChatIdChange: (v: string) => void;
  onTaskFormTaskChange: (v: string) => void;
  onTaskFormSystemPromptChange: (v: string) => void;
  onTaskFormOpeningMessageChange: (v: string) => void;
  onTaskAssign: (agentId: string) => void;
  onTaskComplete: (agentId: string, sessionId: string) => void;
  // Communication structure panel
  missions: AgentMissionRecord[];
  missionsLoading: boolean;
  missionsError: string | null;
  missionsBusy: boolean;
  missionMessages: AgentCommMessageRecord[];
  selectedMissionId: string | null;
  missionCreateTitle: string;
  missionCreateGoal: string;
  missionCreateSystemPrompt: string;
  missionCreateParticipantIds: string[];
  missionSendFromId: string;
  missionSendToId: string;
  missionSendContent: string;
  onMissionsRefresh: () => void;
  onMissionCreateTitleChange: (v: string) => void;
  onMissionCreateGoalChange: (v: string) => void;
  onMissionCreateSystemPromptChange: (v: string) => void;
  onMissionCreateParticipantIdsChange: (ids: string[]) => void;
  onMissionCreate: (masterAgentId: string) => void;
  onMissionComplete: (missionId: string) => void;
  onMissionViewMessages: (missionId: string) => void;
  onMissionBack: () => void;
  onMissionSendFromIdChange: (v: string) => void;
  onMissionSendToIdChange: (v: string) => void;
  onMissionSendContentChange: (v: string) => void;
  onMissionSend: (missionId: string) => void;
  // Chat panel
  chatViewMode: "chat" | "nodes";
  onChatViewModeChange: (mode: "chat" | "nodes") => void;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusChipClass(status: string): string {
  switch (status) {
    case "running":
      return "chip chip-ok";
    case "starting":
      return "chip chip-warn";
    case "error":
      return "chip chip-danger";
    default:
      return "chip";
  }
}

function avatarStyle(status: string): string {
  switch (status) {
    case "running":
      return "background: var(--ok); color: white;";
    case "starting":
      return "background: var(--warn); color: white;";
    case "error":
      return "background: var(--danger); color: white;";
    default:
      return "";
  }
}

function agentInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "T";
}

function isBusy(props: TelegramProps, agentId: string): boolean {
  return props.busy && props.busyAgentId === agentId;
}

// ─── Sidebar: agent list ──────────────────────────────────────────────────────

function renderSidebar(props: TelegramProps) {
  return html`
    <section class="card agents-sidebar">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t("tabs.telegram")}</div>
          <div class="card-sub">${props.agents.length} ${t("ui.configured")}.</div>
        </div>
        <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("ui.loading") : t("ui.refresh")}
        </button>
      </div>

      ${props.error ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>` : nothing}

      <div class="agent-list" style="margin-top: 12px;">
        ${
          props.agents.length === 0 && !props.loading
            ? html`
                <div class="muted">${t("ui.noAgents")}</div>
              `
            : props.agents.map(
                (agent) => html`
                  <button
                    type="button"
                    class="agent-row ${props.selectedAgentId === agent.id ? "active" : ""}"
                    @click=${() => props.onSelectAgent(agent.id)}
                  >
                    <div class="agent-avatar" style="${avatarStyle(agent.status)}">
                      ${agentInitial(agent.name)}
                    </div>
                    <div class="agent-info">
                      <div class="agent-title">${agent.name}</div>
                      <div class="agent-sub">${agent.type} · ${agent.status}</div>
                    </div>
                  </button>
                `,
              )
        }
      </div>

      ${renderCreateForm(props)}
    </section>
  `;
}

// ─── Create agent form ────────────────────────────────────────────────────────

function renderCreateForm(props: TelegramProps) {
  const isUserbot = props.createType === "userbot";
  const canSubmit =
    props.createName.trim() !== "" &&
    (isUserbot ? props.createPhone.trim() !== "" : props.createToken.trim() !== "");

  return html`
    <section class="card" style="margin-top: 4px;">
      <div class="card-title">${t("ui.addAgent")}</div>
      <div class="stack" style="margin-top: 12px;">
        <div class="field">
          <span>${t("ui.agentName")}</span>
          <input
            type="text"
            placeholder="e.g. my-bot"
            .value=${props.createName}
            @input=${(e: InputEvent) => props.onCreateNameChange((e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="field">
          <span>${t("ui.agentType")}</span>
          <select
            .value=${props.createType}
            @change=${(e: Event) =>
              props.onCreateTypeChange((e.target as HTMLSelectElement).value as "userbot" | "bot")}
          >
            <option value="bot">Bot (token)</option>
            <option value="userbot">Userbot (phone)</option>
          </select>
        </div>

        ${
          isUserbot
            ? html`
                <div class="field">
                  <span>${t("ui.agentPhone")}</span>
                  <input
                    type="text"
                    placeholder="+79991234567"
                    .value=${props.createPhone}
                    @input=${(e: InputEvent) =>
                      props.onCreatePhoneChange((e.target as HTMLInputElement).value)}
                  />
                </div>
              `
            : html`
                <div class="field">
                  <span>${t("ui.agentToken")}</span>
                  <input
                    type="password"
                    placeholder="Token from @BotFather"
                    .value=${props.createToken}
                    @input=${(e: InputEvent) =>
                      props.onCreateTokenChange((e.target as HTMLInputElement).value)}
                  />
                </div>
              `
        }

        <button
          class="btn primary"
          ?disabled=${!canSubmit || props.busy}
          @click=${props.onCreateSubmit}
        >
          ${props.busy && props.busyAgentId === "new" ? t("ui.creating") : t("ui.create")}
        </button>
      </div>
    </section>
  `;
}

// ─── Detail: panel tabs ───────────────────────────────────────────────────────

function renderPanelTabs(props: TelegramProps, agent: TelegramAgentRecord) {
  const tabs: Array<{ id: TelegramPanel; label: string }> = [
    { id: "overview", label: t("ui.panelOverview") },
    ...(agent.type === "userbot"
      ? [{ id: "auth" as TelegramPanel, label: t("ui.panelAuth") }]
      : []),
    { id: "chat", label: "Chat" },
    { id: "schemas", label: "Schemas" },
    { id: "communication", label: "Communication" },
    { id: "behaviors", label: t("ui.panelBehaviors") },
    { id: "tasks", label: "Tasks" },
    { id: "events", label: t("ui.panelEvents") },
    { id: "cron", label: "Cron" },
    { id: "files", label: "Files" },
  ];

  return html`
    <div class="agent-tabs">
      ${tabs.map(
        (tab) => html`
          <button
            type="button"
            class="agent-tab ${props.activePanel === tab.id ? "active" : ""}"
            @click=${() => props.onSelectPanel(tab.id)}
          >
            ${tab.label}
          </button>
        `,
      )}
    </div>
  `;
}

// ─── Detail: overview panel ───────────────────────────────────────────────────

function renderOverviewPanel(props: TelegramProps, agent: TelegramAgentRecord) {
  const busy = isBusy(props, agent.id);

  return html`
    <section class="card">
      <div class="card-title">${t("ui.panelOverview")}</div>
      <div class="card-sub">Status, stats, and lifecycle controls.</div>

      <div class="agents-overview-grid" style="margin-top: 16px;">
        <div class="agent-kv">
          <div class="label">ID</div>
          <div class="mono">${agent.id}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${t("ui.agentType")}</div>
          <div>${agent.type}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Status</div>
          <div><span class="${statusChipClass(agent.status)}">${agent.status}</span></div>
        </div>
        ${
          agent.credentials.phoneNumber
            ? html`
                <div class="agent-kv">
                  <div class="label">${t("ui.agentPhone")}</div>
                  <div>${agent.credentials.phoneNumber}</div>
                </div>
              `
            : nothing
        }
      </div>

      <div class="agents-overview-grid" style="margin-top: 16px;">
        <div class="stat">
          <div class="stat-label">Sent</div>
          <div class="stat-value">${agent.stats.sent}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Received</div>
          <div class="stat-value">${agent.stats.received}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Parsed</div>
          <div class="stat-value">${agent.stats.parsed}</div>
        </div>
      </div>

      ${
        agent.lastError
          ? html`<div class="callout danger" style="margin-top: 16px;">${agent.lastError}</div>`
          : nothing
      }

      <!-- Quick-nav to Communication tab -->
      <div style="margin-top: 16px; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
        <span style="font-size: 13px; color: var(--color-muted, #888);">
          Set up missions and inter-agent communication structure:
        </span>
        <button
          class="btn btn--sm"
          @click=${() => props.onSelectPanel("communication")}
        >
          → Communication
        </button>
      </div>

      <div class="row" style="margin-top: 20px; flex-wrap: wrap;">
        <button
          class="btn primary"
          ?disabled=${busy || agent.status === "running" || agent.status === "starting"}
          @click=${() => props.onStart(agent.id)}
        >
          ${busy && agent.status !== "running" ? t("ui.starting") : t("ui.start")}
        </button>
        <button
          class="btn"
          ?disabled=${busy || agent.status === "stopped"}
          @click=${() => props.onStop(agent.id)}
        >
          ${t("ui.stop")}
        </button>
        <button class="btn" ?disabled=${busy} @click=${() => props.onRestart(agent.id)}>
          ${t("ui.restart")}
        </button>
        <button
          class="btn danger"
          ?disabled=${busy}
          @click=${() => {
            if (confirm(t("ui.deleteConfirm", { name: agent.name }))) {
              props.onDelete(agent.id);
            }
          }}
        >
          ${t("ui.delete")}
        </button>
      </div>
    </section>
  `;
}

// ─── Detail: auth panel (userbot only) ───────────────────────────────────────

function renderAuthPanel(props: TelegramProps, agent: TelegramAgentRecord) {
  const busy = isBusy(props, agent.id);
  const { authStep, authError } = props;

  return html`
    <section class="card">
      <div class="card-title">${t("ui.panelAuth")}</div>
      <div class="card-sub">
        Authenticate as <strong>${agent.credentials.phoneNumber ?? "unknown"}</strong>. Sends an
        OTP to the phone number registered with Telegram.
      </div>

      ${
        agent.status === "error" && agent.lastError?.includes("Not authorized")
          ? html`
              <div class="callout danger" style="margin-top: 12px">${t("ui.notAuthorized")}</div>
            `
          : nothing
      }

      ${
        authStep === "idle" || authStep === "done"
          ? html`
              <div style="margin-top: 16px;">
                <button
                  class="btn primary"
                  ?disabled=${busy}
                  @click=${() => props.onAuthStart(agent.id)}
                >
                  ${busy ? t("ui.sendingCode") : t("ui.sendOtp")}
                </button>
              </div>
            `
          : nothing
      }

      ${
        authStep === "awaiting_code"
          ? html`
              <div class="stack" style="margin-top: 16px;">
                <div class="callout">${t("ui.otpSent")}</div>
                <div class="field">
                  <span>${t("ui.otpCode")}</span>
                  <input
                    type="text"
                    placeholder="e.g. 12345"
                    .value=${props.otpCode}
                    @input=${(e: InputEvent) =>
                      props.onOtpCodeChange((e.target as HTMLInputElement).value)}
                  />
                </div>
                <div class="field">
                  <span>${t("ui.otpPassword")}</span>
                  <input
                    type="password"
                    placeholder="Optional"
                    .value=${props.otpPassword}
                    @input=${(e: InputEvent) =>
                      props.onOtpPasswordChange((e.target as HTMLInputElement).value)}
                  />
                </div>
                <button
                  class="btn primary"
                  ?disabled=${busy || props.otpCode.trim() === ""}
                  @click=${() => props.onAuthSubmit(agent.id)}
                >
                  ${busy ? t("ui.submitting") : t("ui.submitCode")}
                </button>
              </div>
            `
          : nothing
      }

      ${
        authStep === "done"
          ? html`
              <div class="callout" style="margin-top: 12px; color: var(--ok)">${t("ui.authorized")}</div>
            `
          : nothing
      }
      ${authError ? html`<div class="callout danger" style="margin-top: 12px;">${authError}</div>` : nothing}
    </section>
  `;
}

// ─── Detail: behaviors panel ──────────────────────────────────────────────────

function renderBehaviorsPanel(props: TelegramProps, agent: TelegramAgentRecord) {
  const busy = isBusy(props, agent.id);

  return html`
    <section class="card">
      <div class="card-title">${t("ui.panelBehaviors")}</div>
      <div class="card-sub">
        Edit behaviors as JSON. Supported types: <code>auto_reply</code>, <code>monitor</code>,
        <code>broadcast</code>, <code>parser</code>.
      </div>
      <div class="stack" style="margin-top: 16px;">
        <div class="field">
          <textarea
            rows="16"
            .value=${props.behaviorsJson}
            @input=${(e: InputEvent) =>
              props.onBehaviorsJsonChange((e.target as HTMLTextAreaElement).value)}
          ></textarea>
        </div>
        ${
          props.behaviorsJsonError
            ? html`<div class="callout danger">${props.behaviorsJsonError}</div>`
            : nothing
        }
        <button
          class="btn primary"
          ?disabled=${busy || !!props.behaviorsJsonError}
          @click=${() => props.onBehaviorsSave(agent.id)}
        >
          ${busy ? t("ui.saving") : t("ui.saveBehaviors")}
        </button>
      </div>
    </section>
  `;
}

// ─── Detail: events panel ─────────────────────────────────────────────────────

function renderEventsPanel(props: TelegramProps, agentId: string) {
  const events = props.recentEvents.filter((e) => e.agentId === agentId);

  return html`
    <section class="card">
      <div class="card-title">${t("ui.panelEvents")}</div>
      <div class="card-sub">${t("ui.eventsDesc")}</div>
      <div class="list" style="margin-top: 16px;">
        ${
          events.length === 0
            ? html`
                <div class="muted">${t("ui.noEvents")}</div>
              `
            : events.slice(0, 50).map(
                (evt) => html`
                  <div class="list-item">
                    <div class="list-main">
                      <div class="list-title">
                        <span class="chip">${evt.type}</span>
                      </div>
                      <div class="list-sub mono" style="word-break: break-all;">
                        ${JSON.stringify(evt.payload).slice(0, 120)}
                      </div>
                    </div>
                    <div class="list-meta">
                      <div>${new Date(evt.timestamp).toLocaleTimeString()}</div>
                    </div>
                  </div>
                `,
              )
        }
      </div>
    </section>
  `;
}

// ─── Detail: tasks panel ──────────────────────────────────────────────────────

function sessionStatusChip(status: TaskSession["status"]) {
  switch (status) {
    case "active":
      return "chip chip-ok";
    case "completed":
      return "chip";
    default:
      return "chip chip-warn";
  }
}

function renderTasksPanel(props: TelegramProps, agentId: string) {
  const canAssign =
    !props.tasksBusy && props.taskFormChatId.trim() !== "" && props.taskFormTask.trim() !== "";

  const active = props.taskSessions.filter((s) => s.status === "active");
  const others = props.taskSessions.filter((s) => s.status !== "active");

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">Tasks</div>
          <div class="card-sub">
            Persistent AI-driven dialogs assigned to this agent by the main OpenClaw agent or manually.
          </div>
        </div>
        <button
          class="btn btn--sm"
          ?disabled=${props.tasksLoading}
          @click=${() => props.onTasksRefresh(agentId)}
        >
          ${props.tasksLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      ${
        props.tasksError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.tasksError}</div>`
          : nothing
      }

      <!-- Assign new task form -->
      <details style="margin-top: 20px;" ?open=${active.length === 0}>
        <summary style="cursor: pointer; font-weight: 500; font-size: 0.9em;">
          Assign new task
        </summary>
        <div class="stack" style="margin-top: 12px;">
          <div class="field">
            <span>Chat ID <span class="muted" style="font-size:0.85em;">(numeric or @username)</span></span>
            <input
              type="text"
              placeholder="e.g. 123456789 or @username"
              .value=${props.taskFormChatId}
              @input=${(e: InputEvent) =>
                props.onTaskFormChatIdChange((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="field">
            <span>Task description</span>
            <textarea
              rows="3"
              placeholder="Describe what the agent should accomplish in this conversation…"
              .value=${props.taskFormTask}
              @input=${(e: InputEvent) =>
                props.onTaskFormTaskChange((e.target as HTMLTextAreaElement).value)}
            ></textarea>
          </div>
          <details>
            <summary style="cursor: pointer; font-size: 0.85em; opacity: 0.75;">
              Advanced options
            </summary>
            <div class="stack" style="margin-top: 10px;">
              <div class="field">
                <span>System prompt <span class="muted" style="font-size:0.85em;">(optional — overrides default)</span></span>
                <textarea
                  rows="3"
                  placeholder="Custom system prompt for the AI in this session…"
                  .value=${props.taskFormSystemPrompt}
                  @input=${(e: InputEvent) =>
                    props.onTaskFormSystemPromptChange((e.target as HTMLTextAreaElement).value)}
                ></textarea>
              </div>
              <div class="field">
                <span>Opening message <span class="muted" style="font-size:0.85em;">(optional — sent immediately)</span></span>
                <input
                  type="text"
                  placeholder="First message sent to the user right away…"
                  .value=${props.taskFormOpeningMessage}
                  @input=${(e: InputEvent) =>
                    props.onTaskFormOpeningMessageChange((e.target as HTMLInputElement).value)}
                />
              </div>
            </div>
          </details>
          <button
            class="btn primary"
            ?disabled=${!canAssign}
            @click=${() => props.onTaskAssign(agentId)}
          >
            ${props.tasksBusy ? "Assigning…" : "Assign task"}
          </button>
        </div>
      </details>

      <!-- Active sessions -->
      <div style="margin-top: 24px;">
        <div class="card-title" style="font-size: 0.85em; margin-bottom: 10px;">
          Active sessions (${active.length})
        </div>
        ${
          active.length === 0
            ? html`
                <div class="muted">No active task sessions.</div>
              `
            : html`
                <div class="list">
                  ${active.map(
                    (s) => html`
                      <div class="list-item">
                        <div class="list-main">
                          <div class="list-title mono" style="font-size:0.85em;">${s.chatId}</div>
                          <div class="list-sub" style="margin-top:4px;">${s.task}</div>
                          ${
                            s.initiatedBy
                              ? html`<div class="muted" style="font-size:0.8em; margin-top:2px;">
                                  by ${s.initiatedBy}
                                </div>`
                              : nothing
                          }
                        </div>
                        <div class="list-meta" style="gap:6px;">
                          <span class="${sessionStatusChip(s.status)}">${s.status}</span>
                          <button
                            class="btn btn--sm danger"
                            ?disabled=${props.tasksBusy}
                            @click=${() => props.onTaskComplete(agentId, s.id)}
                          >
                            Complete
                          </button>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              `
        }
      </div>

      <!-- Completed / paused sessions -->
      ${
        others.length > 0
          ? html`
              <div style="margin-top: 20px;">
                <div class="card-title" style="font-size: 0.85em; margin-bottom: 10px;">
                  History (${others.length})
                </div>
                <div class="list">
                  ${others.slice(0, 20).map(
                    (s) => html`
                      <div class="list-item">
                        <div class="list-main">
                          <div class="list-title mono" style="font-size:0.85em;">${s.chatId}</div>
                          <div class="list-sub" style="margin-top:4px;">${s.task}</div>
                        </div>
                        <div class="list-meta">
                          <span class="${sessionStatusChip(s.status)}">${s.status}</span>
                          <div class="muted" style="font-size:0.8em;">
                            ${
                              s.completedAt
                                ? new Date(s.completedAt).toLocaleString()
                                : new Date(s.startedAt).toLocaleString()
                            }
                          </div>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              </div>
            `
          : nothing
      }
    </section>
  `;
}

// ─── Detail: cron panel ───────────────────────────────────────────────────────

function renderCronPanel(props: TelegramProps) {
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Cron</div>
          <div class="card-sub">Scheduled jobs for this gateway.</div>
        </div>
        <button class="btn btn--sm" ?disabled=${props.cronLoading} @click=${props.onCronRefresh}>
          ${props.cronLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div class="stat-grid" style="margin-top: 16px;">
        <div class="stat">
          <div class="stat-label">Enabled</div>
          <div class="stat-value">
            ${props.cronStatus ? (props.cronStatus.enabled ? "Yes" : "No") : "n/a"}
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">Total Jobs</div>
          <div class="stat-value">${props.cronStatus?.jobs ?? "n/a"}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Next wake</div>
          <div class="stat-value">${formatNextRun(props.cronStatus?.nextWakeAtMs ?? null)}</div>
        </div>
      </div>

      ${
        props.cronError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.cronError}</div>`
          : nothing
      }

      <div style="margin-top: 20px;">
        <div class="card-title" style="font-size: 0.85em; margin-bottom: 12px;">All Jobs</div>
        ${
          props.cronJobs.length === 0
            ? html`
                <div class="muted">No cron jobs configured. Add jobs in the Cron tab.</div>
              `
            : html`
                <div class="list">
                  ${props.cronJobs.map(
                    (job) => html`
                      <div class="list-item">
                        <div class="list-main">
                          <div class="list-title">${job.name}</div>
                          ${
                            job.description
                              ? html`<div class="list-sub">${job.description}</div>`
                              : nothing
                          }
                          <div class="chip-row" style="margin-top: 6px;">
                            <span class="chip">${formatCronSchedule(job)}</span>
                            <span class="chip ${job.enabled ? "chip-ok" : "chip-warn"}">
                              ${job.enabled ? "enabled" : "disabled"}
                            </span>
                            <span class="chip">${job.sessionTarget}</span>
                          </div>
                        </div>
                        <div class="list-meta">
                          <div class="mono">${formatCronState(job)}</div>
                          <div class="muted">${formatCronPayload(job)}</div>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              `
        }
      </div>
    </section>
  `;
}

// ─── Detail: files panel ──────────────────────────────────────────────────────

function renderFilesPanel(props: TelegramProps, agentId: string) {
  return renderAgentFiles({
    agentId,
    agentFilesList: props.agentFilesList,
    agentFilesLoading: props.agentFilesLoading,
    agentFilesError: props.agentFilesError,
    agentFileActive: props.agentFileActive,
    agentFileContents: props.agentFileContents,
    agentFileDrafts: props.agentFileDrafts,
    agentFileSaving: props.agentFileSaving,
    onLoadFiles: props.onLoadFiles,
    onSelectFile: props.onSelectFile,
    onFileDraftChange: props.onFileDraftChange,
    onFileReset: props.onFileReset,
    onFileSave: props.onFileSave,
  });
}

// ─── Detail: chat panel ───────────────────────────────────────────────────────

/** All messages across all missions for this agent, sorted chronologically. */
function getAgentChatMessages(
  missions: AgentMissionRecord[],
  allMessages: AgentCommMessageRecord[],
  agentId: string,
): (AgentCommMessageRecord & { missionTitle: string; timestampMs: number })[] {
  const agentMissionIds = new Set(
    missions
      .filter((m) => m.masterAgentId === agentId || m.participantAgentIds.includes(agentId))
      .map((m) => m.id),
  );
  const missionTitles = new Map(missions.map((m) => [m.id, m.title]));
  return allMessages
    .filter((msg) => agentMissionIds.has(msg.missionId))
    .map((msg) => ({
      ...msg,
      missionTitle: missionTitles.get(msg.missionId) ?? msg.missionId,
      timestampMs: Date.parse(msg.timestamp),
    }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function renderNodesView(
  missions: AgentMissionRecord[],
  agents: TelegramAgentRecord[],
  currentAgentId: string,
) {
  const agentMissions = missions.filter(
    (m) => m.masterAgentId === currentAgentId || m.participantAgentIds.includes(currentAgentId),
  );

  if (agentMissions.length === 0) {
    return html`
      <div class="muted" style="text-align:center;padding:24px 0;">
        No missions yet — create one in the <strong>Communication</strong> tab to see the node graph.
      </div>
    `;
  }

  return html`
    <div style="display:flex;flex-direction:column;gap:16px;">
      ${agentMissions.map((mission) => {
        const masterAgent = agents.find((a) => a.id === mission.masterAgentId);
        const participants = agents.filter((a) => mission.participantAgentIds.includes(a.id));
        const statusColor = missionStatusColor(mission.status);

        return html`
          <div style="border:1px solid var(--color-border,#333);border-radius:8px;overflow:hidden;">
            <!-- Mission header -->
            <div style="padding:8px 12px;background:var(--color-card-bg,#1a1a1a);border-bottom:1px solid var(--color-border,#333);display:flex;align-items:center;gap:8px;">
              <span style="font-weight:600;font-size:13px;">${mission.title}</span>
              <span style="font-size:10px;padding:2px 6px;border-radius:3px;background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44;">${mission.status}</span>
            </div>
            <!-- Node graph row -->
            <div style="padding:16px 12px;display:flex;align-items:center;gap:0;flex-wrap:wrap;row-gap:12px;">
              <!-- Master node -->
              <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                <div style="width:52px;height:52px;border-radius:50%;background:var(--accent,#4a7)22;border:2px solid var(--accent,#4a7);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:var(--accent,#4a7);">
                  ${masterAgent ? masterAgent.name.charAt(0).toUpperCase() : "?"}
                </div>
                <div style="font-size:11px;font-weight:600;max-width:72px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title=${masterAgent?.name ?? mission.masterAgentId}>
                  ${masterAgent?.name ?? mission.masterAgentId.slice(0, 8)}
                </div>
                <div style="font-size:9px;color:var(--color-muted,#888);">master</div>
              </div>
              <!-- Arrows to participants -->
              ${
                participants.length > 0
                  ? html`
                      <div style="display:flex;flex-direction:column;align-items:center;margin:0 4px;">
                        <div style="font-size:18px;color:var(--color-muted,#888);">→</div>
                      </div>
                      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
                        ${participants.map(
                          (p) => html`
                            <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                              <div style="width:44px;height:44px;border-radius:50%;background:var(--color-card-bg,#1a1a1a);border:2px solid var(--color-border,#333);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;">
                                ${p.name.charAt(0).toUpperCase()}
                              </div>
                              <div style="font-size:11px;max-width:64px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title=${p.name}>
                                ${p.name}
                              </div>
                              <div style="font-size:9px;color:var(--color-muted,#888);">participant</div>
                            </div>
                          `,
                        )}
                      </div>
                    `
                  : html`
                      <div style="margin-left:12px;font-size:12px;color:var(--color-muted,#888);">
                        No participants yet.
                      </div>
                    `
              }
            </div>
            <!-- Goal summary -->
            <div style="padding:6px 12px 10px;font-size:11px;color:var(--color-muted,#888);border-top:1px solid var(--color-border,#333);">
              <span style="font-weight:500;color:var(--color-text);">Goal:</span>
              ${mission.goal.length > 160 ? mission.goal.slice(0, 160) + "…" : mission.goal}
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

function renderChatPanel(props: TelegramProps, agent: TelegramAgentRecord) {
  const agentMissions = props.missions.filter(
    (m) => m.masterAgentId === agent.id || m.participantAgentIds.includes(agent.id),
  );
  const chatMessages = getAgentChatMessages(agentMissions, props.missionMessages, agent.id);

  return html`
    <section class="card">
      <!-- Header with view toggle -->
      <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div>
          <div class="card-title">Chat</div>
          <div class="card-sub">
            ${props.chatViewMode === "chat"
              ? "All inter-agent messages across missions in chronological order."
              : "Visual node graph of agent connections and missions."}
          </div>
        </div>
        <div style="display:flex;gap:4px;">
          <button
            class="btn btn--sm ${props.chatViewMode === "chat" ? "primary" : ""}"
            @click=${() => props.onChatViewModeChange("chat")}
          >
            💬 Chat
          </button>
          <button
            class="btn btn--sm ${props.chatViewMode === "nodes" ? "primary" : ""}"
            @click=${() => props.onChatViewModeChange("nodes")}
          >
            ◎ Nodes
          </button>
        </div>
      </div>

      ${
        props.missionsError
          ? html`<div class="callout danger" style="margin-top:12px;">${props.missionsError}</div>`
          : nothing
      }

      <div style="margin-top:16px;">
        ${
          props.chatViewMode === "chat"
            ? html`
                ${
                  chatMessages.length === 0
                    ? html`
                        <div class="muted" style="text-align:center;padding:24px 0;">
                          No messages yet.
                          ${agentMissions.length === 0
                            ? html` Create a mission in the <strong>Communication</strong> tab first.`
                            : nothing}
                        </div>
                      `
                    : html`
                        <div style="display:flex;flex-direction:column;gap:8px;max-height:480px;overflow-y:auto;padding-right:4px;">
                          ${chatMessages.map((msg) => {
                            const fromAgent = props.agents.find((a) => a.id === msg.fromAgentId);
                            const toAgent = props.agents.find((a) => a.id === msg.toAgentId);
                            const isMine = msg.fromAgentId === agent.id;
                            return html`
                              <div style="display:flex;flex-direction:column;${isMine ? "align-items:flex-end;" : "align-items:flex-start;"}">
                                <div style="font-size:10px;color:var(--color-muted,#888);margin-bottom:2px;display:flex;gap:6px;align-items:center;">
                                  <span style="font-weight:600;">${fromAgent?.name ?? msg.fromAgentName}</span>
                                  <span>→</span>
                                  <span>${toAgent?.name ?? msg.toAgentId}</span>
                                  <span style="opacity:0.6;">· ${msg.missionTitle}</span>
                                  <span style="opacity:0.5;">${formatRelativeTimestamp(msg.timestampMs)}</span>
                                </div>
                                <div style="max-width:80%;padding:8px 12px;border-radius:${isMine ? "12px 12px 4px 12px" : "12px 12px 12px 4px"};background:${isMine ? "var(--accent,#4a7)22" : "var(--color-card-bg,#1a1a1a)"};border:1px solid ${isMine ? "var(--accent,#4a7)44" : "var(--color-border,#333)"};font-size:13px;white-space:pre-wrap;word-break:break-word;">
                                  ${msg.content}
                                </div>
                              </div>
                            `;
                          })}
                        </div>
                      `
                }
              `
            : renderNodesView(agentMissions, props.agents, agent.id)
        }
      </div>

      <!-- Refresh button -->
      <div style="margin-top:12px;display:flex;justify-content:flex-end;">
        <button
          class="btn btn--sm"
          ?disabled=${props.missionsLoading}
          @click=${() => props.onMissionsRefresh()}
        >
          ${props.missionsLoading ? "Loading…" : "Refresh"}
        </button>
      </div>
    </section>
  `;
}

// ─── Detail: schemas panel ────────────────────────────────────────────────────

function renderSchemasPanel(props: TelegramProps, agent: TelegramAgentRecord) {
  const agentMissions = props.missions.filter(
    (m) => m.masterAgentId === agent.id || m.participantAgentIds.includes(agent.id),
  );

  return html`
    <section class="card">
      <div class="row" style="justify-content:space-between;align-items:flex-start;">
        <div>
          <div class="card-title">Schemas</div>
          <div class="card-sub">Communication structure skeleton — missions, roles, and agent connections.</div>
        </div>
        <button
          class="btn btn--sm"
          ?disabled=${props.missionsLoading}
          @click=${() => props.onMissionsRefresh()}
        >
          ${props.missionsLoading ? "Loading…" : "Refresh"}
        </button>
      </div>

      ${
        props.missionsError
          ? html`<div class="callout danger" style="margin-top:12px;">${props.missionsError}</div>`
          : nothing
      }

      ${
        agentMissions.length === 0
          ? html`
              <div class="callout" style="margin-top:16px;">
                <strong>No missions defined.</strong>
                Go to the <strong>Communication</strong> tab to create missions and link agents.
                Schemas will appear here showing the skeleton of each mission.
              </div>
            `
          : html`
              <div style="margin-top:16px;display:flex;flex-direction:column;gap:20px;">
                ${agentMissions.map((mission) => renderMissionSchema(mission, props.agents, agent.id))}
              </div>
            `
      }
    </section>
  `;
}

function renderMissionSchema(
  mission: AgentMissionRecord,
  agents: TelegramAgentRecord[],
  currentAgentId: string,
) {
  const masterAgent = agents.find((a) => a.id === mission.masterAgentId);
  const participants = agents.filter((a) => mission.participantAgentIds.includes(a.id));
  const role = mission.masterAgentId === currentAgentId ? "master" : "participant";
  const statusColor = missionStatusColor(mission.status);

  return html`
    <div style="border:1px solid var(--color-border,#333);border-radius:8px;overflow:hidden;">
      <!-- Mission title bar -->
      <div style="padding:10px 14px;background:var(--color-card-bg,#1a1a1a);display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid var(--color-border,#333);">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:11px;color:var(--color-muted,#888);text-transform:uppercase;letter-spacing:0.05em;">Mission</span>
          <span style="font-weight:700;font-size:14px;">${mission.title}</span>
          <span style="font-size:10px;padding:2px 7px;border-radius:3px;background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44;">${mission.status}</span>
          <span class="chip" style="font-size:10px;">your role: ${role}</span>
        </div>
        <div style="font-size:11px;color:var(--color-muted,#888);">${formatRelativeTimestamp(Date.parse(mission.createdAt))}</div>
      </div>

      <!-- Goal -->
      <div style="padding:10px 14px;border-bottom:1px solid var(--color-border,#333);">
        <div style="font-size:11px;font-weight:600;color:var(--color-muted,#888);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Goal</div>
        <div style="font-size:13px;line-height:1.5;">${mission.goal}</div>
      </div>

      <!-- Participants schema -->
      <div style="padding:10px 14px;">
        <div style="font-size:11px;font-weight:600;color:var(--color-muted,#888);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Agents</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <!-- Master row -->
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="width:8px;height:8px;border-radius:50%;background:var(--accent,#4a7);flex-shrink:0;"></div>
            <div style="font-size:13px;font-weight:600;">${masterAgent?.name ?? mission.masterAgentId}</div>
            <span class="chip" style="font-size:10px;">master</span>
            ${masterAgent ? html`<span style="font-size:11px;color:var(--color-muted,#888);">(${masterAgent.type})</span>` : nothing}
          </div>
          <!-- Connection line -->
          ${
            participants.length > 0
              ? html`
                  <div style="margin-left:3px;padding-left:12px;border-left:2px dashed var(--color-border,#333);display:flex;flex-direction:column;gap:4px;">
                    ${participants.map(
                      (p) => html`
                        <div style="display:flex;align-items:center;gap:8px;">
                          <div style="width:6px;height:6px;border-radius:50%;background:var(--color-border,#333);flex-shrink:0;"></div>
                          <div style="font-size:12px;">${p.name}</div>
                          <span class="chip" style="font-size:10px;">participant</span>
                          <span style="font-size:11px;color:var(--color-muted,#888);">(${p.type})</span>
                        </div>
                      `,
                    )}
                  </div>
                `
              : html`
                  <div style="margin-left:14px;font-size:12px;color:var(--color-muted,#888);">
                    No participants — add agents via the Communication tab.
                  </div>
                `
          }
        </div>
      </div>

      ${
        mission.systemPrompt
          ? html`
              <div style="padding:8px 14px 10px;border-top:1px solid var(--color-border,#333);">
                <div style="font-size:11px;font-weight:600;color:var(--color-muted,#888);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">System Prompt</div>
                <pre style="font-size:12px;font-family:monospace;margin:0;white-space:pre-wrap;word-break:break-word;color:var(--color-text);opacity:0.8;">${mission.systemPrompt}</pre>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

// ─── Detail: communication structure panel ────────────────────────────────────

/** Extract the CommunicationBehavior from an agent's behaviors array. */
function getCommunicationBehavior(
  agent: TelegramAgentRecord,
): { enabled: boolean; activeMissionIds: string[] } | null {
  type CommunicationBehaviorShape = { type: string; enabled?: boolean; activeMissionIds?: string[] };
  const b = (agent.behaviors as CommunicationBehaviorShape[]).find((beh) => beh.type === "communication");
  if (!b) return null;
  return { enabled: b.enabled ?? true, activeMissionIds: b.activeMissionIds ?? [] };
}

function renderCommunicationBehaviorStatus(
  commBehavior: { enabled: boolean; activeMissionIds: string[] } | null,
  agentMissions: AgentMissionRecord[],
) {
  const activeMissionCount = agentMissions.filter((m) => m.status === "active").length;

  if (!commBehavior) {
    return html`
      <div class="callout" style="margin-top: 12px;">
        <strong>No communication behavior yet.</strong>
        Create a mission below and this agent will automatically get a
        <code>communication</code> behavior linking it to that mission.
        The behavior tracks which missions this agent actively participates in.
      </div>
    `;
  }

  // Build a lookup of missionId → title from the already-loaded missions
  const missionTitleById = new Map(agentMissions.map((m) => [m.id, m.title]));

  return html`
    <div style="margin-top: 12px; padding: 10px 12px; border: 1px solid var(--color-border,#333); border-radius:6px; background: var(--color-card-bg,#1a1a1a);">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="font-size:12px;font-weight:600;">Communication Behavior</span>
        <span class="chip ${commBehavior.enabled ? "chip-ok" : "chip-warn"}" style="font-size:10px;">
          ${commBehavior.enabled ? "enabled" : "disabled"}
        </span>
      </div>
      <div style="font-size:12px;color:var(--color-muted,#888);">
        Linked missions: <strong>${commBehavior.activeMissionIds.length}</strong>
        ${activeMissionCount > 0 ? html` · <span style="color:var(--ok,#3a7)">${activeMissionCount} active</span>` : nothing}
      </div>
      ${
        commBehavior.activeMissionIds.length > 0
          ? html`
              <div style="font-size:12px;color:var(--color-muted,#888);margin-top:6px;display:flex;flex-direction:column;gap:3px;">
                ${commBehavior.activeMissionIds.map((id) => {
                  const title = missionTitleById.get(id);
                  return html`
                    <div style="display:flex;align-items:center;gap:6px;">
                      <span>·</span>
                      <span>${title ?? id}</span>
                      ${title ? html`<span style="font-size:10px;opacity:0.5;font-family:monospace;">${id.slice(0, 8)}…</span>` : nothing}
                    </div>
                  `;
                })}
              </div>
            `
          : html`
              <div style="font-size:12px;color:var(--color-muted,#888);margin-top:4px;">
                No active mission IDs — create a mission to link this agent.
              </div>
            `
      }
    </div>
  `;
}

function renderCommunicationPanel(props: TelegramProps, agent: TelegramAgentRecord) {
  // Filter missions relevant to this agent (master or participant)
  const agentMissions = props.missions.filter(
    (m) => m.masterAgentId === agent.id || m.participantAgentIds.includes(agent.id),
  );

  if (props.selectedMissionId) {
    const mission = agentMissions.find((m) => m.id === props.selectedMissionId) ?? null;
    return renderMissionMessages(props, agent, mission);
  }

  const canCreate =
    !props.missionsBusy &&
    props.missionCreateTitle.trim() !== "" &&
    props.missionCreateGoal.trim() !== "";

  const commBehavior = getCommunicationBehavior(agent);

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">Communication Structure</div>
          <div class="card-sub">Missions and inter-agent communication for this agent.</div>
        </div>
        <button
          class="btn btn--sm"
          ?disabled=${props.missionsLoading}
          @click=${() => props.onMissionsRefresh()}
        >
          ${props.missionsLoading ? "Loading…" : "Refresh"}
        </button>
      </div>

      ${
        props.missionsError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.missionsError}</div>`
          : nothing
      }

      <!-- Communication behavior status card -->
      ${renderCommunicationBehaviorStatus(commBehavior, agentMissions)}

      <!-- Create mission form -->
      <details style="margin-top: 16px; margin-bottom: 16px;">
        <summary style="cursor: pointer; font-weight: 500; font-size: 0.9em;">
          + Create Mission
        </summary>
        <div class="stack" style="margin-top: 12px;">
          <div class="field">
            <span>Title</span>
            <input
              type="text"
              placeholder="Mission title…"
              .value=${props.missionCreateTitle}
              @input=${(e: Event) =>
                props.onMissionCreateTitleChange((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="field">
            <span>Goal</span>
            <textarea
              rows="3"
              placeholder="Describe the shared goal for all participating agents…"
              .value=${props.missionCreateGoal}
              @input=${(e: Event) =>
                props.onMissionCreateGoalChange((e.target as HTMLTextAreaElement).value)}
            ></textarea>
          </div>
          <div class="field">
            <span>System Prompt <span class="muted" style="font-size:0.85em;">(optional)</span></span>
            <textarea
              rows="2"
              placeholder="Optional system prompt override for sub-agents…"
              .value=${props.missionCreateSystemPrompt}
              @input=${(e: Event) =>
                props.onMissionCreateSystemPromptChange(
                  (e.target as HTMLTextAreaElement).value,
                )}
            ></textarea>
          </div>
          <div class="field">
            <span>Participants</span>
            <div class="stack" style="margin-top: 4px; gap: 4px;">
              ${props.agents
                .filter((a) => a.id !== agent.id)
                .map(
                  (a) => html`
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;">
                      <input
                        type="checkbox"
                        .checked=${props.missionCreateParticipantIds.includes(a.id)}
                        @change=${(e: Event) => {
                          const checked = (e.target as HTMLInputElement).checked;
                          const ids = checked
                            ? [...props.missionCreateParticipantIds, a.id]
                            : props.missionCreateParticipantIds.filter((id) => id !== a.id);
                          props.onMissionCreateParticipantIdsChange(ids);
                        }}
                      />
                      ${a.name}
                    </label>
                  `,
                )}
            </div>
          </div>
          <button
            class="btn primary"
            ?disabled=${!canCreate}
            @click=${() => props.onMissionCreate(agent.id)}
          >
            ${props.missionsBusy ? "Creating…" : "Create Mission"}
          </button>
        </div>
      </details>

      <!-- Mission list -->
      <div style="margin-top: 8px;">
        ${
          agentMissions.length === 0
            ? html`<div class="muted">No missions yet for this agent.</div>`
            : agentMissions.map((m) =>
                renderMissionCard(props, m, agent),
              )
        }
      </div>
    </section>
  `;
}

function missionStatusColor(status: string): string {
  switch (status) {
    case "active":
      return "#3a7";
    case "completed":
      return "#888";
    default:
      return "#a73";
  }
}

function renderMissionCard(
  props: TelegramProps,
  mission: AgentMissionRecord,
  currentAgent: TelegramAgentRecord,
) {
  const masterAgent = props.agents.find((a) => a.id === mission.masterAgentId);
  const participants = props.agents.filter((a) => mission.participantAgentIds.includes(a.id));
  const role = mission.masterAgentId === currentAgent.id ? "master" : "participant";
  const statusColor = missionStatusColor(mission.status);

  return html`
    <div style="padding:12px;border:1px solid var(--color-border,#333);border-radius:6px;margin-bottom:10px;background:var(--color-card-bg,#1a1a1a);">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            ${mission.title}
            <span style="font-size:10px;padding:2px 6px;border-radius:3px;background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44;">${mission.status}</span>
            <span class="chip" style="font-size:10px;">${role}</span>
          </div>
          <div style="font-size:12px;color:var(--color-muted,#888);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title=${mission.goal}>
            ${mission.goal.length > 120 ? mission.goal.slice(0, 120) + "…" : mission.goal}
          </div>
          <div style="font-size:11px;color:var(--color-muted,#888);margin-top:4px;">
            Master: ${masterAgent?.name ?? mission.masterAgentId}
            ${
              participants.length > 0
                ? html` · Participants: ${participants.map((a) => a.name).join(", ")}`
                : nothing
            }
            · ${formatRelativeTimestamp(Date.parse(mission.createdAt))}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
          <button class="btn btn--sm" @click=${() => props.onMissionViewMessages(mission.id)}>
            Messages
          </button>
          ${
            mission.status === "active"
              ? html`<button class="btn btn--sm danger" @click=${() => props.onMissionComplete(mission.id)}>Complete</button>`
              : nothing
          }
        </div>
      </div>
    </div>
  `;
}

function renderMissionMessages(
  props: TelegramProps,
  agent: TelegramAgentRecord,
  mission: AgentMissionRecord | null,
) {
  const canSend =
    !props.missionsBusy &&
    props.missionSendFromId !== "" &&
    props.missionSendToId !== "" &&
    props.missionSendContent.trim() !== "";

  return html`
    <section class="card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <button class="btn btn--sm" @click=${props.onMissionBack}>← Back</button>
        <div>
          <div class="card-title" style="margin-bottom:0;">${mission?.title ?? "Mission Messages"}</div>
          ${
            mission
              ? html`<div class="card-sub">${mission.goal.length > 100 ? mission.goal.slice(0, 100) + "…" : mission.goal}</div>`
              : nothing
          }
        </div>
      </div>

      <!-- Message thread -->
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;max-height:360px;overflow-y:auto;padding-right:4px;">
        ${
          props.missionMessages.length === 0
            ? html`<div class="muted" style="text-align:center;padding:16px 0;">No messages yet.</div>`
            : props.missionMessages.map((msg) => renderMsgBubble(msg, props.agents))
        }
      </div>

      <!-- Send message form -->
      <div style="border-top:1px solid var(--color-border,#333);padding-top:12px;display:flex;flex-direction:column;gap:8px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div class="field">
            <span>From</span>
            <select
              .value=${props.missionSendFromId}
              @change=${(e: Event) =>
                props.onMissionSendFromIdChange((e.target as HTMLSelectElement).value)}
            >
              <option value="">— select —</option>
              ${props.agents.map((a) => html`<option value=${a.id}>${a.name}</option>`)}
            </select>
          </div>
          <div class="field">
            <span>To</span>
            <select
              .value=${props.missionSendToId}
              @change=${(e: Event) =>
                props.onMissionSendToIdChange((e.target as HTMLSelectElement).value)}
            >
              <option value="">— select —</option>
              ${props.agents.map((a) => html`<option value=${a.id}>${a.name}</option>`)}
            </select>
          </div>
        </div>
        <div class="field">
          <span>Message</span>
          <textarea
            rows="3"
            placeholder="Message content…"
            .value=${props.missionSendContent}
            @input=${(e: Event) =>
              props.onMissionSendContentChange((e.target as HTMLTextAreaElement).value)}
          ></textarea>
        </div>
        <div style="display:flex;justify-content:flex-end;">
          <button
            class="btn primary"
            ?disabled=${!canSend}
            @click=${() => {
              if (mission) {
                props.onMissionSend(mission.id);
              }
            }}
          >
            ${props.missionsBusy ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </section>
  `;
}

function renderMsgBubble(msg: AgentCommMessageRecord, agents: TelegramAgentRecord[]) {
  const fromAgent = agents.find((a) => a.id === msg.fromAgentId);
  const toAgent = agents.find((a) => a.id === msg.toAgentId);

  return html`
    <div style="padding:8px 10px;border-radius:6px;border:1px solid var(--color-border,#333);background:var(--color-card-bg,#1a1a1a);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <div style="font-size:11px;font-weight:600;color:var(--color-text);">
          ${fromAgent?.name ?? msg.fromAgentName}
          <span style="color:var(--color-muted,#888);font-weight:400;"> → </span>
          ${toAgent?.name ?? msg.toAgentId}
        </div>
        <div style="font-size:10px;color:var(--color-muted,#888);">${formatRelativeTimestamp(Date.parse(msg.timestamp))}</div>
      </div>
      <div style="font-size:13px;white-space:pre-wrap;word-break:break-word;">${msg.content}</div>
    </div>
  `;
}

// ─── Main panel ───────────────────────────────────────────────────────────────

function renderDetail(props: TelegramProps) {
  const agent = props.agents.find((a) => a.id === props.selectedAgentId);

  if (!agent) {
    return html`
      <section class="agents-main">
        <div class="card">
          <div class="card-title">${t("ui.selectAgentTitle")}</div>
          <div class="card-sub">${t("ui.selectAgentDesc")}</div>
        </div>
        ${renderProxyPanel(props)}
      </section>
    `;
  }

  return html`
    <section class="agents-main">
      <section class="card agent-header">
        <div class="agent-header-main">
          <div class="agent-avatar agent-avatar--lg" style="${avatarStyle(agent.status)}">
            ${agentInitial(agent.name)}
          </div>
          <div>
            <div class="card-title">${agent.name}</div>
            <div class="card-sub">Telegram ${agent.type} agent.</div>
          </div>
        </div>
        <div class="agent-header-meta">
          <span class="${statusChipClass(agent.status)}">${agent.status}</span>
          <span class="agent-pill">${agent.type}</span>
        </div>
      </section>

      ${renderPanelTabs(props, agent)}

      ${props.activePanel === "overview" ? renderOverviewPanel(props, agent) : nothing}
      ${
        props.activePanel === "auth" && agent.type === "userbot"
          ? renderAuthPanel(props, agent)
          : nothing
      }
      ${props.activePanel === "chat" ? renderChatPanel(props, agent) : nothing}
      ${props.activePanel === "schemas" ? renderSchemasPanel(props, agent) : nothing}
      ${props.activePanel === "behaviors" ? renderBehaviorsPanel(props, agent) : nothing}
      ${props.activePanel === "events" ? renderEventsPanel(props, agent.id) : nothing}
      ${props.activePanel === "tasks" ? renderTasksPanel(props, agent.id) : nothing}
      ${props.activePanel === "cron" ? renderCronPanel(props) : nothing}
      ${props.activePanel === "files" ? renderFilesPanel(props, agent.id) : nothing}
      ${props.activePanel === "communication" ? renderCommunicationPanel(props, agent) : nothing}
    </section>
  `;
}

// ─── Credentials setup overlay ───────────────────────────────────────────────

function renderCredentialsCard(props: TelegramProps) {
  const canSave =
    !props.setupSaving && props.setupApiId.trim() !== "" && props.setupApiHash.trim() !== "";
  return html`
    <section class="card" style="width: 100%; max-width: 480px;">
      <div class="card-title">${t("ui.credentialsTitle")}</div>
      <div class="card-sub">
        ${t("ui.credentialsDesc")}
      </div>
      <div class="stack" style="margin-top: 16px;">
        <div class="field">
          <span>${t("ui.apiId")}</span>
          <input
            type="text"
            placeholder="e.g. 12345678"
            .value=${props.setupApiId}
            @input=${(e: InputEvent) =>
              props.onSetupApiIdChange((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="field">
          <span>${t("ui.apiHash")}</span>
          <input
            type="password"
            placeholder="32-character hex string"
            .value=${props.setupApiHash}
            @input=${(e: InputEvent) =>
              props.onSetupApiHashChange((e.target as HTMLInputElement).value)}
          />
        </div>

        <!-- Optional SOCKS5 proxy section -->
        <details style="margin-top: 4px;">
          <summary style="cursor: pointer; font-size: 0.85em; opacity: 0.75;">
            ${t("ui.proxyOptional")}
          </summary>
          <div class="stack" style="margin-top: 10px;">
            <div class="field">
              <span>${t("ui.proxyHost")}</span>
              <input
                type="text"
                placeholder="e.g. 127.0.0.1"
                .value=${props.setupProxyIp}
                @input=${(e: InputEvent) =>
                  props.onSetupProxyIpChange((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <span>${t("ui.proxyPort")}</span>
              <input
                type="text"
                placeholder="e.g. 1080"
                .value=${props.setupProxyPort}
                @input=${(e: InputEvent) =>
                  props.onSetupProxyPortChange((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <span>${t("ui.proxyUsername")}</span>
              <input
                type="text"
                placeholder="${t("ui.optional")}"
                .value=${props.setupProxyUsername}
                @input=${(e: InputEvent) =>
                  props.onSetupProxyUsernameChange((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <span>${t("ui.proxyPassword")}</span>
              <input
                type="password"
                placeholder="${t("ui.optional")}"
                .value=${props.setupProxyPassword}
                @input=${(e: InputEvent) =>
                  props.onSetupProxyPasswordChange((e.target as HTMLInputElement).value)}
              />
            </div>
          </div>
        </details>

        ${props.setupError ? html`<div class="callout danger">${props.setupError}</div>` : nothing}
        <button class="btn primary" ?disabled=${!canSave} @click=${props.onSetupSave}>
          ${props.setupSaving ? t("ui.saving") : t("ui.saveCredentials")}
        </button>
      </div>
    </section>
  `;
}

// ─── Proxy settings panel (accessible after initial setup) ────────────────────

function renderProxyPanel(props: TelegramProps) {
  const canSave =
    !props.proxySaving && props.proxyEditIp.trim() !== "" && props.proxyEditPort.trim() !== "";

  return html`
    <section class="card" style="margin-top: 12px;">
      <div class="card-title">${t("ui.proxyTitle")}</div>
      <div class="card-sub">${t("ui.proxyDesc")}</div>

      ${
        props.proxyConfigured
          ? html`
              <div class="callout" style="margin-top: 12px;">
                ${t("ui.proxyActive")}: <code>${props.proxyIp}:${props.proxyPort}</code>
              </div>
            `
          : nothing
      }

      <div class="stack" style="margin-top: 14px;">
        <div class="field">
          <span>${t("ui.proxyHost")}</span>
          <input
            type="text"
            placeholder="e.g. 127.0.0.1"
            .value=${props.proxyEditIp}
            @input=${(e: InputEvent) =>
              props.onProxyEditIpChange((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="field">
          <span>${t("ui.proxyPort")}</span>
          <input
            type="text"
            placeholder="e.g. 1080"
            .value=${props.proxyEditPort}
            @input=${(e: InputEvent) =>
              props.onProxyEditPortChange((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="field">
          <span>${t("ui.proxyUsername")}</span>
          <input
            type="text"
            placeholder="${t("ui.optional")}"
            .value=${props.proxyEditUsername}
            @input=${(e: InputEvent) =>
              props.onProxyEditUsernameChange((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="field">
          <span>${t("ui.proxyPassword")}</span>
          <input
            type="password"
            placeholder="${t("ui.optional")}"
            .value=${props.proxyEditPassword}
            @input=${(e: InputEvent) =>
              props.onProxyEditPasswordChange((e.target as HTMLInputElement).value)}
          />
        </div>
        ${props.proxyError ? html`<div class="callout danger">${props.proxyError}</div>` : nothing}
        <div class="row">
          <button class="btn primary" ?disabled=${!canSave} @click=${props.onProxySave}>
            ${props.proxySaving ? t("ui.saving") : t("ui.proxySave")}
          </button>
          ${
            props.proxyConfigured
              ? html`
                  <button class="btn danger" ?disabled=${props.proxySaving} @click=${props.onProxyClear}>
                    ${t("ui.proxyClear")}
                  </button>
                `
              : nothing
          }
        </div>
      </div>
    </section>
  `;
}

/** Renders the detail area; when credentials are not configured, blurs it and
 *  shows a setup card overlay so the user can enter API ID / API Hash. */
function renderDetailArea(props: TelegramProps) {
  const needsSetup = props.apiIdConfigured === false;

  if (!needsSetup) {
    return renderDetail(props);
  }

  return html`
    <section class="agents-main" style="position: relative; overflow: hidden;">
      <!-- blurred placeholder so the layout doesn't collapse -->
      <div style="filter: blur(3px); pointer-events: none; user-select: none;">
        <section class="card">
          <div class="card-title" style="opacity: 0.5;">Telegram Agents</div>
          <div class="card-sub" style="opacity: 0.5;">API credentials required to manage agents.</div>
        </section>
      </div>
      <!-- centered overlay -->
      <div
        style="
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          background: rgba(0, 0, 0, 0.12);
          padding: 24px;
        "
      >
        ${renderCredentialsCard(props)}
      </div>
    </section>
  `;
}

// ─── Root render ─────────────────────────────────────────────────────────────

export function renderTelegramManager(props: TelegramProps) {
  return html`
    <div class="tab-container agents-layout">
      ${renderSidebar(props)} ${renderDetailArea(props)}
    </div>
  `;
}
