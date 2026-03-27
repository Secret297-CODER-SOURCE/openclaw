import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";

/**
 * Tracks which message-list elements have already been scrolled to bottom on
 * initial mount. Re-renders (e.g. from translation state updates) must NOT
 * scroll the user back down — only the first mount should.
 */
const _wcInitialScrolled = new WeakSet<Element>();

/** Attach drag-to-scroll behaviour to a horizontal scroll container.
 *  Only activates drag when pointer-down starts on the container itself (not on a child button).
 *  Uses a generous movement threshold so trackpad micro-jitter doesn't suppress clicks.
 */
function initDragScroll(el: Element | undefined) {
  if (!el || (el as HTMLElement).dataset["dragScroll"]) {
    return;
  }
  const node = el as HTMLElement;
  node.dataset["dragScroll"] = "1";
  let isDown = false;
  let didDrag = false;
  let startX = 0;
  let scrollLeft = 0;
  // 12px threshold prevents trackpad micro-jitter from being treated as a drag.
  const THRESHOLD = 12;

  node.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button !== 0) {
      return;
    }
    // If the click originated on a button/anchor, let it pass through as a normal click.
    const target = e.target as HTMLElement | null;
    if (target && target.closest("button, a")) {
      return;
    }
    isDown = true;
    didDrag = false;
    startX = e.pageX;
    scrollLeft = node.scrollLeft;
    node.style.cursor = "grabbing";
    e.preventDefault(); // prevent text selection during drag
  });

  window.addEventListener("mouseup", () => {
    if (!isDown) {
      return;
    }
    isDown = false;
    node.style.cursor = "";
    node.classList.remove("is-dragging");
  });

  window.addEventListener("mousemove", (e: MouseEvent) => {
    if (!isDown) {
      return;
    }
    const dx = e.pageX - startX;
    if (!didDrag && Math.abs(dx) < THRESHOLD) {
      return;
    }
    didDrag = true;
    node.classList.add("is-dragging");
    node.scrollLeft = scrollLeft - dx;
  });

  // Belt-and-suspenders: suppress residual click if we actually scrolled
  node.addEventListener(
    "click",
    (e: MouseEvent) => {
      if (didDrag) {
        e.stopPropagation();
        e.preventDefault();
        didDrag = false; // reset so next click isn't suppressed
      }
    },
    true,
  );
}
import type { TelegramAgentRecord } from "../controllers/telegram.ts";
import type {
  TelegramDialog,
  TelegramDialogFolder,
  TelegramWebMessage,
} from "../controllers/telegram.ts";

export type WebchatProps = {
  agent: TelegramAgentRecord;
  dialogs: TelegramDialog[];
  dialogsLoading: boolean;
  dialogsError: string | null;
  selectedDialogId: string | null;
  messages: TelegramWebMessage[];
  messagesLoading: boolean;
  input: string;
  sending: boolean;
  searchQuery: string;
  folders: TelegramDialogFolder[];
  selectedFolderId: number | null;
  translateEnabled: boolean;
  translations: Record<string, string>;
  showOriginals: Record<string, boolean>;
  onRefreshDialogs: () => void;
  onSelectDialog: (id: string, name: string) => void;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onSearchChange: (q: string) => void;
  onFolderSelect: (folderId: number | null) => void;
  onTranslateToggle: () => void;
  onTranslateText: (text: string) => void;
  onToggleOriginal: (key: string) => void;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase() || "?";
}

function avatarColor(name: string): string {
  // Deterministic color based on name
  const colors = [
    "#2eadab",
    "#4a90e2",
    "#7b68ee",
    "#e5793c",
    "#3dab61",
    "#c85252",
    "#e0875a",
    "#5aace0",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
  }
  return colors[hash % colors.length];
}

function formatTime(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const d = new Date(iso);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function formatMsgTime(iso: string | null): string {
  if (!iso) {
    return "";
  }
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ─── Dialog list item ──────────────────────────────────────────────────────────

function renderDialogItem(dialog: TelegramDialog, isSelected: boolean, onSelect: () => void) {
  const color = avatarColor(dialog.name);
  const preview = dialog.lastMessageOut ? `→ ${dialog.lastMessage}` : dialog.lastMessage;

  return html`
    <button
      type="button"
      class="tg-wc-dialog ${isSelected ? "tg-wc-dialog--active" : ""}"
      @click=${onSelect}
    >
      <div class="tg-wc-avatar" style="background:${color}">
        ${dialog.type === "group" ? "👥" : dialog.type === "channel" ? "📢" : initials(dialog.name)}
      </div>
      <div class="tg-wc-dialog-info">
        <div class="tg-wc-dialog-name">${dialog.name}</div>
        <div class="tg-wc-dialog-last">${preview || "—"}</div>
      </div>
      <div class="tg-wc-dialog-meta">
        <div class="tg-wc-dialog-time">${formatTime(dialog.lastMessageDate)}</div>
        ${
          dialog.unreadCount > 0
            ? html`<div class="tg-wc-unread">${dialog.unreadCount > 99 ? "99+" : dialog.unreadCount}</div>`
            : nothing
        }
      </div>
    </button>
  `;
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function renderMessage(
  msg: TelegramWebMessage,
  translateEnabled: boolean,
  translations: Record<string, string>,
  showOriginals: Record<string, boolean>,
  onTranslateText: (text: string) => void,
  onToggleOriginal: (key: string) => void,
) {
  const cls = msg.out ? "tg-wc-msg tg-wc-msg--out" : "tg-wc-msg";
  const rawText = msg.text || "";

  // Trigger translation if needed
  if (translateEnabled && rawText && !translations[rawText]) {
    onTranslateText(rawText);
  }

  const translated = translateEnabled ? (translations[rawText] ?? null) : null;
  const showOrig = showOriginals[rawText] ?? false;
  const displayText = translated && !showOrig ? translated : rawText;

  return html`
    <div class=${cls}>
      <div class="tg-wc-bubble">
        ${displayText || (msg.hasMedia ? html`<em class="tg-wc-media-label">${msg.mediaType ?? "медиа"}</em>` : "—")}
      </div>
      ${
        translateEnabled && rawText
          ? translated
            ? html`
                <button
                  type="button"
                  class="tg-translate-orig-btn"
                  @click=${() => onToggleOriginal(rawText)}
                >${showOrig ? "↩ перевод" : "🔍 оригинал"}</button>
              `
            : html`
                <span class="tg-translate-pending">Перевод…</span>
              `
          : nothing
      }
      <div class="tg-wc-msg-time">${formatMsgTime(msg.date)}</div>
    </div>
  `;
}

// ─── Webchat panel ────────────────────────────────────────────────────────────

export function renderWebchat(props: WebchatProps) {
  const {
    agent,
    dialogs,
    selectedDialogId,
    messages,
    input,
    sending,
    searchQuery,
    folders,
    selectedFolderId,
    translateEnabled,
    translations,
    showOriginals,
  } = props;

  const filteredDialogs = searchQuery.trim()
    ? dialogs.filter((d) => d.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : dialogs;

  const selectedDialog = dialogs.find((d) => d.id === selectedDialogId) ?? null;

  // Handle Enter key (Shift+Enter for newline)
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      props.onSend();
    }
  };

  return html`
    <section class="card" style="padding: 0; overflow: hidden;">
      <div class="tg-wc-shell">

        <!-- ── Left: dialog list ────────────────────────────────────── -->
        <div class="tg-wc-list">
          <div class="tg-wc-list-header">
            <div class="tg-wc-list-title">Чаты</div>
            <button
              class="btn btn--sm"
              ?disabled=${props.dialogsLoading}
              @click=${props.onRefreshDialogs}
              title="Обновить список чатов"
            >
              ${props.dialogsLoading ? "…" : "↻"}
            </button>
          </div>

          ${
            folders.length > 0
              ? html`
                  <div class="tg-wc-folders" ${ref(initDragScroll)}>
                    <button
                      type="button"
                      class="tg-wc-folder ${selectedFolderId === null ? "tg-wc-folder--active" : ""}"
                      @click=${() => props.onFolderSelect(null)}
                    >Все</button>
                    ${folders.map(
                      (f) => html`
                        <button
                          type="button"
                          class="tg-wc-folder ${selectedFolderId === f.id ? "tg-wc-folder--active" : ""}"
                          @click=${() => props.onFolderSelect(f.id)}
                        >${f.emoji ? `${f.emoji} ` : ""}${f.title}</button>
                      `,
                    )}
                  </div>
                `
              : nothing
          }

          <div class="tg-wc-search-bar">
            <input
              type="text"
              class="tg-wc-search"
              placeholder="Поиск…"
              .value=${searchQuery}
              @input=${(e: InputEvent) => props.onSearchChange((e.target as HTMLInputElement).value)}
            />
          </div>

          ${
            props.dialogsError
              ? html`<div class="callout danger" style="margin: 8px; font-size: 0.8em;">${props.dialogsError}</div>`
              : nothing
          }

          <div class="tg-wc-dialogs">
            ${
              props.dialogsLoading && filteredDialogs.length === 0
                ? html`
                    <div class="tg-wc-empty-hint">Загрузка чатов…</div>
                  `
                : filteredDialogs.length === 0
                  ? html`
                      <div class="tg-wc-empty-hint">
                        ${
                          agent.status !== "running"
                            ? "Запустите агента чтобы загрузить чаты"
                            : "Нет чатов. Нажмите ↻ для обновления."
                        }
                      </div>
                    `
                  : filteredDialogs.map((d) =>
                      renderDialogItem(d, d.id === selectedDialogId, () =>
                        props.onSelectDialog(d.id, d.name),
                      ),
                    )
            }
          </div>
        </div>

        <!-- ── Right: conversation ──────────────────────────────────── -->
        <div class="tg-wc-main">
          ${
            !selectedDialog
              ? html`
                  <div class="tg-wc-empty">
                    <div style="font-size: 2.5rem; opacity: 0.3">💬</div>
                    <div style="opacity: 0.5; font-size: 0.9rem">Выберите чат</div>
                  </div>
                `
              : html`
                  <!-- Header -->
                  <div class="tg-wc-header">
                    <div class="tg-wc-avatar tg-wc-avatar--sm" style="background:${avatarColor(selectedDialog.name)}">
                      ${
                        selectedDialog.type === "group"
                          ? "👥"
                          : selectedDialog.type === "channel"
                            ? "📢"
                            : initials(selectedDialog.name)
                      }
                    </div>
                    <div style="flex:1;">
                      <div class="tg-wc-header-name">${selectedDialog.name}</div>
                      ${
                        selectedDialog.username
                          ? html`<div class="tg-wc-header-sub">@${selectedDialog.username}</div>`
                          : nothing
                      }
                    </div>
                    <button
                      type="button"
                      class="tg-translate-btn ${translateEnabled ? "tg-translate-btn--on" : ""}"
                      @click=${props.onTranslateToggle}
                      title="Режим перевода"
                    >🌐 ${translateEnabled ? "Перевод вкл" : "Перевод"}</button>
                  </div>

                  <!-- Messages — scrolled to bottom only on initial mount -->
                  <div class="tg-wc-messages" id="tg-wc-msg-list"
                    ${ref((el: Element | undefined) => {
                      if (el && !_wcInitialScrolled.has(el)) {
                        _wcInitialScrolled.add(el);
                        requestAnimationFrame(() => {
                          (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
                        });
                      }
                    })}>
                    ${
                      props.messagesLoading && messages.length === 0
                        ? html`
                            <div class="tg-wc-empty-hint">Загрузка…</div>
                          `
                        : messages.length === 0
                          ? html`
                              <div class="tg-wc-empty-hint">Нет сообщений</div>
                            `
                          : messages.map((m) =>
                              renderMessage(
                                m,
                                translateEnabled,
                                translations,
                                showOriginals,
                                props.onTranslateText,
                                props.onToggleOriginal,
                              ),
                            )
                    }
                  </div>

                  <!-- Input bar -->
                  <div class="tg-wc-input-bar">
                    <textarea
                      class="tg-wc-input"
                      rows="1"
                      placeholder="Введите сообщение…"
                      .value=${input}
                      ?disabled=${sending}
                      @input=${(e: InputEvent) => {
                        const el = e.target as HTMLTextAreaElement;
                        props.onInputChange(el.value);
                        // Auto-resize
                        el.style.height = "auto";
                        el.style.height = Math.min(el.scrollHeight, 120) + "px";
                      }}
                      @keydown=${onKeydown}
                    ></textarea>
                    <button
                      class="tg-wc-send-btn"
                      ?disabled=${sending || !input.trim()}
                      @click=${props.onSend}
                      title="Отправить (Enter)"
                    >
                      ${sending ? "…" : "➤"}
                    </button>
                  </div>
                `
          }
        </div>
      </div>
    </section>
  `;
}
