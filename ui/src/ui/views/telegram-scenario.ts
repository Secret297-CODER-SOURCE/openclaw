import { html, nothing } from "lit";
import type { TelegramAgentRecord, TrainingScope } from "../controllers/telegram.ts";
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
export type NodesGraphMode = "chats" | "training";

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
  trainingScope: TrainingScope;
  /** Cached stats for each scope (active scope is live-computed, inactive is cached). */
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
  onTrainingFileLoad: (agentId: string, json: string, fileName: string) => void;
  onTrainingSelectChat: (id: string | null) => void;
  onTrainingSearchChange: (q: string) => void;
  onTrainingCreateNodes: (agentId: string, group: TrainingGroup) => void;
  onTrainingDismiss: () => void;
  onTrainingShowMore: () => void;
  onTrainingSetLabel: (chatId: string, label: TrainingLabel) => void;
  nodesGraphMode: NodesGraphMode;
  onNodesGraphModeChange: (mode: NodesGraphMode) => void;
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

// ─── Nodes view (animated dot graph) ─────────────────────────────────────────

// Graph viewport dimensions (used for both layout math and SVG lines overlay)
const GRAPH_W = 720;
const GRAPH_H = 440;

/** Max nodes shown in the graph to avoid overwhelming the renderer. */
const MAX_GRAPH_NODES = 40;

const LABEL_COLOR: Record<string, string> = {
  success: "#4caf50",
  fail: "#ef5350",
  neutral: "#888888",
};

/** Multi-ring circular layout — nodes in concentric rings. */
function circularPack(count: number): Array<{ x: number; y: number }> {
  const cx = GRAPH_W / 2;
  const cy = GRAPH_H / 2;
  if (count === 0) {
    return [];
  }
  if (count === 1) {
    return [{ x: cx, y: cy }];
  }
  const rings: Array<{ cap: number; r: number }> = [
    { cap: 1, r: 0 }, // center slot
    { cap: 6, r: 90 },
    { cap: 12, r: 170 },
    { cap: 20, r: 210 },
  ];
  const positions: Array<{ x: number; y: number }> = [];
  let remaining = count;
  for (const ring of rings) {
    if (remaining <= 0) {
      break;
    }
    const n = Math.min(ring.cap, remaining);
    for (let i = 0; i < n; i++) {
      if (ring.r === 0) {
        positions.push({ x: cx, y: cy });
      } else {
        const angle = (2 * Math.PI * i) / ring.cap - Math.PI / 2;
        positions.push({ x: cx + ring.r * Math.cos(angle), y: cy + ring.r * Math.sin(angle) });
      }
    }
    remaining -= n;
  }
  return positions;
}

/**
 * Layered left-to-right layout for a DAG of ChatNodes.
 * Assigns each node a column via BFS, distributes rows within columns.
 */
function layeredLayout(nodes: ChatNode[]): Array<{ x: number; y: number }> {
  if (nodes.length === 0) {
    return [];
  }

  const idxById = new Map(nodes.map((n, i) => [n.id, i]));
  const hasPredecessor = new Set<string>();
  for (const n of nodes) {
    if (n.nextNodeId) {
      hasPredecessor.add(n.nextNodeId);
    }
    for (const b of n.branches ?? []) {
      hasPredecessor.add(b.nextNodeId);
    }
  }

  const col = new Map<string, number>();
  const queue: Array<{ id: string; c: number }> = nodes
    .filter((n) => !hasPredecessor.has(n.id))
    .map((n) => ({ id: n.id, c: 0 }));
  if (queue.length === 0) {
    nodes.forEach((n) => queue.push({ id: n.id, c: 0 }));
  }

  while (queue.length > 0) {
    const { id, c } = queue.shift()!;
    if (col.has(id) && col.get(id)! >= c) {
      continue;
    }
    col.set(id, c);
    const node = nodes[idxById.get(id)!];
    if (!node) {
      continue;
    }
    if (node.nextNodeId && idxById.has(node.nextNodeId)) {
      queue.push({ id: node.nextNodeId, c: c + 1 });
    }
    for (const b of node.branches ?? []) {
      if (idxById.has(b.nextNodeId)) {
        queue.push({ id: b.nextNodeId, c: c + 1 });
      }
    }
  }
  nodes.forEach((n) => {
    if (!col.has(n.id)) {
      col.set(n.id, 0);
    }
  });

  const byCols = new Map<number, string[]>();
  for (const [id, c] of col.entries()) {
    if (!byCols.has(c)) {
      byCols.set(c, []);
    }
    byCols.get(c)!.push(id);
  }
  const totalCols = Math.max(...col.values()) + 1;
  const xStep = Math.min(150, (GRAPH_W - 80) / Math.max(totalCols - 1, 1));
  const posById = new Map<string, { x: number; y: number }>();
  for (const [c, ids] of byCols.entries()) {
    const x = 50 + c * xStep;
    const yStep = GRAPH_H / (ids.length + 1);
    ids.forEach((id, i) => posById.set(id, { x, y: yStep * (i + 1) }));
  }
  return nodes.map((n) => posById.get(n.id) ?? { x: GRAPH_W / 2, y: GRAPH_H / 2 });
}

type GraphDotItem = {
  initials: string;
  name: string;
  sublabel: string;
  color: string;
  animDelay: string;
};

/**
 * Render graph using HTML div dots + thin SVG lines overlay.
 * HTML divs are immune to Lit's SVG namespace quirks; lines use only <line> elements.
 */
function renderDivGraph(
  dots: GraphDotItem[],
  positions: Array<{ x: number; y: number }>,
  edges: Array<[number, number]>,
  overflowCount: number,
  onDblClick: (idx: number) => void,
) {
  if (dots.length === 0) {
    return nothing;
  }

  // Convert SVG-space positions to % of container for CSS positioning
  const pct = (v: number, total: number) => ((v / total) * 100).toFixed(2);

  return html`
    <div style="position:relative; width:100%; height:${GRAPH_H}px; overflow:hidden;">

      <!-- SVG overlay — only <line> elements, no defs/markers -->
      <svg
        style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;"
        viewBox="0 0 ${GRAPH_W} ${GRAPH_H}"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        ${edges.map(([fi, ti]) => {
          const f = positions[fi];
          const t = positions[ti];
          if (!f || !t) {
            return nothing;
          }
          return html`<line
            x1="${f.x}" y1="${f.y}"
            x2="${t.x}" y2="${t.y}"
            stroke="rgba(150,150,150,0.45)" stroke-width="1.5"
          />`;
        })}
      </svg>

      <!-- HTML div nodes — absolutely positioned circles -->
      ${dots.map((dot, idx) => {
        const pos = positions[idx];
        if (!pos) {
          return nothing;
        }
        return html`
          <div
            class="tg-graph-dot"
            style="left:${pct(pos.x, GRAPH_W)}%;top:${pct(pos.y, GRAPH_H)}%;background:${dot.color};animation-delay:${dot.animDelay}s;"
            title="${dot.name}"
            @dblclick=${() => onDblClick(idx)}
          >
            <span class="tg-dot-init">${dot.initials}</span>
            <span class="tg-dot-name">${dot.name}</span>
            <span class="tg-dot-sub">${dot.sublabel}</span>
          </div>
        `;
      })}

      ${
        overflowCount > 0
          ? html`<div class="tg-graph-overflow">+${overflowCount} ещё</div>`
          : nothing
      }
    </div>
  `;
}

/** Graph for "Чаты" mode — shows webchat dialogs (userbot) or chatNodes (bot). */
function renderChatsGraph(props: ScenarioProps, _agent: TelegramAgentRecord) {
  // For userbot agents, use live Telegram dialogs from the Чат sub-tab
  if (props.webchat) {
    const dialogs = props.webchat.dialogs;
    if (props.webchat.dialogsLoading) {
      return html`
        <div class="tg-graph-empty muted">Загрузка диалогов…</div>
      `;
    }
    if (dialogs.length === 0) {
      return html`
        <div class="tg-graph-empty muted">Нет диалогов — откройте вкладку «Чат» для загрузки.</div>
      `;
    }
    const visible = dialogs.slice(0, MAX_GRAPH_NODES);
    const positions = circularPack(visible.length);
    const dots: GraphDotItem[] = visible.map((d, idx) => ({
      initials: avatarInitials(d.name),
      name: d.name.length > 12 ? d.name.slice(0, 12) + "…" : d.name,
      sublabel: d.type === "group" ? "группа" : d.type === "channel" ? "канал" : "личный",
      color: d.unreadCount > 0 ? "#5b8fff" : "#5a7fc4",
      animDelay: (((idx * 37) % 30) / 10).toFixed(1),
    }));
    const graph = renderDivGraph(dots, positions, [], dialogs.length - visible.length, (i) => {
      const d = visible[i];
      if (d) {
        props.webchat!.onSelectDialog(d.id, d.name);
      }
      props.onSelectChatSubPanel("chat");
    });
    return graph === nothing
      ? html`
          <div class="tg-graph-empty muted">Нет диалогов</div>
        `
      : graph;
  }

  // For bot agents, use chatNodes
  const nodes = props.chatNodes;
  if (props.chatNodesLoading) {
    return html`
      <div class="tg-graph-empty muted">Загрузка нод…</div>
    `;
  }
  if (nodes.length === 0) {
    return html`
      <div class="tg-graph-empty muted">Нет нод — добавьте «+ Менеджер» или «+ Клиент».</div>
    `;
  }

  const visible = nodes.slice(0, MAX_GRAPH_NODES);
  const positions = layeredLayout(visible);
  const idxById = new Map(visible.map((n, i) => [n.id, i]));
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < visible.length; i++) {
    const n = visible[i];
    if (n.nextNodeId) {
      const ti = idxById.get(n.nextNodeId);
      if (ti !== undefined) {
        edges.push([i, ti]);
      }
    }
    for (const b of n.branches ?? []) {
      const ti = idxById.get(b.nextNodeId);
      if (ti !== undefined) {
        edges.push([i, ti]);
      }
    }
  }
  const dots: GraphDotItem[] = visible.map((node, idx) => ({
    initials: node.role === "manager" ? "МН" : "КЛ",
    name: node.text.length > 12 ? node.text.slice(0, 12) + "…" : node.text,
    sublabel: node.role === "manager" ? "менеджер" : "клиент",
    color: node.role === "manager" ? "#5b8fff" : "#888",
    animDelay: (((idx * 43) % 30) / 10).toFixed(1),
  }));
  const graph = renderDivGraph(dots, positions, edges, nodes.length - visible.length, () => {
    props.onSelectChatSubPanel("chat");
  });
  return graph === nothing
    ? html`
        <div class="tg-graph-empty muted">Нет нод</div>
      `
    : graph;
}

/** Graph for "Обучение" mode — shows training chats as circular nodes. */
function renderTrainingGraph(props: ScenarioProps, _agent: TelegramAgentRecord) {
  const allGroups = props.trainingGroups;
  if (props.trainingLoading) {
    return html`
      <div class="tg-graph-empty muted">Загрузка обучения…</div>
    `;
  }
  if (allGroups.length === 0) {
    return html`
      <div class="tg-graph-empty muted">Нет данных — загрузите JSON во вкладке «Обучение».</div>
    `;
  }

  const visible = allGroups.slice(0, MAX_GRAPH_NODES);
  const maxPairs = Math.max(...visible.map((g) => g.pairs.length), 1);
  const positions = circularPack(visible.length);

  const dots: GraphDotItem[] = visible.map((group, idx) => {
    const label = props.trainingLabels[group.chatId];
    const color = label ? (LABEL_COLOR[label] ?? "#5b8fff") : "#5b8fff";
    // Scale size via opacity hint in sublabel (actual size is CSS-fixed, but color shifts)
    const pairsNorm = Math.round((group.pairs.length / maxPairs) * 100);
    return {
      initials: avatarInitials(group.participantName),
      name:
        group.participantName.length > 12
          ? group.participantName.slice(0, 12) + "…"
          : group.participantName,
      sublabel: `${group.pairs.length} пар · ${pairsNorm}%`,
      color,
      animDelay: (((idx * 37) % 30) / 10).toFixed(1),
    };
  });

  const graph = renderDivGraph(dots, positions, [], allGroups.length - visible.length, (i) => {
    const g = visible[i];
    if (g) {
      props.onTrainingSelectChat(g.chatId);
    }
    props.onSelectChatSubPanel("training");
  });
  return graph === nothing
    ? html`
        <div class="tg-graph-empty muted">Нет данных</div>
      `
    : graph;
}

// ─── Nodes view ───────────────────────────────────────────────────────────────

function renderNodesView(props: ScenarioProps, agent: TelegramAgentRecord) {
  const mode = props.nodesGraphMode;

  // "Чаты" count: webchat dialogs for userbot agents, chatNodes for bot agents
  const chatsCount = props.webchat ? props.webchat.dialogs.length : props.chatNodes.length;
  const trainingCount = props.trainingGroups.length;

  const hint =
    mode === "chats" ? "двойной клик — перейти в чат" : "двойной клик — открыть в обучении";

  return html`
    <section class="card">
      <!-- Toolbar -->
      <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <div class="card-title">Ноды</div>
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

      <!-- Mode switch -->
      <div class="tg-graph-switch">
        <button
          class="tg-graph-switch-btn ${mode === "chats" ? "active" : ""}"
          @click=${() => props.onNodesGraphModeChange("chats")}
        >
          💬 Чаты
          <span class="tg-graph-switch-count">${chatsCount}</span>
        </button>
        <button
          class="tg-graph-switch-btn ${mode === "training" ? "active" : ""}"
          @click=${() => props.onNodesGraphModeChange("training")}
        >
          🧠 Обучение
          <span class="tg-graph-switch-count">${trainingCount}</span>
        </button>
      </div>

      <!-- Graph container -->
      <div class="tg-graph-container">
        ${mode === "chats" ? renderChatsGraph(props, agent) : renderTrainingGraph(props, agent)}
        <div class="tg-graph-hint">${hint}</div>
      </div>

      ${
        props.chatNodesError
          ? html`<div class="callout danger" style="margin-top: 10px;">${props.chatNodesError}</div>`
          : nothing
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

  // ── Database switcher (personal vs shared) ──────────────────────────────
  const personalStats = props.trainingPersonalStats;
  const sharedStats = props.trainingSharedStats;

  const scopeToggle = html`
    <div class="tg-scope-row">
      <span class="tg-scope-row__label">База знаний:</span>
      <div class="tg-scope-switcher">
        <button
          type="button"
          class="tg-scope-btn ${props.trainingScope === "personal" ? "active" : ""}"
          @click=${() => props.onTrainingScopeChange?.(agent.id, "personal")}
          aria-pressed=${props.trainingScope === "personal"}
        >
          👤 Личная
          ${
            personalStats
              ? html`<span class="tg-scope-count">${personalStats.chats}&thinsp;чат${personalStats.chats !== 1 ? "а" : ""}</span>`
              : nothing
          }
        </button>
        <button
          type="button"
          class="tg-scope-btn ${props.trainingScope === "shared" ? "active" : ""}"
          @click=${() => props.onTrainingScopeChange?.(agent.id, "shared")}
          aria-pressed=${props.trainingScope === "shared"}
        >
          🌐 Общая
          ${
            sharedStats
              ? html`<span class="tg-scope-count">${sharedStats.chats}&thinsp;чат${sharedStats.chats !== 1 ? "а" : ""}</span>`
              : nothing
          }
        </button>
      </div>
    </div>
  `;

  // ── Top toolbar (always visible) ──────────────────────────────────────────
  const analyzedCount = Object.keys(props.analysisResults).length;
  const batchPct =
    props.batchTotal > 0 ? Math.round((props.batchProgress / props.batchTotal) * 100) : 0;

  const toolbar = html`
    <div class="tg-msng-toolbar">
      <label
        class="btn primary btn--sm"
        style="cursor: pointer;"
        title="Загрузить файл JSON (${props.trainingScope === "personal" ? "личная" : "общая"} база)"
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
          ? html`
              <button
                type="button"
                class="btn btn--sm ${props.trainingEditorOpen ? "active" : ""}"
                title="Редактировать данные обучения в формате JSON"
                @click=${() => {
                  if (props.trainingEditorOpen) {
                    props.onTrainingEditorClose();
                  } else {
                    props.onTrainingEditorOpen();
                  }
                }}
              >✏️ Правка</button>
            `
          : nothing
      }
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
        ${scopeToggle}
        <div style="padding: 16px 18px;">
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

  // ── Inline JSON editor (shown instead of the messenger layout) ──────────────
  const editorPanel = props.trainingEditorOpen
    ? html`
        <div class="tg-training-editor">
          <div class="tg-training-editor-hint">
            Редактирование базы знаний (${props.trainingScope === "personal" ? "личная" : "общая"}).
            Формат: <code>{"groups":[…], "labels":{…}, "analysisResults":{…}}</code>
          </div>
          <textarea
            class="tg-training-editor-textarea"
            spellcheck="false"
            autocomplete="off"
            .value=${props.trainingEditorJson}
            @input=${(e: Event) => props.onTrainingEditorChange((e.target as HTMLTextAreaElement).value)}
          ></textarea>
          ${
            props.trainingEditorError
              ? html`<div class="tg-training-editor-error">⚠️ ${props.trainingEditorError}</div>`
              : nothing
          }
          <div class="tg-training-editor-actions">
            <button
              type="button"
              class="btn btn--sm primary"
              @click=${() => props.onTrainingEditorSave(props.trainingEditorJson)}
            >💾 Сохранить</button>
            <button
              type="button"
              class="btn btn--sm"
              @click=${() => props.onTrainingEditorClose()}
            >✕ Отмена</button>
          </div>
        </div>
      `
    : nothing;

  // ── Messenger layout ───────────────────────────────────────────────────────
  return html`
    <section class="card tg-msng-card">
      ${scopeToggle} ${toolbar}

      ${props.trainingEditorOpen ? editorPanel : nothing}

      <div class="tg-msng-layout" style="${props.trainingEditorOpen ? "display: none;" : ""}">
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
                <button
                  class="tg-group-delete-btn"
                  title="Удалить чат из базы"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    props.onTrainingDeleteGroup(group.chatId);
                  }}
                >×</button>
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
                  + Ноды
                </button>
              </div>

              <!-- AI result card (shown when analysis is available) -->
              ${renderAiResultCard(props.analysisResults[selectedGroup.chatId])}

              <!-- Bubbles -->
              <div class="tg-msng-bubbles">
                ${selectedGroup.pairs.map(
                  (pair) => html`
                    <div class="tg-pair-block">
                      <div class="tg-msng-bubble tg-msng-bubble--client">
                        <div class="tg-msng-bubble-label">Клиент</div>
                        <div class="tg-msng-bubble-text">${pair.input}</div>
                      </div>
                      <div class="tg-msng-bubble tg-msng-bubble--manager">
                        <div class="tg-msng-bubble-label">Менеджер</div>
                        <div class="tg-msng-bubble-text">${pair.response}</div>
                      </div>
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
