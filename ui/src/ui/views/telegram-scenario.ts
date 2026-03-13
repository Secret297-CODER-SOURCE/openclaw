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
  trainingLoading: boolean;
  trainingError: string | null;
  showCreateNodesPrompt: boolean;
  onSelectChatSubPanel: (sub: TelegramChatSubPanel) => void;
  onTrainingFileLoad: (agentId: string, json: string, fileName: string) => void;
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

function renderTrainingView(props: ScenarioProps, agent: TelegramAgentRecord) {
  const groups = props.trainingGroups;
  const visibleGroups = groups.slice(0, props.trainingGroupsLimit);
  const totalPairs = props.trainingPairs.length;
  const hiddenCount = groups.length - visibleGroups.length;

  return html`
    <section class="card">
      <div class="card-title">Обучение</div>
      <div class="card-sub">
        Загрузите экспорт переписки из Telegram (формат JSON Desktop Export). Пары
        «клиент → менеджер» сгруппированы по чату с датами.
      </div>

      <div style="margin-top: 16px;">
        <label
          class="btn primary"
          style="cursor: pointer; display: inline-block;"
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
                const json = ev.target?.result as string;
                props.onTrainingFileLoad(agent.id, json, file.name);
              });
              reader.readAsText(file);
              (e.target as HTMLInputElement).value = "";
            }}
          />
        </label>
      </div>

      ${
        props.trainingError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.trainingError}</div>`
          : nothing
      }

      ${
        groups.length > 0
          ? html`
        <div style="margin-top: 16px; display: flex; align-items: center; gap: 10px;">
          <span class="card-title" style="font-size: 0.85em; margin: 0;">
            ${groups.length} чатов · ${totalPairs} пар
          </span>
        </div>

        <div style="margin-top: 12px;" class="list">
          ${visibleGroups.map(
            (group) => html`
            <details class="tg-chat-group list-item" style="flex-direction: column; align-items: stretch; padding: 0;">
              <summary style="
                display: flex; align-items: center; gap: 8px; padding: 10px 12px;
                cursor: pointer; list-style: none; user-select: none;
              ">
                <span style="font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  ${group.participantName}
                </span>
                <span class="chip">${group.pairs.length} пар</span>
                <span class="muted" style="font-size: 0.78em; white-space: nowrap;">
                  ${fmtDate(group.firstDate)}${group.firstDate !== group.lastDate ? ` – ${fmtDate(group.lastDate)}` : ""}
                </span>
                <span class="muted" style="font-size: 0.75em; color: var(--color-muted);">
                  #${group.chatId}
                </span>
              </summary>

              <div style="padding: 0 12px 12px;">
                <button
                  class="btn btn--sm primary"
                  style="margin-bottom: 10px;"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    props.onTrainingCreateNodes(agent.id, group);
                  }}
                >
                  + Создать ноды
                </button>

                <div class="list" style="margin: 0;">
                  ${group.pairs.slice(0, 30).map(
                    (pair, i) => html`
                    <div class="list-item" style="flex-direction: column; align-items: flex-start; gap: 4px; padding: 6px 0;">
                      <div style="font-size: 0.75em; color: var(--color-muted);">Пара ${i + 1}</div>
                      <div class="tg-training-pair">
                        <div class="tg-training-input">
                          <span class="chip">Клиент</span>
                          <span>${pair.input}</span>
                        </div>
                        <div class="tg-training-response">
                          <span class="chip chip-ok">Менеджер</span>
                          <span>${pair.response}</span>
                        </div>
                      </div>
                    </div>
                  `,
                  )}
                  ${
                    group.pairs.length > 30
                      ? html`<div class="muted" style="padding: 4px 0; font-size: 0.8em;">… и ещё ${group.pairs.length - 30} пар</div>`
                      : nothing
                  }
                </div>
              </div>
            </details>
          `,
          )}

          ${
            hiddenCount > 0
              ? html`
            <div style="padding: 10px 0; text-align: center;">
              <button class="btn" @click=${props.onTrainingShowMore}>
                Показать ещё ${Math.min(hiddenCount, 100)} чатов (осталось ${hiddenCount})
              </button>
            </div>
          `
              : nothing
          }
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
    <section class="card" style="padding-bottom: 0;">
      ${renderSubTabs(props)}
    </section>

    ${props.chatSubPanel === "chat" ? renderChatView(props, agent) : nothing}
    ${props.chatSubPanel === "nodes" ? renderNodesView(props, agent) : nothing}
    ${props.chatSubPanel === "training" ? renderTrainingView(props, agent) : nothing}
  `;
}
