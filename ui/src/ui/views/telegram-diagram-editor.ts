// ui/src/ui/views/telegram-diagram-editor.ts
//
// Visual flowchart diagram editor for the Telegram "Схема" tab.
// Self-contained LitElement with SVG canvas, drag-and-drop, and auto-save.

import { LitElement, html, css, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  FlowDiagram,
  DiagramNode,
  DiagramGroup,
  DiagramNodeType,
  TrainingScope,
} from "../controllers/telegram.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tool = "select" | "start" | "end" | "process" | "decision" | "group" | "connect";

type DragState = {
  id: string;
  kind: "node" | "group";
  /** pointer offset from element origin at drag start */
  ox: number;
  oy: number;
};

type ConnectState = {
  sourceId: string;
  /** current pointer position in SVG coords */
  curX: number;
  curY: number;
};

type ViewBox = { x: number; y: number; w: number; h: number };

type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type ResizeState = {
  groupId: string;
  handle: ResizeHandle;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
};

type ScrollbarDrag = {
  axis: "h" | "v";
  /** client coordinate at drag start */
  startClient: number;
  /** viewBox origin at drag start */
  startVb: number;
};

// ─── Geometry helpers ─────────────────────────────────────────────────────────

const NODE_W = 180;
const NODE_H = 56;
const OVAL_RX = 90;
const OVAL_RY = 28;
const DIAMOND_RX = 110;
const DIAMOND_RY = 42;

function nodeWidth(type: DiagramNodeType): number {
  return type === "decision" ? DIAMOND_RX * 2 : NODE_W;
}

function nodeHeight(type: DiagramNodeType): number {
  return type === "decision" ? DIAMOND_RY * 2 : NODE_H;
}

function nodeCenterX(n: DiagramNode): number {
  return n.x + nodeWidth(n.type) / 2;
}

function nodeCenterY(n: DiagramNode): number {
  return n.y + nodeHeight(n.type) / 2;
}

function closestEdgePoint(n: DiagramNode, tx: number, ty: number): { x: number; y: number } {
  const cx = nodeCenterX(n);
  const cy = nodeCenterY(n);
  const dx = tx - cx;
  const dy = ty - cy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const hw = nodeWidth(n.type) / 2;
  const hh = nodeHeight(n.type) / 2;
  // Scale to reach the boundary (approximate for all shapes)
  const scale = Math.min(Math.abs(hw / (dx / len || 0.001)), Math.abs(hh / (dy / len || 0.001)));
  return { x: cx + (dx / len) * scale, y: cy + (dy / len) * scale };
}

// ─── Group color palette (dark theme) ─────────────────────────────────────────

const GROUP_COLORS: Record<string, { bg: string; stroke: string; label: string }> = {
  blue: { bg: "rgba(59,130,246,0.08)", stroke: "#3b82f6", label: "Синий" },
  green: { bg: "rgba(20,184,166,0.08)", stroke: "#14b8a6", label: "Зелёный" },
  orange: { bg: "rgba(245,158,11,0.08)", stroke: "#f59e0b", label: "Оранжевый" },
  purple: { bg: "rgba(139,92,246,0.08)", stroke: "#8b5cf6", label: "Фиолетовый" },
};

const GROUP_COLOR_ORDER: Array<"blue" | "green" | "orange" | "purple"> = [
  "blue",
  "green",
  "orange",
  "purple",
];

// Resize handle descriptors (group selection)
const RESIZE_HANDLES: Array<{
  h: ResizeHandle;
  cx: (g: DiagramGroup) => number;
  cy: (g: DiagramGroup) => number;
  cursor: string;
}> = [
  { h: "nw", cx: (g) => g.x, cy: (g) => g.y, cursor: "nwse-resize" },
  { h: "n", cx: (g) => g.x + g.w / 2, cy: (g) => g.y, cursor: "ns-resize" },
  { h: "ne", cx: (g) => g.x + g.w, cy: (g) => g.y, cursor: "nesw-resize" },
  { h: "e", cx: (g) => g.x + g.w, cy: (g) => g.y + g.h / 2, cursor: "ew-resize" },
  { h: "se", cx: (g) => g.x + g.w, cy: (g) => g.y + g.h, cursor: "nwse-resize" },
  { h: "s", cx: (g) => g.x + g.w / 2, cy: (g) => g.y + g.h, cursor: "ns-resize" },
  { h: "sw", cx: (g) => g.x, cy: (g) => g.y + g.h, cursor: "nesw-resize" },
  { h: "w", cx: (g) => g.x, cy: (g) => g.y + g.h / 2, cursor: "ew-resize" },
];

// ─── Node fill colors (dark theme) ────────────────────────────────────────────

const NODE_FILLS: Record<
  DiagramNodeType,
  { fill: string; stroke: string; text: string; glow: string }
> = {
  start: { fill: "#0d3a5e", stroke: "#3b82f6", text: "#93c5fd", glow: "rgba(59,130,246,0.45)" },
  end: { fill: "#2d1c6b", stroke: "#8b5cf6", text: "#c4b5fd", glow: "rgba(139,92,246,0.45)" },
  process: { fill: "#0a3630", stroke: "#14b8a6", text: "#5eead4", glow: "rgba(20,184,166,0.45)" },
  decision: { fill: "#3d2200", stroke: "#f59e0b", text: "#fcd34d", glow: "rgba(245,158,11,0.45)" },
};

// ─── Unique ID helper ─────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Returns true if chatStates has at least one entry. */
function _hasAnyStates(states: Record<string, string>): boolean {
  return Object.keys(states).length > 0;
}

// ─── Default starter diagram ──────────────────────────────────────────────────

export function makeDefaultDiagram(agentId: string, scope: TrainingScope): FlowDiagram {
  const now = new Date().toISOString();
  // Node IDs
  const nStart = uid();
  const nGreet = uid();
  const nCheck = uid();
  const nQual = uid();
  const nUnqual = uid();
  const nClose = uid();
  const nEnd = uid();
  // Group IDs
  const gIn = uid();
  const gProc = uid();
  const gOut = uid();
  return {
    id: uid(),
    agentId,
    scope,
    title: "Алгоритм менеджера",
    nodes: [
      { id: nStart, type: "start", text: "Новый лид", x: 270, y: 60 },
      { id: nGreet, type: "process", text: "Приветствие", x: 270, y: 160, groupId: gIn },
      { id: nCheck, type: "decision", text: "Есть интерес?", x: 220, y: 290, groupId: gProc },
      { id: nQual, type: "process", text: "Квалификация", x: 80, y: 430, groupId: gProc },
      { id: nUnqual, type: "process", text: "Отказ / нет задачи", x: 410, y: 430, groupId: gProc },
      { id: nClose, type: "process", text: "Закрытие сделки", x: 80, y: 560, groupId: gOut },
      { id: nEnd, type: "end", text: "Завершено", x: 240, y: 680 },
    ],
    edges: [
      { id: uid(), sourceId: nStart, targetId: nGreet },
      { id: uid(), sourceId: nGreet, targetId: nCheck },
      { id: uid(), sourceId: nCheck, targetId: nQual, label: "Да" },
      { id: uid(), sourceId: nCheck, targetId: nUnqual, label: "Нет" },
      { id: uid(), sourceId: nQual, targetId: nClose },
      { id: uid(), sourceId: nUnqual, targetId: nEnd },
      { id: uid(), sourceId: nClose, targetId: nEnd },
    ],
    groups: [
      { id: gIn, label: "Входящий контакт", color: "blue", x: 40, y: 130, w: 640, h: 100 },
      { id: gProc, label: "Обработка", color: "orange", x: 40, y: 250, w: 640, h: 260 },
      { id: gOut, label: "Результат", color: "green", x: 40, y: 520, w: 300, h: 120 },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

@customElement("tg-diagram-editor")
export class TgDiagramEditor extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      font-family: inherit;
      color: var(--text, #e4e4e7);
    }

    /* ── Scope row ── */
    .scope-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 7px 14px;
      border-bottom: 1px solid var(--border, #27272a);
      background: var(--card, #181b22);
      flex-shrink: 0;
    }
    .scope-row__label {
      font-size: 10px;
      font-weight: 700;
      color: var(--muted, #71717a);
      white-space: nowrap;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .scope-switcher {
      display: inline-flex;
      background: var(--bg, #12141a);
      border: 1px solid var(--border, #27272a);
      border-radius: 8px;
      padding: 2px;
      gap: 2px;
    }
    .scope-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: none;
      background: transparent;
      border-radius: 6px;
      padding: 4px 12px;
      font-size: 11px;
      font-weight: 600;
      color: var(--muted, #71717a);
      cursor: pointer;
      white-space: nowrap;
      transition:
        background 0.12s,
        color 0.12s;
    }
    .scope-btn:hover {
      background: var(--bg-hover, #262a35);
      color: var(--text, #e4e4e7);
    }
    .scope-btn.active {
      background: var(--bg-elevated, #1a1d25);
      color: var(--text-strong, #fafafa);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    }

    /* ── Toolbar ── */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 5px 8px;
      background: var(--card, #181b22);
      border-bottom: 1px solid var(--border, #27272a);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .tool-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 4px 9px;
      font-size: 11px;
      font-weight: 600;
      background: transparent;
      color: var(--muted, #71717a);
      cursor: pointer;
      transition:
        background 0.1s,
        color 0.1s,
        border-color 0.1s;
      white-space: nowrap;
      letter-spacing: 0.01em;
    }
    .tool-btn:hover {
      background: var(--bg-hover, #262a35);
      color: var(--text, #e4e4e7);
    }
    .tool-btn.active {
      background: var(--bg-elevated, #1a1d25);
      color: var(--text-strong, #fafafa);
      border-color: var(--border-strong, #3f3f46);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    }
    /* node type colour accents on active state */
    .tool-btn.active.tb-start {
      color: #93c5fd;
      border-color: #3b82f6;
    }
    .tool-btn.active.tb-end {
      color: #c4b5fd;
      border-color: #8b5cf6;
    }
    .tool-btn.active.tb-proc {
      color: #5eead4;
      border-color: #14b8a6;
    }
    .tool-btn.active.tb-dec {
      color: #fcd34d;
      border-color: #f59e0b;
    }
    .tool-btn.active.tb-grp {
      color: #fb923c;
      border-color: #f97316;
    }
    .tool-btn.active.tb-conn {
      color: var(--accent, #ff5c5c);
      border-color: var(--accent, #ff5c5c);
    }
    .tool-btn.danger {
      color: var(--accent, #ff5c5c);
    }
    .tool-btn.danger:hover {
      background: rgba(255, 92, 92, 0.1);
      color: #ff7070;
    }
    .tool-btn.tb-import {
      color: #67e8f9;
      border-color: rgba(103, 232, 249, 0.3);
    }
    .tool-btn.tb-import:hover:not(:disabled) {
      background: rgba(103, 232, 249, 0.1);
    }
    .tool-btn.tb-import:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .tool-btn.tb-export-json {
      color: #86efac;
      border-color: rgba(134, 239, 172, 0.3);
    }
    .tool-btn.tb-export-json:hover:not(:disabled) {
      background: rgba(134, 239, 172, 0.1);
    }
    .tool-btn.tb-export-json:disabled {
      opacity: 0.4;
    }
    .tool-btn.tb-import-json {
      color: #fcd34d;
      border-color: rgba(252, 211, 77, 0.3);
    }
    .tool-btn.tb-import-json:hover:not(:disabled) {
      background: rgba(252, 211, 77, 0.1);
    }
    .tool-btn.tb-import-json:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .tool-btn.tb-knowledge {
      color: #a78bfa;
      border-color: rgba(167, 139, 250, 0.3);
    }
    .tool-btn.tb-knowledge:hover:not(:disabled) {
      background: rgba(167, 139, 250, 0.1);
    }
    .tool-btn.tb-knowledge.active {
      background: rgba(167, 139, 250, 0.18);
      border-color: rgba(167, 139, 250, 0.6);
    }
    /* ── KB panel ── */
    .kb-panel {
      border-bottom: 1px solid var(--border, #27272a);
      background: #111;
      padding: 10px 12px;
      max-height: 340px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .kb-panel__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .kb-panel__title {
      font-size: 11px;
      font-weight: 700;
      color: #a78bfa;
      letter-spacing: 0.04em;
    }
    .kb-panel__actions {
      display: flex;
      gap: 6px;
    }
    /* ── Anthropic key modal ───────────────────────────── */
    .anthropic-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(2px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    }
    .anthropic-modal {
      background: #1e2130;
      border: 1px solid rgba(167, 139, 250, 0.35);
      border-radius: 14px;
      padding: 28px 28px 24px;
      width: 380px;
      max-width: 95vw;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
      position: relative;
    }
    .anthropic-modal-close {
      position: absolute;
      top: 12px;
      right: 14px;
      background: transparent;
      border: none;
      color: #6b7280;
      font-size: 20px;
      cursor: pointer;
      line-height: 1;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .anthropic-modal-close:hover {
      color: #e5e7eb;
      background: rgba(255, 255, 255, 0.08);
    }
    .anthropic-modal h3 {
      margin: 0 0 6px;
      font-size: 15px;
      font-weight: 600;
      color: #e5e7eb;
    }
    .anthropic-modal p {
      margin: 0 0 16px;
      font-size: 12px;
      color: #9ca3af;
      line-height: 1.5;
    }
    .anthropic-modal input {
      width: 100%;
      box-sizing: border-box;
      padding: 9px 12px;
      border-radius: 8px;
      border: 1px solid rgba(167, 139, 250, 0.3);
      background: rgba(255, 255, 255, 0.05);
      color: #e5e7eb;
      font-size: 13px;
      font-family: monospace;
      margin-bottom: 8px;
      outline: none;
    }
    .anthropic-modal input:focus {
      border-color: rgba(167, 139, 250, 0.7);
    }
    .anthropic-key-error {
      font-size: 11px;
      color: #f87171;
      margin-bottom: 12px;
      min-height: 16px;
    }
    .anthropic-modal-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .anthropic-btn-save {
      padding: 8px 18px;
      border-radius: 8px;
      border: none;
      background: linear-gradient(135deg, #7c3aed, #4f46e5);
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .anthropic-btn-save:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    .anthropic-btn-save:hover:not(:disabled) {
      opacity: 0.9;
    }
    .anthropic-btn-cancel {
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: transparent;
      color: #9ca3af;
      font-size: 13px;
      cursor: pointer;
    }
    .anthropic-btn-cancel:hover {
      color: #e5e7eb;
    }

    .kb-btn-distribute {
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid rgba(167, 139, 250, 0.4);
      background: rgba(167, 139, 250, 0.1);
      color: #a78bfa;
      cursor: pointer;
    }
    .kb-btn-distribute:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    .kb-btn-close {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: transparent;
      color: #9ca3af;
      cursor: pointer;
    }
    .kb-btn-close:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    .kb-loading,
    .kb-empty {
      font-size: 11px;
      color: #6b7280;
      padding: 4px 0;
    }
    .kb-empty p {
      margin: 2px 0;
    }
    .kb-entries {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .kb-node {
      border: 1px solid rgba(167, 139, 250, 0.2);
      border-radius: 6px;
      padding: 6px 8px;
    }
    .kb-node__title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .kb-node__name {
      font-size: 11px;
      font-weight: 600;
      color: #d1d5db;
    }
    .kb-node__count {
      font-size: 10px;
      color: #6b7280;
    }
    .kb-pairs {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .kb-pair {
      display: flex;
      gap: 6px;
      align-items: flex-start;
      font-size: 10px;
    }
    .kb-pair__score {
      color: #fbbf24;
      flex-shrink: 0;
      font-size: 9px;
      padding-top: 1px;
    }
    .kb-pair__content {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .kb-pair__q {
      color: #e5e7eb;
    }
    .kb-pair__a {
      color: #9ca3af;
    }
    .kb-more {
      font-size: 10px;
      color: #6b7280;
      padding-left: 20px;
    }
    .kb-panel__footer {
      font-size: 9px;
      color: #4b5563;
      margin-top: 2px;
    }
    /* ── Collections panel ── */
    .tool-btn.tb-collections {
      color: #34d399;
      border-color: rgba(52, 211, 153, 0.3);
    }
    .tool-btn.tb-collections:hover:not(:disabled) {
      background: rgba(52, 211, 153, 0.1);
    }
    .tool-btn.tb-collections.active {
      background: rgba(52, 211, 153, 0.15);
      border-color: rgba(52, 211, 153, 0.55);
    }
    .collections-panel {
      border-bottom: 1px solid var(--border, #27272a);
      background: #0f1710;
      padding: 10px 12px;
      max-height: 300px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .collections-panel__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-shrink: 0;
    }
    .collections-panel__title {
      font-size: 11px;
      font-weight: 700;
      color: #34d399;
      letter-spacing: 0.04em;
    }
    .collections-new-btn {
      font-size: 10px;
      padding: 3px 9px;
      border-radius: 4px;
      border: 1px solid rgba(52, 211, 153, 0.4);
      background: rgba(52, 211, 153, 0.1);
      color: #34d399;
      cursor: pointer;
      white-space: nowrap;
    }
    .collections-new-btn:hover {
      background: rgba(52, 211, 153, 0.2);
    }
    .collections-empty {
      font-size: 11px;
      color: #6b7280;
      padding: 8px 0;
      line-height: 1.5;
    }
    .collections-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .collections-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-radius: 5px;
      border: 1px solid transparent;
      cursor: pointer;
      transition:
        background 0.12s,
        border-color 0.12s;
    }
    .collections-item:hover {
      background: rgba(255, 255, 255, 0.04);
      border-color: rgba(255, 255, 255, 0.07);
    }
    .collections-item--active {
      background: rgba(52, 211, 153, 0.1);
      border-color: rgba(52, 211, 153, 0.35);
      cursor: default;
    }
    .collections-item__main {
      display: flex;
      flex-direction: column;
      gap: 1px;
      flex: 1;
      min-width: 0;
    }
    .collections-item__title {
      font-size: 12px;
      font-weight: 500;
      color: var(--text, #e5e7eb);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .collections-item--active .collections-item__title {
      color: #34d399;
    }
    .collections-item__meta {
      font-size: 10px;
      color: #6b7280;
    }
    .collections-item__actions {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
      opacity: 0;
      transition: opacity 0.1s;
    }
    .collections-item:hover .collections-item__actions,
    .collections-item--active .collections-item__actions {
      opacity: 1;
    }
    .collections-action-btn {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      color: #9ca3af;
      cursor: pointer;
      font-size: 10px;
      padding: 2px 5px;
      line-height: 1.4;
      transition:
        color 0.1s,
        border-color 0.1s;
    }
    .collections-action-btn:hover {
      color: #e5e7eb;
      border-color: rgba(255, 255, 255, 0.2);
    }
    .collections-action-btn--danger:hover {
      color: #f87171;
      border-color: rgba(248, 113, 113, 0.4);
    }
    .collections-rename-input {
      font-size: 12px;
      font-family: inherit;
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(52, 211, 153, 0.5);
      border-radius: 4px;
      color: #34d399;
      padding: 2px 6px;
      width: 100%;
      outline: none;
    }
    /* ── AI prompt bar ── */
    .ai-prompt-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border, #27272a);
      background: #0d0d0d;
    }
    .ai-prompt-bar__icon {
      font-size: 14px;
      flex-shrink: 0;
      color: #818cf8;
    }
    .ai-prompt-bar__input {
      flex: 1;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(129, 140, 248, 0.25);
      border-radius: 6px;
      color: #e5e7eb;
      font-size: 11px;
      padding: 5px 8px;
      outline: none;
      font-family: inherit;
      resize: none;
      min-height: 28px;
      max-height: 80px;
      overflow-y: auto;
      line-height: 1.4;
    }
    .ai-prompt-bar__input:focus {
      border-color: rgba(129, 140, 248, 0.6);
      background: rgba(129, 140, 248, 0.07);
    }
    .ai-prompt-bar__input::placeholder {
      color: #4b5563;
    }
    .ai-prompt-bar__btn {
      flex-shrink: 0;
      padding: 5px 10px;
      border-radius: 6px;
      border: 1px solid rgba(129, 140, 248, 0.4);
      background: rgba(129, 140, 248, 0.12);
      color: #818cf8;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .ai-prompt-bar__btn:hover:not(:disabled) {
      background: rgba(129, 140, 248, 0.22);
      border-color: rgba(129, 140, 248, 0.7);
    }
    .ai-prompt-bar__btn:disabled {
      opacity: 0.5;
      cursor: wait;
    }
    .ai-prompt-bar__error {
      font-size: 10px;
      color: #f87171;
      flex-shrink: 0;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .import-error {
      font-size: 10px;
      color: #ff7070;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .toolbar-sep {
      width: 1px;
      height: 20px;
      background: var(--border, #27272a);
      margin: 0 3px;
      flex-shrink: 0;
    }
    .save-badge {
      margin-left: auto;
      font-size: 10px;
      font-weight: 600;
      color: var(--muted, #71717a);
      display: flex;
      align-items: center;
      gap: 4px;
      letter-spacing: 0.02em;
    }
    .save-badge.saving {
      color: #f59e0b;
    }
    .save-badge.saved {
      color: #14b8a6;
    }

    /* ── Canvas ── */
    .canvas-wrap {
      flex: 1;
      min-height: 0;
      position: relative;
      overflow: hidden;
      background: #0b0d12;
    }
    svg.canvas {
      display: block;
      width: 100%;
      height: 100%;
      touch-action: none;
    }
    svg.canvas.tool-select {
      cursor: default;
    }
    svg.canvas.tool-connect {
      cursor: crosshair;
    }
    svg.canvas.tool-group {
      cursor: crosshair;
    }
    svg.canvas.tool-process,
    svg.canvas.tool-start,
    svg.canvas.tool-end,
    svg.canvas.tool-decision {
      cursor: cell;
    }
    svg.canvas.panning {
      cursor: grabbing;
    }

    /* ── Scrollbars ── */
    .scrollbar-h,
    .scrollbar-v {
      position: absolute;
      background: rgba(255, 255, 255, 0.045);
      border-radius: 7px;
      z-index: 20;
      /* Fade in/out based on whether content overflows */
      opacity: 0.6;
      transition: opacity 0.2s;
    }
    .scrollbar-h:hover,
    .scrollbar-v:hover {
      opacity: 1;
    }
    .scrollbar-h {
      bottom: 4px;
      left: 4px;
      right: 20px; /* leave room for corner */
      height: 14px;
      cursor: default;
    }
    .scrollbar-v {
      right: 4px;
      top: 4px;
      bottom: 20px; /* leave room for corner */
      width: 14px;
      cursor: default;
    }
    /* Corner square where h and v scrollbars meet */
    .scrollbar-corner {
      position: absolute;
      bottom: 4px;
      right: 4px;
      width: 14px;
      height: 14px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 3px;
      z-index: 20;
    }
    .scrollbar-thumb-h,
    .scrollbar-thumb-v {
      position: absolute;
      background: rgba(255, 255, 255, 0.28);
      border-radius: 6px;
      cursor: grab;
      transition: background 0.12s;
      min-width: 28px;
      min-height: 28px;
    }
    .scrollbar-thumb-h:hover,
    .scrollbar-thumb-v:hover {
      background: rgba(255, 255, 255, 0.45);
    }
    .scrollbar-thumb-h:active,
    .scrollbar-thumb-v:active {
      background: rgba(255, 255, 255, 0.55);
      cursor: grabbing;
    }
    .scrollbar-thumb-h {
      top: 2px;
      bottom: 2px;
    }
    .scrollbar-thumb-v {
      left: 2px;
      right: 2px;
    }

    /* ── Editing state pulse ── */
    @keyframes edit-dash {
      to {
        stroke-dashoffset: -20;
      }
    }
    .editing-outline {
      animation: edit-dash 0.6s linear infinite;
    }

    /* ── Active chat pulse ring ── */
    @keyframes active-pulse {
      0% {
        opacity: 0.55;
        transform: scale(1);
      }
      50% {
        opacity: 0.2;
        transform: scale(1.06);
      }
      100% {
        opacity: 0.55;
        transform: scale(1);
      }
    }
    .node-active-pulse {
      animation: active-pulse 1.8s ease-in-out infinite;
      transform-origin: center;
      transform-box: fill-box;
    }

    /* ── Inline text editor overlay ── */
    .edit-overlay {
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
      width: 100%;
      height: 100%;
    }
    .edit-input-wrap {
      position: absolute;
      pointer-events: all;
      transform: translate(-50%, -50%);
    }
    .edit-input {
      border: 2px solid var(--edit-color, #3b82f6);
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 13px;
      font-weight: 600;
      text-align: center;
      background: #0c1118;
      color: #f4f4f5;
      outline: none;
      /* width set inline per node type */
      box-shadow:
        0 0 0 3px var(--edit-glow, rgba(59, 130, 246, 0.25)),
        0 12px 32px rgba(0, 0, 0, 0.6);
      transition: box-shadow 0.15s;
    }
    .edit-input:focus {
      box-shadow:
        0 0 0 4px var(--edit-glow, rgba(59, 130, 246, 0.4)),
        0 12px 32px rgba(0, 0, 0, 0.6);
    }
  `;

  @property({ attribute: false }) diagram: FlowDiagram | null = null;
  @property() agentId = "";
  @property() scope: TrainingScope = "personal";
  /**
   * Live conversation states: maps chatId → nodeId (or "__done__" = free-mode continuation).
   * When provided, each node renders a count badge showing how many active chats are there.
   * "__done__" states are attributed to the diagram's END node.
   */
  @property({ attribute: false }) chatStates: Record<string, string> = {};
  @property({ attribute: false }) onSave: (d: FlowDiagram) => void = () => {};
  @property({ attribute: false }) onScopeChange: (agentId: string, scope: TrainingScope) => void =
    () => {};
  /** Called with base64 image data + MIME type; returns a promise that resolves to the new diagram. */
  @property({ attribute: false })
  onImportImage: ((base64: string, mime: string) => Promise<FlowDiagram | null>) | null = null;

  /** Check whether Anthropic API key is configured on the gateway. */
  @property({ attribute: false })
  onCheckAnthropicKey: (() => Promise<boolean>) | null = null;

  /** Save Anthropic API key to the gateway. Returns true on success. */
  @property({ attribute: false })
  onSaveAnthropicKey: ((key: string) => Promise<{ ok: boolean; error?: string }>) | null = null;

  // ── Anthropic key modal state ──────────────────────────────────────────────
  @state() private _anthropicModalOpen = false;
  @state() private _anthropicKeyInput = "";
  @state() private _anthropicKeySaving = false;
  @state() private _anthropicKeyError = "";

  /** Called to export the current diagram as a JSON file. */
  @property({ attribute: false })
  onExportJson: ((diagram: FlowDiagram) => void) | null = null;

  /** Called with a JSON File; returns imported diagram or null on error. */
  @property({ attribute: false })
  onImportJson: ((file: File) => Promise<FlowDiagram | null>) | null = null;

  /** Called to load existing knowledge base for the current agent+scope. */
  @property({ attribute: false })
  onLoadKnowledgeBase: (() => Promise<void>) | null = null;

  /** Called to run AI distribution of training pairs across diagram nodes. */
  @property({ attribute: false })
  onDistributeTraining: (() => Promise<void>) | null = null;

  /** Called to save edited knowledge base. */
  @property({ attribute: false })
  onSaveKnowledgeBase:
    | ((entries: import("../controllers/telegram.ts").DiagramNodeKnowledge[]) => Promise<void>)
    | null = null;

  /** Current knowledge base data (injected from parent). */
  @property({ attribute: false })
  knowledgeBase: import("../controllers/telegram.ts").DiagramKnowledgeBase | null = null;

  /** Whether the knowledge base is being loaded/distributed. */
  @property({ type: Boolean })
  knowledgeBaseLoading = false;

  /** KB edit mode — enables inline editing of pairs. */
  @state()
  private kbEditMode = false;

  /**
   * Called with a natural-language prompt (and the current diagram for modifications).
   * Returns the AI-generated or AI-modified diagram.
   */
  @property({ attribute: false })
  onGenerateDiagramFromText:
    | ((
        prompt: string,
        current: import("../controllers/telegram.ts").FlowDiagram | null,
      ) => Promise<import("../controllers/telegram.ts").FlowDiagram | null>)
    | null = null;

  /** Summary list of all saved diagrams for this agent+scope. */
  @property({ attribute: false })
  diagramList: import("../controllers/telegram.ts").DiagramSummary[] = [];

  @property({ type: Boolean }) diagramListLoading = false;

  /** Called when user picks a diagram from the collection. */
  @property({ attribute: false })
  onSelectDiagram: ((id: string) => void) | null = null;

  /** Called when user deletes a diagram from the collection. */
  @property({ attribute: false })
  onDeleteDiagram: ((id: string) => void) | null = null;

  /** Called when user renames a diagram in the collection. */
  @property({ attribute: false })
  onRenameDiagram: ((id: string, title: string) => void) | null = null;

  /** Called when user clicks "New diagram". */
  @property({ attribute: false })
  onNewDiagram: (() => void) | null = null;

  @state() private tool: Tool = "select";
  @state() private selectedIds: Set<string> = new Set();
  @state() private dragging: DragState | null = null;
  @state() private connecting: ConnectState | null = null;
  @state() private resizing: ResizeState | null = null;
  @state() private editingId: string | null = null;
  @state() private editingText = "";
  @state() private vb: ViewBox = { x: -60, y: -60, w: 1200, h: 800 };
  @state() private panning: { sx: number; sy: number; vbx0: number; vby0: number } | null = null;
  @state() private sbDrag: ScrollbarDrag | null = null;
  @state() private saveStatus: "saved" | "saving" | "" = "";
  @state() private importing = false;
  @state() private importError: string | null = null;
  @state() private importingJson = false;
  @state() private importJsonError: string | null = null;
  @state() private kbPanelOpen = false;
  @state() private collectionsOpen = false;
  @state() private renamingId: string | null = null;
  @state() private renameValue = "";
  @state() private aiPrompt = "";
  @state() private aiGenerating = false;
  @state() private aiError: string | null = null;

  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _spaceDown = false;
  // Cached thumb fracs from last render — used by scroll drag math
  private _thumbWFrac = 1;
  private _thumbHFrac = 1;
  // Manual double-tap detection: setPointerCapture routes click events to SVG,
  // so browser dblclick never fires on the <g> node element.
  private _lastTap: { id: string; time: number } | null = null;

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    // Global move/up so drags work even when pointer leaves the SVG or lands on scrollbar divs
    window.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerUp);
  }

  // ── Diagram mutation helpers ──────────────────────────────────────────────

  private get d(): FlowDiagram {
    return this.diagram!;
  }

  private _mutate(fn: (d: FlowDiagram) => FlowDiagram): void {
    if (!this.diagram) {
      return;
    }
    this.diagram = fn(this.diagram);
    // Notify parent — debounced auto-save
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }
    this.saveStatus = "saving";
    this._saveTimer = setTimeout(() => {
      this.onSave(this.diagram!);
      this.saveStatus = "saved";
      setTimeout(() => {
        this.saveStatus = "";
      }, 2000);
    }, 800);
  }

  // ── Image import ──────────────────────────────────────────────────────────

  private _onImportFileChange = async (e: Event) => {
    if (!this.onImportImage) {
      return;
    }
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    // Reset so the same file can be re-selected
    input.value = "";

    this.importing = true;
    this.importError = null;

    try {
      const base64 = await new Promise<string>((res, rej) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
          // Strip the data-URL prefix (data:<mime>;base64,...)
          const result = (reader.result as string).split(",")[1] ?? "";
          res(result);
        });
        reader.addEventListener("error", () => rej(new Error("Не удалось прочитать файл")));
        reader.readAsDataURL(file);
      });

      const diagram = await this.onImportImage(base64, file.type || "image/jpeg");
      if (diagram) {
        this.diagram = diagram;
        // Fit view to new content
        const b = this._bounds();
        this.vb = { x: b.x, y: b.y, w: b.w, h: b.h };
      }
    } catch (err) {
      this.importError = err instanceof Error ? err.message : String(err);
      setTimeout(() => {
        this.importError = null;
      }, 5000);
    } finally {
      this.importing = false;
    }
  };

  private async _triggerImport() {
    // Before opening the file picker, verify Anthropic key is configured.
    if (this.onCheckAnthropicKey) {
      const hasKey = await this.onCheckAnthropicKey().catch(() => false);
      if (!hasKey) {
        // Show the key-entry modal instead of the file picker.
        this._anthropicModalOpen = true;
        this._anthropicKeyInput = "";
        this._anthropicKeyError = "";
        return;
      }
    }
    const input = this.shadowRoot?.querySelector(".import-file-input") as HTMLInputElement | null;
    input?.click();
  }

  private async _saveAnthropicKey() {
    const key = this._anthropicKeyInput.trim();
    if (!key) {
      this._anthropicKeyError = "Введите ключ";
      return;
    }
    if (!key.startsWith("sk-ant-")) {
      this._anthropicKeyError = "Ключ должен начинаться с «sk-ant-»";
      return;
    }
    if (!this.onSaveAnthropicKey) {
      return;
    }
    this._anthropicKeySaving = true;
    this._anthropicKeyError = "";
    try {
      const res = await this.onSaveAnthropicKey(key);
      if (res.ok) {
        this._anthropicModalOpen = false;
        // Now open the file picker
        const input = this.shadowRoot?.querySelector(
          ".import-file-input",
        ) as HTMLInputElement | null;
        input?.click();
      } else {
        this._anthropicKeyError = res.error ?? "Не удалось сохранить ключ";
      }
    } catch (e) {
      this._anthropicKeyError = String(e);
    } finally {
      this._anthropicKeySaving = false;
    }
  }

  // ── JSON import/export ────────────────────────────────────────────────────

  private _onImportJsonChange = async (e: Event) => {
    if (!this.onImportJson) {
      return;
    }
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) {
      return;
    }

    this.importingJson = true;
    this.importJsonError = null;
    try {
      const diagram = await this.onImportJson(file);
      if (diagram) {
        this.diagram = diagram;
        const b = this._bounds();
        this.vb = { x: b.x, y: b.y, w: b.w, h: b.h };
      }
    } catch (err) {
      this.importJsonError = err instanceof Error ? err.message : String(err);
      setTimeout(() => {
        this.importJsonError = null;
      }, 5000);
    } finally {
      this.importingJson = false;
    }
  };

  private _triggerImportJson() {
    const input = this.shadowRoot?.querySelector(
      ".import-json-file-input",
    ) as HTMLInputElement | null;
    input?.click();
  }

  // ── SVG coordinate helpers ────────────────────────────────────────────────

  private _svgEl(): SVGSVGElement | null {
    return this.shadowRoot?.querySelector("svg.canvas") as SVGSVGElement | null;
  }

  private _clientToSvg(cx: number, cy: number): { x: number; y: number } {
    const el = this._svgEl();
    if (!el) {
      return { x: cx, y: cy };
    }
    const rect = el.getBoundingClientRect();
    const scaleX = this.vb.w / rect.width;
    const scaleY = this.vb.h / rect.height;
    return {
      x: this.vb.x + (cx - rect.left) * scaleX,
      y: this.vb.y + (cy - rect.top) * scaleY,
    };
  }

  private _svgToClient(sx: number, sy: number): { x: number; y: number } {
    const el = this._svgEl();
    if (!el) {
      return { x: sx, y: sy };
    }
    const rect = el.getBoundingClientRect();
    const scaleX = rect.width / this.vb.w;
    const scaleY = rect.height / this.vb.h;
    return {
      x: rect.left + (sx - this.vb.x) * scaleX,
      y: rect.top + (sy - this.vb.y) * scaleY,
    };
  }

  // ── Pointer event handlers ────────────────────────────────────────────────

  private _onCanvasPointerDown = (e: PointerEvent) => {
    if (!this.diagram) {
      return;
    }
    const target = e.target as Element;
    const svg = this._svgEl();
    if (!svg) {
      return;
    }
    // Only handle clicks directly on the SVG background (not nodes/groups/edges)
    const isBackground = target === svg || target.classList.contains("canvas-bg");
    if (!isBackground) {
      return;
    }
    e.preventDefault();
    const { x, y } = this._clientToSvg(e.clientX, e.clientY);

    if (this._spaceDown || e.button === 1) {
      // Pan
      this.panning = { sx: e.clientX, sy: e.clientY, vbx0: this.vb.x, vby0: this.vb.y };
      svg.setPointerCapture(e.pointerId);
      return;
    }

    if (this.tool === "select") {
      this.selectedIds = new Set();
      return;
    }

    if (this.tool === "connect") {
      return;
    }

    if (this.tool === "group") {
      this._addGroup(x, y);
      return;
    }

    // Node placement tools
    const nodeType = this.tool as DiagramNodeType;
    if (["start", "end", "process", "decision"].includes(nodeType)) {
      this._addNode(nodeType, x, y);
    }
  };

  private _onNodePointerDown = (e: PointerEvent, node: DiagramNode) => {
    e.stopPropagation();
    const svg = this._svgEl();
    if (!svg) {
      return;
    }

    // Manual double-tap detection: setPointerCapture routes click/dblclick to SVG,
    // so the browser's dblclick event never reaches the <g> element. We detect
    // two taps on the same node within 350ms and open the text editor instead.
    const now = Date.now();
    const isDoubleTap = this._lastTap?.id === node.id && now - this._lastTap.time < 350;
    this._lastTap = { id: node.id, time: now };

    if (isDoubleTap && this.tool === "select") {
      this.dragging = null;
      this.editingId = node.id;
      this.editingText = node.text;
      this._focusEditInput();
      return;
    }

    svg.setPointerCapture(e.pointerId);
    const { x, y } = this._clientToSvg(e.clientX, e.clientY);

    if (this.tool === "connect") {
      // Start drawing a connection
      this.connecting = { sourceId: node.id, curX: x, curY: y };
      return;
    }

    if (this.tool === "select") {
      this.selectedIds = new Set([node.id]);
      // Start drag
      const cx = nodeCenterX(node);
      const cy = nodeCenterY(node);
      this.dragging = {
        id: node.id,
        kind: "node",
        ox: x - cx,
        oy: y - cy,
      };
    }
  };

  private _onGroupPointerDown = (e: PointerEvent, group: DiagramGroup) => {
    e.stopPropagation();
    const svg = this._svgEl();
    if (!svg) {
      return;
    }

    // Manual double-tap detection for groups (same reason as nodes above)
    const now = Date.now();
    const isDoubleTap = this._lastTap?.id === group.id && now - this._lastTap.time < 350;
    this._lastTap = { id: group.id, time: now };

    if (isDoubleTap && this.tool === "select") {
      this.dragging = null;
      this.editingId = group.id;
      this.editingText = group.label;
      this._focusEditInput();
      return;
    }

    svg.setPointerCapture(e.pointerId);
    const { x, y } = this._clientToSvg(e.clientX, e.clientY);

    if (this.tool === "select") {
      this.selectedIds = new Set([group.id]);
      this.dragging = {
        id: group.id,
        kind: "group",
        ox: x - group.x,
        oy: y - group.y,
      };
    }
  };

  private _onResizeHandlePointerDown = (
    e: PointerEvent,
    group: DiagramGroup,
    handle: ResizeHandle,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const svg = this._svgEl();
    if (!svg) {
      return;
    }
    svg.setPointerCapture(e.pointerId);
    const { x, y } = this._clientToSvg(e.clientX, e.clientY);
    // Don't start a drag — resize takes precedence
    this.dragging = null;
    this.resizing = {
      groupId: group.id,
      handle,
      startX: x,
      startY: y,
      origX: group.x,
      origY: group.y,
      origW: group.w,
      origH: group.h,
    };
  };

  private _onScrollbarPointerDown = (e: PointerEvent, axis: "h" | "v") => {
    // Skip if clicking on the thumb — thumb drag is handled below
    const target = e.target as Element;
    if (
      target.classList.contains("scrollbar-thumb-h") ||
      target.classList.contains("scrollbar-thumb-v")
    ) {
      e.stopPropagation();
      e.preventDefault();
      this.sbDrag = {
        axis,
        startClient: axis === "h" ? e.clientX : e.clientY,
        startVb: axis === "h" ? this.vb.x : this.vb.y,
      };
      return;
    }
    // Click on track itself — jump viewport to that position
    e.stopPropagation();
    e.preventDefault();
    const b = this._bounds();
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    if (axis === "h") {
      const frac = (e.clientX - rect.left) / rect.width;
      const newX = b.x + frac * b.w - this.vb.w / 2;
      this.vb = { ...this.vb, x: Math.max(b.x, Math.min(b.x + b.w - this.vb.w, newX)) };
    } else {
      const frac = (e.clientY - rect.top) / rect.height;
      const newY = b.y + frac * b.h - this.vb.h / 2;
      this.vb = { ...this.vb, y: Math.max(b.y, Math.min(b.y + b.h - this.vb.h, newY)) };
    }
  };

  // ── Content bounds (used for scrollbars) ─────────────────────────────────

  private _bounds(): { x: number; y: number; w: number; h: number } {
    const d = this.diagram;
    if (!d || (d.nodes.length === 0 && d.groups.length === 0)) {
      return { x: -200, y: -200, w: 1600, h: 1200 };
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of d.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + nodeWidth(n.type));
      maxY = Math.max(maxY, n.y + nodeHeight(n.type));
    }
    for (const g of d.groups) {
      minX = Math.min(minX, g.x);
      minY = Math.min(minY, g.y);
      maxX = Math.max(maxX, g.x + g.w);
      maxY = Math.max(maxY, g.y + g.h);
    }
    const pad = 160;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }

  private _onPointerMove = (e: PointerEvent) => {
    // Scrollbar thumb drag — pointer captured globally so always fires
    if (this.sbDrag) {
      const sb = this.sbDrag;
      const b = this._bounds();
      if (sb.axis === "h") {
        const track = this.shadowRoot?.querySelector(".scrollbar-h");
        if (!track) {
          return;
        }
        const trackPx = track.getBoundingClientRect().width;
        const thumbPx = trackPx * this._thumbWFrac;
        const scrollablePx = trackPx - thumbPx;
        if (scrollablePx <= 0) {
          return;
        }
        const delta = e.clientX - sb.startClient;
        const vbRange = b.w - this.vb.w;
        const newX = sb.startVb + delta * (vbRange / scrollablePx);
        this.vb = { ...this.vb, x: Math.max(b.x, Math.min(b.x + b.w - this.vb.w, newX)) };
      } else {
        const track = this.shadowRoot?.querySelector(".scrollbar-v");
        if (!track) {
          return;
        }
        const trackPx = track.getBoundingClientRect().height;
        const thumbPx = trackPx * this._thumbHFrac;
        const scrollablePx = trackPx - thumbPx;
        if (scrollablePx <= 0) {
          return;
        }
        const delta = e.clientY - sb.startClient;
        const vbRange = b.h - this.vb.h;
        const newY = sb.startVb + delta * (vbRange / scrollablePx);
        this.vb = { ...this.vb, y: Math.max(b.y, Math.min(b.y + b.h - this.vb.h, newY)) };
      }
      return;
    }

    if (!this.diagram) {
      return;
    }
    const { x, y } = this._clientToSvg(e.clientX, e.clientY);

    if (this.panning) {
      const el = this._svgEl();
      if (!el) {
        return;
      }
      const rect = el.getBoundingClientRect();
      const scaleX = this.vb.w / rect.width;
      const scaleY = this.vb.h / rect.height;
      this.vb = {
        ...this.vb,
        x: this.panning.vbx0 - (e.clientX - this.panning.sx) * scaleX,
        y: this.panning.vby0 - (e.clientY - this.panning.sy) * scaleY,
      };
      return;
    }

    if (this.resizing) {
      const r = this.resizing;
      const dx = x - r.startX;
      const dy = y - r.startY;
      const MIN_W = 120;
      const MIN_H = 80;
      this._mutate((d) => ({
        ...d,
        groups: d.groups.map((g) => {
          if (g.id !== r.groupId) {
            return g;
          }
          let gx = r.origX,
            gy = r.origY,
            gw = r.origW,
            gh = r.origH;
          if (r.handle.includes("e")) {
            gw = Math.max(MIN_W, r.origW + dx);
          }
          if (r.handle.includes("s")) {
            gh = Math.max(MIN_H, r.origH + dy);
          }
          if (r.handle.includes("w")) {
            const nw = Math.max(MIN_W, r.origW - dx);
            gx = r.origX + (r.origW - nw);
            gw = nw;
          }
          if (r.handle.includes("n")) {
            const nh = Math.max(MIN_H, r.origH - dy);
            gy = r.origY + (r.origH - nh);
            gh = nh;
          }
          return { ...g, x: gx, y: gy, w: gw, h: gh };
        }),
      }));
      return;
    }

    if (this.connecting) {
      this.connecting = { ...this.connecting, curX: x, curY: y };
      return;
    }

    if (this.dragging) {
      const { id, kind, ox, oy } = this.dragging;
      if (kind === "node") {
        this._mutate((d) => ({
          ...d,
          nodes: d.nodes.map((n) =>
            n.id === id
              ? { ...n, x: x - ox - nodeWidth(n.type) / 2, y: y - oy - nodeHeight(n.type) / 2 }
              : n,
          ),
        }));
      } else {
        this._mutate((d) => ({
          ...d,
          groups: d.groups.map((g) => (g.id === id ? { ...g, x: x - ox, y: y - oy } : g)),
        }));
      }
    }
  };

  private _onPointerUp = (e: PointerEvent) => {
    if (this.sbDrag) {
      this.sbDrag = null;
      return;
    }

    if (this.panning) {
      this.panning = null;
      return;
    }

    if (this.resizing) {
      this.resizing = null;
      return;
    }

    if (this.connecting && this.diagram) {
      const { x, y } = this._clientToSvg(e.clientX, e.clientY);
      const target = this.diagram.nodes.find((n) => {
        const hw = nodeWidth(n.type) / 2;
        const hh = nodeHeight(n.type) / 2;
        const cx = nodeCenterX(n);
        const cy = nodeCenterY(n);
        return Math.abs(x - cx) < hw && Math.abs(y - cy) < hh;
      });
      if (target && target.id !== this.connecting.sourceId) {
        this._addEdge(this.connecting.sourceId, target.id);
      }
      this.connecting = null;
      return;
    }

    this.dragging = null;
  };

  private _onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.12 : 0.88;
    const { x: mx, y: my } = this._clientToSvg(e.clientX, e.clientY);
    const nw = this.vb.w * factor;
    const nh = this.vb.h * factor;
    // Zoom toward mouse position
    this.vb = {
      x: mx - (mx - this.vb.x) * factor,
      y: my - (my - this.vb.y) * factor,
      w: nw,
      h: nh,
    };
  };

  private _focusEditInput() {
    // Wait for Lit to finish rendering, then wait one paint frame before focusing.
    // This is more reliable than an arbitrary setTimeout.
    void this.updateComplete.then(() => {
      requestAnimationFrame(() => {
        const input = this.shadowRoot?.querySelector(".edit-input") as HTMLInputElement | null;
        if (input) {
          input.focus();
          input.select();
        }
      });
    });
  }

  private _onNodeDblClick = (e: MouseEvent, node: DiagramNode) => {
    if (this.tool !== "select") {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    this.dragging = null; // cancel any accidental drag that started on first click
    this.editingId = node.id;
    this.editingText = node.text;
    this._focusEditInput();
  };

  private _onGroupDblClick = (e: MouseEvent, group: DiagramGroup) => {
    if (this.tool !== "select") {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    this.dragging = null;
    this.editingId = group.id;
    this.editingText = group.label;
    this._focusEditInput();
  };

  private _onEditKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      this._commitEdit();
    }
    if (e.key === "Escape") {
      this._cancelEdit();
    }
  };

  private _commitEdit = () => {
    if (!this.editingId || !this.diagram) {
      this._cancelEdit();
      return;
    }
    const id = this.editingId;
    const text = this.editingText.trim();
    const isNode = this.diagram.nodes.some((n) => n.id === id);
    const isEdge = this.diagram.edges.some((e) => e.id === id);
    if (isNode) {
      this._mutate((d) => ({
        ...d,
        nodes: d.nodes.map((n) => (n.id === id ? { ...n, text: text || n.text } : n)),
      }));
    } else if (isEdge) {
      // Save edge label (empty string removes label)
      this._mutate((d) => ({
        ...d,
        edges: d.edges.map((e) => (e.id === id ? { ...e, label: text || undefined } : e)),
      }));
    } else {
      this._mutate((d) => ({
        ...d,
        groups: d.groups.map((g) => (g.id === id ? { ...g, label: text || g.label } : g)),
      }));
    }
    this._cancelEdit();
  };

  private _cancelEdit = () => {
    this.editingId = null;
    this.editingText = "";
  };

  private _onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
      this._spaceDown = true;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && !(e.target instanceof HTMLInputElement)) {
      if (this.selectedIds.size > 0) {
        this._deleteSelected();
      }
    }
    if (e.key === "Escape") {
      this.connecting = null;
      this.dragging = null;
      this._cancelEdit();
    }
  };

  private _onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      this._spaceDown = false;
    }
  };

  // ── Diagram mutations ─────────────────────────────────────────────────────

  private _addNode(type: DiagramNodeType, x: number, y: number): void {
    const id = uid();
    const defaults: Record<DiagramNodeType, string> = {
      start: "Старт",
      end: "Конец",
      process: "Действие",
      decision: "Условие",
    };
    const nx = x - nodeWidth(type) / 2;
    const ny = y - nodeHeight(type) / 2;
    this._mutate((d) => ({
      ...d,
      nodes: [...d.nodes, { id, type, text: defaults[type], x: nx, y: ny }],
    }));
    this.selectedIds = new Set([id]);
    this.tool = "select";
  }

  private _addGroup(x: number, y: number): void {
    const id = uid();
    const usedColors = new Set(this.d.groups.map((g) => g.color));
    const color = GROUP_COLOR_ORDER.find((c) => !usedColors.has(c)) ?? "blue";
    const num = this.d.groups.length + 1;
    const g: DiagramGroup = {
      id,
      label: `Блок ${num}`,
      color,
      x: x - 220,
      y: y - 100,
      w: 440,
      h: 200,
    };
    this._mutate((d) => ({ ...d, groups: [...d.groups, g] }));
    this.selectedIds = new Set([id]);
    this.tool = "select";
  }

  private _addEdge(sourceId: string, targetId: string): void {
    // Avoid duplicate edges
    if (this.d.edges.some((e) => e.sourceId === sourceId && e.targetId === targetId)) {
      return;
    }
    const id = uid();
    this._mutate((d) => ({
      ...d,
      edges: [...d.edges, { id, sourceId, targetId }],
    }));
  }

  private _deleteSelected(): void {
    const ids = this.selectedIds;
    this._mutate((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => !ids.has(n.id)),
      edges: d.edges.filter((e) => !ids.has(e.id) && !ids.has(e.sourceId) && !ids.has(e.targetId)),
      groups: d.groups.filter((g) => !ids.has(g.id)),
    }));
    this.selectedIds = new Set();
  }

  private _deleteEdge(id: string): void {
    this._mutate((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== id) }));
    this.selectedIds = new Set();
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  render() {
    const d = this.diagram;
    const vb = this.vb;
    const canvasCursor = this.panning
      ? "panning"
      : this.tool === "connect"
        ? "tool-connect"
        : ["start", "end", "process", "decision"].includes(this.tool)
          ? `tool-${this.tool}`
          : this.tool === "group"
            ? "tool-group"
            : "tool-select";

    return html`
      ${
        this._anthropicModalOpen
          ? html`
        <div class="anthropic-overlay" @click=${(e: Event) => {
          if ((e.target as HTMLElement).classList.contains("anthropic-overlay")) {
            this._anthropicModalOpen = false;
          }
        }}>
          <div class="anthropic-modal">
            <button class="anthropic-modal-close"
              @click=${() => {
                this._anthropicModalOpen = false;
              }}
              title="Закрыть">✕</button>
            <h3>🔑 Anthropic API ключ</h3>
            <p>
              Для анализа фото нужен Anthropic API ключ (Claude Vision).<br>
              Получите его на <a href="https://console.anthropic.com/settings/keys"
                target="_blank" style="color:#a78bfa;">console.anthropic.com</a>
            </p>
            <input
              type="password"
              placeholder="sk-ant-api03-..."
              .value=${this._anthropicKeyInput}
              @input=${(e: Event) => {
                this._anthropicKeyInput = (e.target as HTMLInputElement).value;
                this._anthropicKeyError = "";
              }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  void this._saveAnthropicKey();
                }
              }}
              autocomplete="off"
            />
            <div class="anthropic-key-error">${this._anthropicKeyError}</div>
            <div class="anthropic-modal-actions">
              <button class="anthropic-btn-cancel"
                @click=${() => {
                  this._anthropicModalOpen = false;
                }}>
                Отмена
              </button>
              <button class="anthropic-btn-save"
                ?disabled=${this._anthropicKeySaving || !this._anthropicKeyInput.trim()}
                @click=${() => void this._saveAnthropicKey()}>
                ${this._anthropicKeySaving ? "Сохранение…" : "Сохранить и продолжить"}
              </button>
            </div>
          </div>
        </div>
      `
          : ""
      }
      ${this._renderScopeRow()}
      ${this._renderToolbar()}
      ${this.kbPanelOpen ? this._renderKbPanel() : nothing}
      ${this.collectionsOpen ? this._renderCollectionsPanel() : nothing}
      ${this._renderAiPromptBar()}
      <div class="canvas-wrap">
        <svg
          class="canvas ${canvasCursor}"
          viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}"
          @pointerdown=${this._onCanvasPointerDown}
          @wheel=${this._onWheel}
          @dblclick=${this._onCanvasDblClick}
        >
          <defs>
            <!-- arrows -->
            <marker id="arrow" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto">
              <path d="M0,0.5 L0,5.5 L6,3 z" fill="#4b5563" />
            </marker>
            <marker id="arrow-sel" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto">
              <path d="M0,0.5 L0,5.5 L6,3 z" fill="var(--accent,#ff5c5c)" />
            </marker>
            <!-- node glow filters -->
            <filter id="glow-blue" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="6" result="b"/>
              <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <filter id="glow-purple" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="6" result="b"/>
              <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <filter id="glow-teal" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="6" result="b"/>
              <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <filter id="glow-amber" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="6" result="b"/>
              <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <!-- dot grid pattern -->
            <pattern id="dot-grid" patternUnits="userSpaceOnUse" width="32" height="32">
              <circle cx="0.5" cy="0.5" r="1" fill="rgba(255,255,255,0.07)"/>
            </pattern>
          </defs>

          <!-- dot grid background -->
          <rect class="canvas-bg" x="${vb.x - 10000}" y="${vb.y - 10000}" width="100000" height="100000" fill="#0b0d12" />
          <rect x="${vb.x - 10000}" y="${vb.y - 10000}" width="100000" height="100000" fill="url(#dot-grid)" style="pointer-events:none;" />

          ${d ? this._renderGroups(d) : nothing}
          ${d ? this._renderEdges(d) : nothing}
          ${d ? this._renderNodes(d) : nothing}
          ${this._renderConnecting()}
        </svg>

        ${this._renderEditOverlay(d)}
        ${this._renderScrollbars()}
      </div>
    `;
  }

  private _renderScopeRow() {
    const scope = this.scope;
    return html`
      <div class="scope-row">
        <span class="scope-row__label">Схема:</span>
        <div class="scope-switcher">
          <button type="button" class="scope-btn ${scope === "personal" ? "active" : ""}"
            @click=${() => this.onScopeChange(this.agentId, "personal")} aria-pressed=${scope === "personal"}>
            👤 Личная
          </button>
          <button type="button" class="scope-btn ${scope === "shared" ? "active" : ""}"
            @click=${() => this.onScopeChange(this.agentId, "shared")} aria-pressed=${scope === "shared"}>
            🌐 Общая
          </button>
        </div>
      </div>
    `;
  }

  private _renderKbPanel() {
    const kb = this.knowledgeBase;
    const loading = this.knowledgeBaseLoading;
    const scopeLabel = this.scope === "shared" ? "Общая" : "Личная";
    const scoreStars = (s: number) => (s === 3 ? "★★★" : s === 2 ? "★★" : "★");
    const editMode = this.kbEditMode;

    return html`
      <div class="kb-panel">
        <div class="kb-panel__header">
          <span class="kb-panel__title">📚 База знаний — ${scopeLabel}</span>
          <div class="kb-panel__actions">
            ${
              editMode
                ? html`
                    <button class="kb-btn-save"
                      ?disabled=${loading}
                      title="Сохранить изменения"
                      @click=${async () => {
                        if (this.onSaveKnowledgeBase && kb) {
                          await this.onSaveKnowledgeBase(kb.entries);
                          this.kbEditMode = false;
                        }
                      }}>
                      💾 Сохранить
                    </button>
                    <button class="kb-btn-cancel"
                      ?disabled=${loading}
                      title="Отменить редактирование"
                      @click=${async () => {
                        this.kbEditMode = false;
                        // Reload KB to discard changes
                        if (this.onLoadKnowledgeBase) {
                          await this.onLoadKnowledgeBase();
                        }
                      }}>
                      ❌ Отмена
                    </button>
                  `
                : html`
                    <button class="kb-btn-edit"
                      ?disabled=${loading || !kb || kb.entries.length === 0}
                      title="Редактировать базу знаний"
                      @click=${() => {
                        this.kbEditMode = true;
                      }}>
                      ✏️ Редактировать
                    </button>
                    <button class="kb-btn-distribute"
                      ?disabled=${loading || !this.onDistributeTraining}
                      title="ИИ автоматически распределяет пары из раздела «Обучение» по узлам схемы"
                      @click=${async () => {
                        if (this.onDistributeTraining) {
                          await this.onDistributeTraining();
                        }
                      }}>
                      ${loading ? "⏳ Обработка…" : "🤖 Автораспределить"}
                    </button>
                  `
            }
            <button class="kb-btn-close" @click=${() => {
              this.kbPanelOpen = false;
              this.kbEditMode = false;
            }}
              title="Закрыть">✕</button>
          </div>
        </div>

        ${
          loading
            ? html`
                <div class="kb-loading">Загрузка…</div>
              `
            : nothing
        }

        ${
          !loading && (!kb || kb.entries.length === 0)
            ? html`
              <div class="kb-empty">
                <p>База знаний пуста.</p>
                <p>Убедитесь, что в разделе «Обучение» (${scopeLabel}) есть данные и создана схема,
                   затем нажмите <strong>🤖 Автораспределить</strong>.</p>
              </div>
            `
            : nothing
        }

        ${
          kb && kb.entries.length > 0
            ? html`
              <div class="kb-entries">
                ${kb.entries.map(
                  (entry, entryIdx) => html`
                    <div class="kb-node">
                      <div class="kb-node__title">
                        <span class="kb-node__name">${entry.nodeText}</span>
                        <span class="kb-node__count">${entry.pairs.length} пар</span>
                        ${
                          editMode
                            ? html`
                                <button class="kb-node-add-pair"
                                  title="Добавить пару"
                                  @click=${() => {
                                    if (!kb) {return;}
                                    const newPair = { input: "", response: "", score: 2 };
                                    kb.entries[entryIdx].pairs.push(newPair);
                                    this.requestUpdate();
                                  }}>
                                  ➕ Добавить пару
                                </button>
                              `
                            : nothing
                        }
                      </div>
                      <div class="kb-pairs">
                        ${(editMode ? entry.pairs : entry.pairs.slice(0, 5)).map(
                          (pair, pairIdx) => html`
                            <div class="kb-pair ${editMode ? "kb-pair--edit" : ""}">
                              ${
                                !editMode
                                  ? html`
                                      <span class="kb-pair__score" title="Оценка качества">${scoreStars(pair.score)}</span>
                                      <div class="kb-pair__content">
                                        <div class="kb-pair__q">${pair.input}</div>
                                        <div class="kb-pair__a">→ ${pair.response}</div>
                                      </div>
                                    `
                                  : html`
                                      <div class="kb-pair__edit-content">
                                        <div class="kb-pair__edit-row">
                                          <label class="kb-pair__label">Вопрос:</label>
                                          <textarea class="kb-pair__input"
                                            rows="2"
                                            .value=${pair.input}
                                            @input=${(e: Event) => {
                                              if (!kb) {return;}
                                              kb.entries[entryIdx].pairs[pairIdx].input = (
                                                e.target as HTMLTextAreaElement
                                              ).value;
                                            }}
                                          ></textarea>
                                        </div>
                                        <div class="kb-pair__edit-row">
                                          <label class="kb-pair__label">Ответ:</label>
                                          <textarea class="kb-pair__input"
                                            rows="2"
                                            .value=${pair.response}
                                            @input=${(e: Event) => {
                                              if (!kb) {return;}
                                              kb.entries[entryIdx].pairs[pairIdx].response = (
                                                e.target as HTMLTextAreaElement
                                              ).value;
                                            }}
                                          ></textarea>
                                        </div>
                                        <div class="kb-pair__edit-row">
                                          <label class="kb-pair__label">Оценка:</label>
                                          <select class="kb-pair__score-select"
                                            .value=${String(pair.score)}
                                            @change=${(e: Event) => {
                                              if (!kb) {return;}
                                              kb.entries[entryIdx].pairs[pairIdx].score = parseInt(
                                                (e.target as HTMLSelectElement).value,
                                                10,
                                              );
                                            }}>
                                            <option value="1">★ (1)</option>
                                            <option value="2">★★ (2)</option>
                                            <option value="3">★★★ (3)</option>
                                          </select>
                                          <button class="kb-pair__delete"
                                            title="Удалить пару"
                                            @click=${() => {
                                              if (!kb) {return;}
                                              kb.entries[entryIdx].pairs.splice(pairIdx, 1);
                                              this.requestUpdate();
                                            }}>
                                            🗑️ Удалить
                                          </button>
                                        </div>
                                      </div>
                                    `
                              }
                            </div>
                          `,
                        )}
                        ${
                          !editMode && entry.pairs.length > 5
                            ? html`<div class="kb-more">+ ещё ${entry.pairs.length - 5} пар…</div>`
                            : nothing
                        }
                      </div>
                    </div>
                  `,
                )}
              </div>
              <div class="kb-panel__footer">
                Обновлено: ${kb.updatedAt ? new Date(kb.updatedAt).toLocaleString("ru") : "—"}
              </div>
            `
            : nothing
        }
      </div>
    `;
  }

  private _renderCollectionsPanel() {
    const list = this.diagramList;
    const activeid = this.diagram?.id ?? null;

    const fmtDate = (iso: string) => {
      try {
        const d = new Date(iso);
        return `${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1).toString().padStart(2, "0")} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
      } catch {
        return iso.slice(0, 10);
      }
    };

    return html`
      <div class="collections-panel">
        <div class="collections-panel__header">
          <span class="collections-panel__title">🗂 Набор схем</span>
          <div style="display:flex;gap:6px;align-items:center;">
            ${
              this.onNewDiagram
                ? html`<button class="collections-new-btn"
                  title="Создать новую пустую схему"
                  @click=${() => {
                    this.onNewDiagram!();
                  }}>
                  ＋ Новая
                </button>`
                : nothing
            }
            <button class="kb-btn-close" @click=${() => {
              this.collectionsOpen = false;
            }} title="Закрыть">✕</button>
          </div>
        </div>

        ${
          this.diagramListLoading
            ? html`
                <div class="collections-empty">Загрузка…</div>
              `
            : list.length === 0
              ? html`
                  <div class="collections-empty">
                    Нет сохранённых схем.<br />Нажмите <strong>＋ Новая</strong> чтобы создать.
                  </div>
                `
              : html`<div class="collections-list">
                ${list.map((item) => {
                  const isActive = item.id === activeid;
                  const isRenaming = this.renamingId === item.id;
                  return html`
                    <div class="collections-item ${isActive ? "collections-item--active" : ""}">
                      <div class="collections-item__main"
                        @click=${() => {
                          if (!isActive && this.onSelectDiagram) {
                            this.onSelectDiagram(item.id);
                          }
                        }}>
                        ${
                          isRenaming
                            ? html`<input
                              class="collections-rename-input"
                              .value=${this.renameValue}
                              @input=${(e: InputEvent) => {
                                this.renameValue = (e.target as HTMLInputElement).value;
                              }}
                              @keydown=${(e: KeyboardEvent) => {
                                if (e.key === "Enter") {
                                  if (this.renameValue.trim() && this.onRenameDiagram) {
                                    this.onRenameDiagram(item.id, this.renameValue.trim());
                                  }
                                  this.renamingId = null;
                                } else if (e.key === "Escape") {
                                  this.renamingId = null;
                                }
                              }}
                              @blur=${() => {
                                if (this.renameValue.trim() && this.onRenameDiagram) {
                                  this.onRenameDiagram(item.id, this.renameValue.trim());
                                }
                                this.renamingId = null;
                              }}
                              @click=${(e: MouseEvent) => e.stopPropagation()}
                            />`
                            : html`<span class="collections-item__title">${item.title}</span>`
                        }
                        <span class="collections-item__meta">${item.nodeCount} уз · ${fmtDate(item.updatedAt)}</span>
                      </div>
                      <div class="collections-item__actions">
                        <button class="collections-action-btn" title="Переименовать"
                          @click=${(e: MouseEvent) => {
                            e.stopPropagation();
                            this.renamingId = item.id;
                            this.renameValue = item.title;
                            // Focus the input on next tick
                            void this.updateComplete.then(() => {
                              this.renderRoot.querySelector(".collections-rename-input")?.focus();
                            });
                          }}>✏</button>
                        ${
                          this.onDeleteDiagram && list.length > 1
                            ? html`<button class="collections-action-btn collections-action-btn--danger" title="Удалить схему"
                              @click=${(e: MouseEvent) => {
                                e.stopPropagation();
                                if (confirm(`Удалить схему «${item.title}»?`)) {
                                  this.onDeleteDiagram!(item.id);
                                }
                              }}>🗑</button>`
                            : nothing
                        }
                      </div>
                    </div>
                  `;
                })}
              </div>`
        }
      </div>
    `;
  }

  private _renderAiPromptBar() {
    const canGenerate = !!this.onGenerateDiagramFromText;
    const hasNodes = (this.diagram?.nodes?.length ?? 0) > 0;
    const placeholder = canGenerate
      ? hasNodes
        ? "Опишите корректировку схемы…  (напр. «Добавь узел согласования после узла Презентации»)"
        : "Опишите схему словами…  (напр. «Схема продаж: приветствие → выявление потребностей → презентация → закрытие»)"
      : "Выберите агента для генерации схемы через ИИ";

    return html`
      <div class="ai-prompt-bar">
        <span class="ai-prompt-bar__icon">✨</span>
        <textarea
          class="ai-prompt-bar__input"
          rows="1"
          .value=${this.aiPrompt}
          placeholder="${placeholder}"
          ?disabled=${this.aiGenerating || !canGenerate}
          @input=${(e: Event) => {
            this.aiPrompt = (e.target as HTMLTextAreaElement).value;
            this.aiError = null;
          }}
          @keydown=${(e: KeyboardEvent) => {
            // Ctrl/Cmd+Enter submits; plain Enter adds newline
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void this._submitAiPrompt();
            }
          }}
        ></textarea>
        <button class="ai-prompt-bar__btn"
          ?disabled=${this.aiGenerating || !canGenerate || !this.aiPrompt.trim()}
          @click=${() => void this._submitAiPrompt()}>
          ${this.aiGenerating ? "⏳" : hasNodes ? "✏ Изменить" : "✨ Создать"}
        </button>
        ${
          this.aiError
            ? html`<span class="ai-prompt-bar__error" title="${this.aiError}">⚠ ${this.aiError}</span>`
            : nothing
        }
      </div>
    `;
  }

  private async _submitAiPrompt() {
    const prompt = this.aiPrompt.trim();
    if (!prompt || !this.onGenerateDiagramFromText || this.aiGenerating) {
      return;
    }
    this.aiGenerating = true;
    this.aiError = null;
    try {
      const result = await this.onGenerateDiagramFromText(prompt, this.diagram);
      if (result) {
        this.diagram = result;
        this.aiPrompt = "";
        // Fit the view to the new content
        const b = this._bounds();
        if (b.w > 0 && b.h > 0) {
          this.vb = { x: b.x - 40, y: b.y - 40, w: b.w + 80, h: b.h + 80 };
        }
      }
    } catch (err) {
      this.aiError = err instanceof Error ? err.message : String(err);
      setTimeout(() => {
        this.aiError = null;
      }, 6000);
    } finally {
      this.aiGenerating = false;
    }
  }

  private _renderToolbar() {
    const t = this.tool;
    const hasSelection = this.selectedIds.size > 0;

    return html`
      <div class="toolbar">
        <button class="tool-btn ${t === "select" ? "active" : ""}"
          title="Выбор / перемещение (V)" @click=${() => {
            this.tool = "select";
          }}>
          ↖ Выбор
        </button>
        <div class="toolbar-sep"></div>
        <button class="tool-btn tb-start ${t === "start" ? "active" : ""}"
          title="Добавить START-узел — начало сценария" @click=${() => {
            this.tool = "start";
          }}>
          ⬬ Старт
        </button>
        <button class="tool-btn tb-end ${t === "end" ? "active" : ""}"
          title="Добавить END-узел — конец сценария" @click=${() => {
            this.tool = "end";
          }}>
          ⬬ Конец
        </button>
        <button class="tool-btn tb-proc ${t === "process" ? "active" : ""}"
          title="Добавить блок Действие — шаг менеджера" @click=${() => {
            this.tool = "process";
          }}>
          ▭ Действие
        </button>
        <button class="tool-btn tb-dec ${t === "decision" ? "active" : ""}"
          title="Добавить блок Условие — ветвление" @click=${() => {
            this.tool = "decision";
          }}>
          ◇ Условие
        </button>
        <div class="toolbar-sep"></div>
        <button class="tool-btn tb-grp ${t === "group" ? "active" : ""}"
          title="Добавить фазу / блок (кликни на канвас)" @click=${() => {
            this.tool = "group";
          }}>
          ⊡ Фаза
        </button>
        <button class="tool-btn tb-conn ${t === "connect" ? "active" : ""}"
          title="Соединить шаги стрелкой (кликни два узла)" @click=${() => {
            this.tool = "connect";
          }}>
          → Связь
        </button>
        <div class="toolbar-sep"></div>
        ${
          hasSelection
            ? html`
          <button class="tool-btn danger"
            title="Удалить выбранное (Delete)" @click=${() => {
              this._deleteSelected();
            }}>
            ✕ Удалить
          </button>
        `
            : nothing
        }
        <div class="toolbar-sep"></div>
        <button class="tool-btn tb-import"
          title="${
            this.onImportImage
              ? "Загрузить изображение и создать схему с помощью ИИ"
              : "Загрузите агент и откройте схему чтобы использовать импорт"
          }"
          ?disabled=${this.importing || !this.onImportImage}
          @click=${() => {
            void this._triggerImport();
          }}>
          ${this.importing ? "⏳ Анализ…" : "🖼 Из фото"}
        </button>
        <input type="file" accept="image/*" class="import-file-input"
          style="display:none"
          @change=${this._onImportFileChange} />
        ${
          this.importError
            ? html`<span class="import-error" title="${this.importError}">⚠ ${this.importError}</span>`
            : nothing
        }
        <button class="tool-btn tb-export-json"
          title="${this.diagram ? "Экспорт схемы в JSON файл" : "Нет схемы для экспорта"}"
          ?disabled=${!this.diagram || !this.onExportJson}
          @click=${() => {
            if (this.diagram && this.onExportJson) {
              this.onExportJson(this.diagram);
            }
          }}>
          ↓ JSON
        </button>
        <button class="tool-btn tb-import-json"
          title="${this.onImportJson ? "Импорт схемы из JSON файла" : "Выберите агента чтобы импортировать"}"
          ?disabled=${this.importingJson || !this.onImportJson}
          @click=${() => {
            this._triggerImportJson();
          }}>
          ${this.importingJson ? "⏳…" : "↑ JSON"}
        </button>
        <input type="file" accept="application/json,.json" class="import-json-file-input"
          style="display:none"
          @change=${this._onImportJsonChange} />
        ${
          this.importJsonError
            ? html`<span class="import-error" title="${this.importJsonError}">⚠ ${this.importJsonError}</span>`
            : nothing
        }
        <button class="tool-btn tb-knowledge ${this.kbPanelOpen ? "active" : ""}"
          title="${
            this.onLoadKnowledgeBase
              ? "Открыть базу знаний (обучение ↔ схема)"
              : "Выберите агента и откройте схему чтобы использовать базу знаний"
          }"
          ?disabled=${!this.onLoadKnowledgeBase}
          @click=${async () => {
            if (!this.kbPanelOpen && this.onLoadKnowledgeBase) {
              await this.onLoadKnowledgeBase();
            }
            this.kbPanelOpen = !this.kbPanelOpen;
          }}>
          📚 База
        </button>
        <button class="tool-btn tb-collections ${this.collectionsOpen ? "active" : ""}"
          title="Набор схем — сохранённые версии"
          @click=${() => {
            this.collectionsOpen = !this.collectionsOpen;
          }}>
          🗂 Набор
        </button>
        <span class="save-badge ${this.saveStatus}">
          ${this.saveStatus === "saving" ? "⏳ Сохранение…" : this.saveStatus === "saved" ? "✓ Сохранено" : ""}
        </span>
      </div>
    `;
  }

  private _onCanvasDblClick = (e: MouseEvent) => {
    // Double-click on canvas background: no action
    const target = e.target as Element;
    if (target.classList.contains("canvas-bg") || target.tagName === "svg") {
      // noop
    }
  };

  private _renderGroups(d: FlowDiagram) {
    return svg`
      ${d.groups.map((g) => {
        const c = GROUP_COLORS[g.color] ?? GROUP_COLORS.blue;
        const isSelected = this.selectedIds.has(g.id);
        const isEditing = this.editingId === g.id;
        return svg`
          <g class="group-el"
            @pointerdown=${(e: PointerEvent) => {
              this._onGroupPointerDown(e, g);
            }}
            @dblclick=${(e: MouseEvent) => {
              this._onGroupDblClick(e, g);
            }}>
            <!-- filled rect -->
            <rect
              x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="12"
              fill="${c.bg}"
              stroke="${isSelected ? "#ff5c5c" : c.stroke}"
              stroke-width="${isSelected ? 2 : 1.5}"
              style="cursor:${isSelected ? "text" : "move"};"
            />
            <!-- editing dashed outline -->
            ${
              isEditing
                ? svg`<rect
              x="${g.x - 3}" y="${g.y - 3}" width="${g.w + 6}" height="${g.h + 6}" rx="14"
              fill="none" stroke="${c.stroke}" stroke-width="2" stroke-dasharray="8 4"
              class="editing-outline" style="pointer-events:none;" opacity="0.85" />`
                : nothing
            }
            <!-- top-left label chip (hide text while editing — input overlay shown instead) -->
            <rect x="${g.x + 12}" y="${g.y - 11}" width="${g.label.length * 7.5 + 16}" height="20"
              rx="5" fill="${c.stroke}" opacity="0.92"
              style="pointer-events:none;"
            />
            ${
              isEditing
                ? nothing
                : svg`<text
              x="${g.x + 20}" y="${g.y + 3}"
              font-size="11" font-weight="700"
              fill="#fff"
              style="pointer-events:none; user-select:none; font-family:inherit;"
            >${g.label}</text>`
            }
            <!-- 8 resize handles — visible only when selected -->
            ${
              isSelected
                ? RESIZE_HANDLES.map(
                    (hd) => svg`
              <rect
                x="${hd.cx(g) - 5}" y="${hd.cy(g) - 5}" width="10" height="10" rx="2"
                fill="#1a1d25" stroke="#ff5c5c" stroke-width="1.5"
                style="cursor:${hd.cursor};"
                @pointerdown=${(e: PointerEvent) => {
                  this._onResizeHandlePointerDown(e, g, hd.h);
                }}
              />
            `,
                  )
                : nothing
            }
          </g>
        `;
      })}
    `;
  }

  private _renderEdges(d: FlowDiagram) {
    return svg`
      ${d.edges.map((edge) => {
        const src = d.nodes.find((n) => n.id === edge.sourceId);
        const tgt = d.nodes.find((n) => n.id === edge.targetId);
        if (!src || !tgt) {
          return nothing;
        }
        const tx = nodeCenterX(tgt);
        const ty = nodeCenterY(tgt);
        const ep = closestEdgePoint(src, tx, ty);
        const sp = closestEdgePoint(tgt, nodeCenterX(src), nodeCenterY(src));
        // Cubic bezier control points
        const dy = sp.y - ep.y;
        const cpOffset = Math.min(Math.abs(dy) * 0.4 + 50, 140);
        const c1x = ep.x;
        const c1y = ep.y + cpOffset;
        const c2x = sp.x;
        const c2y = sp.y - cpOffset;
        const isSelected = this.selectedIds.has(edge.id);
        const isEditingEdge = this.editingId === edge.id;
        const mid = { x: (ep.x + sp.x) / 2, y: (ep.y + sp.y) / 2 };
        const lineColor = isSelected ? "var(--accent,#ff5c5c)" : "#374151";
        const lineW = isSelected ? 2.5 : 1.8;
        return svg`
          <g class="edge-el">
            <!-- wider invisible hit area -->
            <path
              d="M${ep.x},${ep.y} C${c1x},${c1y} ${c2x},${c2y} ${sp.x},${sp.y}"
              fill="none" stroke="transparent" stroke-width="16"
              style="cursor:pointer;"
              @click=${(e: MouseEvent) => {
                e.stopPropagation();
                this.selectedIds = new Set([edge.id]);
              }}
              @dblclick=${(e: MouseEvent) => {
                e.stopPropagation();
                // Edit label
                this.editingId = edge.id;
                this.editingText = edge.label ?? "";
              }}
            />
            <path
              d="M${ep.x},${ep.y} C${c1x},${c1y} ${c2x},${c2y} ${sp.x},${sp.y}"
              fill="none"
              stroke="${lineColor}"
              stroke-width="${lineW}"
              marker-end="url(#${isSelected ? "arrow-sel" : "arrow"})"
              style="pointer-events:none;"
            />
            ${
              edge.label && !isEditingEdge
                ? svg`
              <rect x="${mid.x - edge.label.length * 3.8 - 6}" y="${mid.y - 17}" width="${edge.label.length * 7.6 + 12}" height="18"
                rx="4" fill="#1a1d25" stroke="#374151" stroke-width="1"
                style="pointer-events:none;" />
              <text x="${mid.x}" y="${mid.y - 5}"
                text-anchor="middle" font-size="10" font-weight="700" fill="#9ca3af"
                style="pointer-events:none; user-select:none; font-family:inherit; letter-spacing:0.04em;"
              >${edge.label}</text>
            `
                : nothing
            }
            ${
              isSelected
                ? svg`
              <circle cx="${mid.x}" cy="${mid.y + 14}" r="9"
                fill="#1a1d25" stroke="var(--accent,#ff5c5c)" stroke-width="1.5"
                style="cursor:pointer;"
                @click=${(ev: MouseEvent) => {
                  ev.stopPropagation();
                  this._deleteEdge(edge.id);
                }}
              />
              <text x="${mid.x}" y="${mid.y + 18}" text-anchor="middle" font-size="10"
                fill="var(--accent,#ff5c5c)"
                style="pointer-events:none; user-select:none;">✕</text>
            `
                : nothing
            }
          </g>
        `;
      })}
    `;
  }

  /**
   * Build a map from nodeId → count of active chats at that node.
   * "__done__" values are attributed to the END node of the diagram.
   */
  private _buildNodeCounts(d: FlowDiagram): Map<string, { count: number; hasDone: boolean }> {
    const endNode = d.nodes.find((n) => n.type === "end");
    const counts = new Map<string, { count: number; hasDone: boolean }>();
    for (const nodeId of Object.values(this.chatStates)) {
      if (nodeId === "__done__") {
        // Attribute to the END node with a special "done" marker
        if (endNode) {
          const cur = counts.get(endNode.id) ?? { count: 0, hasDone: false };
          counts.set(endNode.id, { count: cur.count + 1, hasDone: true });
        }
      } else {
        const cur = counts.get(nodeId) ?? { count: 0, hasDone: false };
        counts.set(nodeId, { count: cur.count + 1, hasDone: cur.hasDone });
      }
    }
    return counts;
  }

  private _renderNodes(d: FlowDiagram) {
    const glowFilterMap: Record<DiagramNodeType, string> = {
      start: "glow-blue",
      end: "glow-purple",
      process: "glow-teal",
      decision: "glow-amber",
    };
    const nodeCounts = _hasAnyStates(this.chatStates) ? this._buildNodeCounts(d) : null;
    return svg`
      ${d.nodes.map((node) => {
        const isSelected = this.selectedIds.has(node.id);
        const isEditing = this.editingId === node.id;
        const c = NODE_FILLS[node.type] ?? NODE_FILLS.process;
        const hw = nodeWidth(node.type) / 2;
        const hh = nodeHeight(node.type) / 2;
        const cx = node.x + hw;
        const cy = node.y + hh;
        // Determine active chat counts for this node
        const nodeActivity = nodeCounts?.get(node.id) ?? null;
        const activeCount = nodeActivity?.count ?? 0;
        const hasDone = nodeActivity?.hasDone ?? false;
        const isActive = activeCount > 0;
        // Active nodes get a pulsing glow in addition to any selection glow
        const glowFilter = isSelected || isEditing || isActive ? glowFilterMap[node.type] : "";
        // Cursor hint: "text" when selected (hinting dblclick to edit), otherwise "move"
        const cursor = this.tool === "connect" ? "crosshair" : isSelected ? "text" : "move";

        return svg`
          <g
            transform="translate(${cx}, ${cy})"
            style="cursor:${cursor};"
            filter="${glowFilter ? `url(#${glowFilter})` : ""}"
            @pointerdown=${(e: PointerEvent) => {
              this._onNodePointerDown(e, node);
            }}
            @dblclick=${(e: MouseEvent) => {
              this._onNodeDblClick(e, node);
            }}
          >
            ${
              node.type === "start" || node.type === "end"
                ? svg`
              ${
                isSelected && !isEditing
                  ? svg`<ellipse cx="0" cy="0" rx="${OVAL_RX + 5}" ry="${OVAL_RY + 5}"
                fill="none" stroke="${c.glow}" stroke-width="3" opacity="0.7" />`
                  : nothing
              }
              ${
                isEditing
                  ? svg`<ellipse cx="0" cy="0" rx="${OVAL_RX + 7}" ry="${OVAL_RY + 7}"
                fill="none" stroke="${c.stroke}" stroke-width="2" stroke-dasharray="8 4"
                class="editing-outline" opacity="0.9" />`
                  : nothing
              }
              <ellipse cx="0" cy="0" rx="${OVAL_RX}" ry="${OVAL_RY}"
                fill="${c.fill}" stroke="${c.stroke}" stroke-width="${isSelected || isEditing ? 2.5 : 1.5}" />
            `
                : node.type === "decision"
                  ? svg`
              ${
                isSelected && !isEditing
                  ? svg`<polygon
                points="0,${-(DIAMOND_RY + 6)} ${DIAMOND_RX + 6},0 0,${DIAMOND_RY + 6} ${-(DIAMOND_RX + 6)},0"
                fill="none" stroke="${c.glow}" stroke-width="3" opacity="0.7" />`
                  : nothing
              }
              ${
                isEditing
                  ? svg`<polygon
                points="0,${-(DIAMOND_RY + 8)} ${DIAMOND_RX + 8},0 0,${DIAMOND_RY + 8} ${-(DIAMOND_RX + 8)},0"
                fill="none" stroke="${c.stroke}" stroke-width="2" stroke-dasharray="8 4"
                class="editing-outline" opacity="0.9" />`
                  : nothing
              }
              <polygon points="0,${-DIAMOND_RY} ${DIAMOND_RX},0 0,${DIAMOND_RY} ${-DIAMOND_RX},0"
                fill="${c.fill}" stroke="${c.stroke}" stroke-width="${isSelected || isEditing ? 2.5 : 1.5}" />
            `
                  : svg`
              ${
                isSelected && !isEditing
                  ? svg`<rect x="${-hw - 5}" y="${-hh - 5}" width="${NODE_W + 10}" height="${NODE_H + 10}" rx="13"
                fill="none" stroke="${c.glow}" stroke-width="3" opacity="0.7" />`
                  : nothing
              }
              ${
                isEditing
                  ? svg`<rect x="${-hw - 7}" y="${-hh - 7}" width="${NODE_W + 14}" height="${NODE_H + 14}" rx="14"
                fill="none" stroke="${c.stroke}" stroke-width="2" stroke-dasharray="8 4"
                class="editing-outline" opacity="0.9" />`
                  : nothing
              }
              <rect x="${-hw}" y="${-hh}" width="${NODE_W}" height="${NODE_H}" rx="9"
                fill="${c.fill}" stroke="${c.stroke}" stroke-width="${isSelected || isEditing ? 2.5 : 1.5}" />
            `
            }
            <!-- Node text — hide while editing (input overlay shown instead) -->
            ${
              isEditing
                ? nothing
                : svg`
              <text text-anchor="middle" dominant-baseline="middle"
                font-size="12" font-weight="700" fill="${c.text}"
                style="pointer-events:none; user-select:none; font-family:inherit; letter-spacing:0.02em;"
                x="0" y="0"
              >${node.text}</text>
            `
            }
            <!-- Active chat badge — shown when chats are tracked at this node -->
            ${
              isActive
                ? svg`
              <!-- Pulse ring — animated when active chats are present -->
              ${
                node.type === "start" || node.type === "end"
                  ? svg`<ellipse cx="0" cy="0" rx="${OVAL_RX + 8}" ry="${OVAL_RY + 8}"
                      fill="none" stroke="${hasDone ? "#22c55e" : "#f97316"}"
                      stroke-width="2" opacity="0.5" class="node-active-pulse" />`
                  : node.type === "decision"
                    ? svg`<polygon
                        points="0,${-(DIAMOND_RY + 9)} ${DIAMOND_RX + 9},0 0,${DIAMOND_RY + 9} ${-(DIAMOND_RX + 9)},0"
                        fill="none" stroke="${hasDone ? "#22c55e" : "#f97316"}"
                        stroke-width="2" opacity="0.5" class="node-active-pulse" />`
                    : svg`<rect x="${-hw - 9}" y="${-hh - 9}" width="${NODE_W + 18}" height="${NODE_H + 18}" rx="14"
                        fill="none" stroke="${hasDone ? "#22c55e" : "#f97316"}"
                        stroke-width="2" opacity="0.5" class="node-active-pulse" />`
              }
              <!-- Count badge pill (top-right corner) -->
              <g transform="translate(${hw - 2}, ${-hh + 2})" style="pointer-events:none;">
                <rect x="-16" y="-9" width="32" height="18" rx="9"
                  fill="${hasDone ? "#166534" : "#7c2d12"}"
                  stroke="${hasDone ? "#22c55e" : "#f97316"}"
                  stroke-width="1.5" opacity="0.95" />
                <text text-anchor="middle" dominant-baseline="middle"
                  font-size="10" font-weight="800"
                  fill="${hasDone ? "#86efac" : "#fed7aa"}"
                  style="user-select:none; font-family:inherit;"
                  x="0" y="0"
                >${hasDone ? `✓${activeCount}` : `●${activeCount}`}</text>
              </g>
            `
                : nothing
            }
          </g>
        `;
      })}
    `;
  }

  private _renderConnecting() {
    if (!this.connecting || !this.diagram) {
      return nothing;
    }
    const src = this.diagram.nodes.find((n) => n.id === this.connecting!.sourceId);
    if (!src) {
      return nothing;
    }
    const { curX, curY } = this.connecting;
    const sp = closestEdgePoint(src, curX, curY);
    return svg`
      <line x1="${sp.x}" y1="${sp.y}" x2="${curX}" y2="${curY}"
        stroke="var(--accent,#ff5c5c)" stroke-width="2" stroke-dasharray="6 4" opacity="0.8"
        marker-end="url(#arrow-sel)"
        style="pointer-events:none;"
      />
    `;
  }

  private _renderScrollbars() {
    const b = this._bounds();
    const vb = this.vb;
    const MIN_THUMB = 0.08; // at least 8% of track so it's always grabbable

    // Content-to-viewport ratios; clamped to [MIN_THUMB, 1]
    this._thumbWFrac = Math.min(1, Math.max(MIN_THUMB, vb.w / b.w));
    this._thumbHFrac = Math.min(1, Math.max(MIN_THUMB, vb.h / b.h));

    const showH = this._thumbWFrac < 1;
    const showV = this._thumbHFrac < 1;

    if (!showH && !showV) {
      return nothing;
    }

    // Scroll progress: how far into the content the viewport sits [0..1]
    const xFrac = b.w > vb.w ? Math.max(0, Math.min(1, (vb.x - b.x) / (b.w - vb.w))) : 0;
    const yFrac = b.h > vb.h ? Math.max(0, Math.min(1, (vb.y - b.y) / (b.h - vb.h))) : 0;

    // Thumb left/top as % of track, accounting for thumb width so it stays inside track
    const thumbXLeft = xFrac * (1 - this._thumbWFrac) * 100;
    const thumbYTop = yFrac * (1 - this._thumbHFrac) * 100;

    return html`
      ${
        showH && showV
          ? html`
              <div class="scrollbar-corner"></div>
            `
          : nothing
      }
      ${
        showH
          ? html`
        <div class="scrollbar-h"
          @pointerdown=${(e: PointerEvent) => {
            this._onScrollbarPointerDown(e, "h");
          }}>
          <div class="scrollbar-thumb-h" style="left:${thumbXLeft}%;width:${this._thumbWFrac * 100}%"></div>
        </div>
      `
          : nothing
      }
      ${
        showV
          ? html`
        <div class="scrollbar-v"
          @pointerdown=${(e: PointerEvent) => {
            this._onScrollbarPointerDown(e, "v");
          }}>
          <div class="scrollbar-thumb-v" style="top:${thumbYTop}%;height:${this._thumbHFrac * 100}%"></div>
        </div>
      `
          : nothing
      }
    `;
  }

  private _renderEditOverlay(d: FlowDiagram | null) {
    if (!this.editingId || !d) {
      return nothing;
    }
    const node = d.nodes.find((n) => n.id === this.editingId);
    const group = d.groups.find((g) => g.id === this.editingId);
    const edge = d.edges.find((e) => e.id === this.editingId);

    let svgX = 0;
    let svgY = 0;
    // CSS vars for border/glow colour matching the element type
    let editColor = "#3b82f6";
    let editGlow = "rgba(59,130,246,0.3)";
    // Input width in px (in SVG units, convert via scale below)
    let inputW = NODE_W;

    if (node) {
      svgX = nodeCenterX(node);
      svgY = nodeCenterY(node);
      const c = NODE_FILLS[node.type];
      editColor = c.stroke;
      editGlow = c.glow;
      inputW = nodeWidth(node.type);
    } else if (group) {
      svgX = group.x + group.w / 2;
      svgY = group.y + 14; // sit just inside the top edge
      const gc = GROUP_COLORS[group.color] ?? GROUP_COLORS.blue;
      editColor = gc.stroke;
      editGlow = `${gc.stroke}55`;
      inputW = Math.min(group.w - 40, 360);
    } else if (edge) {
      const src = d.nodes.find((n) => n.id === edge.sourceId);
      const tgt = d.nodes.find((n) => n.id === edge.targetId);
      if (src && tgt) {
        svgX = (nodeCenterX(src) + nodeCenterX(tgt)) / 2;
        svgY = (nodeCenterY(src) + nodeCenterY(tgt)) / 2;
        inputW = 140;
      } else {
        return nothing;
      }
    } else {
      return nothing;
    }

    const client = this._svgToClient(svgX, svgY);
    const wrap = this.shadowRoot?.querySelector(".canvas-wrap");
    const wrapRect = wrap?.getBoundingClientRect();
    const lx = wrapRect ? client.x - wrapRect.left : client.x;
    const ly = wrapRect ? client.y - wrapRect.top : client.y;

    // Scale SVG units → client px so the input visually fits inside the shape
    const svgEl = this._svgEl();
    const svgRect = svgEl?.getBoundingClientRect();
    const scale = svgRect ? svgRect.width / this.vb.w : 1;
    const inputPx = Math.max(100, Math.min(340, inputW * scale));

    return html`
      <div class="edit-overlay">
        <div class="edit-input-wrap" style="left:${lx}px; top:${ly}px;">
          <input
            class="edit-input"
            style="
              width: ${inputPx}px;
              --edit-color: ${editColor};
              --edit-glow: ${editGlow};
            "
            .value=${this.editingText}
            @input=${(e: InputEvent) => {
              this.editingText = (e.target as HTMLInputElement).value;
            }}
            @keydown=${this._onEditKeyDown}
            @blur=${this._commitEdit}
          />
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tg-diagram-editor": TgDiagramEditor;
  }
}
