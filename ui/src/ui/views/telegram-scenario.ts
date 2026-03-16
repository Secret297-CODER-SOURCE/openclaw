import { html, nothing } from "lit";
import type { TelegramAgentRecord } from "../controllers/telegram.ts";
import type { ChatNode, FlowNode, TrainingPair, TrainingGroup } from "../controllers/telegram.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TelegramChatSubPanel = "chat" | "nodes" | "training";

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
  onSelectChatSubPanel: (sub: TelegramChatSubPanel) => void;
  onTrainingFileLoad: (agentId: string, json: string, fileName: string) => void;
  onTrainingSelectChat: (id: string | null) => void;
  onTrainingSearchChange: (q: string) => void;
  onTrainingCreateNodes: (agentId: string, group: TrainingGroup) => void;
  onTrainingDismiss: () => void;
  onTrainingShowMore: () => void;
  onAddChatNode: (agentId: string, role: "manager" | "client") => void;
  onDeleteChatNode: (agentId: string, nodeId: string) => void;
  onLoadChatNodes: (agentId: string) => void;
  onLoadFlowNodes: (agentId: string) => void;
};

// ─── Sub-panel tabs ───────────────────────────────────────────────────────────

function renderSubTabs(props: ScenarioProps) {
  const tabs: Array<{ id: TelegramChatSubPanel; label: string }> = [
    { id: "chat", label: "Чат" },
    { id: "nodes", label: "Ноды" },
    { id: "training", label: "Обучение" },
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
        props.trainingError
          ? html`<span class="tg-msng-error">${props.trainingError}</span>`
          : nothing
      }
    </div>
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
                  <div class="tg-msng-chat-name">${group.participantName}</div>
                  <div class="tg-msng-chat-meta">
                    <span class="tg-msng-chat-date">${fmtShortDate(group.lastDate)}</span>
                    <span class="tg-msng-chat-count">${group.pairs.length} пар</span>
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
                <button
                  class="btn btn--sm primary"
                  @click=${() => props.onTrainingCreateNodes(agent.id, selectedGroup)}
                >
                  + Создать ноды
                </button>
              </div>

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
    <section class="card" style="padding-bottom: 0;">
      ${renderSubTabs(props)}
    </section>

    ${props.chatSubPanel === "chat" ? renderChatView(props, agent) : nothing}
    ${props.chatSubPanel === "nodes" ? renderNodesView(props, agent) : nothing}
    ${props.chatSubPanel === "training" ? renderTrainingView(props, agent) : nothing}
  `;
}
