import { html, nothing } from "lit";
import type { TelegramAgentRecord } from "../controllers/telegram.ts";
import type { AgentMissionRecord, AgentCommMessageRecord } from "../controllers/telegram.ts";
import { formatRelativeTimestamp } from "../format.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TelegramMissionsForm = {
  masterAgentId: string;
  title: string;
  goal: string;
  systemPrompt: string;
  participantIds: string[];
};

export type TelegramSendForm = {
  fromAgentId: string;
  toAgentId: string;
  content: string;
};

export type TelegramMissionsProps = {
  agents: TelegramAgentRecord[];
  missions: AgentMissionRecord[];
  selectedMissionId: string | null;
  missionMessages: AgentCommMessageRecord[];
  loading: boolean;
  creating: boolean;
  form: TelegramMissionsForm;
  sendForm: TelegramSendForm;
  onFormChange: (patch: Partial<TelegramMissionsForm>) => void;
  onSendFormChange: (patch: Partial<TelegramSendForm>) => void;
  onCreate: () => void;
  onComplete: (missionId: string) => void;
  onViewMessages: (missionId: string) => void;
  onBack: () => void;
  onSendMessage: () => void;
  onRefresh: () => void;
};

// ─── View ─────────────────────────────────────────────────────────────────────

export function renderTelegramMissions(props: TelegramMissionsProps) {
  const { selectedMissionId, missions } = props;

  if (selectedMissionId) {
    const mission = missions.find((m) => m.id === selectedMissionId) ?? null;
    return renderMissionMessages(props, mission);
  }

  return renderMissionList(props);
}

// ─── Mission list ─────────────────────────────────────────────────────────────

function renderMissionList(props: TelegramMissionsProps) {
  const {
    agents,
    missions,
    loading,
    creating,
    form,
    onFormChange,
    onCreate,
    onComplete,
    onViewMessages,
    onRefresh,
  } = props;

  return html`
    <section class="card">
      <div class="card-header-row" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <div>
          <div class="card-title">Agent Missions</div>
          <div class="card-sub">Coordinate Telegram agents toward a shared goal.</div>
        </div>
        <button class="btn btn-sm" @click=${onRefresh} ?disabled=${loading}>
          ${loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <!-- Create mission form -->
      <details style="margin-bottom:16px;">
        <summary style="cursor:pointer;font-size:13px;font-weight:600;padding:6px 0;">
          + Create Mission
        </summary>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">
          <div>
            <label style="font-size:11px;color:var(--color-muted,#888);">Master Agent</label>
            <select
              style="width:100%;padding:6px;background:var(--color-card-bg,#1a1a1a);color:var(--color-text);border:1px solid var(--color-border,#333);border-radius:4px;"
              .value=${form.masterAgentId}
              @change=${(e: Event) => onFormChange({ masterAgentId: (e.target as HTMLSelectElement).value })}
            >
              <option value="">— select master agent —</option>
              ${agents.map((a) => html`<option value=${a.id}>${a.name}</option>`)}
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:var(--color-muted,#888);">Title</label>
            <input
              type="text"
              style="width:100%;padding:6px;background:var(--color-card-bg,#1a1a1a);color:var(--color-text);border:1px solid var(--color-border,#333);border-radius:4px;box-sizing:border-box;"
              placeholder="Mission title…"
              .value=${form.title}
              @input=${(e: Event) => onFormChange({ title: (e.target as HTMLInputElement).value })}
            />
          </div>
          <div>
            <label style="font-size:11px;color:var(--color-muted,#888);">Goal</label>
            <textarea
              style="width:100%;padding:6px;font-family:inherit;font-size:13px;background:var(--color-card-bg,#1a1a1a);color:var(--color-text);border:1px solid var(--color-border,#333);border-radius:4px;resize:vertical;min-height:80px;box-sizing:border-box;"
              placeholder="Describe the shared goal for all participating agents…"
              .value=${form.goal}
              @input=${(e: Event) => onFormChange({ goal: (e.target as HTMLTextAreaElement).value })}
            ></textarea>
          </div>
          <div>
            <label style="font-size:11px;color:var(--color-muted,#888);">System Prompt (optional)</label>
            <textarea
              style="width:100%;padding:6px;font-family:monospace;font-size:12px;background:var(--color-card-bg,#1a1a1a);color:var(--color-text);border:1px solid var(--color-border,#333);border-radius:4px;resize:vertical;min-height:60px;box-sizing:border-box;"
              placeholder="Optional system prompt override for sub-agents…"
              .value=${form.systemPrompt}
              @input=${(e: Event) => onFormChange({ systemPrompt: (e.target as HTMLTextAreaElement).value })}
            ></textarea>
          </div>
          <div>
            <label style="font-size:11px;color:var(--color-muted,#888);">Participants</label>
            <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px;">
              ${agents.map(
                (a) => html`
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;">
                  <input
                    type="checkbox"
                    .checked=${form.participantIds.includes(a.id)}
                    @change=${(e: Event) => {
                      const checked = (e.target as HTMLInputElement).checked;
                      const ids = checked
                        ? [...form.participantIds, a.id]
                        : form.participantIds.filter((id) => id !== a.id);
                      onFormChange({ participantIds: ids });
                    }}
                  />
                  ${a.name}
                </label>
              `,
              )}
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:4px;">
            <button
              class="btn btn-primary"
              @click=${onCreate}
              ?disabled=${creating || !form.masterAgentId || !form.title || !form.goal}
            >
              ${creating ? "Creating…" : "Create Mission"}
            </button>
          </div>
        </div>
      </details>

      <!-- Mission cards -->
      ${
        missions.length === 0
          ? html`
              <div style="color: var(--color-muted, #888); padding: 16px 0; text-align: center">
                No missions yet.
              </div>
            `
          : missions.map((m) => renderMissionCard(m, agents, onComplete, onViewMessages))
      }
    </section>
  `;
}

function renderMissionCard(
  mission: AgentMissionRecord,
  agents: TelegramAgentRecord[],
  onComplete: (id: string) => void,
  onViewMessages: (id: string) => void,
) {
  const masterAgent = agents.find((a) => a.id === mission.masterAgentId);
  const participants = agents.filter((a) => mission.participantAgentIds.includes(a.id));
  const statusColor =
    mission.status === "active" ? "#3a7" : mission.status === "completed" ? "#888" : "#a73";

  return html`
    <div style="padding:12px;border:1px solid var(--color-border,#333);border-radius:6px;margin-bottom:10px;background:var(--color-card-bg,#1a1a1a);">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;">
            ${mission.title}
            <span style="font-size:10px;padding:2px 6px;border-radius:3px;background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44;">${mission.status}</span>
          </div>
          <div style="font-size:12px;color:var(--color-muted,#888);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title=${mission.goal}>
            ${mission.goal.length > 120 ? mission.goal.slice(0, 120) + "…" : mission.goal}
          </div>
          <div style="font-size:11px;color:var(--color-muted,#888);margin-top:4px;">
            Master: ${masterAgent?.name ?? mission.masterAgentId}
            ${
              participants.length > 0
                ? html` · Participants: ${participants.map((a) => a.name).join(", ")}`
                : nothing
            }
            · ${formatRelativeTimestamp(new Date(mission.createdAt).getTime())}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
          <button class="btn btn-sm" @click=${() => onViewMessages(mission.id)}>
            View Messages
          </button>
          ${
            mission.status === "active"
              ? html`<button class="btn btn-sm btn-danger" @click=${() => onComplete(mission.id)}>Complete</button>`
              : nothing
          }
        </div>
      </div>
    </div>
  `;
}

// ─── Mission messages ─────────────────────────────────────────────────────────

function renderMissionMessages(props: TelegramMissionsProps, mission: AgentMissionRecord | null) {
  const { agents, missionMessages, sendForm, onSendFormChange, onSendMessage, onBack } = props;

  return html`
    <section class="card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <button class="btn btn-sm" @click=${onBack}>← Back</button>
        <div>
          <div class="card-title" style="margin-bottom:0;">${mission?.title ?? "Mission Messages"}</div>
          ${
            mission
              ? html`<div class="card-sub">${mission.goal.length > 100 ? mission.goal.slice(0, 100) + "…" : mission.goal}</div>`
              : nothing
          }
        </div>
      </div>

      <!-- Message thread -->
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;max-height:360px;overflow-y:auto;padding-right:4px;">
        ${
          missionMessages.length === 0
            ? html`
                <div style="color: var(--color-muted, #888); padding: 16px 0; text-align: center">
                  No messages yet.
                </div>
              `
            : missionMessages.map((msg) => renderMessageBubble(msg, agents))
        }
      </div>

      <!-- Send message form -->
      <div style="border-top:1px solid var(--color-border,#333);padding-top:12px;display:flex;flex-direction:column;gap:8px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <label style="font-size:11px;color:var(--color-muted,#888);">From Agent</label>
            <select
              style="width:100%;padding:6px;background:var(--color-card-bg,#1a1a1a);color:var(--color-text);border:1px solid var(--color-border,#333);border-radius:4px;"
              .value=${sendForm.fromAgentId}
              @change=${(e: Event) => onSendFormChange({ fromAgentId: (e.target as HTMLSelectElement).value })}
            >
              <option value="">— select —</option>
              ${agents.map((a) => html`<option value=${a.id}>${a.name}</option>`)}
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:var(--color-muted,#888);">To Agent</label>
            <select
              style="width:100%;padding:6px;background:var(--color-card-bg,#1a1a1a);color:var(--color-text);border:1px solid var(--color-border,#333);border-radius:4px;"
              .value=${sendForm.toAgentId}
              @change=${(e: Event) => onSendFormChange({ toAgentId: (e.target as HTMLSelectElement).value })}
            >
              <option value="">— select —</option>
              ${agents.map((a) => html`<option value=${a.id}>${a.name}</option>`)}
            </select>
          </div>
        </div>
        <textarea
          style="width:100%;padding:8px;font-family:inherit;font-size:13px;background:var(--color-card-bg,#1a1a1a);color:var(--color-text);border:1px solid var(--color-border,#333);border-radius:4px;resize:vertical;min-height:72px;box-sizing:border-box;"
          placeholder="Message content…"
          .value=${sendForm.content}
          @input=${(e: Event) => onSendFormChange({ content: (e.target as HTMLTextAreaElement).value })}
        ></textarea>
        <div style="display:flex;justify-content:flex-end;">
          <button
            class="btn btn-primary"
            @click=${onSendMessage}
            ?disabled=${!sendForm.fromAgentId || !sendForm.toAgentId || !sendForm.content}
          >
            Send
          </button>
        </div>
      </div>
    </section>
  `;
}

function renderMessageBubble(msg: AgentCommMessageRecord, agents: TelegramAgentRecord[]) {
  const fromAgent = agents.find((a) => a.id === msg.fromAgentId);
  const toAgent = agents.find((a) => a.id === msg.toAgentId);

  return html`
    <div style="padding:8px 10px;border-radius:6px;border:1px solid var(--color-border,#333);background:var(--color-card-bg,#1a1a1a);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <div style="font-size:11px;font-weight:600;color:var(--color-text);">
          ${fromAgent?.name ?? msg.fromAgentName}
          <span style="color:var(--color-muted,#888);font-weight:400;"> → </span>
          ${toAgent?.name ?? msg.toAgentId}
        </div>
        <div style="font-size:10px;color:var(--color-muted,#888);">${formatRelativeTimestamp(new Date(msg.timestamp).getTime())}</div>
      </div>
      <div style="font-size:13px;white-space:pre-wrap;word-break:break-word;">${msg.content}</div>
    </div>
  `;
}
