import { html, nothing } from "lit";

// ─── Types (mirror the plugin types for the UI layer) ─────────────────────────

export interface AutoReplyBehavior {
  type: "auto_reply";
  enabled: boolean;
  replyMode: "ai" | "template";
  aiSystemPrompt?: string;
  goal?: string;
  triggerKeywords?: string[];
  templates?: { trigger: string; response: string }[];
  onlyInChats?: string[];
  cooldownSeconds?: number;
}

export interface MonitorBehavior {
  type: "monitor";
  enabled: boolean;
  targets: string[];
  filters?: { keywords?: string[]; hasMedia?: boolean };
  webhookUrl?: string;
  saveToDb?: boolean;
}

export interface BroadcastBehavior {
  type: "broadcast";
  enabled: boolean;
  targets: string[];
  message: string;
  schedule?: string;
  parseMode?: "html" | "markdown";
  delayBetweenMs?: number;
  onlyOnce?: boolean;
}

export interface ParserBehavior {
  type: "parser";
  enabled: boolean;
  targets: string[];
  parseMessages?: boolean;
  parseMembers?: boolean;
  limit?: number;
  webhookUrl?: string;
  saveToDb?: boolean;
}

export interface MasterControlBehavior {
  type: "master_control";
  enabled: boolean;
  allowedChatIds: string[];
  systemPrompt?: string;
}

export type BehaviorConfig =
  | AutoReplyBehavior
  | MonitorBehavior
  | BroadcastBehavior
  | ParserBehavior
  | MasterControlBehavior;

export type BehaviorEditorProps = {
  behaviors: BehaviorConfig[];
  saving: boolean;
  error: string | null;
  onChange: (behaviors: BehaviorConfig[]) => void;
  onSave: () => void;
  onExportJson: () => void;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Get or create a behavior of a specific type */
function getBehavior<T extends BehaviorConfig>(
  behaviors: BehaviorConfig[],
  type: T["type"],
): T | undefined {
  return behaviors.find((b) => b.type === type) as T | undefined;
}

/** Update a behavior in the array, or add it if missing */
function upsertBehavior(behaviors: BehaviorConfig[], updated: BehaviorConfig): BehaviorConfig[] {
  const idx = behaviors.findIndex((b) => b.type === updated.type);
  if (idx >= 0) {
    const copy = [...behaviors];
    copy[idx] = updated;
    return copy;
  }
  return [...behaviors, updated];
}

/** Parse a comma/newline separated string to array, trimming blanks */
function parseList(val: string): string[] {
  return val
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Join array to comma-separated string */
function joinList(arr: string[] | undefined): string {
  return arr?.join(", ") ?? "";
}

// ─── Section: Auto Reply ──────────────────────────────────────────────────────

function renderAutoReply(props: BehaviorEditorProps) {
  const ar = getBehavior<AutoReplyBehavior>(props.behaviors, "auto_reply");
  const enabled = ar?.enabled ?? false;
  const replyMode = ar?.replyMode ?? "ai";

  const update = (patch: Partial<AutoReplyBehavior>) => {
    const current: AutoReplyBehavior = ar ?? {
      type: "auto_reply",
      enabled: false,
      replyMode: "ai",
    };
    props.onChange(upsertBehavior(props.behaviors, { ...current, ...patch }));
  };

  return html`
    <div class="tg-be-section">
      <div class="tg-be-section-header">
        <label class="tg-be-toggle">
          <input
            type="checkbox"
            ?checked=${enabled}
            @change=${(e: Event) => update({ enabled: (e.target as HTMLInputElement).checked })}
          />
          <span class="tg-be-section-title">💬 Авто-ответ (auto_reply)</span>
        </label>
      </div>

      ${
        enabled
          ? html`
              <div class="tg-be-fields">
                <!-- Reply mode -->
                <div class="tg-be-field">
                  <label class="tg-be-label">Режим ответа</label>
                  <div class="tg-be-btn-group">
                    <button
                      type="button"
                      class="tg-be-btn ${replyMode === "ai" ? "active" : ""}"
                      @click=${() => update({ replyMode: "ai" })}
                    >AI</button>
                    <button
                      type="button"
                      class="tg-be-btn ${replyMode === "template" ? "active" : ""}"
                      @click=${() => update({ replyMode: "template" })}
                    >Шаблон</button>
                  </div>
                </div>

                <!-- System prompt -->
                <div class="tg-be-field">
                  <label class="tg-be-label">Системный промпт</label>
                  <textarea
                    class="tg-be-textarea"
                    rows="5"
                    placeholder="Ты — менеджер по продажам…"
                    .value=${ar?.aiSystemPrompt ?? ""}
                    @input=${(e: Event) =>
                      update({
                        aiSystemPrompt: (e.target as HTMLTextAreaElement).value || undefined,
                      })}
                  ></textarea>
                </div>

                <!-- Goal -->
                <div class="tg-be-field">
                  <label class="tg-be-label">Цель агента</label>
                  <textarea
                    class="tg-be-textarea"
                    rows="3"
                    placeholder="Привести клиента к звонку…"
                    .value=${ar?.goal ?? ""}
                    @input=${(e: Event) =>
                      update({ goal: (e.target as HTMLTextAreaElement).value || undefined })}
                  ></textarea>
                </div>

                <!-- Trigger keywords -->
                <div class="tg-be-field">
                  <label class="tg-be-label">Триггер-слова <span class="tg-be-hint">(через запятую)</span></label>
                  <input
                    type="text"
                    class="tg-be-input"
                    placeholder="привет, цена, стоимость"
                    .value=${joinList(ar?.triggerKeywords)}
                    @change=${(e: Event) =>
                      update({ triggerKeywords: parseList((e.target as HTMLInputElement).value) })}
                  />
                </div>

                <!-- Only in chats (exclusion list) -->
                <div class="tg-be-field">
                  <label class="tg-be-label">Только в чатах <span class="tg-be-hint">(ID через запятую, пусто = все)</span></label>
                  <input
                    type="text"
                    class="tg-be-input"
                    placeholder="-1001234567890, 987654321"
                    .value=${joinList(ar?.onlyInChats)}
                    @change=${(e: Event) => {
                      const val = (e.target as HTMLInputElement).value.trim();
                      update({ onlyInChats: val ? parseList(val) : undefined });
                    }}
                  />
                </div>

                <!-- Cooldown -->
                <div class="tg-be-field">
                  <label class="tg-be-label">Кулдаун (сек)</label>
                  <input
                    type="number"
                    class="tg-be-input tg-be-input--sm"
                    min="0"
                    .value=${String(ar?.cooldownSeconds ?? 0)}
                    @change=${(e: Event) =>
                      update({
                        cooldownSeconds: Number((e.target as HTMLInputElement).value) || 0,
                      })}
                  />
                </div>

                <!-- Templates (for template mode) -->
                ${
                  replyMode === "template"
                    ? html`
                        <div class="tg-be-field">
                          <label class="tg-be-label">Шаблоны ответов</label>
                          ${(ar?.templates ?? []).map(
                            (t, i) => html`
                              <div class="tg-be-template-row">
                                <input
                                  type="text"
                                  class="tg-be-input"
                                  placeholder="Триггер"
                                  .value=${t.trigger}
                                  @change=${(e: Event) => {
                                    const templates = [...(ar?.templates ?? [])];
                                    templates[i] = {
                                      ...templates[i],
                                      trigger: (e.target as HTMLInputElement).value,
                                    };
                                    update({ templates });
                                  }}
                                />
                                <input
                                  type="text"
                                  class="tg-be-input"
                                  placeholder="Ответ"
                                  .value=${t.response}
                                  @change=${(e: Event) => {
                                    const templates = [...(ar?.templates ?? [])];
                                    templates[i] = {
                                      ...templates[i],
                                      response: (e.target as HTMLInputElement).value,
                                    };
                                    update({ templates });
                                  }}
                                />
                                <button
                                  type="button"
                                  class="tg-be-btn danger"
                                  @click=${() => {
                                    const templates = (ar?.templates ?? []).filter(
                                      (_, j) => j !== i,
                                    );
                                    update({ templates });
                                  }}
                                >✕</button>
                              </div>
                            `,
                          )}
                          <button
                            type="button"
                            class="tg-be-btn"
                            @click=${() => {
                              const templates = [
                                ...(ar?.templates ?? []),
                                { trigger: "", response: "" },
                              ];
                              update({ templates });
                            }}
                          >+ Шаблон</button>
                        </div>
                      `
                    : nothing
                }
              </div>
            `
          : nothing
      }
    </div>
  `;
}

// ─── Section: Monitor ─────────────────────────────────────────────────────────

function renderMonitor(props: BehaviorEditorProps) {
  const m = getBehavior<MonitorBehavior>(props.behaviors, "monitor");
  const enabled = m?.enabled ?? false;

  const update = (patch: Partial<MonitorBehavior>) => {
    const current: MonitorBehavior = m ?? {
      type: "monitor",
      enabled: false,
      targets: [],
    };
    props.onChange(upsertBehavior(props.behaviors, { ...current, ...patch }));
  };

  return html`
    <div class="tg-be-section">
      <div class="tg-be-section-header">
        <label class="tg-be-toggle">
          <input
            type="checkbox"
            ?checked=${enabled}
            @change=${(e: Event) => update({ enabled: (e.target as HTMLInputElement).checked })}
          />
          <span class="tg-be-section-title">👁️ Мониторинг (monitor)</span>
        </label>
      </div>

      ${
        enabled
          ? html`
              <div class="tg-be-fields">
                <div class="tg-be-field">
                  <label class="tg-be-label">Цели <span class="tg-be-hint">(ID чатов/каналов через запятую)</span></label>
                  <input
                    type="text"
                    class="tg-be-input"
                    placeholder="-1001234567890"
                    .value=${joinList(m?.targets)}
                    @change=${(e: Event) => update({ targets: parseList((e.target as HTMLInputElement).value) })}
                  />
                </div>
                <div class="tg-be-field">
                  <label class="tg-be-label">Фильтр: ключевые слова <span class="tg-be-hint">(через запятую)</span></label>
                  <input
                    type="text"
                    class="tg-be-input"
                    placeholder="крипто, биткоин"
                    .value=${joinList(m?.filters?.keywords)}
                    @change=${(e: Event) => {
                      const keywords = parseList((e.target as HTMLInputElement).value);
                      update({
                        filters: {
                          ...m?.filters,
                          keywords: keywords.length ? keywords : undefined,
                        },
                      });
                    }}
                  />
                </div>
                <div class="tg-be-field tg-be-row">
                  <label class="tg-be-toggle">
                    <input
                      type="checkbox"
                      ?checked=${m?.filters?.hasMedia ?? false}
                      @change=${(e: Event) =>
                        update({
                          filters: {
                            ...m?.filters,
                            hasMedia: (e.target as HTMLInputElement).checked,
                          },
                        })}
                    />
                    <span>Только с медиа</span>
                  </label>
                </div>
                <div class="tg-be-field">
                  <label class="tg-be-label">Webhook URL</label>
                  <input
                    type="text"
                    class="tg-be-input"
                    placeholder="https://..."
                    .value=${m?.webhookUrl ?? ""}
                    @change=${(e: Event) =>
                      update({ webhookUrl: (e.target as HTMLInputElement).value || undefined })}
                  />
                </div>
                <div class="tg-be-field tg-be-row">
                  <label class="tg-be-toggle">
                    <input
                      type="checkbox"
                      ?checked=${m?.saveToDb ?? false}
                      @change=${(e: Event) =>
                        update({ saveToDb: (e.target as HTMLInputElement).checked })}
                    />
                    <span>Сохранять в БД</span>
                  </label>
                </div>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

// ─── Section: Broadcast ───────────────────────────────────────────────────────

function renderBroadcast(props: BehaviorEditorProps) {
  const b = getBehavior<BroadcastBehavior>(props.behaviors, "broadcast");
  const enabled = b?.enabled ?? false;

  const update = (patch: Partial<BroadcastBehavior>) => {
    const current: BroadcastBehavior = b ?? {
      type: "broadcast",
      enabled: false,
      targets: [],
      message: "",
    };
    props.onChange(upsertBehavior(props.behaviors, { ...current, ...patch }));
  };

  return html`
    <div class="tg-be-section">
      <div class="tg-be-section-header">
        <label class="tg-be-toggle">
          <input
            type="checkbox"
            ?checked=${enabled}
            @change=${(e: Event) => update({ enabled: (e.target as HTMLInputElement).checked })}
          />
          <span class="tg-be-section-title">📢 Рассылка (broadcast)</span>
        </label>
      </div>

      ${
        enabled
          ? html`
              <div class="tg-be-fields">
                <div class="tg-be-field">
                  <label class="tg-be-label">Цели <span class="tg-be-hint">(ID через запятую)</span></label>
                  <input
                    type="text"
                    class="tg-be-input"
                    .value=${joinList(b?.targets)}
                    @change=${(e: Event) => update({ targets: parseList((e.target as HTMLInputElement).value) })}
                  />
                </div>
                <div class="tg-be-field">
                  <label class="tg-be-label">Сообщение</label>
                  <textarea
                    class="tg-be-textarea"
                    rows="4"
                    .value=${b?.message ?? ""}
                    @input=${(e: Event) =>
                      update({ message: (e.target as HTMLTextAreaElement).value })}
                  ></textarea>
                </div>
                <div class="tg-be-field">
                  <label class="tg-be-label">Расписание (cron)</label>
                  <input
                    type="text"
                    class="tg-be-input"
                    placeholder="0 9 * * *"
                    .value=${b?.schedule ?? ""}
                    @change=${(e: Event) =>
                      update({ schedule: (e.target as HTMLInputElement).value || undefined })}
                  />
                </div>
                <div class="tg-be-field">
                  <label class="tg-be-label">Формат</label>
                  <div class="tg-be-btn-group">
                    <button
                      type="button"
                      class="tg-be-btn ${!b?.parseMode || b.parseMode === "html" ? "active" : ""}"
                      @click=${() => update({ parseMode: "html" })}
                    >HTML</button>
                    <button
                      type="button"
                      class="tg-be-btn ${b?.parseMode === "markdown" ? "active" : ""}"
                      @click=${() => update({ parseMode: "markdown" })}
                    >Markdown</button>
                  </div>
                </div>
                <div class="tg-be-field">
                  <label class="tg-be-label">Задержка между отправками (мс)</label>
                  <input
                    type="number"
                    class="tg-be-input tg-be-input--sm"
                    min="0"
                    .value=${String(b?.delayBetweenMs ?? 1000)}
                    @change=${(e: Event) =>
                      update({
                        delayBetweenMs: Number((e.target as HTMLInputElement).value) || 1000,
                      })}
                  />
                </div>
                <div class="tg-be-field tg-be-row">
                  <label class="tg-be-toggle">
                    <input
                      type="checkbox"
                      ?checked=${b?.onlyOnce ?? false}
                      @change=${(e: Event) =>
                        update({ onlyOnce: (e.target as HTMLInputElement).checked })}
                    />
                    <span>Отправить только один раз</span>
                  </label>
                </div>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

// ─── Section: Parser ──────────────────────────────────────────────────────────

function renderParser(props: BehaviorEditorProps) {
  const p = getBehavior<ParserBehavior>(props.behaviors, "parser");
  const enabled = p?.enabled ?? false;

  const update = (patch: Partial<ParserBehavior>) => {
    const current: ParserBehavior = p ?? {
      type: "parser",
      enabled: false,
      targets: [],
    };
    props.onChange(upsertBehavior(props.behaviors, { ...current, ...patch }));
  };

  return html`
    <div class="tg-be-section">
      <div class="tg-be-section-header">
        <label class="tg-be-toggle">
          <input
            type="checkbox"
            ?checked=${enabled}
            @change=${(e: Event) => update({ enabled: (e.target as HTMLInputElement).checked })}
          />
          <span class="tg-be-section-title">🔍 Парсер (parser)</span>
        </label>
      </div>

      ${
        enabled
          ? html`
              <div class="tg-be-fields">
                <div class="tg-be-field">
                  <label class="tg-be-label">Цели <span class="tg-be-hint">(ID через запятую)</span></label>
                  <input
                    type="text"
                    class="tg-be-input"
                    .value=${joinList(p?.targets)}
                    @change=${(e: Event) => update({ targets: parseList((e.target as HTMLInputElement).value) })}
                  />
                </div>
                <div class="tg-be-field tg-be-row">
                  <label class="tg-be-toggle">
                    <input
                      type="checkbox"
                      ?checked=${p?.parseMessages ?? true}
                      @change=${(e: Event) =>
                        update({ parseMessages: (e.target as HTMLInputElement).checked })}
                    />
                    <span>Парсить сообщения</span>
                  </label>
                </div>
                <div class="tg-be-field tg-be-row">
                  <label class="tg-be-toggle">
                    <input
                      type="checkbox"
                      ?checked=${p?.parseMembers ?? false}
                      @change=${(e: Event) =>
                        update({ parseMembers: (e.target as HTMLInputElement).checked })}
                    />
                    <span>Парсить участников</span>
                  </label>
                </div>
                <div class="tg-be-field">
                  <label class="tg-be-label">Лимит</label>
                  <input
                    type="number"
                    class="tg-be-input tg-be-input--sm"
                    min="1"
                    .value=${String(p?.limit ?? 100)}
                    @change=${(e: Event) =>
                      update({ limit: Number((e.target as HTMLInputElement).value) || 100 })}
                  />
                </div>
                <div class="tg-be-field">
                  <label class="tg-be-label">Webhook URL</label>
                  <input
                    type="text"
                    class="tg-be-input"
                    placeholder="https://..."
                    .value=${p?.webhookUrl ?? ""}
                    @change=${(e: Event) =>
                      update({ webhookUrl: (e.target as HTMLInputElement).value || undefined })}
                  />
                </div>
                <div class="tg-be-field tg-be-row">
                  <label class="tg-be-toggle">
                    <input
                      type="checkbox"
                      ?checked=${p?.saveToDb ?? false}
                      @change=${(e: Event) =>
                        update({ saveToDb: (e.target as HTMLInputElement).checked })}
                    />
                    <span>Сохранять в БД</span>
                  </label>
                </div>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

// ─── Section: Master Control ──────────────────────────────────────────────────

function renderMasterControl(props: BehaviorEditorProps) {
  const mc = getBehavior<MasterControlBehavior>(props.behaviors, "master_control");
  const enabled = mc?.enabled ?? false;

  const update = (patch: Partial<MasterControlBehavior>) => {
    const current: MasterControlBehavior = mc ?? {
      type: "master_control",
      enabled: false,
      allowedChatIds: [],
    };
    props.onChange(upsertBehavior(props.behaviors, { ...current, ...patch }));
  };

  return html`
    <div class="tg-be-section">
      <div class="tg-be-section-header">
        <label class="tg-be-toggle">
          <input
            type="checkbox"
            ?checked=${enabled}
            @change=${(e: Event) => update({ enabled: (e.target as HTMLInputElement).checked })}
          />
          <span class="tg-be-section-title">🎛️ Мастер-контроль (master_control)</span>
        </label>
      </div>

      ${
        enabled
          ? html`
              <div class="tg-be-fields">
                <div class="tg-be-field">
                  <label class="tg-be-label">Разрешённые чаты <span class="tg-be-hint">(ID через запятую)</span></label>
                  <input
                    type="text"
                    class="tg-be-input"
                    placeholder="123456789"
                    .value=${joinList(mc?.allowedChatIds)}
                    @change=${(e: Event) =>
                      update({ allowedChatIds: parseList((e.target as HTMLInputElement).value) })}
                  />
                </div>
                <div class="tg-be-field">
                  <label class="tg-be-label">Системный промпт (мастер)</label>
                  <textarea
                    class="tg-be-textarea"
                    rows="4"
                    placeholder="Ты — управляющий AI агент…"
                    .value=${mc?.systemPrompt ?? ""}
                    @input=${(e: Event) =>
                      update({
                        systemPrompt: (e.target as HTMLTextAreaElement).value || undefined,
                      })}
                  ></textarea>
                </div>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

// ─── Main: Behavior Editor ────────────────────────────────────────────────────

export function renderBehaviorEditor(props: BehaviorEditorProps) {
  return html`
    <div class="tg-be">
      ${renderAutoReply(props)}
      ${renderMonitor(props)}
      ${renderBroadcast(props)}
      ${renderParser(props)}
      ${renderMasterControl(props)}

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }

      <div class="tg-be-actions">
        <button
          type="button"
          class="btn primary"
          ?disabled=${props.saving}
          @click=${props.onSave}
        >${props.saving ? "Сохранение…" : "💾 Сохранить поведения"}</button>
        <button
          type="button"
          class="btn btn--sm"
          @click=${props.onExportJson}
          title="Экспортировать поведения как JSON"
        >↓ JSON</button>
      </div>
    </div>
  `;
}
