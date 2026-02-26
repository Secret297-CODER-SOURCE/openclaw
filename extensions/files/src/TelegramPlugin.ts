// plugins/telegram/src/TelegramPlugin.ts
//
// This is the entry point for the OpenClaw plugin system.
// It implements GatewayPlugin and integrates with the Gateway's:
//   - Auth (same OPENCLAW_GATEWAY_TOKEN)
//   - WebSocket message routing (method: "telegram.*")
//   - HTTP routes (REST fallback / polling clients)
//   - Broadcast (push events to all connected WS clients)

import path from "path";
import { AgentManager } from "./agents/AgentManager";
import { TelegramStorage } from "./storage/TelegramStorage";
import { GatewayPlugin, IGatewayContext, GatewayMessage, HttpRoute, TelegramEvent } from "./types";

export class TelegramPlugin implements GatewayPlugin {
  readonly namespace = "telegram";

  private ctx!: IGatewayContext;
  private storage!: TelegramStorage;
  private manager!: AgentManager;

  // ─── Plugin lifecycle ─────────────────────────────────────────────────────

  async init(ctx: IGatewayContext): Promise<void> {
    this.ctx = ctx;
    this.storage = new TelegramStorage(path.join(ctx.dataDir, "telegram"));
    this.manager = new AgentManager(this.storage, ctx.logger);
    await this.manager.init();

    // Forward all agent events to every connected WS client
    this.manager.onEvent((event: TelegramEvent) => {
      ctx.broadcast({ method: "telegram.event", params: event });
    });

    ctx.logger.info("[TelegramPlugin] initialized");
  }

  async destroy(): Promise<void> {
    await this.manager.shutdown();
  }

  // ─── WebSocket message handler ────────────────────────────────────────────
  //
  // All messages with method starting with "telegram." land here.
  // reply() sends a response back to the single client that sent the message.

  async handleMessage(msg: GatewayMessage, reply: (r: GatewayMessage) => void): Promise<boolean> {
    if (!msg.method.startsWith("telegram.")) return false; // not ours

    const respond = (result: unknown) => reply({ id: msg.id, method: msg.method, result });

    const fail = (error: string) => reply({ id: msg.id, method: msg.method, error });

    const p = (msg.params ?? {}) as Record<string, any>;

    try {
      switch (msg.method) {
        // ── Agents ─────────────────────────────────────────────────────────

        case "telegram.agent.list":
          respond(this.manager.list().map(safeRecord));
          break;

        case "telegram.agent.get":
          respond(safeRecord(this.manager.get(p.agentId)));
          break;

        case "telegram.agent.create": {
          const record = this.manager.create(p.name, p.credentials, p.behaviors ?? []);
          respond(safeRecord(record));
          break;
        }

        case "telegram.agent.delete":
          await this.manager.delete(p.agentId);
          respond({ deleted: true });
          break;

        // ── Lifecycle ──────────────────────────────────────────────────────

        case "telegram.agent.start":
          await this.manager.start(p.agentId);
          respond({ status: "started" });
          break;

        case "telegram.agent.stop":
          await this.manager.stop(p.agentId);
          respond({ status: "stopped" });
          break;

        case "telegram.agent.restart":
          await this.manager.restart(p.agentId);
          respond({ status: "restarted" });
          break;

        // ── Behaviors ──────────────────────────────────────────────────────

        case "telegram.agent.setBehaviors":
          await this.manager.setBehaviors(p.agentId, p.behaviors);
          respond({ ok: true });
          break;

        // ── Auth (userbot) ─────────────────────────────────────────────────

        case "telegram.agent.authStart":
          await this.manager.authStart(p.agentId);
          respond({ step: "code_sent" });
          break;

        case "telegram.agent.authSubmit":
          await this.manager.authSubmit(p.agentId, p.code, p.password);
          respond({ authenticated: true });
          break;

        // ── Tools (imperative calls) ───────────────────────────────────────
        // These mirror CDP "forwardCDPCommand" but for Telegram.
        // e.g.: { method: "telegram.tool.call", params: { agentId, tool: "sendMessage", args: { target: "@user", message: "hi" } } }

        case "telegram.tool.call": {
          const result = await this.manager.callTool(p.agentId, p.tool, p.args ?? {});
          respond({ ok: true, data: result });
          break;
        }

        // ── Data ───────────────────────────────────────────────────────────

        case "telegram.events.get":
          respond(this.manager.getEvents(p.agentId, p.limit));
          break;

        case "telegram.parsed.get":
          respond(this.manager.getParsed(p.agentId, p.limit));
          break;

        default:
          fail(`Unknown method: ${msg.method}`);
      }
    } catch (err) {
      fail(String(err));
    }

    return true; // handled
  }

  // ─── HTTP REST routes (optional, for non-WS clients) ─────────────────────

  httpRoutes(): HttpRoute[] {
    const mgr = this.manager;

    return [
      // GET /telegram/agents
      {
        method: "GET",
        path: "/telegram/agents",
        handler: (req, res) => res.json({ ok: true, data: mgr.list().map(safeRecord) }),
      },
      // GET /telegram/agents/:id
      {
        method: "GET",
        path: "/telegram/agents/:id",
        handler: (req, res) => {
          const r = mgr.get(req.params.id);
          r
            ? res.json({ ok: true, data: safeRecord(r) })
            : res.status(404).json({ ok: false, error: "Not found" });
        },
      },
      // POST /telegram/agents
      {
        method: "POST",
        path: "/telegram/agents",
        handler: async (req, res) => {
          const { name, credentials, behaviors } = req.body;
          const r = mgr.create(name, credentials, behaviors);
          res.status(201).json({ ok: true, data: safeRecord(r) });
        },
      },
      // DELETE /telegram/agents/:id
      {
        method: "DELETE",
        path: "/telegram/agents/:id",
        handler: async (req, res) => {
          await mgr.delete(req.params.id);
          res.json({ ok: true });
        },
      },
      // POST /telegram/agents/:id/start
      {
        method: "POST",
        path: "/telegram/agents/:id/start",
        handler: async (req, res) => {
          await mgr.start(req.params.id);
          res.json({ ok: true });
        },
      },
      // POST /telegram/agents/:id/stop
      {
        method: "POST",
        path: "/telegram/agents/:id/stop",
        handler: async (req, res) => {
          await mgr.stop(req.params.id);
          res.json({ ok: true });
        },
      },
      // POST /telegram/agents/:id/restart
      {
        method: "POST",
        path: "/telegram/agents/:id/restart",
        handler: async (req, res) => {
          await mgr.restart(req.params.id);
          res.json({ ok: true });
        },
      },
      // PUT /telegram/agents/:id/behaviors
      {
        method: "PUT",
        path: "/telegram/agents/:id/behaviors",
        handler: async (req, res) => {
          await mgr.setBehaviors(req.params.id, req.body.behaviors);
          res.json({ ok: true });
        },
      },
      // POST /telegram/agents/:id/auth/start
      {
        method: "POST",
        path: "/telegram/agents/:id/auth/start",
        handler: async (req, res) => {
          await mgr.authStart(req.params.id);
          res.json({ ok: true, step: "code_sent" });
        },
      },
      // POST /telegram/agents/:id/auth/submit
      {
        method: "POST",
        path: "/telegram/agents/:id/auth/submit",
        handler: async (req, res) => {
          await mgr.authSubmit(req.params.id, req.body.code, req.body.password);
          res.json({ ok: true, authenticated: true });
        },
      },
      // POST /telegram/agents/:id/tool
      {
        method: "POST",
        path: "/telegram/agents/:id/tool",
        handler: async (req, res) => {
          const data = await mgr.callTool(req.params.id, req.body.tool, req.body.args ?? {});
          res.json({ ok: true, data });
        },
      },
      // GET /telegram/agents/:id/events
      {
        method: "GET",
        path: "/telegram/agents/:id/events",
        handler: (req, res) =>
          res.json({
            ok: true,
            data: mgr.getEvents(req.params.id, parseInt(req.query.limit ?? "200")),
          }),
      },
      // GET /telegram/agents/:id/parsed
      {
        method: "GET",
        path: "/telegram/agents/:id/parsed",
        handler: (req, res) =>
          res.json({
            ok: true,
            data: mgr.getParsed(req.params.id, parseInt(req.query.limit ?? "1000")),
          }),
      },
    ];
  }
}

// Mask token / sessionString in API responses
function safeRecord(r: any) {
  if (!r) return null;
  const masked = { ...r, credentials: { ...r.credentials } };
  if (masked.credentials.token)
    masked.credentials.token = masked.credentials.token.slice(0, 10) + "…";
  if (masked.credentials.sessionString) masked.credentials.sessionString = "[saved]";
  return masked;
}
