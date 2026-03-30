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
  | "schema"
  | "leads";

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
  /** Live schema conversation states: chatId → nodeId or "__done__" (free-mode). */
  chatConversationStates: Record<string, string>;
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
  onExportDiagramJson: ((diagram: import("../controllers/telegram.ts").FlowDiagram) => void) | null;
  onImportDiagramJson:
    | ((file: File) => Promise<import("../controllers/telegram.ts").FlowDiagram | null>)
    | null;
  onCheckAnthropicKey: (() => Promise<boolean>) | null;
  onSaveAnthropicKey: ((key: string) => Promise<{ ok: boolean; error?: string }>) | null;
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
  // Build schema + KB from top training chats
  buildLoading: boolean;
  buildResult: import("../controllers/telegram.ts").BuildFromTrainingResult | null;
  buildError: string | null;
  onBuildFromTraining: (agentId: string) => void;
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
  webchatFolders: import("../controllers/telegram.ts").TelegramDialogFolder[];
  webchatFolderId: number | null;
  onWebchatRefresh: (agentId: string) => void;
  onWebchatSelectDialog: (agentId: string, dialogId: string, dialogName: string) => void;
  onWebchatInputChange: (v: string) => void;
  onWebchatSend: (agentId: string) => void;
  onWebchatSearchChange: (q: string) => void;
  onWebchatFolderSelect: (agentId: string, folderId: number | null) => void;
  translateEnabled: boolean;
  translations: Record<string, string>;
  showOriginals: Record<string, boolean>;
  onTranslateToggle: () => void;
  onTranslateText: (text: string) => void;
  onToggleOriginal: (key: string) => void;
  // Agent work-mode settings
  agentSettings: import("../controllers/telegram.ts").AgentSettings | null;
  agentSettingsLoading: boolean;
  agentSettingsSaving: boolean;
  onSaveAgentSettings: (
    agentId: string,
    settings: import("../controllers/telegram.ts").AgentSettings,
  ) => void;
  /** Pending (unsaved) work-mode patches — null means no changes yet. */
  workModePending: Partial<import("../controllers/telegram.ts").AgentSettings> | null;
  onWorkModePatch: (patch: Partial<import("../controllers/telegram.ts").AgentSettings>) => void;
  onWorkModeApply: (agentId: string) => void;
  onInitLeadsGroup: (agentId: string) => void;
  telegramTemplateGenerating: boolean;
  onGenerateTemplate: (agentId: string) => void;
  // Leads tab
  leads: import("../controllers/telegram.ts").TelegramLead[];
  leadsLoading: boolean;
  leadsError: string | null;
  onLoadLeads: (agentId: string) => void;
  onDeleteLead: (leadId: string) => void;
  onSaveLead: (lead: import("../controllers/telegram.ts").TelegramLead) => void;
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
    { id: "leads", label: "🎯 Лиды" },
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
  const savedSettings = props.agentSettings ?? {
    useSchema: false,
    scheduleMode: "always" as const,
    replyTo: "all" as const,
  };
  // Merge pending work-mode edits into displayed settings.
  const settings = props.workModePending
    ? { ...savedSettings, ...props.workModePending }
    : savedSettings;
  const workModeDirty =
    props.workModePending !== null && Object.keys(props.workModePending).length > 0;
  const settingsSaving = props.agentSettingsSaving;
  const settingsLoading = props.agentSettingsLoading;
  const diagramList = props.diagramList ?? [];

  /** Stage a work-mode change locally (shown immediately, saved on "Применить"). */
  const patchWorkMode = (patch: Partial<typeof savedSettings>) => {
    console.log("[workMode] patch:", patch, "dirty:", workModeDirty);
    props.onWorkModePatch(patch);
  };

  /** Save non-work-mode settings immediately (re-engagement, leads group, etc). */
  const saveSettings = (patch: Partial<typeof savedSettings>) => {
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

      <!-- AI master switch + auto-start -->
      <div style="margin-top:16px;display:flex;flex-direction:column;gap:10px;">
        <!-- AI master kill-switch -->
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;background:${savedSettings.aiEnabled === false ? "rgba(239,68,68,0.12)" : "rgba(34,197,94,0.08)"};border:1px solid ${savedSettings.aiEnabled === false ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.25)"};">
          <span style="font-size:1.1rem;">${savedSettings.aiEnabled === false ? "🔴" : "🟢"}</span>
          <div style="flex:1;">
            <div style="font-size:0.9rem;font-weight:600;">${savedSettings.aiEnabled === false ? "ИИ отключён — агент молчит" : "ИИ активен"}</div>
            <div style="font-size:0.75rem;opacity:0.6;">Когда выключен: агент получает сообщения но ничего не отправляет</div>
          </div>
          <label style="cursor:pointer;position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0;">
            <input
              type="checkbox"
              ?checked=${savedSettings.aiEnabled !== false}
              @change=${(e: Event) =>
                saveSettings({ aiEnabled: (e.target as HTMLInputElement).checked })}
              style="opacity:0;width:0;height:0;position:absolute;"
            />
            <span style="position:absolute;inset:0;border-radius:12px;background:${savedSettings.aiEnabled === false ? "#666" : "var(--primary)"};transition:background .2s;cursor:pointer;">
              <span style="position:absolute;top:3px;left:${savedSettings.aiEnabled === false ? "3px" : "23px"};width:18px;height:18px;border-radius:50%;background:#fff;transition:left .2s;"></span>
            </span>
          </label>
        </div>

        <!-- Auto-start toggle -->
        <label class="tg-toggle-row" style="cursor:pointer;display:flex;align-items:center;gap:8px;user-select:none;">
          <input
            type="checkbox"
            ?checked=${savedSettings.autoStartEnabled !== false}
            @change=${(e: Event) =>
              saveSettings({ autoStartEnabled: (e.target as HTMLInputElement).checked })}
            style="width:16px;height:16px;cursor:pointer;accent-color:var(--primary);"
          />
          <span style="font-size:0.9rem;">Автозапуск при старте gateway</span>
        </label>
      </div>
    </section>

    <!-- ── Work mode settings ─────────────────────────────────────────── -->
    <section class="card" style="margin-top: 16px;">
      <div class="card-title" style="display:flex;align-items:center;gap:10px;">
        <span>⚙️ Режим работы</span>
        ${
          workModeDirty
            ? html`<button
                type="button"
                class="btn primary"
                style="font-size:12px;padding:4px 16px;margin-left:auto;animation:fadeIn .15s ease;"
                ?disabled=${settingsSaving}
                @click=${() => props.onWorkModeApply(agent.id)}
              >${settingsSaving ? "⏳ Сохраняю…" : "✅ Применить"}</button>`
            : nothing
        }
      </div>

      ${
        settingsLoading
          ? html`
              <div style="color: var(--text-muted); padding: 8px 0">Загрузка…</div>
            `
          : nothing
      }

      <!-- ── 1. Активная схема ──────────────────────────────────────── -->
      <div class="tg-setting-row">
        <div class="tg-setting-label">🗺 Активная схема</div>
        <div class="tg-setting-right">
          ${
            diagramList.length === 0
              ? html`
                  <div class="tg-setting-hint">Нет схем — создайте в разделе «Схема»</div>
                `
              : html`<select
                  class="input"
                  style="max-width:280px;"
                  .value=${settings.activeDiagramId ?? ""}
                  @change=${(e: Event) => {
                    const v = (e.target as HTMLSelectElement).value;
                    patchWorkMode({ activeDiagramId: v || undefined });
                  }}
                >
                  <option value="">— Не выбрана —</option>
                  ${diagramList.map(
                    (d) =>
                      html`<option value=${d.id} ?selected=${d.id === settings.activeDiagramId}>
                        ${d.title} (${d.nodeCount} узл.)
                      </option>`,
                  )}
                </select>`
          }
        </div>
      </div>

      <!-- ── 2. Режим общения ───────────────────────────────────────── -->
      <div class="tg-setting-row">
        <div class="tg-setting-label">💬 Режим общения</div>
        <div class="tg-setting-right">
          <div class="tg-toggle-group">
            <label class="tg-toggle-option ${settings.useSchema ? "tg-toggle-option--active" : ""}"
              @click=${() => patchWorkMode({ useSchema: true })}>
              По схеме
            </label>
            <label class="tg-toggle-option ${!settings.useSchema ? "tg-toggle-option--active" : ""}"
              @click=${() => patchWorkMode({ useSchema: false })}>
              Свободно
            </label>
          </div>
          ${
            settings.useSchema && !settings.activeDiagramId
              ? html`
                  <div class="tg-setting-hint tg-setting-hint--warn">⚠ Выберите схему выше</div>
                `
              : settings.useSchema
                ? html`
                    <div class="tg-setting-hint">Строго по шагам выбранной схемы</div>
                  `
                : html`
                    <div class="tg-setting-hint">Свободный AI-ответ</div>
                  `
          }
        </div>
      </div>

      <!-- ── 2b. Строгость схемы (visible only when useSchema is on) ─── -->
      ${
        settings.useSchema
          ? html`
              <div class="tg-setting-row">
                <div class="tg-setting-label">🎯 Строгость</div>
                <div class="tg-setting-right">
                  <div class="tg-toggle-group">
                    <label class="tg-toggle-option ${settings.schemaStrictMode ? "tg-toggle-option--active" : ""}"
                      @click=${() => patchWorkMode({ schemaStrictMode: true })}>
                      Строгий
                    </label>
                    <label class="tg-toggle-option ${!settings.schemaStrictMode ? "tg-toggle-option--active" : ""}"
                      @click=${() => patchWorkMode({ schemaStrictMode: false })}>
                      Гибкий
                    </label>
                  </div>
                  ${
                    settings.schemaStrictMode
                      ? html`
                          <div class="tg-setting-hint">
                            Шаблоны KB обязательны · ответы проверяются · нарушения пересобираются
                          </div>
                        `
                      : html`
                          <div class="tg-setting-hint">Шаблоны KB как подсказка · без проверки</div>
                        `
                  }
                </div>
              </div>

              <!-- ── Стиль подачи скриптов ──────────────────────────────── -->
              <div class="tg-setting-row">
                <div class="tg-setting-label">🗣 Стиль подачи</div>
                <div class="tg-setting-right">
                  <div class="tg-toggle-group">
                    <label class="tg-toggle-option ${(settings.schemaDeliveryStyle ?? "neutral") === "neutral" ? "tg-toggle-option--active" : ""}"
                      @click=${() => patchWorkMode({ schemaDeliveryStyle: "neutral" })}>
                      Стандарт
                    </label>
                    <label class="tg-toggle-option ${settings.schemaDeliveryStyle === "buyer" ? "tg-toggle-option--active" : ""}"
                      @click=${() => patchWorkMode({ schemaDeliveryStyle: "buyer" })}>
                      🔥 Баер
                    </label>
                  </div>
                  <div class="tg-setting-hint">
                    ${
                      settings.schemaDeliveryStyle === "buyer"
                        ? "Скрипты подаются в стиле баера: цифры, ROI, без воды, уверенный тон"
                        : "Стандартная адаптация скриптов под язык и контекст клиента"
                    }
                  </div>
                </div>
              </div>

              ${
                settings.schemaDeliveryStyle === "buyer"
                  ? html`
                      <!-- ── Агрессивность баера ──────────────────────────── -->
                      <div class="tg-setting-row" style="padding-left:12px;border-left:2px solid var(--accent,#e8660088);">
                        <div class="tg-setting-label">⚡ Напористость</div>
                        <div class="tg-setting-right">
                          <div class="tg-toggle-group">
                            <label class="tg-toggle-option ${(settings.buyerAggressionLevel ?? "balanced") === "soft" ? "tg-toggle-option--active" : ""}"
                              @click=${() => patchWorkMode({ buyerAggressionLevel: "soft" })}>
                              Мягкий
                            </label>
                            <label class="tg-toggle-option ${(settings.buyerAggressionLevel ?? "balanced") === "balanced" ? "tg-toggle-option--active" : ""}"
                              @click=${() => patchWorkMode({ buyerAggressionLevel: "balanced" })}>
                              Баланс
                            </label>
                            <label class="tg-toggle-option ${settings.buyerAggressionLevel === "hard" ? "tg-toggle-option--active" : ""}"
                              @click=${() => patchWorkMode({ buyerAggressionLevel: "hard" })}>
                              🔥 Жёсткий
                            </label>
                          </div>
                          <div class="tg-setting-hint">
                            ${
                              {
                                soft: "Больше вопросов, мягкое давление — фокус на понимании",
                                balanced: "Стандартный баер: ROI, срочность, альтернативный выбор",
                                hard: "Прямые предложения, минимум вопросов, максимум давления",
                              }[settings.buyerAggressionLevel ?? "balanced"]
                            }
                          </div>
                        </div>
                      </div>

                      <!-- ── Техника закрытия ────────────────────────────── -->
                      <div class="tg-setting-row" style="padding-left:12px;border-left:2px solid var(--accent,#e8660088);">
                        <div class="tg-setting-label">🎯 Закрытие</div>
                        <div class="tg-setting-right">
                          <div class="tg-toggle-group">
                            <label class="tg-toggle-option ${(settings.buyerCloseStyle ?? "alternative") === "alternative" ? "tg-toggle-option--active" : ""}"
                              @click=${() => patchWorkMode({ buyerCloseStyle: "alternative" })}>
                              X или Y?
                            </label>
                            <label class="tg-toggle-option ${settings.buyerCloseStyle === "direct" ? "tg-toggle-option--active" : ""}"
                              @click=${() => patchWorkMode({ buyerCloseStyle: "direct" })}>
                              Напрямую
                            </label>
                            <label class="tg-toggle-option ${settings.buyerCloseStyle === "micro-step" ? "tg-toggle-option--active" : ""}"
                              @click=${() => patchWorkMode({ buyerCloseStyle: "micro-step" })}>
                              Микрошаг
                            </label>
                          </div>
                          <div class="tg-setting-hint">
                            ${
                              {
                                alternative: "«Удобнее X или Y?» — альтернативный выбор без да/нет",
                                direct: "«Давай оформим прямо сейчас» — прямое закрытие",
                                "micro-step": "«Давай начнём с малого» — снизить барьер входа",
                              }[settings.buyerCloseStyle ?? "alternative"]
                            }
                          </div>
                        </div>
                      </div>

                      <!-- ── Контекст продукта / ниши ────────────────────── -->
                      <div class="tg-setting-row" style="padding-left:12px;border-left:2px solid var(--accent,#e8660088);">
                        <div class="tg-setting-label">📦 Продукт / ниша</div>
                        <div class="tg-setting-right">
                          <textarea
                            class="input"
                            rows="2"
                            style="width:100%;max-width:320px;resize:vertical;font-size:13px;"
                            placeholder="Курс по трейдингу — ученик выходит в плюс за 2 мес., ROI ×3"
                            .value=${settings.buyerProductContext ?? ""}
                            @input=${(e: Event) =>
                              patchWorkMode({
                                buyerProductContext:
                                  (e.target as HTMLTextAreaElement).value.trim() || undefined,
                              })}
                          ></textarea>
                          <div class="tg-setting-hint">
                            Агент использует эти цифры в ROI-аргументах вместо «X» и «Y»
                          </div>
                        </div>
                      </div>
                    `
                  : html``
              }
            `
          : html``
      }

      <!-- ── 3. Расписание ──────────────────────────────────────────── -->
      <div class="tg-setting-row">
        <div class="tg-setting-label">🕐 Время ответов</div>
        <div class="tg-setting-right">
          <div class="tg-toggle-group">
            <label class="tg-toggle-option ${settings.scheduleMode === "always" ? "tg-toggle-option--active" : ""}"
              @click=${() => patchWorkMode({ scheduleMode: "always" })}>
              Всегда
            </label>
            <label class="tg-toggle-option ${settings.scheduleMode === "schedule" ? "tg-toggle-option--active" : ""}"
              @click=${() => patchWorkMode({ scheduleMode: "schedule" })}>
              По расписанию
            </label>
          </div>
          ${
            settings.scheduleMode === "schedule"
              ? html`<div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;">
                  <span style="font-size:13px;color:var(--text-muted);">С</span>
                  <input type="time" class="input" style="width:110px;"
                    .value=${settings.scheduleFrom ?? "09:00"}
                    @input=${(e: Event) =>
                      patchWorkMode({ scheduleFrom: (e.target as HTMLInputElement).value })} />
                  <span style="font-size:13px;color:var(--text-muted);">до</span>
                  <input type="time" class="input" style="width:110px;"
                    .value=${settings.scheduleTo ?? "18:00"}
                    @input=${(e: Event) =>
                      patchWorkMode({ scheduleTo: (e.target as HTMLInputElement).value })} />
                  <span class="tg-setting-hint">(время сервера)</span>
                </div>`
              : html`
                  <div class="tg-setting-hint">Отвечает в любое время</div>
                `
          }
        </div>
      </div>

      <!-- ── 4. Кому отвечать ───────────────────────────────────────── -->
      <div class="tg-setting-row">
        <div class="tg-setting-label">👥 Кому отвечать</div>
        <div class="tg-setting-right">
          <div class="tg-toggle-group">
            <label class="tg-toggle-option ${settings.replyTo === "all" ? "tg-toggle-option--active" : ""}"
              @click=${() => patchWorkMode({ replyTo: "all" })}>
              Всем
            </label>
            <label class="tg-toggle-option ${settings.replyTo === "tasks" ? "tg-toggle-option--active" : ""}"
              @click=${() => patchWorkMode({ replyTo: "tasks" })}>
              Только из Tasks
            </label>
          </div>
          ${
            settings.replyTo === "tasks"
              ? html`
                  <div class="tg-setting-hint">Только чаты с активной задачей</div>
                `
              : html`
                  <div class="tg-setting-hint">Все входящие сообщения</div>
                `
          }
        </div>
      </div>

      <!-- ── 5. Задержка ответа ────────────────────────────────────── -->
      <div class="tg-setting-row">
        <div class="tg-setting-label">⏱ Задержка ответа</div>
        <div class="tg-setting-right">
          <div class="tg-reeng-section-title" style="margin-bottom:8px;">Пауза перед ответом агента (сек)</div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="color:var(--text-muted,#aaa);font-size:13px;">от</span>
            <input type="number" min="0" max="300" style="width:70px;"
              class="tg-reeng-input"
              .value=${String(settings.replyDelayMin ?? 0)}
              @input=${(e: Event) => patchWorkMode({ replyDelayMin: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })} />
            <span style="color:var(--text-muted,#aaa);font-size:13px;">до</span>
            <input type="number" min="0" max="300" style="width:70px;"
              class="tg-reeng-input"
              .value=${String(settings.replyDelayMax ?? 0)}
              @input=${(e: Event) => patchWorkMode({ replyDelayMax: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })} />
            <span style="color:var(--text-muted,#aaa);font-size:13px;">сек</span>
          </div>
          <div class="tg-setting-hint" style="margin-top:6px;">
            ${
              (settings.replyDelayMin ?? 0) === 0 && (settings.replyDelayMax ?? 0) === 0
                ? "Без задержки — агент отвечает мгновенно"
                : `Агент выждет ${settings.replyDelayMin ?? 0}–${settings.replyDelayMax ?? 0} сек. перед каждым ответом`
            }
          </div>
        </div>
      </div>

      <!-- ── 6. Реактивация лидов ──────────────────────────────────── -->
      <div class="tg-setting-row">
        <div class="tg-setting-label">🔁 Реактивация</div>
        <div class="tg-setting-right">

          <!-- Header: toggle + description -->
          <div class="tg-reeng-header">
            <div class="tg-toggle-group">
              <label class="tg-toggle-option ${settings.reEngagementEnabled ? "tg-toggle-option--active" : ""}">
                <input type="radio" name="reeng-${agent.id}"
                  ?checked=${!!settings.reEngagementEnabled}
                  @change=${() => saveSettings({ reEngagementEnabled: true })}
                  style="display:none;" />
                ✅ Включить
              </label>
              <label class="tg-toggle-option ${!settings.reEngagementEnabled ? "tg-toggle-option--active" : ""}">
                <input type="radio" name="reeng-${agent.id}"
                  ?checked=${!settings.reEngagementEnabled}
                  @change=${() => saveSettings({ reEngagementEnabled: false })}
                  style="display:none;" />
                Выкл
              </label>
            </div>
            <div class="tg-setting-hint" style="margin-top:6px;">
              Агент автоматически возобновляет диалог с молчащими контактами.
              ИИ персонализирует каждое сообщение на основе истории переписки.
            </div>
          </div>

          ${
            settings.reEngagementEnabled
              ? html`
            <div class="tg-reeng-panel">

              <!-- Day range -->
              <div class="tg-reeng-section-title">Интервал молчания (дней)</div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
                <span style="font-size:13px;color:var(--text-muted);">от</span>
                <input
                  type="number"
                  min="1"
                  max="365"
                  class="input"
                  style="width:64px;font-size:13px;text-align:center;"
                  .value=${String(settings.reEngagementDelayFrom ?? 1)}
                  @change=${(e: Event) => {
                    const v = parseInt((e.target as HTMLInputElement).value, 10);
                    if (v > 0) {
                      saveSettings({ reEngagementDelayFrom: v });
                    }
                  }}
                />
                <span style="font-size:13px;color:var(--text-muted);">до</span>
                <input
                  type="number"
                  min="1"
                  max="365"
                  class="input"
                  style="width:64px;font-size:13px;text-align:center;"
                  .value=${String(settings.reEngagementDelayTo ?? 7)}
                  @change=${(e: Event) => {
                    const v = parseInt((e.target as HTMLInputElement).value, 10);
                    if (v > 0) {
                      saveSettings({ reEngagementDelayTo: v });
                    }
                  }}
                />
                <span style="font-size:13px;color:var(--text-muted);">дней</span>
                <label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;margin-left:4px;">
                  <input
                    type="checkbox"
                    ?checked=${!!settings.reEngagementDelayMore}
                    @change=${(e: Event) =>
                      saveSettings({
                        reEngagementDelayMore: (e.target as HTMLInputElement).checked,
                      })}
                  />
                  <span style="color:var(--text-muted);">и более</span>
                </label>
              </div>
              <div class="tg-setting-hint" style="margin-bottom:6px;">
                Агент пишет контактам, молчавшим от <b>${settings.reEngagementDelayFrom ?? 1}</b>
                до <b>${settings.reEngagementDelayTo ?? 7}</b> дней${settings.reEngagementDelayMore ? `, а также всем кто молчит дольше` : ""}.
              </div>

              <!-- Pause between messages -->
              <div class="tg-reeng-section-title" style="margin-top:14px;">Задержка между сообщениями</div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;">
                <span style="font-size:0.85rem;color:var(--text-muted);">от</span>
                <input
                  type="number" min="0" max="3600"
                  class="input"
                  style="width:72px;padding:4px 8px;font-size:0.85rem;"
                  .value=${String(settings.reEngagementPauseMin ?? 0)}
                  @change=${(e: Event) =>
                    saveSettings({
                      reEngagementPauseMin: Math.max(
                        0,
                        Number((e.target as HTMLInputElement).value) || 0,
                      ),
                    })}
                />
                <span style="font-size:0.85rem;color:var(--text-muted);">до</span>
                <input
                  type="number" min="0" max="3600"
                  class="input"
                  style="width:72px;padding:4px 8px;font-size:0.85rem;"
                  .value=${String(settings.reEngagementPauseMax ?? 0)}
                  @change=${(e: Event) =>
                    saveSettings({
                      reEngagementPauseMax: Math.max(
                        0,
                        Number((e.target as HTMLInputElement).value) || 0,
                      ),
                    })}
                />
                <span style="font-size:0.85rem;color:var(--text-muted);">сек.</span>
              </div>
              <div class="tg-setting-hint">
                ${
                  (settings.reEngagementPauseMin ?? 0) === 0 &&
                  (settings.reEngagementPauseMax ?? 0) === 0
                    ? "Без паузы — все сообщения отправляются подряд"
                    : `Случайная пауза от ${settings.reEngagementPauseMin ?? 0} до ${settings.reEngagementPauseMax ?? 0} сек. между каждым сообщением`
                }
              </div>

              <!-- AI mode toggle -->
              <div class="tg-reeng-section-title" style="margin-top:14px;margin-bottom:8px;">
                Режим сообщения
              </div>
              <div class="tg-toggle-group" style="margin-bottom:10px;">
                <label
                  class="tg-toggle-option ${(settings.reEngagementAiMode ?? "template") === "template" ? "tg-toggle-option--active" : ""}"
                  @click=${() => saveSettings({ reEngagementAiMode: "template" })}>
                  📝 Шаблон
                </label>
                <label
                  class="tg-toggle-option ${settings.reEngagementAiMode === "ai" ? "tg-toggle-option--active" : ""}"
                  @click=${() => saveSettings({ reEngagementAiMode: "ai" })}>
                  🤖 ИИ генерирует
                </label>
              </div>
              ${
                settings.reEngagementAiMode === "ai"
                  ? html`
                      <div class="tg-setting-hint" style="margin-bottom: 10px">
                        ИИ читает всю историю чата и пишет уникальное сообщение с нуля — в тему прошлого разговора, на
                        языке клиента. Шаблон не нужен.
                      </div>
                    `
                  : html`
              <!-- Template -->
              <div class="tg-reeng-section-title" style="display:flex;align-items:center;gap:8px;">
                <span>Шаблон сообщения</span>
                <span class="tg-reeng-badge-ai">✨ AI улучшает</span>
                <button
                  type="button"
                  class="btn"
                  style="font-size:11px;padding:2px 10px;margin-left:auto;"
                  ?disabled=${props.telegramTemplateGenerating}
                  @click=${() => props.onGenerateTemplate(agent.id)}
                >${props.telegramTemplateGenerating ? "⏳ Генерация..." : "✨ Сгенерировать"}</button>
              </div>
              <textarea
                class="input tg-reeng-textarea"
                rows="3"
                placeholder='Привет {имя}! Горит сделка с профитом 37%, ты с нами? 🔥'
                .value=${settings.reEngagementTemplate ?? ""}
                @input=${(e: Event) =>
                  saveSettings({
                    reEngagementTemplate: (e.target as HTMLTextAreaElement).value || undefined,
                  })}
              ></textarea>`
              }

              <!-- Save template + saved templates list -->
              <div style="display:flex;gap:8px;margin-top:6px;">
                <button
                  type="button"
                  class="btn"
                  style="font-size:11px;padding:2px 10px;"
                  ?disabled=${!settings.reEngagementTemplate}
                  @click=${() => {
                    const tpl = settings.reEngagementTemplate;
                    if (!tpl) {
                      return;
                    }
                    const existing = settings.reEngagementSavedTemplates ?? [];
                    if (!existing.includes(tpl)) {
                      saveSettings({ reEngagementSavedTemplates: [...existing, tpl] });
                    }
                  }}
                >💾 Сохранить шаблон</button>
              </div>
              ${
                (settings.reEngagementSavedTemplates ?? []).length > 0
                  ? html`
                    <div class="tg-reeng-templates">
                      ${(settings.reEngagementSavedTemplates ?? []).map(
                        (tpl) => html`
                        <div class="tg-reeng-template-item">
                          <span class="tg-reeng-template-text" title="${tpl}">${tpl}</span>
                          <button
                            type="button"
                            class="tg-reeng-template-select"
                            @click=${() => saveSettings({ reEngagementTemplate: tpl })}
                          >← выбрать</button>
                          <button
                            type="button"
                            class="tg-reeng-template-delete"
                            title="Удалить шаблон"
                            @click=${() => {
                              const existing = settings.reEngagementSavedTemplates ?? [];
                              saveSettings({
                                reEngagementSavedTemplates: existing.filter((t) => t !== tpl),
                              });
                            }}
                          >🗑</button>
                        </div>
                      `,
                      )}
                    </div>
                  `
                  : nothing
              }

              <!-- Placeholders hint -->
              <div class="tg-reeng-placeholders">
                <span class="tg-reeng-hint-label">Переменные:</span>
                <code class="tg-reeng-code">{имя}</code>
                <code class="tg-reeng-code">{фамилия}</code>
                <code class="tg-reeng-code">{имя_полное}</code>
              </div>

              <!-- AI tip box -->
              <div class="tg-reeng-ai-tip">
                <span class="tg-reeng-ai-tip-icon">🤖</span>
                <span>
                  ИИ персонализирует шаблон для каждого клиента. Если имя не указано — берёт
                  <strong>имя профиля</strong> (@username). Итоговый текст будет живым и интересным.
                </span>
              </div>

              <!-- Name-only checkbox -->
              <label class="tg-reeng-checkbox">
                <input
                  type="checkbox"
                  ?checked=${!!settings.reEngagementNameOnly}
                  @change=${(e: Event) =>
                    saveSettings({ reEngagementNameOnly: (e.target as HTMLInputElement).checked })}
                />
                <span>Не писать, если нет ни имени, ни @username</span>
              </label>

            </div>
          `
              : nothing
          }
        </div>
      </div>

      <!-- ── 6. Группа для лидов ───────────────────────────────────── -->
      <div class="tg-setting-row">
        <div class="tg-setting-label">🎯 Группа лидов</div>
        <div class="tg-setting-right">
          <div style="display:flex;gap:8px;align-items:center;width:100%;max-width:520px;">
            <input
              type="text"
              class="input"
              style="flex:1;font-size:13px;"
              placeholder="https://t.me/+xxxx или @groupname"
              .value=${settings.leadsGroupLink ?? ""}
              @input=${(e: Event) => {
                // Local update only — saved when button is clicked
                (e.target as HTMLInputElement).dataset["pendingValue"] = (
                  e.target as HTMLInputElement
                ).value;
              }}
              @change=${(e: Event) => {
                (e.target as HTMLInputElement).dataset["pendingValue"] = (
                  e.target as HTMLInputElement
                ).value;
              }}
              id="leads-group-input-${agent.id}"
            />
            <button
              type="button"
              class="btn btn-primary"
              style="white-space:nowrap;font-size:12px;"
              @click=${() => {
                const input = document.getElementById(
                  `leads-group-input-${agent.id}`,
                ) as HTMLInputElement | null;
                const val = (input?.value ?? "").trim() || undefined;
                saveSettings({ leadsGroupLink: val });
                if (val) {
                  props.onInitLeadsGroup(agent.id);
                }
              }}
            >💾 Сохранить и подключить</button>
          </div>
          ${
            settings.leadsGroupLink
              ? html`<div class="tg-setting-hint" style="color:var(--ok,#4caf50);margin-top:4px;">✓ Подключено: ${settings.leadsGroupLink}</div>`
              : nothing
          }
          <div class="tg-setting-hint">
            Агент вступит в группу и отправит приветственное сообщение при первом подключении.
            Карточки лидов будут автоматически публиковаться при каждом новом контакте.
            Работает с закрытыми группами (ссылка-приглашение) и публичными (<code style="background:var(--bg-muted);padding:1px 4px;border-radius:3px;">@username</code>).
          </div>
        </div>
      </div>

      <!-- ── 6. Офлайн-режим ────────────────────────────────────────── -->
      <div class="tg-setting-row" style="border-bottom:none;">
        <div class="tg-setting-label">📴 Менеджер офлайн</div>
        <div class="tg-setting-right">
          <div class="tg-toggle-group">
            <label class="tg-toggle-option ${settings.offlineReplyEnabled ? "tg-toggle-option--active" : ""}"
              @click=${() =>
                patchWorkMode({
                  offlineReplyEnabled: true,
                  managerWorkFrom: settings.managerWorkFrom ?? "09:00",
                  managerWorkTo: settings.managerWorkTo ?? "18:00",
                })}>
              ИИ ведёт диалог
            </label>
            <label class="tg-toggle-option ${!settings.offlineReplyEnabled ? "tg-toggle-option--active" : ""}"
              @click=${() => patchWorkMode({ offlineReplyEnabled: false })}>
              Молчать
            </label>
          </div>
          ${
            settings.offlineReplyEnabled
              ? html`
                  <div class="tg-setting-hint" style="margin-bottom:10px;">
                    Пока менеджер недоступен — ИИ продолжает общение, обрабатывает лид
                    и узнаёт удобное время звонка. Работает в режиме «По расписанию».
                  </div>

                  <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;font-weight:500;">
                    Рабочие часы менеджера
                  </div>
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
                    <span style="font-size:13px;color:var(--text-muted);">с</span>
                    <input
                      type="time"
                      class="input"
                      style="width:120px;font-size:13px;"
                      .value=${settings.managerWorkFrom ?? settings.scheduleFrom ?? "09:00"}
                      @input=${(e: Event) =>
                        patchWorkMode({ managerWorkFrom: (e.target as HTMLInputElement).value })}
                    />
                    <span style="font-size:13px;color:var(--text-muted);">до</span>
                    <input
                      type="time"
                      class="input"
                      style="width:120px;font-size:13px;"
                      .value=${settings.managerWorkTo ?? settings.scheduleTo ?? "18:00"}
                      @input=${(e: Event) =>
                        patchWorkMode({ managerWorkTo: (e.target as HTMLInputElement).value })}
                    />
                  </div>
                  <div class="tg-setting-hint" style="margin-bottom:10px;">
                    ИИ скажет клиенту: «менеджер доступен с [от] до [до] — давайте созвонимся завтра в это время»
                  </div>

                  <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">
                    Доп. инструкции для ИИ в офлайн-режиме
                    <span style="opacity:0.6;">(необязательно)</span>
                  </div>
                  <textarea
                    class="input"
                    rows="3"
                    style="width:100%;max-width:420px;resize:vertical;font-size:13px;line-height:1.5;"
                    placeholder="Например: уточни какой продукт интересует, предложи записаться на демо в {от}–{до}"
                    .value=${settings.offlineReplyTemplate ?? ""}
                    @input=${(e: Event) =>
                      patchWorkMode({
                        offlineReplyTemplate: (e.target as HTMLTextAreaElement).value || undefined,
                      })}
                  ></textarea>
                  <div class="tg-setting-hint" style="margin-top:4px;">
                    В инструкциях можно использовать
                    <code style="background:var(--bg-muted);padding:1px 4px;border-radius:3px;">{от}</code>
                    и <code style="background:var(--bg-muted);padding:1px 4px;border-radius:3px;">{до}</code>
                    — подставится время из расписания.
                  </div>
                `
              : html`
                  <div class="tg-setting-hint">Вне расписания агент не отвечает — сообщения игнорируются</div>
                `
          }
        </div>
      </div>

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
  const all = props.recentEvents.filter((e) => e.agentId === agentId);

  const typeIcon: Record<string, string> = {
    message_in: "📨",
    message_out: "📤",
    ai_reply: "🤖",
    behavior: "⚙️",
    reengagement: "🔁",
    followup: "🔔",
    validation: "✅",
    status_change: "🔌",
    error: "❌",
    agent_message: "💬",
    parsed_item: "📋",
  };

  const typeLabel: Record<string, string> = {
    message_in: "Входящее",
    message_out: "Исходящее",
    ai_reply: "Ответ ИИ",
    behavior: "Поведение",
    reengagement: "Реактивация",
    followup: "Follow-up",
    validation: "Валидация",
    status_change: "Статус",
    error: "Ошибка",
    agent_message: "Сообщение",
    parsed_item: "Парсинг",
  };

  const chipClass: Record<string, string> = {
    message_in: "chip",
    message_out: "chip chip-ok",
    ai_reply: "chip chip-ok",
    behavior: "chip",
    reengagement: "chip chip-warn",
    followup: "chip chip-warn",
    validation: "chip chip-ok",
    status_change: "chip",
    error: "chip chip-err",
    agent_message: "chip chip-ok",
  };

  const fmtPayload = (evt: TelegramAgentEvent): string => {
    const p = evt.payload;
    const action = p["action"] as string | undefined;
    const text = (p["text"] ?? p["message"] ?? "") as string;
    const chatId = (p["chatId"] ?? p["chat"]) as string | undefined;
    const chatPrefix = chatId ? `[${chatId}] ` : "";

    switch (evt.type) {
      case "message_in":
        return `${chatPrefix}${text}`;
      case "message_out":
      case "agent_message":
        return `${chatPrefix}${text}`;
      case "ai_reply":
        return `${chatPrefix}[${action ?? "reply"}] ${text}`;
      case "behavior":
        if (action === "schema_advance") {
          return `${chatPrefix}${String(p["from"])} → ${String(p["to"])}`;
        }
        if (action === "catchup_process") {
          return `${chatPrefix}обработка догона`;
        }
        if (action === "offline_lead_reply") {
          return `${chatPrefix}офлайн-лид режим`;
        }
        return `${chatPrefix}${action ?? ""}`;
      case "reengagement":
        return `${chatPrefix}день ${String(p["day"])} · ${text}`;
      case "followup":
        return action === "scheduled"
          ? `${chatPrefix}запланирован через ${String(p["inMinutes"])} мин.`
          : `${chatPrefix}отправлен · ${text}`;
      case "validation":
        return action === "strict_ok"
          ? `${chatPrefix}OK`
          : `${chatPrefix}FAIL: ${JSON.stringify(p["violations"])}`;
      case "status_change":
        return JSON.stringify(p["status"] ?? "");
      case "error":
        return JSON.stringify(p["message"] ?? p["error"] ?? p);
      default:
        return JSON.stringify(p).slice(0, 200);
    }
  };

  return html`
    <section class="card">
      <div class="card-title" style="display:flex;align-items:center;gap:10px;">
        <span>${t("ui.panelEvents")}</span>
        <span style="font-size:12px;color:var(--text-muted);">${all.length} событий</span>
      </div>
      <div class="card-sub">${t("ui.eventsDesc")}</div>
      <div class="list" style="margin-top:12px;">
        ${
          all.length === 0
            ? html`<div class="muted">${t("ui.noEvents")}</div>`
            : all.slice(0, 200).map((evt) => {
                const icon = typeIcon[evt.type] ?? "•";
                const label = typeLabel[evt.type] ?? evt.type;
                const cls = chipClass[evt.type] ?? "chip";
                const body = fmtPayload(evt);
                const chatId = (evt.payload["chatId"] ?? evt.payload["chat"]) as string | undefined;
                return html`
                  <div class="list-item" style="align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--border,#2a2a2a);">
                    <div style="font-size:18px;line-height:1;padding-top:2px;">${icon}</div>
                    <div style="flex:1;min-width:0;">
                      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px;">
                        <span class="${cls}" style="font-size:11px;">${label}</span>
                        ${chatId ? html`<span style="font-size:11px;color:var(--text-muted);">chat:${chatId}</span>` : nothing}
                        <span style="font-size:11px;color:var(--text-muted);margin-left:auto;">
                          ${new Date(evt.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <div style="font-size:13px;color:var(--text-primary,#eee);word-break:break-word;white-space:pre-wrap;line-height:1.4;">${body}</div>
                    </div>
                  </div>
                `;
              })
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
    chatConversationStates: props.chatConversationStates,
    diagramList: props.diagramList,
    diagramListLoading: props.diagramListLoading,
    onLoadDiagram: props.onLoadDiagram,
    onSaveDiagram: props.onSaveDiagram,
    onSelectDiagram: props.onSelectDiagram,
    onDeleteDiagram: props.onDeleteDiagram,
    onRenameDiagram: props.onRenameDiagram,
    onNewDiagram: props.onNewDiagram,
    onImportDiagramFromImage: props.onImportDiagramFromImage,
    onExportDiagramJson: props.onExportDiagramJson,
    onImportDiagramJson: props.onImportDiagramJson,
    onCheckAnthropicKey: props.onCheckAnthropicKey,
    onSaveAnthropicKey: props.onSaveAnthropicKey,
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
    buildLoading: props.buildLoading,
    buildResult: props.buildResult,
    buildError: props.buildError,
    onBuildFromTraining: props.onBuildFromTraining,
    // Translation (shared across chat/training views)
    translateEnabled: props.translateEnabled,
    translations: props.translations,
    showOriginals: props.showOriginals,
    onTranslateToggle: props.onTranslateToggle,
    onTranslateText: props.onTranslateText,
    onToggleOriginal: props.onToggleOriginal,
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
            folders: props.webchatFolders,
            selectedFolderId: props.webchatFolderId,
            translateEnabled: props.translateEnabled,
            translations: props.translations,
            showOriginals: props.showOriginals,
            onRefreshDialogs: () => props.onWebchatRefresh(agent.id),
            onSelectDialog: (id, name) => props.onWebchatSelectDialog(agent.id, id, name),
            onInputChange: props.onWebchatInputChange,
            onSend: () => props.onWebchatSend(agent.id),
            onSearchChange: props.onWebchatSearchChange,
            onFolderSelect: (folderId) => props.onWebchatFolderSelect(agent.id, folderId),
            onTranslateToggle: props.onTranslateToggle,
            onTranslateText: props.onTranslateText,
            onToggleOriginal: props.onToggleOriginal,
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
      ${props.activePanel === "leads" ? renderLeadsPanel(props, agent) : nothing}
    </section>
  `;
}

// ─── Leads panel ─────────────────────────────────────────────────────────────

function renderLeadsPanel(props: TelegramProps, agent: TelegramAgentRecord) {
  const leads = props.leads ?? [];

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return `${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1).toString().padStart(2, "0")} / ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    } catch {
      return iso;
    }
  };

  return html`
    <section class="card" style="margin-top: 12px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
        <div class="card-title" style="margin:0;">🎯 Лиды</div>
        <button
          type="button"
          class="btn btn-sm"
          ?disabled=${props.leadsLoading}
          @click=${() => props.onLoadLeads(agent.id)}
        >
          ${props.leadsLoading ? "Загрузка…" : "Обновить"}
        </button>
      </div>

      ${props.leadsError ? html`<div class="error-banner">${props.leadsError}</div>` : nothing}

      ${
        leads.length === 0 && !props.leadsLoading
          ? html`
              <div class="empty-hint">
                Лиды ещё не собраны. Они появятся автоматически, когда ИИ зафиксирует телефон или завершит диалог.
              </div>
            `
          : nothing
      }

      <div class="tg-leads-list">
        ${leads.map((lead) => {
          const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "—";
          const contactTimeStr = lead.preferredContactTime
            ? `Время связи ${lead.preferredContactTime}`
            : null;
          return html`
            <div class="tg-lead-card">
              <div class="tg-lead-name">${name}</div>
              <div class="tg-lead-fields">
                ${lead.phone ? html`<span class="tg-lead-chip">📞 ${lead.phone}</span>` : nothing}
                ${
                  lead.contactMethod
                    ? html`<span class="tg-lead-chip">${lead.contactMethod}</span>`
                    : nothing
                }
                ${
                  lead.country
                    ? html`<span class="tg-lead-chip">🌍 ${lead.country}</span>`
                    : nothing
                }
                ${lead.age ? html`<span class="tg-lead-chip">👤 ${lead.age} лет</span>` : nothing}
                ${
                  contactTimeStr
                    ? html`<span class="tg-lead-chip">🕐 ${contactTimeStr}</span>`
                    : nothing
                }
                ${lead.role ? html`<span class="tg-lead-chip">💼 ${lead.role}</span>` : nothing}
              </div>
              ${
                lead.telegramLink
                  ? html`
                    <div class="tg-lead-row">
                      <a href=${lead.telegramLink} target="_blank" rel="noopener" class="tg-lead-link">
                        ${lead.telegramLink}
                      </a>
                    </div>
                  `
                  : nothing
              }
              <div class="tg-lead-footer">
                <span class="tg-lead-meta">🤖 ${lead.agentName ?? agent.name}</span>
                <span class="tg-lead-meta">📅 ${formatDate(lead.createdAt)}</span>
                <button
                  type="button"
                  class="btn btn-xs btn-danger"
                  @click=${() => props.onDeleteLead(lead.id)}
                >✕</button>
              </div>
            </div>
          `;
        })}
      </div>
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
