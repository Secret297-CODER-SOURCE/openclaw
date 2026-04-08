import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { t } from "../../i18n/index.ts";
import type { CronFieldErrors, CronFieldKey } from "../controllers/cron.ts";
import { formatRelativeTimestamp, formatMs } from "../format.ts";
import { pathForTab } from "../navigation.ts";
import { formatCronSchedule, formatNextRun } from "../presenter.ts";
import type { ChannelUiMetaEntry, CronJob, CronRunLogEntry, CronStatus } from "../types.ts";
import type {
  CronDeliveryStatus,
  CronJobsEnabledFilter,
  CronRunScope,
  CronRunsStatusValue,
  CronJobsSortBy,
  CronRunsStatusFilter,
  CronSortDir,
} from "../types.ts";
import type { CronFormState } from "../ui-types.ts";

export type CronProps = {
  basePath: string;
  loading: boolean;
  jobsLoadingMore: boolean;
  status: CronStatus | null;
  jobs: CronJob[];
  jobsTotal: number;
  jobsHasMore: boolean;
  jobsQuery: string;
  jobsEnabledFilter: CronJobsEnabledFilter;
  jobsSortBy: CronJobsSortBy;
  jobsSortDir: CronSortDir;
  error: string | null;
  busy: boolean;
  form: CronFormState;
  fieldErrors: CronFieldErrors;
  canSubmit: boolean;
  editingJobId: string | null;
  channels: string[];
  channelLabels?: Record<string, string>;
  channelMeta?: ChannelUiMetaEntry[];
  runsJobId: string | null;
  runs: CronRunLogEntry[];
  runsTotal: number;
  runsHasMore: boolean;
  runsLoadingMore: boolean;
  runsScope: CronRunScope;
  runsStatuses: CronRunsStatusValue[];
  runsDeliveryStatuses: CronDeliveryStatus[];
  runsStatusFilter: CronRunsStatusFilter;
  runsQuery: string;
  runsSortDir: CronSortDir;
  agentSuggestions: string[];
  modelSuggestions: string[];
  thinkingSuggestions: string[];
  timezoneSuggestions: string[];
  deliveryToSuggestions: string[];
  onFormChange: (patch: Partial<CronFormState>) => void;
  onRefresh: () => void;
  onAdd: () => void;
  onEdit: (job: CronJob) => void;
  onClone: (job: CronJob) => void;
  onCancelEdit: () => void;
  onToggle: (job: CronJob, enabled: boolean) => void;
  onRun: (job: CronJob) => void;
  onRemove: (job: CronJob) => void;
  onLoadRuns: (jobId: string) => void;
  onLoadMoreJobs: () => void;
  onJobsFiltersChange: (patch: {
    cronJobsQuery?: string;
    cronJobsEnabledFilter?: CronJobsEnabledFilter;
    cronJobsSortBy?: CronJobsSortBy;
    cronJobsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onLoadMoreRuns: () => void;
  onRunsFiltersChange: (patch: {
    cronRunsScope?: CronRunScope;
    cronRunsStatuses?: CronRunsStatusValue[];
    cronRunsDeliveryStatuses?: CronDeliveryStatus[];
    cronRunsStatusFilter?: CronRunsStatusFilter;
    cronRunsQuery?: string;
    cronRunsSortDir?: CronSortDir;
  }) => void | Promise<void>;
};

function getRunStatusOptions(): Array<{ value: CronRunsStatusValue; label: string }> {
  return [
    { value: "ok", label: t("cronView.statusOk") },
    { value: "error", label: t("cronView.statusError") },
    { value: "skipped", label: t("cronView.statusSkipped") },
  ];
}

function getRunDeliveryOptions(): Array<{ value: CronDeliveryStatus; label: string }> {
  return [
    { value: "delivered", label: t("cronView.deliveredLabel") },
    { value: "not-delivered", label: t("cronView.notDeliveredLabel") },
    { value: "unknown", label: t("cronView.unknownLabel") },
    { value: "not-requested", label: t("cronView.notRequestedLabel") },
  ];
}

function toggleSelection<T extends string>(selected: T[], value: T, checked: boolean): T[] {
  const set = new Set(selected);
  if (checked) {
    set.add(value);
  } else {
    set.delete(value);
  }
  return Array.from(set);
}

function summarizeSelection(selectedLabels: string[], allLabel: string) {
  if (selectedLabels.length === 0) {
    return allLabel;
  }
  if (selectedLabels.length <= 2) {
    return selectedLabels.join(", ");
  }
  return `${selectedLabels[0]} +${selectedLabels.length - 1}`;
}

function buildChannelOptions(props: CronProps): string[] {
  const options = ["last", ...props.channels.filter(Boolean)];
  const current = props.form.deliveryChannel?.trim();
  if (current && !options.includes(current)) {
    options.push(current);
  }
  const seen = new Set<string>();
  return options.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function resolveChannelLabel(props: CronProps, channel: string): string {
  if (channel === "last") {
    return "last";
  }
  const meta = props.channelMeta?.find((entry) => entry.id === channel);
  if (meta?.label) {
    return meta.label;
  }
  return props.channelLabels?.[channel] ?? channel;
}

function renderRunFilterDropdown(params: {
  id: string;
  title: string;
  summary: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onToggle: (value: string, checked: boolean) => void;
  onClear: () => void;
}) {
  return html`
    <div class="field cron-filter-dropdown" data-filter=${params.id}>
      <span>${params.title}</span>
      <details class="cron-filter-dropdown__details">
        <summary class="btn cron-filter-dropdown__trigger">
          <span>${params.summary}</span>
        </summary>
        <div class="cron-filter-dropdown__panel">
          <div class="cron-filter-dropdown__list">
            ${params.options.map(
              (option) => html`
                <label class="cron-filter-dropdown__option">
                  <input
                    type="checkbox"
                    value=${option.value}
                    .checked=${params.selected.includes(option.value)}
                    @change=${(event: Event) => {
                      const target = event.target as HTMLInputElement;
                      params.onToggle(option.value, target.checked);
                    }}
                  />
                  <span>${option.label}</span>
                </label>
              `,
            )}
          </div>
          <div class="row">
            <button class="btn" type="button" @click=${params.onClear}>${t("cronView.clear")}</button>
          </div>
        </div>
      </details>
    </div>
  `;
}

function renderSuggestionList(id: string, options: string[]) {
  const clean = Array.from(new Set(options.map((option) => option.trim()).filter(Boolean)));
  if (clean.length === 0) {
    return nothing;
  }
  return html`<datalist id=${id}>
    ${clean.map((value) => html`<option value=${value}></option> `)}
  </datalist>`;
}

type BlockingField = {
  key: CronFieldKey;
  label: string;
  message: string;
  inputId: string;
};

function errorIdForField(key: CronFieldKey) {
  return `cron-error-${key}`;
}

function inputIdForField(key: CronFieldKey) {
  if (key === "name") {
    return "cron-name";
  }
  if (key === "scheduleAt") {
    return "cron-schedule-at";
  }
  if (key === "everyAmount") {
    return "cron-every-amount";
  }
  if (key === "cronExpr") {
    return "cron-cron-expr";
  }
  if (key === "staggerAmount") {
    return "cron-stagger-amount";
  }
  if (key === "payloadText") {
    return "cron-payload-text";
  }
  if (key === "payloadModel") {
    return "cron-payload-model";
  }
  if (key === "payloadThinking") {
    return "cron-payload-thinking";
  }
  if (key === "timeoutSeconds") {
    return "cron-timeout-seconds";
  }
  return "cron-delivery-to";
}

function fieldLabelForKey(
  key: CronFieldKey,
  form: CronFormState,
  deliveryMode: CronFormState["deliveryMode"],
) {
  if (key === "payloadText") {
    return form.payloadKind === "systemEvent"
      ? t("cronView.mainTimelineMsg")
      : t("cronView.assistantTaskPrompt");
  }
  if (key === "deliveryTo") {
    return deliveryMode === "webhook" ? t("cronView.webhookUrlLabel") : t("cronView.toField");
  }
  const labels: Record<CronFieldKey, string> = {
    name: t("cronView.nameLabel"),
    scheduleAt: t("cronView.runAtLabel"),
    everyAmount: t("cronView.everyLabel"),
    cronExpr: t("cronView.expressionLabel"),
    staggerAmount: t("cronView.staggerLabel"),
    payloadText: t("cronView.payloadLabel"),
    payloadModel: t("cronView.modelLabel"),
    payloadThinking: t("cronView.thinkingLabel"),
    timeoutSeconds: t("cronView.timeoutLabel"),
    deliveryTo: t("cronView.toLabel"),
  };
  return labels[key];
}

function collectBlockingFields(
  errors: CronFieldErrors,
  form: CronFormState,
  deliveryMode: CronFormState["deliveryMode"],
): BlockingField[] {
  const orderedKeys: CronFieldKey[] = [
    "name",
    "scheduleAt",
    "everyAmount",
    "cronExpr",
    "staggerAmount",
    "payloadText",
    "payloadModel",
    "payloadThinking",
    "timeoutSeconds",
    "deliveryTo",
  ];
  const fields: BlockingField[] = [];
  for (const key of orderedKeys) {
    const message = errors[key];
    if (!message) {
      continue;
    }
    fields.push({
      key,
      label: fieldLabelForKey(key, form, deliveryMode),
      message,
      inputId: inputIdForField(key),
    });
  }
  return fields;
}

function focusFormField(id: string) {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLElement)) {
    return;
  }
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  el.focus();
}

function renderFieldLabel(text: string, required = false) {
  return html`<span>
    ${text}
    ${
      required
        ? html`
            <span class="cron-required-marker" aria-hidden="true">*</span>
            <span class="cron-required-sr">required</span>
          `
        : nothing
    }
  </span>`;
}

export function renderCron(props: CronProps) {
  const isEditing = Boolean(props.editingJobId);
  const isAgentTurn = props.form.payloadKind === "agentTurn";
  const isCronSchedule = props.form.scheduleKind === "cron";
  const channelOptions = buildChannelOptions(props);
  const selectedJob =
    props.runsJobId == null ? undefined : props.jobs.find((job) => job.id === props.runsJobId);
  const selectedRunTitle =
    props.runsScope === "all"
      ? "all jobs"
      : (selectedJob?.name ?? props.runsJobId ?? "(select a job)");
  const runs = props.runs;
  const runStatusOptions = getRunStatusOptions();
  const runDeliveryOptions = getRunDeliveryOptions();
  const selectedStatusLabels = runStatusOptions
    .filter((option) => props.runsStatuses.includes(option.value))
    .map((option) => option.label);
  const selectedDeliveryLabels = runDeliveryOptions
    .filter((option) => props.runsDeliveryStatuses.includes(option.value))
    .map((option) => option.label);
  const statusSummary = summarizeSelection(selectedStatusLabels, t("cronView.allStatuses"));
  const deliverySummary = summarizeSelection(selectedDeliveryLabels, t("cronView.allDelivery"));
  const supportsAnnounce =
    props.form.sessionTarget === "isolated" && props.form.payloadKind === "agentTurn";
  const selectedDeliveryMode =
    props.form.deliveryMode === "announce" && !supportsAnnounce ? "none" : props.form.deliveryMode;
  const blockingFields = collectBlockingFields(props.fieldErrors, props.form, selectedDeliveryMode);
  const blockedByValidation = !props.busy && blockingFields.length > 0;
  const submitDisabledReason =
    blockedByValidation && !props.canSubmit
      ? `Fix ${blockingFields.length} ${blockingFields.length === 1 ? "field" : "fields"} to continue.`
      : "";
  return html`
    <section class="card cron-summary-strip">
      <div class="cron-summary-strip__left">
        <div class="cron-summary-item">
          <div class="cron-summary-label">${t("cronView.enabledLabel")}</div>
          <div class="cron-summary-value">
            <span class=${`chip ${props.status?.enabled ? "chip-ok" : "chip-danger"}`}>
              ${props.status ? (props.status.enabled ? t("ui.yes") : t("ui.no")) : t("common.na")}
            </span>
          </div>
        </div>
        <div class="cron-summary-item">
          <div class="cron-summary-label">${t("cronView.jobsLabel")}</div>
          <div class="cron-summary-value">${props.status?.jobs ?? t("common.na")}</div>
        </div>
        <div class="cron-summary-item cron-summary-item--wide">
          <div class="cron-summary-label">${t("cronView.nextWakeLabel")}</div>
          <div class="cron-summary-value">${formatNextRun(props.status?.nextWakeAtMs ?? null)}</div>
        </div>
      </div>
      <div class="cron-summary-strip__actions">
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("debug.refreshing") : t("ui.refresh")}
        </button>
        ${props.error ? html`<span class="muted">${props.error}</span>` : nothing}
      </div>
    </section>

    <section class="cron-workspace">
      <div class="cron-workspace-main">
        <section class="card">
          <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 12px;">
            <div>
              <div class="card-title">${t("cronView.title")}</div>
              <div class="card-sub">${t("cronView.subtitle")}</div>
            </div>
            <div class="muted">${props.jobs.length} ${t("cronView.shownOf")} ${props.jobsTotal}</div>
          </div>
          <div class="filters" style="margin-top: 12px;">
            <label class="field cron-filter-search">
              <span>Search jobs</span>
              <input
                .value=${props.jobsQuery}
                placeholder=${t("cronView.searchPlaceholder")}
                @input=${(e: Event) =>
                  props.onJobsFiltersChange({
                    cronJobsQuery: (e.target as HTMLInputElement).value,
                  })}
              />
            </label>
            <label class="field">
              <span>${t("cronView.enabledFilter")}</span>
              <select
                .value=${props.jobsEnabledFilter}
                @change=${(e: Event) =>
                  props.onJobsFiltersChange({
                    cronJobsEnabledFilter: (e.target as HTMLSelectElement)
                      .value as CronJobsEnabledFilter,
                  })}
              >
                <option value="all">${t("cronView.allOption")}</option>
                <option value="enabled">${t("cronView.enabledOption")}</option>
                <option value="disabled">${t("cronView.disabledOption")}</option>
              </select>
            </label>
            <label class="field">
              <span>${t("cronView.sortLabel")}</span>
              <select
                .value=${props.jobsSortBy}
                @change=${(e: Event) =>
                  props.onJobsFiltersChange({
                    cronJobsSortBy: (e.target as HTMLSelectElement).value as CronJobsSortBy,
                  })}
              >
                <option value="nextRunAtMs">${t("cronView.nextRunOption")}</option>
                <option value="updatedAtMs">${t("cronView.recentlyUpdatedOption")}</option>
                <option value="name">${t("cronView.nameOption")}</option>
              </select>
            </label>
            <label class="field">
              <span>${t("cronView.directionLabel")}</span>
              <select
                .value=${props.jobsSortDir}
                @change=${(e: Event) =>
                  props.onJobsFiltersChange({
                    cronJobsSortDir: (e.target as HTMLSelectElement).value as CronSortDir,
                  })}
              >
                <option value="asc">${t("cronView.ascendingOption")}</option>
                <option value="desc">${t("cronView.descendingOption")}</option>
              </select>
            </label>
          </div>
          ${
            props.jobs.length === 0
              ? html`
                  <div class="muted" style="margin-top: 12px">${t("cronView.noJobs")}</div>
                `
              : html`
                  <div class="list" style="margin-top: 12px;">
                    ${props.jobs.map((job) => renderJob(job, props))}
                  </div>
                `
          }
          ${
            props.jobsHasMore
              ? html`
                  <div class="row" style="margin-top: 12px">
                    <button
                      class="btn"
                      ?disabled=${props.loading || props.jobsLoadingMore}
                      @click=${props.onLoadMoreJobs}
                    >
                      ${props.jobsLoadingMore ? t("ui.loading") : t("cronView.loadMore")}
                    </button>
                  </div>
                `
              : nothing
          }
        </section>

        <section class="card">
          <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 12px;">
            <div>
              <div class="card-title">${t("cronView.historyTitle")}</div>
              <div class="card-sub">
                ${
                  props.runsScope === "all"
                    ? t("cronView.historySubtitleAll")
                    : `${t("cronView.historySubtitleFor")} ${selectedRunTitle}.`
                }
              </div>
            </div>
            <div class="muted">${runs.length} ${t("cronView.shownOf")} ${props.runsTotal}</div>
          </div>
          <div class="cron-run-filters">
            <div class="cron-run-filters__row cron-run-filters__row--primary">
              <label class="field">
                <span>${t("cronView.scopeLabel")}</span>
                <select
                  .value=${props.runsScope}
                  @change=${(e: Event) =>
                    props.onRunsFiltersChange({
                      cronRunsScope: (e.target as HTMLSelectElement).value as CronRunScope,
                    })}
                >
                  <option value="all">${t("cronView.allJobsOption")}</option>
                  <option value="job" ?disabled=${props.runsJobId == null}>Selected job</option>
                </select>
              </label>
              <label class="field cron-run-filter-search">
                <span>Search runs</span>
                <input
                  .value=${props.runsQuery}
                  placeholder="Summary, error, or job"
                  @input=${(e: Event) =>
                    props.onRunsFiltersChange({
                      cronRunsQuery: (e.target as HTMLInputElement).value,
                    })}
                />
              </label>
              <label class="field">
                <span>Sort</span>
                <select
                  .value=${props.runsSortDir}
                  @change=${(e: Event) =>
                    props.onRunsFiltersChange({
                      cronRunsSortDir: (e.target as HTMLSelectElement).value as CronSortDir,
                    })}
                >
                  <option value="desc">Newest first</option>
                  <option value="asc">Oldest first</option>
                </select>
              </label>
            </div>
            <div class="cron-run-filters__row cron-run-filters__row--secondary">
              ${renderRunFilterDropdown({
                id: "status",
                title: t("debug.statusLabel"),
                summary: statusSummary,
                options: runStatusOptions,
                selected: props.runsStatuses,
                onToggle: (value, checked) => {
                  const next = toggleSelection(
                    props.runsStatuses,
                    value as CronRunsStatusValue,
                    checked,
                  );
                  void props.onRunsFiltersChange({ cronRunsStatuses: next });
                },
                onClear: () => {
                  void props.onRunsFiltersChange({ cronRunsStatuses: [] });
                },
              })}
              ${renderRunFilterDropdown({
                id: "delivery",
                title: t("cronView.deliveryField"),
                summary: deliverySummary,
                options: runDeliveryOptions,
                selected: props.runsDeliveryStatuses,
                onToggle: (value, checked) => {
                  const next = toggleSelection(
                    props.runsDeliveryStatuses,
                    value as CronDeliveryStatus,
                    checked,
                  );
                  void props.onRunsFiltersChange({ cronRunsDeliveryStatuses: next });
                },
                onClear: () => {
                  void props.onRunsFiltersChange({ cronRunsDeliveryStatuses: [] });
                },
              })}
            </div>
          </div>
          ${
            props.runsScope === "job" && props.runsJobId == null
              ? html`
                  <div class="muted" style="margin-top: 12px">Select a job to inspect run history.</div>
                `
              : runs.length === 0
                ? html`
                    <div class="muted" style="margin-top: 12px">No matching runs.</div>
                  `
                : html`
                    <div class="list" style="margin-top: 12px;">
                      ${runs.map((entry) => renderRun(entry, props.basePath))}
                    </div>
                  `
          }
          ${
            (props.runsScope === "all" || props.runsJobId != null) && props.runsHasMore
              ? html`
                  <div class="row" style="margin-top: 12px">
                    <button
                      class="btn"
                      ?disabled=${props.runsLoadingMore}
                      @click=${props.onLoadMoreRuns}
                    >
                      ${props.runsLoadingMore ? t("ui.loading") : t("cronView.loadMore")}
                    </button>
                  </div>
                `
              : nothing
          }
        </section>
      </div>

      <section class="card cron-workspace-form">
        <div class="card-title">${isEditing ? t("cronView.editJobTitle") : t("cronView.newJobTitle")}</div>
        <div class="card-sub">
          ${isEditing ? "Update the selected scheduled job." : "Create a scheduled wakeup or agent run."}
        </div>
        <div class="cron-form">
          <div class="cron-required-legend">
            <span class="cron-required-marker" aria-hidden="true">*</span> Required
          </div>
          <section class="cron-form-section">
            <div class="cron-form-section__title">${t("cronView.sectionBasics")}</div>
            <div class="cron-form-section__sub">${t("cronView.sectionBasicsSub")}</div>
            <div class="form-grid cron-form-grid">
              <label class="field">
                ${renderFieldLabel(t("cronView.nameField"), true)}
                <input
                  id="cron-name"
                  .value=${props.form.name}
                  placeholder="Morning brief"
                  aria-invalid=${props.fieldErrors.name ? "true" : "false"}
                  aria-describedby=${ifDefined(
                    props.fieldErrors.name ? errorIdForField("name") : undefined,
                  )}
                  @input=${(e: Event) =>
                    props.onFormChange({ name: (e.target as HTMLInputElement).value })}
                />
                ${renderFieldError(props.fieldErrors.name, errorIdForField("name"))}
              </label>
              <label class="field">
                <span>${t("cronView.descriptionField")}</span>
                <input
                  .value=${props.form.description}
                  placeholder=""
                  @input=${(e: Event) =>
                    props.onFormChange({ description: (e.target as HTMLInputElement).value })}
                />
              </label>
              <label class="field">
                ${renderFieldLabel(t("cronView.agentIdField"))}
                <input
                  id="cron-agent-id"
                  .value=${props.form.agentId}
                  list="cron-agent-suggestions"
                  ?disabled=${props.form.clearAgent}
                  @input=${(e: Event) =>
                    props.onFormChange({ agentId: (e.target as HTMLInputElement).value })}
                  placeholder="main or ops"
                />
                <div class="cron-help">
                  Start typing to pick a known agent, or enter a custom one.
                </div>
              </label>
              <label class="field checkbox cron-checkbox cron-checkbox-inline">
                <input
                  type="checkbox"
                  .checked=${props.form.enabled}
                  @change=${(e: Event) =>
                    props.onFormChange({ enabled: (e.target as HTMLInputElement).checked })}
                />
                <span class="field-checkbox__label">${t("cronView.enabledLabel2")}</span>
              </label>
            </div>
          </section>

          <section class="cron-form-section">
            <div class="cron-form-section__title">${t("cronView.scheduleField")}</div>
            <div class="cron-form-section__sub">Control when this job runs.</div>
            <div class="form-grid cron-form-grid">
              <label class="field cron-span-2">
                ${renderFieldLabel(t("cronView.scheduleField"))}
                <select
                  id="cron-schedule-kind"
                  .value=${props.form.scheduleKind}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      scheduleKind: (e.target as HTMLSelectElement)
                        .value as CronFormState["scheduleKind"],
                    })}
                >
                  <option value="every">Every</option>
                  <option value="at">At</option>
                  <option value="cron">Cron</option>
                </select>
              </label>
            </div>
            ${renderScheduleFields(props)}
          </section>

          <section class="cron-form-section">
            <div class="cron-form-section__title">${t("cronView.sectionExecution")}</div>
            <div class="cron-form-section__sub">Choose when to wake, and what this job should do.</div>
            <div class="form-grid cron-form-grid">
              <label class="field">
                ${renderFieldLabel(t("cronView.sessionField"))}
                <select
                  id="cron-session-target"
                  .value=${props.form.sessionTarget}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      sessionTarget: (e.target as HTMLSelectElement)
                        .value as CronFormState["sessionTarget"],
                    })}
                >
                  <option value="main">Main</option>
                  <option value="isolated">Isolated</option>
                </select>
                <div class="cron-help">Main posts a system event. Isolated runs a dedicated agent turn.</div>
              </label>
              <label class="field">
                ${renderFieldLabel(t("cronView.wakeModeField"))}
                <select
                  id="cron-wake-mode"
                  .value=${props.form.wakeMode}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      wakeMode: (e.target as HTMLSelectElement).value as CronFormState["wakeMode"],
                    })}
                >
                  <option value="now">Now</option>
                  <option value="next-heartbeat">Next heartbeat</option>
                </select>
                <div class="cron-help">Now triggers immediately. Next heartbeat waits for the next cycle.</div>
              </label>
              <label class="field ${isAgentTurn ? "" : "cron-span-2"}">
                ${renderFieldLabel(t("cronView.wakeModeField"))}
                <select
                  id="cron-payload-kind"
                  .value=${props.form.payloadKind}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      payloadKind: (e.target as HTMLSelectElement)
                        .value as CronFormState["payloadKind"],
                    })}
                >
                  <option value="systemEvent">Post message to main timeline</option>
                  <option value="agentTurn">Run assistant task (isolated)</option>
                </select>
                <div class="cron-help">
                  ${
                    props.form.payloadKind === "systemEvent"
                      ? "Sends your text to the gateway main timeline (good for reminders/triggers)."
                      : "Starts an assistant run in its own session using your prompt."
                  }
                </div>
              </label>
              ${
                isAgentTurn
                  ? html`
                      <label class="field">
                        ${renderFieldLabel(t("cronView.timeoutField"))}
                        <input
                          id="cron-timeout-seconds"
                          .value=${props.form.timeoutSeconds}
                          placeholder="Optional, e.g. 90"
                          aria-invalid=${props.fieldErrors.timeoutSeconds ? "true" : "false"}
                          aria-describedby=${ifDefined(
                            props.fieldErrors.timeoutSeconds
                              ? errorIdForField("timeoutSeconds")
                              : undefined,
                          )}
                          @input=${(e: Event) =>
                            props.onFormChange({
                              timeoutSeconds: (e.target as HTMLInputElement).value,
                            })}
                        />
                        <div class="cron-help">
                          Optional. Leave blank to use the gateway default timeout behavior for this run.
                        </div>
                        ${renderFieldError(
                          props.fieldErrors.timeoutSeconds,
                          errorIdForField("timeoutSeconds"),
                        )}
                      </label>
                    `
                  : nothing
              }
            </div>
            <label class="field cron-span-2">
              ${renderFieldLabel(
                props.form.payloadKind === "systemEvent"
                  ? "Main timeline message"
                  : "Assistant task prompt",
                true,
              )}
              <textarea
                id="cron-payload-text"
                .value=${props.form.payloadText}
                aria-invalid=${props.fieldErrors.payloadText ? "true" : "false"}
                aria-describedby=${ifDefined(
                  props.fieldErrors.payloadText ? errorIdForField("payloadText") : undefined,
                )}
                @input=${(e: Event) =>
                  props.onFormChange({
                    payloadText: (e.target as HTMLTextAreaElement).value,
                  })}
                rows="4"
              ></textarea>
              ${renderFieldError(props.fieldErrors.payloadText, errorIdForField("payloadText"))}
            </label>
          </section>

          <section class="cron-form-section">
            <div class="cron-form-section__title">${t("cronView.sectionDelivery")}</div>
            <div class="cron-form-section__sub">Choose where run summaries are sent.</div>
            <div class="form-grid cron-form-grid">
              <label class="field ${selectedDeliveryMode === "none" ? "cron-span-2" : ""}">
                ${renderFieldLabel(t("cronView.deliveryField"))}
                <select
                  id="cron-delivery-mode"
                  .value=${selectedDeliveryMode}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      deliveryMode: (e.target as HTMLSelectElement)
                        .value as CronFormState["deliveryMode"],
                    })}
                >
                  ${
                    supportsAnnounce
                      ? html`
                          <option value="announce">Announce summary (default)</option>
                        `
                      : nothing
                  }
                  <option value="webhook">Webhook POST</option>
                  <option value="none">None (internal)</option>
                </select>
                <div class="cron-help">Announce posts a summary to chat. None keeps execution internal.</div>
              </label>
              ${
                selectedDeliveryMode !== "none"
                  ? html`
                      <label class="field ${selectedDeliveryMode === "webhook" ? "cron-span-2" : ""}">
                        ${renderFieldLabel(selectedDeliveryMode === "webhook" ? t("cronView.webhookUrlLabel") : t("cronView.channelLabel"), selectedDeliveryMode === "webhook")}
                        ${
                          selectedDeliveryMode === "webhook"
                            ? html`
                                <input
                                  id="cron-delivery-to"
                                  .value=${props.form.deliveryTo}
                                  list="cron-delivery-to-suggestions"
                                  aria-invalid=${props.fieldErrors.deliveryTo ? "true" : "false"}
                                  aria-describedby=${ifDefined(
                                    props.fieldErrors.deliveryTo
                                      ? errorIdForField("deliveryTo")
                                      : undefined,
                                  )}
                                  @input=${(e: Event) =>
                                    props.onFormChange({
                                      deliveryTo: (e.target as HTMLInputElement).value,
                                    })}
                                  placeholder="https://example.com/cron"
                                />
                              `
                            : html`
                                <select
                                  id="cron-delivery-channel"
                                  .value=${props.form.deliveryChannel || "last"}
                                  @change=${(e: Event) =>
                                    props.onFormChange({
                                      deliveryChannel: (e.target as HTMLSelectElement).value,
                                    })}
                                >
                                  ${channelOptions.map(
                                    (channel) =>
                                      html`<option value=${channel}>
                                        ${resolveChannelLabel(props, channel)}
                                      </option>`,
                                  )}
                                </select>
                              `
                        }
                        ${
                          selectedDeliveryMode === "announce"
                            ? html`
                                <div class="cron-help">Choose which connected channel receives the summary.</div>
                              `
                            : html`
                                <div class="cron-help">Send run summaries to a webhook endpoint.</div>
                              `
                        }
                      </label>
                      ${
                        selectedDeliveryMode === "announce"
                          ? html`
                              <label class="field cron-span-2">
                                ${renderFieldLabel("To")}
                                <input
                                  id="cron-delivery-to"
                                  .value=${props.form.deliveryTo}
                                  list="cron-delivery-to-suggestions"
                                  @input=${(e: Event) =>
                                    props.onFormChange({
                                      deliveryTo: (e.target as HTMLInputElement).value,
                                    })}
                                  placeholder="+1555... or chat id"
                                />
                                <div class="cron-help">Optional recipient override (chat id, phone, or user id).</div>
                              </label>
                            `
                          : nothing
                      }
                      ${
                        selectedDeliveryMode === "webhook"
                          ? renderFieldError(
                              props.fieldErrors.deliveryTo,
                              errorIdForField("deliveryTo"),
                            )
                          : nothing
                      }
                    `
                  : nothing
              }
            </div>
          </section>

          <details class="cron-advanced">
            <summary class="cron-advanced__summary">Advanced</summary>
            <div class="cron-help">
              Optional overrides for delivery guarantees, schedule jitter, and model controls.
            </div>
            <div class="form-grid cron-form-grid">
              <label class="field checkbox cron-checkbox">
                <input
                  type="checkbox"
                  .checked=${props.form.deleteAfterRun}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      deleteAfterRun: (e.target as HTMLInputElement).checked,
                    })}
                />
                <span class="field-checkbox__label">Delete after run</span>
                <div class="cron-help">Best for one-shot reminders that should auto-clean up.</div>
              </label>
              <label class="field checkbox cron-checkbox">
                <input
                  type="checkbox"
                  .checked=${props.form.clearAgent}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      clearAgent: (e.target as HTMLInputElement).checked,
                    })}
                />
                <span class="field-checkbox__label">Clear agent override</span>
                <div class="cron-help">Force this job to use the gateway default assistant.</div>
              </label>
              ${
                isCronSchedule
                  ? html`
                      <label class="field checkbox cron-checkbox cron-span-2">
                        <input
                          type="checkbox"
                          .checked=${props.form.scheduleExact}
                          @change=${(e: Event) =>
                            props.onFormChange({
                              scheduleExact: (e.target as HTMLInputElement).checked,
                            })}
                        />
                        <span class="field-checkbox__label">Exact timing (no stagger)</span>
                        <div class="cron-help">Run on exact cron boundaries with no spread.</div>
                      </label>
                      <div class="cron-stagger-group cron-span-2">
                        <label class="field">
                          ${renderFieldLabel(t("cronView.staggerField"))}
                          <input
                            id="cron-stagger-amount"
                            .value=${props.form.staggerAmount}
                            ?disabled=${props.form.scheduleExact}
                            aria-invalid=${props.fieldErrors.staggerAmount ? "true" : "false"}
                            aria-describedby=${ifDefined(
                              props.fieldErrors.staggerAmount
                                ? errorIdForField("staggerAmount")
                                : undefined,
                            )}
                            @input=${(e: Event) =>
                              props.onFormChange({
                                staggerAmount: (e.target as HTMLInputElement).value,
                              })}
                            placeholder="30"
                          />
                          ${renderFieldError(
                            props.fieldErrors.staggerAmount,
                            errorIdForField("staggerAmount"),
                          )}
                        </label>
                        <label class="field">
                          <span>Stagger unit</span>
                          <select
                            .value=${props.form.staggerUnit}
                            ?disabled=${props.form.scheduleExact}
                            @change=${(e: Event) =>
                              props.onFormChange({
                                staggerUnit: (e.target as HTMLSelectElement)
                                  .value as CronFormState["staggerUnit"],
                              })}
                          >
                            <option value="seconds">Seconds</option>
                            <option value="minutes">Minutes</option>
                          </select>
                        </label>
                      </div>
                    `
                  : nothing
              }
              ${
                isAgentTurn
                  ? html`
                      <label class="field">
                        ${renderFieldLabel(t("cronView.modelField"))}
                        <input
                          id="cron-payload-model"
                          .value=${props.form.payloadModel}
                          list="cron-model-suggestions"
                          @input=${(e: Event) =>
                            props.onFormChange({
                              payloadModel: (e.target as HTMLInputElement).value,
                            })}
                          placeholder="openai/gpt-5.2"
                        />
                        <div class="cron-help">
                          Start typing to pick a known model, or enter a custom one.
                        </div>
                      </label>
                      <label class="field">
                        ${renderFieldLabel(t("cronView.thinkingField"))}
                        <input
                          id="cron-payload-thinking"
                          .value=${props.form.payloadThinking}
                          list="cron-thinking-suggestions"
                          @input=${(e: Event) =>
                            props.onFormChange({
                              payloadThinking: (e.target as HTMLInputElement).value,
                            })}
                          placeholder="low"
                        />
                        <div class="cron-help">Use a suggested level or enter a provider-specific value.</div>
                      </label>
                    `
                  : nothing
              }
              ${
                selectedDeliveryMode !== "none"
                  ? html`
                      <label class="field checkbox cron-checkbox cron-span-2">
                        <input
                          type="checkbox"
                          .checked=${props.form.deliveryBestEffort}
                          @change=${(e: Event) =>
                            props.onFormChange({
                              deliveryBestEffort: (e.target as HTMLInputElement).checked,
                            })}
                        />
                        <span class="field-checkbox__label">Best effort delivery</span>
                        <div class="cron-help">Do not fail the job if delivery itself fails.</div>
                      </label>
                    `
                  : nothing
              }
            </div>
          </details>
        </div>
        ${
          blockedByValidation
            ? html`
                <div class="cron-form-status" role="status" aria-live="polite">
                  <div class="cron-form-status__title">Can't add job yet</div>
                  <div class="cron-help">Fill the required fields below to enable submit.</div>
                  <ul class="cron-form-status__list">
                    ${blockingFields.map(
                      (field) => html`
                        <li>
                          <button
                            type="button"
                            class="cron-form-status__link"
                            @click=${() => focusFormField(field.inputId)}
                          >
                            ${field.label}: ${field.message}
                          </button>
                        </li>
                      `,
                    )}
                  </ul>
                </div>
              `
            : nothing
        }
        <div class="row cron-form-actions">
          <button class="btn primary" ?disabled=${props.busy || !props.canSubmit} @click=${props.onAdd}>
            ${props.busy ? t("ui.saving") : isEditing ? t("cronView.saveChanges") : t("cronView.addJob")}
          </button>
          ${
            submitDisabledReason
              ? html`<div class="cron-submit-reason" aria-live="polite">${submitDisabledReason}</div>`
              : nothing
          }
          ${
            isEditing
              ? html`
                  <button class="btn" ?disabled=${props.busy} @click=${props.onCancelEdit}>
                    Cancel
                  </button>
                `
              : nothing
          }
        </div>
      </section>
    </section>

    ${renderSuggestionList("cron-agent-suggestions", props.agentSuggestions)}
    ${renderSuggestionList("cron-model-suggestions", props.modelSuggestions)}
    ${renderSuggestionList("cron-thinking-suggestions", props.thinkingSuggestions)}
    ${renderSuggestionList("cron-tz-suggestions", props.timezoneSuggestions)}
    ${renderSuggestionList("cron-delivery-to-suggestions", props.deliveryToSuggestions)}
  `;
}

function renderScheduleFields(props: CronProps) {
  const form = props.form;
  if (form.scheduleKind === "at") {
    return html`
      <label class="field cron-span-2" style="margin-top: 12px;">
        ${renderFieldLabel("Run at", true)}
        <input
          id="cron-schedule-at"
          type="datetime-local"
          .value=${form.scheduleAt}
          aria-invalid=${props.fieldErrors.scheduleAt ? "true" : "false"}
          aria-describedby=${ifDefined(
            props.fieldErrors.scheduleAt ? errorIdForField("scheduleAt") : undefined,
          )}
          @input=${(e: Event) =>
            props.onFormChange({
              scheduleAt: (e.target as HTMLInputElement).value,
            })}
        />
        ${renderFieldError(props.fieldErrors.scheduleAt, errorIdForField("scheduleAt"))}
      </label>
    `;
  }
  if (form.scheduleKind === "every") {
    return html`
      <div class="form-grid cron-form-grid" style="margin-top: 12px;">
        <label class="field">
          ${renderFieldLabel("Every", true)}
          <input
            id="cron-every-amount"
            .value=${form.everyAmount}
            aria-invalid=${props.fieldErrors.everyAmount ? "true" : "false"}
            aria-describedby=${ifDefined(
              props.fieldErrors.everyAmount ? errorIdForField("everyAmount") : undefined,
            )}
            @input=${(e: Event) =>
              props.onFormChange({
                everyAmount: (e.target as HTMLInputElement).value,
              })}
            placeholder="30"
          />
          ${renderFieldError(props.fieldErrors.everyAmount, errorIdForField("everyAmount"))}
        </label>
        <label class="field">
          <span>Unit</span>
          <select
            .value=${form.everyUnit}
            @change=${(e: Event) =>
              props.onFormChange({
                everyUnit: (e.target as HTMLSelectElement).value as CronFormState["everyUnit"],
              })}
          >
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </select>
        </label>
      </div>
    `;
  }
  return html`
    <div class="form-grid cron-form-grid" style="margin-top: 12px;">
      <label class="field">
        ${renderFieldLabel("Expression", true)}
        <input
          id="cron-cron-expr"
          .value=${form.cronExpr}
          aria-invalid=${props.fieldErrors.cronExpr ? "true" : "false"}
          aria-describedby=${ifDefined(
            props.fieldErrors.cronExpr ? errorIdForField("cronExpr") : undefined,
          )}
          @input=${(e: Event) =>
            props.onFormChange({ cronExpr: (e.target as HTMLInputElement).value })}
          placeholder="0 7 * * *"
        />
        ${renderFieldError(props.fieldErrors.cronExpr, errorIdForField("cronExpr"))}
      </label>
      <label class="field">
        <span>Timezone (optional)</span>
        <input
          .value=${form.cronTz}
          list="cron-tz-suggestions"
          @input=${(e: Event) =>
            props.onFormChange({ cronTz: (e.target as HTMLInputElement).value })}
          placeholder="America/Los_Angeles"
        />
        <div class="cron-help">Pick a common timezone or enter any valid IANA timezone.</div>
      </label>
      <div class="cron-help cron-span-2">Need jitter? Use Advanced → Stagger window / Stagger unit.</div>
    </div>
  `;
}

function renderFieldError(message?: string, id?: string) {
  if (!message) {
    return nothing;
  }
  return html`<div id=${ifDefined(id)} class="cron-help cron-error">${message}</div>`;
}

function renderJob(job: CronJob, props: CronProps) {
  const isSelected = props.runsJobId === job.id;
  const itemClass = `list-item list-item-clickable cron-job${isSelected ? " list-item-selected" : ""}`;
  const selectAnd = (action: () => void) => {
    props.onLoadRuns(job.id);
    action();
  };
  return html`
    <div class=${itemClass} @click=${() => props.onLoadRuns(job.id)}>
      <div class="list-main">
        <div class="list-title">${job.name}</div>
        <div class="list-sub">${formatCronSchedule(job)}</div>
        ${renderJobPayload(job)}
        ${job.agentId ? html`<div class="muted cron-job-agent">Agent: ${job.agentId}</div>` : nothing}
      </div>
      <div class="list-meta">
        ${renderJobState(job)}
      </div>
      <div class="cron-job-footer">
        <div class="chip-row cron-job-chips">
          <span class=${`chip ${job.enabled ? "chip-ok" : "chip-danger"}`}>
            ${job.enabled ? "enabled" : "disabled"}
          </span>
          <span class="chip">${job.sessionTarget}</span>
          <span class="chip">${job.wakeMode}</span>
        </div>
        <div class="row cron-job-actions">
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              selectAnd(() => props.onEdit(job));
            }}
          >
            Edit
          </button>
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              selectAnd(() => props.onClone(job));
            }}
          >
            Clone
          </button>
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              selectAnd(() => props.onToggle(job, !job.enabled));
            }}
          >
            ${job.enabled ? t("cronView.disableJob") : t("cronView.enableJob")}
          </button>
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              selectAnd(() => props.onRun(job));
            }}
          >
            Run
          </button>
          <button
            class="btn"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              selectAnd(() => props.onLoadRuns(job.id));
            }}
          >
            History
          </button>
          <button
            class="btn danger"
            ?disabled=${props.busy}
            @click=${(event: Event) => {
              event.stopPropagation();
              selectAnd(() => props.onRemove(job));
            }}
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderJobPayload(job: CronJob) {
  if (job.payload.kind === "systemEvent") {
    return html`<div class="cron-job-detail">
      <span class="cron-job-detail-label">System</span>
      <span class="muted cron-job-detail-value">${job.payload.text}</span>
    </div>`;
  }

  const delivery = job.delivery;
  const deliveryTarget =
    delivery?.mode === "webhook"
      ? delivery.to
        ? ` (${delivery.to})`
        : ""
      : delivery?.channel || delivery?.to
        ? ` (${delivery.channel ?? "last"}${delivery.to ? ` -> ${delivery.to}` : ""})`
        : "";

  return html`
    <div class="cron-job-detail">
      <span class="cron-job-detail-label">Prompt</span>
      <span class="muted cron-job-detail-value">${job.payload.message}</span>
    </div>
    ${
      delivery
        ? html`<div class="cron-job-detail">
            <span class="cron-job-detail-label">Delivery</span>
            <span class="muted cron-job-detail-value">${delivery.mode}${deliveryTarget}</span>
          </div>`
        : nothing
    }
  `;
}

function formatStateRelative(ms?: number) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "n/a";
  }
  return formatRelativeTimestamp(ms);
}

function formatRunNextLabel(nextRunAtMs: number, nowMs = Date.now()) {
  const rel = formatRelativeTimestamp(nextRunAtMs);
  return nextRunAtMs > nowMs ? `Next ${rel}` : `Due ${rel}`;
}

function renderJobState(job: CronJob) {
  const status = job.state?.lastStatus ?? "n/a";
  const statusClass =
    status === "ok"
      ? "cron-job-status-ok"
      : status === "error"
        ? "cron-job-status-error"
        : status === "skipped"
          ? "cron-job-status-skipped"
          : "cron-job-status-na";
  const nextRunAtMs = job.state?.nextRunAtMs;
  const lastRunAtMs = job.state?.lastRunAtMs;

  return html`
    <div class="cron-job-state">
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">Status</span>
        <span class=${`cron-job-status-pill ${statusClass}`}>${status}</span>
      </div>
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">Next</span>
        <span class="cron-job-state-value" title=${formatMs(nextRunAtMs)}>
          ${formatStateRelative(nextRunAtMs)}
        </span>
      </div>
      <div class="cron-job-state-row">
        <span class="cron-job-state-key">Last</span>
        <span class="cron-job-state-value" title=${formatMs(lastRunAtMs)}>
          ${formatStateRelative(lastRunAtMs)}
        </span>
      </div>
    </div>
  `;
}

function renderRun(entry: CronRunLogEntry, basePath: string) {
  const chatUrl =
    typeof entry.sessionKey === "string" && entry.sessionKey.trim().length > 0
      ? `${pathForTab("chat", basePath)}?session=${encodeURIComponent(entry.sessionKey)}`
      : null;
  const status = entry.status ?? "unknown";
  const delivery = entry.deliveryStatus ?? "not-requested";
  const usage = entry.usage;
  const usageSummary =
    usage && typeof usage.total_tokens === "number"
      ? `${usage.total_tokens} tokens`
      : usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number"
        ? `${usage.input_tokens} in / ${usage.output_tokens} out`
        : null;
  return html`
    <div class="list-item cron-run-entry">
      <div class="list-main cron-run-entry__main">
        <div class="list-title cron-run-entry__title">
          ${entry.jobName ?? entry.jobId}
          <span class="muted"> · ${status}</span>
        </div>
        <div class="list-sub cron-run-entry__summary">${entry.summary ?? entry.error ?? "No summary."}</div>
        <div class="chip-row" style="margin-top: 6px;">
          <span class="chip">${delivery}</span>
          ${entry.model ? html`<span class="chip">${entry.model}</span>` : nothing}
          ${entry.provider ? html`<span class="chip">${entry.provider}</span>` : nothing}
          ${usageSummary ? html`<span class="chip">${usageSummary}</span>` : nothing}
        </div>
      </div>
      <div class="list-meta cron-run-entry__meta">
        <div>${formatMs(entry.ts)}</div>
        ${typeof entry.runAtMs === "number" ? html`<div class="muted">Run at ${formatMs(entry.runAtMs)}</div>` : nothing}
        <div class="muted">${entry.durationMs ?? 0}ms</div>
        ${
          typeof entry.nextRunAtMs === "number"
            ? html`<div class="muted">${formatRunNextLabel(entry.nextRunAtMs)}</div>`
            : nothing
        }
        ${
          chatUrl
            ? html`<div><a class="session-link" href=${chatUrl}>Open run chat</a></div>`
            : nothing
        }
        ${entry.error ? html`<div class="muted">${entry.error}</div>` : nothing}
        ${entry.deliveryError ? html`<div class="muted">${entry.deliveryError}</div>` : nothing}
      </div>
    </div>
  `;
}
