import { html, nothing } from "lit";
import type { TelegramAgentRecord } from "../controllers/telegram.ts";
import type {
  ChatNode,
  FlowNode,
  TrainingPair,
  TrainingGroup,
  TrainingLabel,
  DialogAnalysisResult,
} from "../controllers/telegram.ts";
import { renderWebchat } from "./telegram-webchat.ts";
import type { WebchatProps } from "./telegram-webchat.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TelegramChatSubPanel = "chat" | "nodes" | "training" | "analysis";

export type ScenarioProps = {
  chatSubPanel: TelegramChatSubPanel;
  chatNodes: ChatNode[];
  chatNodesLoading: boolean;
  chatNodesError: string | null;
  flowNodes: FlowNode[];
  flowNodesLoading: boolean;
  trainingPairs: TrainingPair[];
  trainingGroups: TrainingGroup[];
  trainingGroupsLimit: number;
  trainingSelectedChatId: string | null;
  trainingSearchQuery: string;
  trainingLoading: boolean;
  trainingError: string | null;
  showCreateNodesPrompt: boolean;
  // Labels keyed by chatId
  trainingLabels: Record<string, TrainingLabel>;
  // AI analysis
  analysisResult: string | null;
  analysisLoading: boolean;
  analysisError: string | null;
  onSelectChatSubPanel: (sub: TelegramChatSubPanel) => void;
  onTrainingFileLoad: (agentId: string, json: string, fileName: string) => void;
  onTrainingSelectChat: (id: string | null) => void;
  onTrainingSearchChange: (q: string) => void;
  onTrainingCreateNodes: (agentId: string, group: TrainingGroup) => void;
  onTrainingDismiss: () => void;
  onTrainingShowMore: () => void;
  onTrainingSetLabel: (chatId: string, label: TrainingLabel) => void;
  onAddChatNode: (agentId: string, role: "manager" | "client") => void;
  onDeleteChatNode: (agentId: string, nodeId: string) => void;
  onLoadChatNodes: (agentId: string) => void;
  onLoadFlowNodes: (agentId: string) => void;
  onRunAnalysis: (agentId: string) => void;
  // Per-dialog batch analysis
  analysisResults: Record<string, DialogAnalysisResult>;
  batchRunning: boolean;
  batchProgress: number;
  batchTotal: number;
  batchError: string | null;
  onRunBatchAnalysis: (agentId: string, force?: boolean) => void;
  onCancelBatchAnalysis: () => void;
  // Webchat (Telegram messenger) — provided for userbot agents only
  webchat?: WebchatProps;
};

// ─── Sub-panel tabs ───────────────────────────────────────────────────────────

function renderSubTabs(props: ScenarioProps) {
  const tabs: Array<{ id: TelegramChatSubPanel; label: string }> = [
    { id: "chat", label: "Чат" },
    { id: "nodes", label: "Ноды" },
    { id: "training", label: "Обучение" },
    { id: "analysis", label: "Анализ" },
  ];
  return html`
    <div class="agent-tabs" style="margin-bottom: 0;">
      ${tabs.map(
        (tab) => html`
          <button
            type="button"
            class="agent-tab ${props.chatSubPanel === tab.id ? "active" : ""}"
            @click=${() => props.onSelectChatSubPanel(tab.id)}
          >
            ${tab.label}
          </button>
        `,
      )}
    </div>
  `;
}

// ─── Chat view (message bubbles) ──────────────────────────────────────────────

function renderChatView(props: ScenarioProps, _agent: TelegramAgentRecord) {
  // For userbot agents the "Чат" sub-tab shows the live Telegram messenger
  if (props.webchat) {
    return renderWebchat(props.webchat);
  }

  // Bot agents: show scenario message bubbles
  const nodes = props.chatNodes;

  if (props.chatNodesLoading) {
    return html`
      <div class="muted" style="padding: 16px">Загрузка…</div>
    `;
  }

  if (nodes.length === 0) {
    return html`
      <div class="muted" style="padding: 16px">
        Нет сообщений. Добавьте ноды в разделе «Ноды» или загрузите переписку в «Обучении».
      </div>
    `;
  }

  return html`
    <div class="tg-chat-bubbles">
      ${nodes.map(
        (node) => html`
          <div class="tg-bubble tg-bubble--${node.role}">
            <div class="tg-bubble-label">${node.role === "manager" ? "Менеджер" : "Клиент"}</div>
            <div class="tg-bubble-text">${node.text}</div>
            ${
              node.branches && node.branches.length > 0
                ? html`
                    <div class="tg-bubble-branches">
                      ${node.branches.map(
                        (b) => html`
                          <span class="chip" style="margin: 2px 4px 0 0;">${b.keyword} →</span>
                        `,
                      )}
                    </div>
                  `
                : nothing
            }
          </div>
        `,
      )}
    </div>
  `;
}

// ─── Nodes view (node graph / list) ───────────────────────────────────────────

function renderNodesView(props: ScenarioProps, agent: TelegramAgentRecord) {
  const nodes = props.chatNodes;

  if (props.chatNodesLoading) {
    return html`
      <div class="muted" style="padding: 16px">Загрузка…</div>
    `;
  }

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <div>
          <div class="card-title">Ноды</div>
          <div class="card-sub">${nodes.length} нод · Сценарий общения</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button class="btn btn--sm" @click=${() => props.onLoadChatNodes(agent.id)}>
            Обновить
          </button>
          <button class="btn btn--sm primary" @click=${() => props.onAddChatNode(agent.id, "manager")}>
            + Менеджер
          </button>
          <button class="btn btn--sm" @click=${() => props.onAddChatNode(agent.id, "client")}>
            + Клиент
          </button>
        </div>
      </div>

      ${
        props.chatNodesError
          ? html`<div class="callout danger" style="margin-bottom: 12px;">${props.chatNodesError}</div>`
          : nothing
      }

      ${
        nodes.length === 0
          ? html`
              <div class="muted">Нет нод. Нажмите «+ Менеджер» или «+ Клиент» чтобы добавить.</div>
            `
          : html`
              <div class="tg-nodes-list">
                ${nodes.map(
                  (node, idx) => html`
                    <div class="tg-node tg-node--${node.role}">
                      <div class="tg-node-header">
                        <span class="chip ${node.role === "manager" ? "chip-ok" : ""}">
                          ${node.role === "manager" ? "Менеджер" : "Клиент"}
                        </span>
                        <span class="muted" style="font-size: 0.75em;">
                          ${idx + 1} / ${nodes.length}
                        </span>
                        <button
                          class="btn btn--sm danger"
                          style="margin-left: auto;"
                          @click=${() => props.onDeleteChatNode(agent.id, node.id)}
                        >
                          ✕
                        </button>
                      </div>
                      <div class="tg-node-text">${node.text}</div>
                      ${
                        node.nextNodeId
                          ? html`<div class="tg-node-next muted" style="font-size: 0.75em; margin-top: 4px;">
                              → ${node.nextNodeId.slice(0, 8)}…
                            </div>`
                          : nothing
                      }
                      ${
                        node.branches && node.branches.length > 0
                          ? html`
                              <div style="margin-top: 6px;">
                                ${node.branches.map(
                                  (b) => html`
                                    <div class="tg-node-branch">
                                      <span class="chip">${b.keyword}</span>
                                      <span class="muted">→ ${b.nextNodeId.slice(0, 8)}…</span>
                                    </div>
                                  `,
                                )}
                              </div>
                            `
                          : nothing
                      }
                    </div>
                    ${
                      idx < nodes.length - 1
                        ? html`
                            <div class="tg-node-connector" aria-hidden="true">↓</div>
                          `
                        : nothing
                    }
                  `,
                )}
              </div>
            `
      }
    </section>
  `;
}

// ─── Training view (JSON upload + pair display grouped by chat) ───────────────

function fmtDate(iso: string): string {
  if (!iso) {
    return "";
  }
  // "2026-01-23T15:08:29" → "23.01.2026"
  const d = iso.slice(0, 10).split("-");
  return d.length === 3 ? `${d[2]}.${d[1]}.${d[0]}` : iso.slice(0, 10);
}

/** Avatar initials from a name */
function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/** Short date: "13.03" or "13.03.25" if not current year */
function fmtShortDate(iso: string): string {
  if (!iso) {
    return "";
  }
  const parts = iso.slice(0, 10).split("-");
  if (parts.length !== 3) {
    return iso.slice(0, 10);
  }
  const [y, m, d] = parts;
  const currentYear = String(new Date().getFullYear());
  return y === currentYear ? `${d}.${m}` : `${d}.${m}.${y.slice(2)}`;
}

// ─── Label helpers ────────────────────────────────────────────────────────────

function renderLabelBadge(label: TrainingLabel | undefined) {
  if (!label || label === "neutral") {
    return nothing;
  }
  return html`<span class="tg-label-badge tg-label-badge--${label}" title="${label}"></span>`;
}

function renderLabelButton(
  props: ScenarioProps,
  chatId: string,
  label: TrainingLabel,
  icon: string,
) {
  const current = props.trainingLabels[chatId];
  const active = current === label;
  return html`
    <button
      type="button"
      class="tg-label-btn ${active ? "active" : ""}"
      title="${label}"
      @click=${(e: Event) => {
        e.stopPropagation();
        // Toggle off if clicking the already-active label
        props.onTrainingSetLabel(chatId, active ? "neutral" : label);
      }}
    >${icon}</button>
  `;
}

// ─── AI status helpers ────────────────────────────────────────────────────────

const AI_STATUS_EMOJI: Record<TrainingLabel, string> = {
  success: "✅",
  fail: "❌",
  neutral: "⚪",
};

const AI_STATUS_LABEL: Record<TrainingLabel, string> = {
  success: "успешный",
  fail: "неуспешный",
  neutral: "нейтральный",
};

function aiStatusEmoji(result: DialogAnalysisResult | undefined): string {
  return result ? (AI_STATUS_EMOJI[result.status] ?? "") : "";
}

/** Compact score bar rendered as a colored fill (0-100) */
function renderScoreBar(score: number) {
  const pct = Math.min(100, Math.max(0, score));
  const color = score >= 70 ? "#22c55e" : score >= 40 ? "#f59e0b" : "#ef4444";
  return html`
    <div class="tg-score-bar">
      <div class="tg-score-bar-fill" style="width: ${pct}%; background: ${color};"></div>
    </div>
  `;
}

/** Card shown in the conversation panel when a dialog has been AI-analyzed */
function renderAiResultCard(result: DialogAnalysisResult | undefined) {
  if (!result) {
    return nothing;
  }
  return html`
    <div class="tg-ai-result-card tg-ai-result-card--${result.status}">
      <div class="tg-ai-result-header">
        <span class="tg-ai-result-icon">${AI_STATUS_EMOJI[result.status]}</span>
        <span class="tg-ai-result-title">AI анализ диалога</span>
        <span class="tg-ai-result-score">${result.score}/100</span>
      </div>
      ${renderScoreBar(result.score)}
      <div class="tg-ai-result-body">
        <span class="tg-ai-result-status-label">
          Статус: <strong>${AI_STATUS_LABEL[result.status]}</strong>
        </span>
        <div class="tg-ai-result-reason">${result.reason}</div>
      </div>
    </div>
  `;
}

// ─── Training view ─────────────────────────────────────────────────────────────

function renderTrainingView(props: ScenarioProps, agent: TelegramAgentRecord) {
  const allGroups = props.trainingGroups;
  const q = props.trainingSearchQuery.trim().toLowerCase();
  // Apply search filter
  const filtered = q
    ? allGroups.filter((g) => g.participantName.toLowerCase().includes(q) || g.chatId.includes(q))
    : allGroups;
  const visibleGroups = filtered.slice(0, props.trainingGroupsLimit);
  const hiddenCount = filtered.length - visibleGroups.length;
  const totalPairs = props.trainingPairs.length;

  const selectedGroup = props.trainingSelectedChatId
    ? (allGroups.find((g) => g.chatId === props.trainingSelectedChatId) ?? null)
    : null;

  // ── Top toolbar (always visible) ──────────────────────────────────────────
  const analyzedCount = Object.keys(props.analysisResults).length;
  const batchPct =
    props.batchTotal > 0 ? Math.round((props.batchProgress / props.batchTotal) * 100) : 0;

  const toolbar = html`
    <div class="tg-msng-toolbar">
      <label
        class="btn primary btn--sm"
        style="cursor: pointer;"
        title="Загрузить файл JSON"
      >
        ${props.trainingLoading ? "Обработка…" : "Загрузить JSON"}
        <input
          type="file"
          accept=".json"
          style="display: none;"
          ?disabled=${props.trainingLoading}
          @change=${(e: Event) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) {
              return;
            }
            const reader = new FileReader();
            reader.addEventListener("load", (ev) => {
              props.onTrainingFileLoad(agent.id, ev.target?.result as string, file.name);
            });
            reader.readAsText(file);
            (e.target as HTMLInputElement).value = "";
          }}
        />
      </label>
      ${
        allGroups.length > 0
          ? html`<span class="tg-msng-stats">${allGroups.length} чатов · ${totalPairs} пар</span>`
          : nothing
      }
      ${
        // Show batch start/cancel controls when chats are loaded
        allGroups.length > 0
          ? props.batchRunning
            ? html`
                <button
                  class="btn btn--sm danger"
                  @click=${() => props.onCancelBatchAnalysis()}
                >
                  Отменить
                </button>
              `
            : html`
                <button
                  class="btn btn--sm"
                  title="Запустить AI анализ всех диалогов"
                  @click=${() => props.onRunBatchAnalysis(agent.id, false)}
                >
                  AI анализ
                </button>
                ${
                  analyzedCount > 0
                    ? html`
                        <button
                          class="btn btn--sm"
                          title="Переанализировать все диалоги заново"
                          @click=${() => props.onRunBatchAnalysis(agent.id, true)}
                        >
                          Переанализировать
                        </button>
                      `
                    : nothing
                }
              `
          : nothing
      }
      ${
        props.trainingError
          ? html`<span class="tg-msng-error">${props.trainingError}</span>`
          : nothing
      }
    </div>

    <!-- Batch progress bar -->
    ${
      props.batchRunning || (props.batchTotal > 0 && props.batchProgress === props.batchTotal)
        ? html`
            <div class="tg-batch-progress-wrap">
              <div class="tg-batch-progress-bar">
                <div class="tg-batch-progress-fill" style="width: ${batchPct}%;"></div>
              </div>
              <span class="tg-batch-progress-label">
                Анализ диалогов
                <strong>${props.batchProgress}</strong> / ${props.batchTotal} обработано
                ${
                  props.batchRunning
                    ? nothing
                    : html`
                        <span class="chip chip-ok" style="margin-left: 6px; font-size: 0.75em">готово</span>
                      `
                }
              </span>
              ${
                props.batchError
                  ? html`<span class="tg-msng-error" style="margin-left: 8px;">${props.batchError}</span>`
                  : nothing
              }
            </div>
          `
        : nothing
    }
  `;

  // ── Empty / loading state ─────────────────────────────────────────────────
  if (allGroups.length === 0) {
    return html`
      <section class="card" style="padding: 0; overflow: hidden;">
        <div style="padding: 20px;">
          <div class="card-title">Обучение</div>
          <div class="card-sub" style="margin-bottom: 16px;">
            Загрузите экспорт переписки из Telegram (JSON Desktop Export). Пары «клиент → менеджер»
            сгруппируются по чатам.
          </div>
          ${toolbar}
        </div>
      </section>
    `;
  }

  // ── Messenger layout ───────────────────────────────────────────────────────
  return html`
    <section class="card tg-msng-card">
      ${toolbar}

      <div class="tg-msng-layout">
        <!-- ── Sidebar (chat list) ── -->
        <div class="tg-msng-sidebar">
          <div class="tg-msng-search">
            <input
              class="tg-msng-search-input"
              type="search"
              placeholder="Поиск чата…"
              .value=${props.trainingSearchQuery}
              @input=${(e: Event) => props.onTrainingSearchChange((e.target as HTMLInputElement).value)}
            />
          </div>

          <div class="tg-msng-chat-list">
            ${visibleGroups.map(
              (group) => html`
              <div
                class="tg-msng-chat-item ${group.chatId === props.trainingSelectedChatId ? "active" : ""}"
                @click=${() => props.onTrainingSelectChat(group.chatId)}
              >
                <div class="tg-msng-avatar">${avatarInitials(group.participantName)}</div>
                <div class="tg-msng-chat-info">
                  <div class="tg-msng-chat-name">
                    ${
                      aiStatusEmoji(props.analysisResults[group.chatId])
                        ? html`<span class="tg-ai-status-icon" aria-hidden="true"
                            >${aiStatusEmoji(props.analysisResults[group.chatId])}</span
                          >`
                        : nothing
                    }${group.participantName}
                  </div>
                  <div class="tg-msng-chat-meta">
                    <span class="tg-msng-chat-date">${fmtShortDate(group.lastDate)}</span>
                    <span class="tg-msng-chat-count">${group.pairs.length} пар</span>
                    ${renderLabelBadge(props.trainingLabels[group.chatId])}
                  </div>
                </div>
              </div>
            `,
            )}

            ${
              hiddenCount > 0
                ? html`
                <div class="tg-msng-load-more">
                  <button class="btn btn--sm" @click=${props.onTrainingShowMore}>
                    Ещё ${Math.min(hiddenCount, 100)} из ${hiddenCount}
                  </button>
                </div>
              `
                : nothing
            }

            ${
              filtered.length === 0 && q
                ? html`
                    <div class="tg-msng-empty-search">Ничего не найдено</div>
                  `
                : nothing
            }
          </div>
        </div>

        <!-- ── Conversation panel ── -->
        <div class="tg-msng-convo">
          ${
            selectedGroup
              ? html`
              <!-- Header -->
              <div class="tg-msng-convo-header">
                <div class="tg-msng-avatar tg-msng-avatar--sm">${avatarInitials(selectedGroup.participantName)}</div>
                <div class="tg-msng-convo-title">
                  <div class="tg-msng-convo-name">${selectedGroup.participantName}</div>
                  <div class="tg-msng-convo-sub">
                    ${selectedGroup.pairs.length} пар ·
                    ${fmtDate(selectedGroup.firstDate)}${selectedGroup.firstDate !== selectedGroup.lastDate ? ` – ${fmtDate(selectedGroup.lastDate)}` : ""}
                    · #${selectedGroup.chatId}
                  </div>
                </div>
                <!-- Label buttons -->
                <div class="tg-label-btns" @click=${(e: Event) => e.stopPropagation()}>
                  ${renderLabelButton(props, selectedGroup.chatId, "success", "✅")}
                  ${renderLabelButton(props, selectedGroup.chatId, "fail", "❌")}
                  ${renderLabelButton(props, selectedGroup.chatId, "neutral", "⚪")}
                </div>
                <button
                  class="btn btn--sm primary"
                  @click=${() => props.onTrainingCreateNodes(agent.id, selectedGroup)}
                >
                  + Создать ноды
                </button>
              </div>

              <!-- AI result card (shown when analysis is available) -->
              ${renderAiResultCard(props.analysisResults[selectedGroup.chatId])}

              <!-- Bubbles -->
              <div class="tg-msng-bubbles">
                ${selectedGroup.pairs.map(
                  (pair) => html`
                  <div class="tg-msng-bubble tg-msng-bubble--client">
                    <div class="tg-msng-bubble-label">Клиент</div>
                    <div class="tg-msng-bubble-text">${pair.input}</div>
                  </div>
                  <div class="tg-msng-bubble tg-msng-bubble--manager">
                    <div class="tg-msng-bubble-label">Менеджер</div>
                    <div class="tg-msng-bubble-text">${pair.response}</div>
                  </div>
                `,
                )}
              </div>
            `
              : html`
                  <div class="tg-msng-convo-placeholder">
                    <div class="tg-msng-placeholder-icon">💬</div>
                    <div>Выберите чат слева</div>
                  </div>
                `
          }
        </div>
      </div>
    </section>
  `;
}

// ─── Analysis view ────────────────────────────────────────────────────────────

function renderAnalysisView(props: ScenarioProps, agent: TelegramAgentRecord) {
  const groups = props.trainingGroups;
  const results = props.analysisResults;

  // Derive label from AI result when no manual label is set
  const effectiveLabel = (g: TrainingGroup) =>
    props.trainingLabels[g.chatId] ?? results[g.chatId]?.status;

  const total = groups.length;
  const analyzedCount = Object.keys(results).length;
  const successGroups = groups.filter((g) => effectiveLabel(g) === "success");
  const failGroups = groups.filter((g) => effectiveLabel(g) === "fail");
  const neutralGroups = groups.filter((g) => effectiveLabel(g) === "neutral" || !effectiveLabel(g));

  const avgPairs = (list: TrainingGroup[]) =>
    list.length === 0 ? 0 : Math.round(list.reduce((s, g) => s + g.pairs.length, 0) / list.length);

  const avgScore = (list: TrainingGroup[]) => {
    const scored = list.map((g) => results[g.chatId]?.score).filter((s) => s !== undefined);
    return scored.length === 0
      ? null
      : Math.round(scored.reduce((a, b) => a + b, 0) / scored.length);
  };

  // Top-5 successful chats by AI score, then by pair count
  const top5 = [...successGroups]
    .toSorted((a, b) => {
      const sa = results[a.chatId]?.score ?? 0;
      const sb = results[b.chatId]?.score ?? 0;
      return sb - sa || b.pairs.length - a.pairs.length;
    })
    .slice(0, 5);

  const hasGroups = total > 0;
  const batchPct =
    props.batchTotal > 0 ? Math.round((props.batchProgress / props.batchTotal) * 100) : 0;

  return html`
    <section class="card">
      <!-- Header row -->
      <div class="row" style="justify-content: space-between; align-items: flex-start; margin-bottom: 20px; flex-wrap: wrap; gap: 10px;">
        <div>
          <div class="card-title">Анализ обучающих данных</div>
          <div class="card-sub">Автоматическая оценка диалогов менеджеров с клиентами</div>
        </div>
        ${
          hasGroups
            ? html`
                <div class="row" style="gap: 8px; flex-wrap: wrap;">
                  ${
                    props.batchRunning
                      ? html`
                          <button
                            class="btn btn--sm danger"
                            @click=${() => props.onCancelBatchAnalysis()}
                          >
                            Отменить анализ
                          </button>
                        `
                      : html`
                          <button
                            class="btn btn--sm primary"
                            @click=${() => props.onRunBatchAnalysis(agent.id, false)}
                          >
                            ${analyzedCount > 0 ? "Продолжить анализ" : "Запустить AI анализ"}
                          </button>
                          ${
                            analyzedCount > 0
                              ? html`
                                  <button
                                    class="btn btn--sm"
                                    title="Переанализировать все диалоги заново"
                                    @click=${() => props.onRunBatchAnalysis(agent.id, true)}
                                  >
                                    Переанализировать
                                  </button>
                                `
                              : nothing
                          }
                        `
                  }
                  <button
                    class="btn btn--sm ${props.analysisLoading ? "btn--loading" : ""}"
                    ?disabled=${props.analysisLoading}
                    title="Отправить все размеченные диалоги на AI-суммаризацию паттернов"
                    @click=${() => props.onRunAnalysis(agent.id)}
                  >
                    ${props.analysisLoading ? "Суммаризируем…" : "AI-суммаризация"}
                  </button>
                </div>
              `
            : nothing
        }
      </div>

      ${
        !hasGroups
          ? html`
              <div class="muted">Нет данных. Загрузите экспорт переписки в разделе «Обучение».</div>
            `
          : html`
              <!-- Batch progress bar (shown while running or after completion) -->
              ${
                props.batchRunning || props.batchTotal > 0
                  ? html`
                      <div class="tg-batch-progress-wrap" style="margin-bottom: 16px;">
                        <div class="tg-batch-progress-bar">
                          <div
                            class="tg-batch-progress-fill ${props.batchRunning ? "tg-batch-progress-fill--animated" : ""}"
                            style="width: ${batchPct}%;"
                          ></div>
                        </div>
                        <span class="tg-batch-progress-label">
                          Анализ диалогов
                          <strong>${props.batchProgress}</strong> / ${props.batchTotal} обработано
                          (${batchPct}%)
                          ${
                            !props.batchRunning && props.batchProgress === props.batchTotal
                              ? html`
                                  <span class="chip chip-ok" style="margin-left: 6px; font-size: 0.75em">готово</span>
                                `
                              : nothing
                          }
                        </span>
                        ${
                          props.batchError
                            ? html`<div class="callout danger" style="margin-top: 8px;">${props.batchError}</div>`
                            : nothing
                        }
                      </div>
                    `
                  : nothing
              }

              <!-- Stats chips -->
              <div class="tg-analysis-stats">
                <div class="tg-stat-chip">
                  <div class="tg-stat-value">${total}</div>
                  <div class="tg-stat-label">Всего чатов</div>
                </div>
                <div class="tg-stat-chip">
                  <div class="tg-stat-value">${analyzedCount}</div>
                  <div class="tg-stat-label">Проанализировано</div>
                </div>
                <div class="tg-stat-chip tg-stat-chip--success">
                  <div class="tg-stat-icon">✅</div>
                  <div class="tg-stat-value">${successGroups.length}</div>
                  <div class="tg-stat-label">Успешных</div>
                </div>
                <div class="tg-stat-chip tg-stat-chip--fail">
                  <div class="tg-stat-icon">❌</div>
                  <div class="tg-stat-value">${failGroups.length}</div>
                  <div class="tg-stat-label">Неуспешных</div>
                </div>
                <div class="tg-stat-chip">
                  <div class="tg-stat-icon">⚪</div>
                  <div class="tg-stat-value">${neutralGroups.length}</div>
                  <div class="tg-stat-label">Нейтральных</div>
                </div>
                ${
                  successGroups.length > 0
                    ? html`
                        <div class="tg-stat-chip tg-stat-chip--success">
                          <div class="tg-stat-value">${avgScore(successGroups) ?? "—"}</div>
                          <div class="tg-stat-label">Ср. score (✅)</div>
                        </div>
                      `
                    : nothing
                }
                ${
                  failGroups.length > 0
                    ? html`
                        <div class="tg-stat-chip tg-stat-chip--fail">
                          <div class="tg-stat-value">${avgScore(failGroups) ?? "—"}</div>
                          <div class="tg-stat-label">Ср. score (❌)</div>
                        </div>
                      `
                    : nothing
                }
                <div class="tg-stat-chip">
                  <div class="tg-stat-value">${avgPairs(successGroups)}</div>
                  <div class="tg-stat-label">Ср. пар (✅)</div>
                </div>
              </div>

              ${
                analyzedCount === 0
                  ? html`
                      <div class="callout" style="margin: 16px 0 0">
                        Нажмите «Запустить AI анализ» — система автоматически проанализирует каждый диалог и определит его
                        успешность.
                      </div>
                    `
                  : nothing
              }

              <!-- Top-5 successful chats by AI score -->
              ${
                top5.length > 0
                  ? html`
                      <div style="margin-top: 20px;">
                        <div class="card-title" style="font-size: 0.85em; margin-bottom: 8px;">
                          Топ успешных диалогов
                        </div>
                        <table class="tg-analysis-table">
                          <thead>
                            <tr>
                              <th>Клиент</th>
                              <th>Score</th>
                              <th>Пар</th>
                              <th>Причина</th>
                            </tr>
                          </thead>
                          <tbody>
                            ${top5.map((g) => {
                              const r = results[g.chatId];
                              return html`
                                <tr>
                                  <td>${g.participantName}</td>
                                  <td>
                                    ${
                                      r
                                        ? html`<span class="tg-score-chip tg-score-chip--${r.status}">${r.score}</span>`
                                        : "—"
                                    }
                                  </td>
                                  <td>${g.pairs.length}</td>
                                  <td class="muted" style="font-size: 0.8em; max-width: 200px;">
                                    ${r?.reason ?? ""}
                                  </td>
                                </tr>
                              `;
                            })}
                          </tbody>
                        </table>
                      </div>
                    `
                  : nothing
              }
            `
      }

      <!-- AI freeform analysis result (whole-dataset summary) -->
      ${
        props.analysisError
          ? html`<div class="callout danger" style="margin-top: 16px;">${props.analysisError}</div>`
          : nothing
      }
      ${
        props.analysisResult
          ? html`
              <div style="margin-top: 20px;">
                <div class="card-title" style="font-size: 0.85em; margin-bottom: 8px;">
                  AI-суммаризация паттернов
                </div>
                <pre class="tg-analysis-result">${props.analysisResult}</pre>
              </div>
            `
          : nothing
      }
    </section>
  `;
}

// ─── Schema view (Flow Nodes pipeline) ────────────────────────────────────────

export function renderSchemaPanel(props: ScenarioProps, _agent: TelegramAgentRecord) {
  const flowNodes = props.flowNodes;

  if (props.flowNodesLoading) {
    return html`
      <section class="card">
        <div class="muted">Загрузка схемы…</div>
      </section>
    `;
  }

  if (flowNodes.length === 0) {
    return html`
      <section class="card">
        <div class="card-title">Схема</div>
        <div class="card-sub">
          Структура общения (этапы диалога). Создайте ноды через раздел «Чат» → «Обучение».
        </div>
        <div class="muted" style="margin-top: 16px">
          Нет этапов диалога. После создания нод они сгруппируются здесь.
        </div>
      </section>
    `;
  }

  return html`
    <section class="card">
      <div class="card-title">Схема</div>
      <div class="card-sub">Этапы диалога — путь от старта до конверсии.</div>

      <div class="tg-schema-pipeline" style="margin-top: 20px;">
        ${flowNodes.map(
          (fn, idx) => html`
            <div class="tg-schema-node">
              <div class="tg-schema-node-title">${fn.title}</div>
              ${fn.description ? html`<div class="tg-schema-node-desc">${fn.description}</div>` : nothing}
              <div class="tg-schema-node-count muted" style="font-size: 0.75em;">
                ${fn.chatNodeIds.length} нод
              </div>
            </div>
            ${
              idx < flowNodes.length - 1
                ? html`
                    <div class="tg-schema-arrow" aria-hidden="true">→</div>
                  `
                : nothing
            }
          `,
        )}
      </div>
    </section>
  `;
}

// ─── Chat panel (wrapper with sub-tabs) ───────────────────────────────────────

export function renderChatPanel(props: ScenarioProps, agent: TelegramAgentRecord) {
  return html`
    <section class="card" style="padding: 6px 16px 0;">
      ${renderSubTabs(props)}
    </section>

    ${props.chatSubPanel === "chat" ? renderChatView(props, agent) : nothing}
    ${props.chatSubPanel === "nodes" ? renderNodesView(props, agent) : nothing}
    ${props.chatSubPanel === "training" ? renderTrainingView(props, agent) : nothing}
    ${props.chatSubPanel === "analysis" ? renderAnalysisView(props, agent) : nothing}
  `;
}
