import { html, nothing } from "lit";
import type { TelegramAgentEvent, TelegramAgentRecord } from "../controllers/telegram.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TelegramPanel = "overview" | "auth" | "behaviors" | "events";

export type TelegramProps = {
  loading: boolean;
  error: string | null;
  agents: TelegramAgentRecord[];
  selectedAgentId: string | null;
  activePanel: TelegramPanel;
  busy: boolean;
  busyAgentId: string | null;
  authStep: "idle" | "awaiting_code" | "done" | "error";
  authError: string | null;
  recentEvents: TelegramAgentEvent[];
  // Create form
  createName: string;
  createType: "userbot" | "bot";
  createPhone: string;
  createToken: string;
  // OTP auth
  otpCode: string;
  otpPassword: string;
  // Behavior editor (raw JSON)
  behaviorsJson: string;
  behaviorsJsonError: string | null;
  // Callbacks
  onRefresh: () => void;
  onSelectAgent: (id: string | null) => void;
  onSelectPanel: (panel: TelegramPanel) => void;
  onCreateNameChange: (v: string) => void;
  onCreateTypeChange: (v: "userbot" | "bot") => void;
  onCreatePhoneChange: (v: string) => void;
  onCreateTokenChange: (v: string) => void;
  onCreateSubmit: () => void;
  onDelete: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onRestart: (id: string) => void;
  onAuthStart: (id: string) => void;
  onOtpCodeChange: (v: string) => void;
  onOtpPasswordChange: (v: string) => void;
  onAuthSubmit: (id: string) => void;
  onBehaviorsJsonChange: (v: string) => void;
  onBehaviorsSave: (id: string) => void;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  running: "var(--color-green, #22c55e)",
  starting: "var(--color-yellow, #eab308)",
  error: "var(--color-red, #ef4444)",
  stopped: "var(--color-muted, #6b7280)",
};

function statusDot(status: string) {
  const color = STATUS_COLORS[status] ?? STATUS_COLORS.stopped;
  return html`<span
    style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px;"
  ></span>`;
}

function isBusy(props: TelegramProps, agentId: string): boolean {
  return props.busy && props.busyAgentId === agentId;
}

// ─── Sidebar: agent list ──────────────────────────────────────────────────────

function renderSidebar(props: TelegramProps) {
  return html`
    <div class="agents-sidebar">
      <div class="agents-sidebar-header">
        <span class="agents-sidebar-title">Agents</span>
        <button
          class="icon-btn"
          title="Refresh"
          @click=${props.onRefresh}
          ?disabled=${props.loading}
        >
          ↺
        </button>
      </div>

      ${
        props.loading
          ? html`
              <div class="agents-sidebar-loading">Loading…</div>
            `
          : nothing
      }
      ${
        props.error
          ? html`<div class="callout danger" style="margin:8px">${props.error}</div>`
          : nothing
      }

      <ul class="agents-list" role="list">
        ${props.agents.map(
          (agent) => html`
            <li
              class="agents-list-item ${props.selectedAgentId === agent.id ? "selected" : ""}"
              role="button"
              tabindex="0"
              @click=${() => props.onSelectAgent(agent.id)}
              @keydown=${(e: KeyboardEvent) => e.key === "Enter" && props.onSelectAgent(agent.id)}
            >
              <div class="agents-list-item-name">
                ${statusDot(agent.status)}${agent.name}
              </div>
              <div class="agents-list-item-meta">
                <span class="badge">${agent.type}</span>
                <span style="font-size:0.75em;color:var(--color-muted)">${agent.status}</span>
              </div>
            </li>
          `,
        )}
        ${
          props.agents.length === 0 && !props.loading
            ? html`
                <li class="agents-list-empty">No agents yet</li>
              `
            : nothing
        }
      </ul>

      ${renderCreateForm(props)}
    </div>
  `;
}

// ─── Create agent form ────────────────────────────────────────────────────────

function renderCreateForm(props: TelegramProps) {
  const isUserbot = props.createType === "userbot";
  const canSubmit =
    props.createName.trim() !== "" &&
    (isUserbot ? props.createPhone.trim() !== "" : props.createToken.trim() !== "");

  return html`
    <div class="callout" style="margin:8px;padding:10px">
      <div style="font-weight:600;margin-bottom:8px">Add agent</div>

      <input
        class="input"
        type="text"
        placeholder="Name"
        .value=${props.createName}
        @input=${(e: InputEvent) => props.onCreateNameChange((e.target as HTMLInputElement).value)}
        style="width:100%;margin-bottom:6px"
      />

      <select
        class="input"
        .value=${props.createType}
        @change=${(e: Event) =>
          props.onCreateTypeChange((e.target as HTMLSelectElement).value as "userbot" | "bot")}
        style="width:100%;margin-bottom:6px"
      >
        <option value="bot">Bot (token)</option>
        <option value="userbot">Userbot (phone)</option>
      </select>

      ${
        isUserbot
          ? html`<input
            class="input"
            type="text"
            placeholder="+79991234567"
            .value=${props.createPhone}
            @input=${(e: InputEvent) =>
              props.onCreatePhoneChange((e.target as HTMLInputElement).value)}
            style="width:100%;margin-bottom:6px"
          />`
          : html`<input
            class="input"
            type="password"
            placeholder="Bot token from @BotFather"
            .value=${props.createToken}
            @input=${(e: InputEvent) =>
              props.onCreateTokenChange((e.target as HTMLInputElement).value)}
            style="width:100%;margin-bottom:6px"
          />`
      }

      <button
        class="btn btn-primary"
        style="width:100%"
        ?disabled=${!canSubmit || props.busy}
        @click=${props.onCreateSubmit}
      >
        ${props.busy && props.busyAgentId === "new" ? "Creating…" : "Create"}
      </button>
    </div>
  `;
}

// ─── Detail: panel tabs ───────────────────────────────────────────────────────

function renderPanelTabs(props: TelegramProps, agent: TelegramAgentRecord) {
  const tabs: Array<{ id: TelegramPanel; label: string }> = [
    { id: "overview", label: "Overview" },
    ...(agent.type === "userbot" ? [{ id: "auth" as TelegramPanel, label: "Auth" }] : []),
    { id: "behaviors", label: "Behaviors" },
    { id: "events", label: "Events" },
  ];

  return html`
    <div class="agents-panel-tabs">
      ${tabs.map(
        (tab) => html`
          <button
            class="agents-panel-tab ${props.activePanel === tab.id ? "active" : ""}"
            @click=${() => props.onSelectPanel(tab.id)}
          >
            ${tab.label}
          </button>
        `,
      )}
    </div>
  `;
}

// ─── Detail: overview panel ───────────────────────────────────────────────────

function renderOverviewPanel(props: TelegramProps, agent: TelegramAgentRecord) {
  const busy = isBusy(props, agent.id);

  return html`
    <div class="agents-panel-content">
      <div class="callout" style="margin-bottom:12px">
        <table class="kv-table">
          <tr><td>ID</td><td><code>${agent.id}</code></td></tr>
          <tr><td>Type</td><td>${agent.type}</td></tr>
          <tr>
            <td>Status</td>
            <td>${statusDot(agent.status)}${agent.status}</td>
          </tr>
          ${
            agent.credentials.phoneNumber
              ? html`<tr><td>Phone</td><td>${agent.credentials.phoneNumber}</td></tr>`
              : nothing
          }
          <tr><td>Sent</td><td>${agent.stats.sent}</td></tr>
          <tr><td>Received</td><td>${agent.stats.received}</td></tr>
          <tr><td>Parsed</td><td>${agent.stats.parsed}</td></tr>
          ${
            agent.lastError
              ? html`<tr>
                <td>Last error</td>
                <td style="color:var(--color-red)">${agent.lastError}</td>
              </tr>`
              : nothing
          }
        </table>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button
          class="btn btn-primary"
          ?disabled=${busy || agent.status === "running" || agent.status === "starting"}
          @click=${() => props.onStart(agent.id)}
        >
          ${busy && agent.status !== "running" ? "Starting…" : "Start"}
        </button>
        <button
          class="btn"
          ?disabled=${busy || agent.status === "stopped"}
          @click=${() => props.onStop(agent.id)}
        >
          Stop
        </button>
        <button
          class="btn"
          ?disabled=${busy}
          @click=${() => props.onRestart(agent.id)}
        >
          Restart
        </button>
        <button
          class="btn btn-danger"
          ?disabled=${busy}
          @click=${() => {
            if (confirm(`Delete agent "${agent.name}"?`)) {
              props.onDelete(agent.id);
            }
          }}
        >
          Delete
        </button>
      </div>
    </div>
  `;
}

// ─── Detail: auth panel (userbot only) ───────────────────────────────────────

function renderAuthPanel(props: TelegramProps, agent: TelegramAgentRecord) {
  const busy = isBusy(props, agent.id);
  const { authStep, authError } = props;

  return html`
    <div class="agents-panel-content">
      <div class="callout" style="margin-bottom:12px">
        <p style="margin:0 0 8px 0">
          Authenticate as <strong>${agent.credentials.phoneNumber ?? "unknown"}</strong>.
          Requires <code>TG_API_ID</code> and <code>TG_API_HASH</code> env vars.
        </p>
        ${
          agent.status === "error" && agent.lastError?.includes("Not authorized")
            ? html`
                <div class="callout danger" style="margin-bottom: 8px">Not authorized — complete auth below.</div>
              `
            : nothing
        }
      </div>

      ${
        authStep === "idle" || authStep === "done"
          ? html`
            <button
              class="btn btn-primary"
              ?disabled=${busy}
              @click=${() => props.onAuthStart(agent.id)}
            >
              ${busy ? "Sending code…" : "Send OTP to phone"}
            </button>
          `
          : nothing
      }

      ${
        authStep === "awaiting_code"
          ? html`
            <div class="callout" style="margin-bottom:12px;padding:10px">
              <p style="margin:0 0 8px 0;color:var(--color-yellow)">
                ⚠️ Code sent. Submit within 5 minutes.
              </p>
              <input
                class="input"
                type="text"
                placeholder="OTP code (e.g. 12345)"
                .value=${props.otpCode}
                @input=${(e: InputEvent) =>
                  props.onOtpCodeChange((e.target as HTMLInputElement).value)}
                style="width:100%;margin-bottom:6px"
              />
              <input
                class="input"
                type="password"
                placeholder="2FA password (leave blank if none)"
                .value=${props.otpPassword}
                @input=${(e: InputEvent) =>
                  props.onOtpPasswordChange((e.target as HTMLInputElement).value)}
                style="width:100%;margin-bottom:8px"
              />
              <button
                class="btn btn-primary"
                ?disabled=${busy || props.otpCode.trim() === ""}
                @click=${() => props.onAuthSubmit(agent.id)}
              >
                ${busy ? "Submitting…" : "Submit code"}
              </button>
            </div>
          `
          : nothing
      }

      ${
        authStep === "done"
          ? html`
              <div class="callout" style="color: var(--color-green)">✓ Authorized. Session saved.</div>
            `
          : nothing
      }

      ${
        authError
          ? html`<div class="callout danger" style="margin-top:8px">${authError}</div>`
          : nothing
      }
    </div>
  `;
}

// ─── Detail: behaviors panel ──────────────────────────────────────────────────

function renderBehaviorsPanel(props: TelegramProps, agent: TelegramAgentRecord) {
  const busy = isBusy(props, agent.id);

  return html`
    <div class="agents-panel-content">
      <p style="margin:0 0 8px 0;font-size:0.85em;color:var(--color-muted)">
        Edit behaviors as JSON. Supported types:
        <code>auto_reply</code>, <code>monitor</code>, <code>broadcast</code>,
        <code>parser</code>.
      </p>
      <textarea
        class="input"
        rows="16"
        style="width:100%;font-family:monospace;font-size:0.8em"
        .value=${props.behaviorsJson}
        @input=${(e: InputEvent) =>
          props.onBehaviorsJsonChange((e.target as HTMLTextAreaElement).value)}
      ></textarea>
      ${
        props.behaviorsJsonError
          ? html`<div class="callout danger" style="margin-top:4px;font-size:0.85em">
            ${props.behaviorsJsonError}
          </div>`
          : nothing
      }
      <button
        class="btn btn-primary"
        style="margin-top:8px"
        ?disabled=${busy || !!props.behaviorsJsonError}
        @click=${() => props.onBehaviorsSave(agent.id)}
      >
        ${busy ? "Saving…" : "Save behaviors"}
      </button>
    </div>
  `;
}

// ─── Detail: events panel ─────────────────────────────────────────────────────

function renderEventsPanel(props: TelegramProps, agentId: string) {
  const events = props.recentEvents.filter((e) => e.agentId === agentId);

  return html`
    <div class="agents-panel-content">
      ${
        events.length === 0
          ? html`
              <div style="color: var(--color-muted); font-size: 0.85em">No events yet.</div>
            `
          : html`
            <table class="kv-table" style="font-size:0.8em;width:100%">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Payload</th>
                </tr>
              </thead>
              <tbody>
                ${events.slice(0, 50).map(
                  (evt) => html`
                    <tr>
                      <td style="white-space:nowrap;color:var(--color-muted)">
                        ${new Date(evt.timestamp).toLocaleTimeString()}
                      </td>
                      <td><span class="badge">${evt.type}</span></td>
                      <td style="font-family:monospace;word-break:break-all">
                        ${JSON.stringify(evt.payload).slice(0, 120)}
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `
      }
    </div>
  `;
}

// ─── Main panel ───────────────────────────────────────────────────────────────

function renderDetail(props: TelegramProps) {
  const agent = props.agents.find((a) => a.id === props.selectedAgentId);

  if (!agent) {
    return html`
      <div class="agents-main">
        <div style="color: var(--color-muted); padding: 24px">
          Select an agent from the list, or create one.
        </div>
      </div>
    `;
  }

  return html`
    <div class="agents-main">
      <div class="agents-detail-header">
        <h2 class="agents-detail-title">
          ${statusDot(agent.status)}${agent.name}
          <span class="badge" style="margin-left:4px">${agent.type}</span>
        </h2>
      </div>

      ${renderPanelTabs(props, agent)}

      ${props.activePanel === "overview" ? renderOverviewPanel(props, agent) : nothing}
      ${
        props.activePanel === "auth" && agent.type === "userbot"
          ? renderAuthPanel(props, agent)
          : nothing
      }
      ${props.activePanel === "behaviors" ? renderBehaviorsPanel(props, agent) : nothing}
      ${props.activePanel === "events" ? renderEventsPanel(props, agent.id) : nothing}
    </div>
  `;
}

// ─── Root render ─────────────────────────────────────────────────────────────

export function renderTelegramManager(props: TelegramProps) {
  return html`
    <div class="tab-container agents-layout">
      ${renderSidebar(props)} ${renderDetail(props)}
    </div>
  `;
}
