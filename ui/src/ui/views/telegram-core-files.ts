import { html, nothing } from "lit";
import type { TelegramCoreFile } from "../controllers/telegram-core-files.ts";
import { formatRelativeTimestamp } from "../format.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TelegramCoreFilesProps = {
  agentId: string;
  agentName: string;
  files: TelegramCoreFile[];
  selectedFile: string | null;
  content: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  workspacePath?: string;
  onSelectFile: (filename: string) => void;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onRefresh: () => void;
};

// ─── View ─────────────────────────────────────────────────────────────────────

export function renderTelegramCoreFiles(props: TelegramCoreFilesProps) {
  const {
    agentName: _agentName,
    files,
    selectedFile,
    content,
    loading,
    saving,
    error,
    workspacePath,
    onSelectFile,
    onContentChange,
    onSave,
    onRefresh,
  } = props;

  return html`
    <section class="card">
      <div class="card-header-row" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <div>
          <div class="card-title">Core Files</div>
          <div class="card-sub">Bootstrap persona, identity, and tool guidance.</div>
        </div>
        <button class="btn btn-sm" @click=${onRefresh} ?disabled=${loading}>
          ${loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      ${
        workspacePath
          ? html`<div class="mono" style="font-size:11px;color:var(--color-muted,#888);margin-bottom:12px;word-break:break-all;">${workspacePath}</div>`
          : nothing
      }

      ${
        error
          ? html`<div class="callout danger" style="margin-bottom:12px;">${error}</div>`
          : nothing
      }

      ${
        loading && (!files || files.length === 0)
          ? html`
              <div style="color: var(--color-muted, #888); padding: 16px 0">Loading…</div>
            `
          : html`
          <div style="display:grid;grid-template-columns:220px 1fr;gap:16px;min-height:320px;">

            <!-- Left column: file list -->
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${files.map((file) => renderFileCard(file, selectedFile, onSelectFile))}
            </div>

            <!-- Right column: editor -->
            <div style="display:flex;flex-direction:column;gap:8px;">
              ${
                selectedFile
                  ? html`
                  <div style="font-size:12px;font-weight:600;color:var(--color-text);">${selectedFile}</div>
                  <textarea
                    style="flex:1;min-height:260px;font-family:monospace;font-size:12px;background:var(--color-card-bg,#1a1a1a);color:var(--color-text);border:1px solid var(--color-border,#333);border-radius:6px;padding:10px;resize:vertical;"
                    .value=${content ?? ""}
                    @input=${(e: Event) => onContentChange((e.target as HTMLTextAreaElement).value)}
                  ></textarea>
                  <div style="display:flex;justify-content:flex-end;">
                    <button
                      class="btn btn-primary"
                      @click=${onSave}
                      ?disabled=${saving}
                    >
                      ${saving ? "Saving…" : "Save"}
                    </button>
                  </div>
                `
                  : html`
                      <div style="color: var(--color-muted, #888); padding: 24px 0; text-align: center">
                        Select a file to edit
                      </div>
                    `
              }
            </div>

          </div>
        `
      }
    </section>
  `;
}

function renderFileCard(
  file: TelegramCoreFile,
  selectedFile: string | null,
  onSelect: (name: string) => void,
) {
  const isSelected = file.name === selectedFile;
  return html`
    <div
      class="file-card${isSelected ? " selected" : ""}"
      style="cursor:pointer;padding:8px 10px;border-radius:6px;border:1px solid ${isSelected ? "var(--color-primary,#4f8ef7)" : "var(--color-border,#333)"};background:${isSelected ? "rgba(79,142,247,0.08)" : "var(--color-card-bg,#1a1a1a)"};"
      @click=${() => onSelect(file.name)}
    >
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
        <span style="font-weight:600;font-size:12px;">${file.name}</span>
        ${
          file.missing
            ? html`
                <span
                  style="font-size: 10px; padding: 1px 5px; border-radius: 3px; background: #5c1a1a; color: #f88"
                  >MISSING</span
                >
              `
            : nothing
        }
      </div>
      ${
        !file.missing
          ? html`
          <div style="font-size:10px;color:var(--color-muted,#888);margin-top:3px;">
            ${file.sizeBytes !== undefined ? `${file.sizeBytes} B` : ""}
            ${file.updatedAt ? ` · ${formatRelativeTimestamp(new Date(file.updatedAt).getTime())}` : ""}
          </div>
        `
          : nothing
      }
    </div>
  `;
}
