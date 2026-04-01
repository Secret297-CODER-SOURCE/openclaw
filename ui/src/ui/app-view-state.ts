import type { EventLogEntry } from "./app-events.ts";
import type { CompactionStatus, FallbackStatus } from "./app-tool-stream.ts";
import type { CronFieldErrors } from "./controllers/cron.ts";
import type { DevicePairingList } from "./controllers/devices.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./controllers/exec-approvals.ts";
import type { SkillMessage } from "./controllers/skills.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import type { UiSettings } from "./storage.ts";
import type { ThemeTransitionContext } from "./theme-transition.ts";
import type { ThemeMode } from "./theme.ts";
import type {
  AgentsListResult,
  AgentsFilesListResult,
  AgentIdentityResult,
  ChannelsStatusSnapshot,
  ConfigSnapshot,
  ConfigUiHints,
  CronJob,
  CronJobsEnabledFilter,
  CronJobsSortBy,
  CronDeliveryStatus,
  CronRunScope,
  CronSortDir,
  CronRunsStatusValue,
  CronRunsStatusFilter,
  CronRunLogEntry,
  CronStatus,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  NostrProfile,
  PresenceEntry,
  SessionsUsageResult,
  CostUsageSummary,
  SessionUsageTimeSeries,
  SessionsListResult,
  SkillStatusReport,
  ToolsCatalogResult,
  StatusSummary,
} from "./types.ts";
import type { ChatAttachment, ChatQueueItem, CronFormState } from "./ui-types.ts";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form.ts";
import type { SessionLogEntry } from "./views/usage.ts";

export type AppViewState = {
  settings: UiSettings;
  password: string;
  tab: Tab;
  onboarding: boolean;
  basePath: string;
  connected: boolean;
  theme: ThemeMode;
  themeResolved: "light" | "dark";
  hello: GatewayHelloOk | null;
  lastError: string | null;
  lastErrorCode: string | null;
  eventLog: EventLogEntry[];
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  sessionKey: string;
  chatLoading: boolean;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatRunId: string | null;
  compactionStatus: CompactionStatus | null;
  fallbackStatus: FallbackStatus | null;
  chatAvatarUrl: string | null;
  chatThinkingLevel: string | null;
  chatQueue: ChatQueueItem[];
  chatManualRefreshInFlight: boolean;
  nodesLoading: boolean;
  nodes: Array<Record<string, unknown>>;
  chatNewMessagesBelow: boolean;
  sidebarOpen: boolean;
  sidebarContent: string | null;
  sidebarError: string | null;
  splitRatio: number;
  scrollToBottom: (opts?: { smooth?: boolean }) => void;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  execApprovalsTarget: "gateway" | "node";
  execApprovalsTargetNodeId: string | null;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalBusy: boolean;
  execApprovalError: string | null;
  pendingGatewayUrl: string | null;
  configLoading: boolean;
  configRaw: string;
  configRawOriginal: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  updateRunning: boolean;
  applySessionKey: string;
  configSnapshot: ConfigSnapshot | null;
  configSchema: unknown;
  configSchemaVersion: string | null;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  configFormMode: "form" | "raw";
  configSearchQuery: string;
  configActiveSection: string | null;
  configActiveSubsection: string | null;
  channelsLoading: boolean;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  channelsLastSuccess: number | null;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
  nostrProfileFormState: NostrProfileFormState | null;
  nostrProfileAccountId: string | null;
  configFormDirty: boolean;
  presenceLoading: boolean;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: string | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  agentsSelectedId: string | null;
  toolsCatalogLoading: boolean;
  toolsCatalogError: string | null;
  toolsCatalogResult: ToolsCatalogResult | null;
  agentsPanel: "overview" | "files" | "tools" | "skills" | "channels" | "cron";
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFilesList: AgentsFilesListResult | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileActive: string | null;
  agentFileSaving: boolean;
  agentIdentityLoading: boolean;
  agentIdentityError: string | null;
  agentIdentityById: Record<string, AgentIdentityResult>;
  agentSkillsLoading: boolean;
  agentSkillsError: string | null;
  agentSkillsReport: SkillStatusReport | null;
  agentSkillsAgentId: string | null;
  // --- Telegram agents tab ---
  telegramLoading: boolean;
  telegramError: string | null;
  telegramAgents: import("./controllers/telegram.ts").TelegramAgentRecord[];
  telegramSelectedId: string | null;
  telegramBusy: boolean;
  telegramBusyAgentId: string | null;
  telegramAuthStep: "idle" | "awaiting_code" | "done" | "error";
  telegramAuthError: string | null;
  telegramRecentEvents: import("./controllers/telegram.ts").TelegramAgentEvent[];
  telegramCreateName: string;
  telegramCreateType: "userbot" | "bot";
  telegramCreatePhone: string;
  telegramCreateToken: string;
  telegramOtpCode: string;
  telegramOtpPassword: string;
  telegramSelectedBehaviors: unknown[];
  telegramActivePanel: import("./views/telegram.ts").TelegramPanel;
  telegramBehaviorsJson: string;
  telegramBehaviorsJsonError: string | null;
  telegramBehaviorsVisual: import("./views/telegram-behavior-editor.ts").BehaviorConfig[];
  telegramBehaviorsEditorMode: "visual" | "json";
  // Telegram credentials setup overlay
  telegramApiIdConfigured: boolean | null; // null = not yet loaded
  telegramSetupApiId: string;
  telegramSetupApiHash: string;
  telegramSetupProxyIp: string;
  telegramSetupProxyPort: string;
  telegramSetupProxyUsername: string;
  telegramSetupProxyPassword: string;
  telegramSetupSaving: boolean;
  telegramSetupError: string | null;
  // Telegram proxy settings (accessible after initial setup)
  telegramProxyConfigured: boolean;
  telegramProxyIp: string;
  telegramProxyPort: string;
  telegramProxyEditIp: string;
  telegramProxyEditPort: string;
  telegramProxyEditUsername: string;
  telegramProxyEditPassword: string;
  telegramProxySaving: boolean;
  telegramProxyError: string | null;
  // Telegram task sessions
  telegramTaskSessions: import("./controllers/telegram.ts").TaskSession[];
  telegramTasksLoading: boolean;
  telegramTasksError: string | null;
  telegramTasksBusy: boolean;
  telegramTaskFormChatId: string;
  telegramTaskFormTask: string;
  telegramTaskFormSystemPrompt: string;
  telegramTaskFormOpeningMessage: string;
  // Telegram scenario / chat panel
  telegramChatSubPanel: import("./views/telegram-scenario.ts").TelegramChatSubPanel;
  telegramNodesGraphMode: import("./views/telegram-scenario.ts").NodesGraphMode;
  telegramChatNodes: import("./controllers/telegram.ts").ChatNode[];
  telegramChatNodesLoading: boolean;
  telegramChatNodesError: string | null;
  telegramFlowNodes: import("./controllers/telegram.ts").FlowNode[];
  telegramFlowNodesLoading: boolean;
  /** Schema scope: personal (per-agent) or shared (global across agents). */
  telegramSchemaScope: import("./controllers/telegram.ts").TrainingScope;
  telegramDiagram: import("./controllers/telegram.ts").FlowDiagram | null;
  telegramDiagramLoading: boolean;
  /** All saved diagrams for the current agent+scope (lightweight summaries). */
  telegramDiagramList: import("./controllers/telegram.ts").DiagramSummary[];
  telegramDiagramListLoading: boolean;
  /** Knowledge base: training pairs distributed to diagram nodes. */
  telegramKnowledgeBase: import("./controllers/telegram.ts").DiagramKnowledgeBase | null;
  telegramKnowledgeBaseLoading: boolean;
  /** Live schema conversation states: chatId → nodeId or "__done__". */
  telegramConversationStates: Record<string, string>;
  /** Collected leads for the selected agent. */
  telegramLeads: import("./controllers/telegram.ts").TelegramLead[];
  telegramLeadsLoading: boolean;
  telegramLeadsError: string | null;
  /** Prompt/filter summary for the selected agent. */
  telegramPromptSummary: import("./controllers/telegram.ts").PromptSummary | null;
  telegramPromptSummaryLoading: boolean;
  /** AI coaching tips per chatId — fetched on demand, persisted to DB. */
  telegramCoachingTips: Record<string, import("./controllers/telegram.ts").CoachingTips>;
  telegramCoachingLoading: Set<string>;
  /** Set of chatIds whose coaching card is currently collapsed. */
  telegramCoachingCollapsed: Set<string>;
  /** Agent work-mode settings (active diagram, schedule, mode). */
  telegramAgentSettings: import("./controllers/telegram.ts").AgentSettings | null;
  telegramAgentSettingsLoading: boolean;
  telegramAgentSettingsSaving: boolean;
  /** Unsaved work-mode changes pending "Применить" click (null = no pending edits). */
  telegramWorkModePending: Partial<import("./controllers/telegram.ts").AgentSettings> | null;
  /** Whether an AI re-engagement template generation is in progress. */
  telegramTemplateGenerating: boolean;
  telegramTrainingPairs: import("./controllers/telegram.ts").TrainingPair[];
  telegramTrainingGroups: import("./controllers/telegram.ts").TrainingGroup[];
  telegramTrainingGroupsLimit: number;
  telegramTrainingSelectedChatId: string | null;
  telegramTrainingSearchQuery: string;
  telegramTrainingLoading: boolean;
  telegramTrainingError: string | null;
  telegramShowCreateNodesPrompt: boolean;
  /** Training scope: personal (per-agentId) or shared (global across agents) */
  telegramTrainingScope: import("./controllers/telegram.ts").TrainingScope;
  /** Cached chat/pair counts for the personal scope (set when that scope was last active). */
  telegramTrainingPersonalStats: { chats: number; pairs: number } | null;
  /** Cached chat/pair counts for the shared scope (set when that scope was last active). */
  telegramTrainingSharedStats: { chats: number; pairs: number } | null;
  /** Whether the inline training JSON editor is open. */
  telegramTrainingEditorOpen: boolean;
  /** Current text in the inline JSON editor. */
  telegramTrainingEditorJson: string;
  /** Validation error from the last editor save attempt. */
  telegramTrainingEditorError: string | null;
  // Labels (success/fail/neutral) keyed by chatId
  telegramTrainingLabels: Record<string, import("./controllers/telegram.ts").TrainingLabel>;
  // Whole-dataset AI analysis (freeform text result)
  telegramAnalysisResult: string | null;
  telegramAnalysisLoading: boolean;
  telegramAnalysisError: string | null;
  // Per-dialog batch AI analysis
  telegramAnalysisResults: Record<string, import("./controllers/telegram.ts").DialogAnalysisResult>;
  telegramBatchRunning: boolean;
  telegramBatchProgress: number;
  telegramBatchTotal: number;
  telegramBatchError: string | null;
  /** Non-reactive abort ref set by runBatchAnalysis */
  _telegramBatchAbort?: { cancelled: boolean };
  /** Non-reactive: scroll position per training chatId */
  _trainingScrollPositions?: Record<string, number>;
  // Build schema + KB from training chats
  telegramBuildLoading: boolean;
  telegramBuildResult: import("./controllers/telegram.ts").BuildFromTrainingResult | null;
  telegramBuildError: string | null;
  // Webchat (Telegram-Web-like messenger)
  telegramWebchatDialogs: import("./controllers/telegram.ts").TelegramDialog[];
  telegramWebchatDialogsLoading: boolean;
  telegramWebchatDialogsError: string | null;
  telegramWebchatSelectedId: string | null;
  telegramWebchatMessages: import("./controllers/telegram.ts").TelegramWebMessage[];
  telegramWebchatMessagesLoading: boolean;
  telegramWebchatInput: string;
  telegramWebchatSending: boolean;
  telegramWebchatSearchQuery: string;
  telegramWebchatFolders: import("./controllers/telegram.ts").TelegramDialogFolder[];
  telegramWebchatFolderId: number | null;
  /** Translation mode (shared between Chat and Training tabs) */
  telegramTranslateEnabled: boolean;
  /** Cache: original text → translated text */
  telegramTranslations: Record<string, string>;
  /** Set of texts currently showing original instead of translation */
  telegramTranslateShowOriginals: Record<string, boolean>;
  /** Non-reactive: holds the polling interval ID */
  _telegramWebchatPollTimer?: number | null;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  usageLoading: boolean;
  usageResult: SessionsUsageResult | null;
  usageCostSummary: CostUsageSummary | null;
  usageError: string | null;
  usageStartDate: string;
  usageEndDate: string;
  usageSelectedSessions: string[];
  usageSelectedDays: string[];
  usageSelectedHours: number[];
  usageChartMode: "tokens" | "cost";
  usageDailyChartMode: "total" | "by-type";
  usageTimeSeriesMode: "cumulative" | "per-turn";
  usageTimeSeriesBreakdownMode: "total" | "by-type";
  usageTimeSeries: SessionUsageTimeSeries | null;
  usageTimeSeriesLoading: boolean;
  usageTimeSeriesCursorStart: number | null;
  usageTimeSeriesCursorEnd: number | null;
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsLoading: boolean;
  usageSessionLogsExpanded: boolean;
  usageQuery: string;
  usageQueryDraft: string;
  usageQueryDebounceTimer: number | null;
  usageSessionSort: "tokens" | "cost" | "recent" | "messages" | "errors";
  usageSessionSortDir: "asc" | "desc";
  usageRecentSessions: string[];
  usageTimeZone: "local" | "utc";
  usageContextExpanded: boolean;
  usageHeaderPinned: boolean;
  usageSessionsTab: "all" | "recent";
  usageVisibleColumns: string[];
  usageLogFilterRoles: import("./views/usage.js").SessionLogRole[];
  usageLogFilterTools: string[];
  usageLogFilterHasTools: boolean;
  usageLogFilterQuery: string;
  cronLoading: boolean;
  cronJobsLoadingMore: boolean;
  cronJobs: CronJob[];
  cronJobsTotal: number;
  cronJobsHasMore: boolean;
  cronJobsNextOffset: number | null;
  cronJobsLimit: number;
  cronJobsQuery: string;
  cronJobsEnabledFilter: CronJobsEnabledFilter;
  cronJobsSortBy: CronJobsSortBy;
  cronJobsSortDir: CronSortDir;
  cronStatus: CronStatus | null;
  cronError: string | null;
  cronForm: CronFormState;
  cronFieldErrors: CronFieldErrors;
  cronEditingJobId: string | null;
  cronRunsJobId: string | null;
  cronRunsLoadingMore: boolean;
  cronRuns: CronRunLogEntry[];
  cronRunsTotal: number;
  cronRunsHasMore: boolean;
  cronRunsNextOffset: number | null;
  cronRunsLimit: number;
  cronRunsScope: CronRunScope;
  cronRunsStatuses: CronRunsStatusValue[];
  cronRunsDeliveryStatuses: CronDeliveryStatus[];
  cronRunsStatusFilter: CronRunsStatusFilter;
  cronRunsQuery: string;
  cronRunsSortDir: CronSortDir;
  cronModelSuggestions: string[];
  cronBusy: boolean;
  skillsLoading: boolean;
  skillsReport: SkillStatusReport | null;
  skillsError: string | null;
  skillsFilter: string;
  skillEdits: Record<string, string>;
  skillMessages: Record<string, SkillMessage>;
  skillsBusyKey: string | null;
  debugLoading: boolean;
  debugStatus: StatusSummary | null;
  debugHealth: HealthSnapshot | null;
  debugModels: unknown[];
  debugHeartbeat: unknown;
  debugCallMethod: string;
  debugCallParams: string;
  debugCallResult: string | null;
  debugCallError: string | null;
  logsLoading: boolean;
  logsError: string | null;
  logsFile: string | null;
  logsEntries: LogEntry[];
  logsFilterText: string;
  logsLevelFilters: Record<LogLevel, boolean>;
  logsAutoFollow: boolean;
  logsTruncated: boolean;
  logsCursor: number | null;
  logsLastFetchAt: number | null;
  logsLimit: number;
  logsMaxBytes: number;
  logsAtBottom: boolean;
  updateAvailable: import("./types.js").UpdateAvailable | null;
  client: GatewayBrowserClient | null;
  refreshSessionsAfterChat: Set<string>;
  connect: () => void;
  setTab: (tab: Tab) => void;
  setTheme: (theme: ThemeMode, context?: ThemeTransitionContext) => void;
  applySettings: (next: UiSettings) => void;
  loadOverview: () => Promise<void>;
  loadAssistantIdentity: () => Promise<void>;
  loadCron: () => Promise<void>;
  handleWhatsAppStart: (force: boolean) => Promise<void>;
  handleWhatsAppWait: () => Promise<void>;
  handleWhatsAppLogout: () => Promise<void>;
  handleChannelConfigSave: () => Promise<void>;
  handleChannelConfigReload: () => Promise<void>;
  handleNostrProfileEdit: (accountId: string, profile: NostrProfile | null) => void;
  handleNostrProfileCancel: () => void;
  handleNostrProfileFieldChange: (field: keyof NostrProfile, value: string) => void;
  handleNostrProfileSave: () => Promise<void>;
  handleNostrProfileImport: () => Promise<void>;
  handleNostrProfileToggleAdvanced: () => void;
  handleExecApprovalDecision: (decision: "allow-once" | "allow-always" | "deny") => Promise<void>;
  handleGatewayUrlConfirm: () => void;
  handleGatewayUrlCancel: () => void;
  handleConfigLoad: () => Promise<void>;
  handleConfigSave: () => Promise<void>;
  handleConfigApply: () => Promise<void>;
  handleConfigFormUpdate: (path: string, value: unknown) => void;
  handleConfigFormModeChange: (mode: "form" | "raw") => void;
  handleConfigRawChange: (raw: string) => void;
  handleInstallSkill: (key: string) => Promise<void>;
  handleUpdateSkill: (key: string) => Promise<void>;
  handleToggleSkillEnabled: (key: string, enabled: boolean) => Promise<void>;
  handleUpdateSkillEdit: (key: string, value: string) => void;
  handleSaveSkillApiKey: (key: string, apiKey: string) => Promise<void>;
  handleCronToggle: (jobId: string, enabled: boolean) => Promise<void>;
  handleCronRun: (jobId: string) => Promise<void>;
  handleCronRemove: (jobId: string) => Promise<void>;
  handleCronAdd: () => Promise<void>;
  handleCronRunsLoad: (jobId: string) => Promise<void>;
  handleCronFormUpdate: (path: string, value: unknown) => void;
  handleSessionsLoad: () => Promise<void>;
  handleSessionsPatch: (key: string, patch: unknown) => Promise<void>;
  handleLoadNodes: () => Promise<void>;
  handleLoadPresence: () => Promise<void>;
  handleLoadSkills: () => Promise<void>;
  handleLoadDebug: () => Promise<void>;
  handleLoadLogs: () => Promise<void>;
  handleDebugCall: () => Promise<void>;
  handleRunUpdate: () => Promise<void>;
  setPassword: (next: string) => void;
  setSessionKey: (next: string) => void;
  setChatMessage: (next: string) => void;
  handleSendChat: (messageOverride?: string, opts?: { restoreDraft?: boolean }) => Promise<void>;
  handleAbortChat: () => Promise<void>;
  removeQueuedMessage: (id: string) => void;
  handleChatScroll: (event: Event) => void;
  resetToolStream: () => void;
  resetChatScroll: () => void;
  exportLogs: (lines: string[], label: string) => void;
  handleLogsScroll: (event: Event) => void;
  handleOpenSidebar: (content: string) => void;
  handleCloseSidebar: () => void;
  handleSplitRatioChange: (ratio: number) => void;
};
