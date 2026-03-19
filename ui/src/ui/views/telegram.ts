import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  TelegramAgentEvent,
  TelegramAgentRecord,
  TaskSession,
  ChatNode,
  FlowNode,
  TrainingPair,
  TrainingGroup,
  TrainingLabel,
  DialogAnalysisResult,
  TrainingScope,
} from "../controllers/telegram.ts";
import {
  formatCronPayload,
  formatCronSchedule,
  formatCronState,
  formatNextRun,
} from "../presenter.ts";
import type { AgentsFilesListResult, CronJob, CronStatus } from "../types.ts";
import { renderAgentFiles } from "./agents-panels-status-files.ts";
import { renderChatPanel, renderSchemaPanel } from "./telegram-scenario.ts";
import type { TelegramChatSubPanel, NodesGraphMode, ScenarioProps } from "./telegram-scenario.ts";
import type { WebchatProps } from "./telegram-webchat.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TelegramPanel =
  | "overview"
  | "auth"
  | "behaviors"
  | "events"
  | "cron"
  | "files"
  | "tasks"
  | "chat"
  | "schema";

export type { TelegramChatSubPanel };

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
  // Scenario / Chat panel
  chatSubPanel: TelegramChatSubPanel;
  nodesGraphMode: NodesGraphMode;
  onNodesGraphModeChange: (mode: NodesGraphMode) => void;
  chatNodes: ChatNode[];
  chatNodesLoading: boolean;
  chatNodesError: string | null;
  flowNodes: FlowNode[];
  flowNodesLoading: boolean;
  schemaScope: import("../controllers/telegram.ts").TrainingScope;
  onSchemaScopeChange: (
    agentId: string,
    scope: import("../controllers/telegram.ts").TrainingScope,
  ) => void;
  diagram: import("../controllers/telegram.ts").FlowDiagram | null;
  diagramLoading: boolean;
  diagramList: import("../controllers/telegram.ts").DiagramSummary[];
  diagramListLoading: boolean;
  onLoadDiagram: (agentId: string) => void;
  onSaveDiagram: (diagram: import("../controllers/telegram.ts").FlowDiagram) => void;
  onSelectDiagram: ((id: string) => void) | null;
  onDeleteDiagram: ((id: string) => void) | null;
  onRenameDiagram: ((id: string, title: string) => void) | null;
  onNewDiagram: (() => void) | null;
  onImportDiagramFromImage:
    | ((
        base64: string,
        mime: string,
      ) => Promise<import("../controllers/telegram.ts").FlowDiagram | null>)
    | null;
  onLoadKnowledgeBase: (() => Promise<void>) | null;
  onDistributeTraining: (() => Promise<void>) | null;
  knowledgeBase: import("../controllers/telegram.ts").DiagramKnowledgeBase | null;
  knowledgeBaseLoading: boolean;
  onGenerateDiagramFromText:
    | ((
        prompt: string,
        current: import("../controllers/telegram.ts").FlowDiagram | null,
      ) => Promise<import("../controllers/telegram.ts").FlowDiagram | null>)
    | null;
  onGetCoachingTips:
    | ((chatId: string, pairs: Array<{ input: string; response: string }>) => Promise<void>)
    | null;
  onToggleCoachingCollapsed: ((chatId: string) => void) | null;
  coachingTips: Record<string, import("../controllers/telegram.ts").CoachingTips>;
  coachingLoading: Set<string>;
  coachingCollapsed: Set<string>;
  trainingPairs: TrainingPair[];
  trainingGroups: TrainingGroup[];
  trainingGroupsLimit: number;
  trainingSelectedChatId: string | null;
  trainingSearchQuery: string;
  trainingLoading: boolean;
  trainingError: string | null;
  showCreateNodesPrompt: boolean;
  onSelectChatSubPanel: (sub: TelegramChatSubPanel) => void;
  onTrainingFileLoad: (agentId: string, json: string, fileName: string) => void;
  onTrainingSelectChat: (id: string | null) => void;
  onTrainingSearchChange: (q: string) => void;
  onTrainingCreateNodes: (agentId: string, group: TrainingGroup) => void;
  onTrainingDismiss: () => void;
  onTrainingShowMore: () => void;
  // Training scope + delete
  trainingScope: TrainingScope;
  trainingPersonalStats: { chats: number; pairs: number } | null;
  trainingSharedStats: { chats: number; pairs: number } | null;
  onTrainingScopeChange: (agentId: string, scope: TrainingScope) => void;
  onTrainingDeletePair: (chatId: string, pairIdx: number) => void;
  onTrainingDeleteGroup: (chatId: string) => void;
  // Inline JSON editor
  trainingEditorOpen: boolean;
  trainingEditorJson: string;
  trainingEditorError: string | null;
  onTrainingEditorOpen: () => void;
  onTrainingEditorChange: (json: string) => void;
  onTrainingEditorSave: (json: string) => void;
  onTrainingEditorClose: () => void;
  onAddChatNode: (agentId: string, role: "manager" | "client") => void;
  onDeleteChatNode: (agentId: string, nodeId: string) => void;
  onLoadChatNodes: (agentId: string) => void;
  onLoadFlowNodes: (agentId: string) => void;
  // Labels & AI analysis
  trainingLabels: Record<string, TrainingLabel>;
  analysisResult: string | null;
  analysisLoading: boolean;
  analysisError: string | null;
  onTrainingSetLabel: (chatId: string, label: TrainingLabel) => void;
  onRunAnalysis: (agentId: string) => void;
  // Per-dialog batch analysis
  analysisResults: Record<string, DialogAnalysisResult>;
  batchRunning: boolean;
  batchProgress: number;
  batchTotal: number;
  batchError: string | null;
  onRunBatchAnalysis: (agentId: string, force?: boolean) => void;
  onCancelBatchAnalysis: () => void;
  // Webchat (Telegram Web messenger)
  webchatDialogs: import("../controllers/telegram.ts").TelegramDialog[];
  webchatDialogsLoading: boolean;
  webchatDialogsError: string | null;
  webchatSelectedId: string | null;
  webchatMessages: import("../controllers/telegram.ts").TelegramWebMessage[];
  webchatMessagesLoading: boolean;
  webchatInput: string;
  webchatSending: boolean;
  webchatSearchQuery: string;
  onWebchatRefresh: (agentId: string) => void;
  onWebchatSelectDialog: (agentId: string, dialogId: string, dialogName: string) => void;
  onWebchatInputChange: (v: string) => void;
  onWebchatSend: (agentId: string) => void;
  onWebchatSearchChange: (q: string) => void;
  // Agent work-mode settings
  agentSettings: import("../controllers/telegram.ts").AgentSettings | null;
  agentSettingsLoading: boolean;
  agentSettingsSaving: boolean;
  onSaveAgentSettings: (
    agentId: string,
    settings: import("../controllers/telegram.ts").AgentSettings,
  ) => void;
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
    { id: "behaviors", label: t("ui.panelBehaviors") },
    { id: "events", label: t("ui.panelEvents") },
    { id: "tasks", label: "Tasks" },
    { id: "cron", label: "Cron" },
    { id: "files", label: "Files" },
    { id: "chat", label: "Чат" },
    { id: "schema", label: "Схема" },
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
  const settings = props.agentSettings ?? { workMode: "always" as const };
  const settingsSaving = props.agentSettingsSaving;
  const settingsLoading = props.agentSettingsLoading;
  const diagramList = props.diagramList ?? [];

  /** Emit updated settings to the backend. */
  const saveSettings = (patch: Partial<typeof settings>) => {
    props.onSaveAgentSettings(agent.id, { ...settings, ...patch });
  };

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

    <!-- ── Work mode settings ─────────────────────────────────────────── -->
    <section class="card" style="margin-top: 16px;">
      <div class="card-title">⚙️ Режим работы</div>
      <div class="card-sub">Настройте когда и как агент отвечает на сообщения.</div>

      ${
        settingsLoading
          ? html`
              <div style="color: var(--text-muted); margin-top: 12px">Загрузка…</div>
            `
          : nothing
      }

      <!-- Diagram selector -->
      <div style="margin-top: 16px;">
        <div class="label" style="margin-bottom: 6px;">🗺 Активная схема</div>
        ${
          diagramList.length === 0
            ? html`
                <div style="color: var(--text-muted); font-size: 13px">
                  Нет сохранённых схем. Создайте схему в разделе «Схема».
                </div>
              `
            : html`
              <select
                class="input"
                style="max-width: 320px;"
                .value=${settings.activeDiagramId ?? ""}
                @change=${(e: Event) => {
                  const v = (e.target as HTMLSelectElement).value;
                  saveSettings({ activeDiagramId: v || undefined });
                }}
              >
                <option value="">— Не выбрана —</option>
                ${diagramList.map(
                  (d) => html`<option value=${d.id} ?selected=${d.id === settings.activeDiagramId}>
                    ${d.title} (${d.nodeCount} узл.)
                  </option>`,
                )}
              </select>
            `
        }
      </div>

      <!-- Work mode -->
      <div style="margin-top: 16px;">
        <div class="label" style="margin-bottom: 8px;">📋 Режим ответов</div>
        <div class="tg-workmode-options">
          ${(
            [
              {
                value: "always",
                label: "Всегда",
                desc: "Агент отвечает на все входящие сообщения",
              },
              {
                value: "schedule",
                label: "По расписанию",
                desc: "Агент отвечает только в указанный временной промежуток",
              },
              {
                value: "schema",
                label: "По схеме",
                desc: "Агент следует выбранной схеме разговора при каждом ответе",
              },
            ] as const
          ).map(
            (opt) => html`
              <label
                class="tg-workmode-option ${settings.workMode === opt.value ? "tg-workmode-option--active" : ""}"
              >
                <input
                  type="radio"
                  name="workMode-${agent.id}"
                  value=${opt.value}
                  ?checked=${settings.workMode === opt.value}
                  @change=${() => saveSettings({ workMode: opt.value })}
                  style="display: none;"
                />
                <div class="tg-workmode-label">${opt.label}</div>
                <div class="tg-workmode-desc">${opt.desc}</div>
              </label>
            `,
          )}
        </div>
      </div>

      <!-- Schedule time range (visible only in "schedule" mode) -->
      ${
        settings.workMode === "schedule"
          ? html`
            <div style="margin-top: 14px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
              <div class="label">С</div>
              <input
                type="time"
                class="input"
                style="width: 120px;"
                .value=${settings.scheduleFrom ?? "09:00"}
                @change=${(e: Event) =>
                  saveSettings({ scheduleFrom: (e.target as HTMLInputElement).value })}
              />
              <div class="label">до</div>
              <input
                type="time"
                class="input"
                style="width: 120px;"
                .value=${settings.scheduleTo ?? "18:00"}
                @change=${(e: Event) =>
                  saveSettings({ scheduleTo: (e.target as HTMLInputElement).value })}
              />
              <div style="color: var(--text-muted); font-size: 12px;">
                (по локальному времени сервера)
              </div>
            </div>
          `
          : nothing
      }

      ${
        settingsSaving
          ? html`
              <div style="color: var(--text-muted); font-size: 12px; margin-top: 8px">Сохранение…</div>
            `
          : nothing
      }
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

  const scenarioProps: ScenarioProps = {
    chatSubPanel: props.chatSubPanel,
    nodesGraphMode: props.nodesGraphMode,
    onNodesGraphModeChange: props.onNodesGraphModeChange,
    chatNodes: props.chatNodes,
    chatNodesLoading: props.chatNodesLoading,
    chatNodesError: props.chatNodesError,
    flowNodes: props.flowNodes,
    flowNodesLoading: props.flowNodesLoading,
    trainingPairs: props.trainingPairs,
    trainingGroups: props.trainingGroups,
    trainingGroupsLimit: props.trainingGroupsLimit,
    trainingSelectedChatId: props.trainingSelectedChatId,
    trainingSearchQuery: props.trainingSearchQuery,
    trainingLoading: props.trainingLoading,
    trainingError: props.trainingError,
    showCreateNodesPrompt: props.showCreateNodesPrompt,
    onSelectChatSubPanel: props.onSelectChatSubPanel,
    onTrainingFileLoad: props.onTrainingFileLoad,
    onTrainingSelectChat: props.onTrainingSelectChat,
    onTrainingSearchChange: props.onTrainingSearchChange,
    onTrainingCreateNodes: props.onTrainingCreateNodes,
    onTrainingDismiss: props.onTrainingDismiss,
    onTrainingShowMore: props.onTrainingShowMore,
    trainingScope: props.trainingScope,
    trainingPersonalStats: props.trainingPersonalStats,
    trainingSharedStats: props.trainingSharedStats,
    onTrainingScopeChange: props.onTrainingScopeChange,
    onTrainingDeletePair: props.onTrainingDeletePair,
    onTrainingDeleteGroup: props.onTrainingDeleteGroup,
    trainingEditorOpen: props.trainingEditorOpen,
    trainingEditorJson: props.trainingEditorJson,
    trainingEditorError: props.trainingEditorError,
    onTrainingEditorOpen: props.onTrainingEditorOpen,
    onTrainingEditorChange: props.onTrainingEditorChange,
    onTrainingEditorSave: props.onTrainingEditorSave,
    onTrainingEditorClose: props.onTrainingEditorClose,
    onAddChatNode: props.onAddChatNode,
    onDeleteChatNode: props.onDeleteChatNode,
    onLoadChatNodes: props.onLoadChatNodes,
    onLoadFlowNodes: props.onLoadFlowNodes,
    schemaScope: props.schemaScope,
    onSchemaScopeChange: props.onSchemaScopeChange,
    diagram: props.diagram,
    diagramLoading: props.diagramLoading,
    diagramList: props.diagramList,
    diagramListLoading: props.diagramListLoading,
    onLoadDiagram: props.onLoadDiagram,
    onSaveDiagram: props.onSaveDiagram,
    onSelectDiagram: props.onSelectDiagram,
    onDeleteDiagram: props.onDeleteDiagram,
    onRenameDiagram: props.onRenameDiagram,
    onNewDiagram: props.onNewDiagram,
    onImportDiagramFromImage: props.onImportDiagramFromImage,
    onLoadKnowledgeBase: props.onLoadKnowledgeBase,
    onDistributeTraining: props.onDistributeTraining,
    knowledgeBase: props.knowledgeBase,
    knowledgeBaseLoading: props.knowledgeBaseLoading,
    onGenerateDiagramFromText: props.onGenerateDiagramFromText,
    onGetCoachingTips: props.onGetCoachingTips,
    onToggleCoachingCollapsed: props.onToggleCoachingCollapsed,
    coachingTips: props.coachingTips,
    coachingLoading: props.coachingLoading,
    coachingCollapsed: props.coachingCollapsed,
    trainingLabels: props.trainingLabels,
    analysisResult: props.analysisResult,
    analysisLoading: props.analysisLoading,
    analysisError: props.analysisError,
    onTrainingSetLabel: props.onTrainingSetLabel,
    onRunAnalysis: props.onRunAnalysis,
    analysisResults: props.analysisResults,
    batchRunning: props.batchRunning,
    batchProgress: props.batchProgress,
    batchTotal: props.batchTotal,
    batchError: props.batchError,
    onRunBatchAnalysis: props.onRunBatchAnalysis,
    onCancelBatchAnalysis: props.onCancelBatchAnalysis,
    // Webchat: only provide for userbot agents
    webchat:
      agent.type === "userbot"
        ? ({
            agent,
            dialogs: props.webchatDialogs,
            dialogsLoading: props.webchatDialogsLoading,
            dialogsError: props.webchatDialogsError,
            selectedDialogId: props.webchatSelectedId,
            messages: props.webchatMessages,
            messagesLoading: props.webchatMessagesLoading,
            input: props.webchatInput,
            sending: props.webchatSending,
            searchQuery: props.webchatSearchQuery,
            onRefreshDialogs: () => props.onWebchatRefresh(agent.id),
            onSelectDialog: (id, name) => props.onWebchatSelectDialog(agent.id, id, name),
            onInputChange: props.onWebchatInputChange,
            onSend: () => props.onWebchatSend(agent.id),
            onSearchChange: props.onWebchatSearchChange,
          } satisfies WebchatProps)
        : undefined,
  };

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
      ${props.activePanel === "behaviors" ? renderBehaviorsPanel(props, agent) : nothing}
      ${props.activePanel === "events" ? renderEventsPanel(props, agent.id) : nothing}
      ${props.activePanel === "tasks" ? renderTasksPanel(props, agent.id) : nothing}
      ${props.activePanel === "cron" ? renderCronPanel(props) : nothing}
      ${props.activePanel === "files" ? renderFilesPanel(props, agent.id) : nothing}
      ${props.activePanel === "chat" ? renderChatPanel(scenarioProps, agent) : nothing}
      ${props.activePanel === "schema" ? renderSchemaPanel(scenarioProps, agent) : nothing}
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
