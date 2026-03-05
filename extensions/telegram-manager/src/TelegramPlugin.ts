// plugins/telegram/src/TelegramPlugin.ts
//
// This is the entry point for the OpenClaw plugin system.
// It implements GatewayPlugin and integrates with the Gateway's:
//   - Auth (same OPENCLAW_GATEWAY_TOKEN)
//   - WebSocket message routing (method: "telegram.*")
//   - HTTP routes (REST fallback / polling clients)
//   - Broadcast (push events to all connected WS clients)

import { randomUUID } from "crypto";
import path from "path";
import { AgentManager } from "./agents/AgentManager";
import { TelegramStorage } from "./storage/TelegramStorage";
import type { ProxyConfig } from "./storage/TelegramStorage";
import {
  GatewayPlugin,
  IGatewayContext,
  GatewayMessage,
  HttpRoute,
  TelegramEvent,
  TaskSession,
} from "./types";

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

    const respond = (result: unknown) =>
      reply({ id: msg.id, method: msg.method, result: safeSerialize(result) });

    const fail = (error: string) => reply({ id: msg.id, method: msg.method, error });

    const p = (msg.params ?? {}) as Record<string, any>;

    try {
      switch (msg.method) {
        // ── Agents ──────────────────────────��──────────────────────────────

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
        //
        // IMPORTANT: the result from callTool (e.g. gramjs Message objects) must be
        // sanitized via safeSerialize before being placed in the respond payload.
        // gramjs objects contain live PromisedNetSockets which cannot be cloned by
        // structuredClone. If a non-serializable object leaks into a tool result, it
        // gets stored in the agent's message history and causes DataCloneError on every
        // subsequent call to transformContext → emitContext in the pi-agent framework.

        case "telegram.tool.call": {
          const result = await this.manager.callTool(p.agentId, p.tool, p.args ?? {});
          respond({ ok: true, data: result });
          break;
        }

        // ── Task sessions ──────────────────────────────────────────────────

        case "telegram.agent.assignTask": {
          if (!p.agentId) {
            fail("agentId is required");
            break;
          }
          if (!p.chatId) {
            fail("chatId is required");
            break;
          }
          if (!p.task) {
            fail("task is required");
            break;
          }
          const session: TaskSession = {
            id: randomUUID(),
            chatId: String(p.chatId),
            task: String(p.task),
            ...(p.systemPrompt ? { systemPrompt: String(p.systemPrompt) } : {}),
            status: "active",
            startedAt: new Date().toISOString(),
            ...(p.initiatedBy ? { initiatedBy: String(p.initiatedBy) } : {}),
          };
          await this.manager.assignTaskSession(p.agentId, session);
          // Optionally send an opening message right away
          let openingMessageError: string | undefined;
          if (p.openingMessage) {
            try {
              await this.manager.callTool(p.agentId, "sendMessage", {
                target: p.chatId,
                message: p.openingMessage,
              });
            } catch (e) {
              openingMessageError = String(e);
              // Log the actual reason (not just metadata) so it appears in the gateway log
              this.ctx.logger.warn(
                `[TelegramPlugin] opening message to ${p.chatId} failed: ${openingMessageError}`,
              );
            }
          }
          // Always respond ok (session is active); include warning if message failed
          respond({
            ok: true,
            sessionId: session.id,
            ...(openingMessageError ? { openingMessageWarning: openingMessageError } : {}),
          });
          break;
        }

        case "telegram.agent.listTaskSessions":
          respond(this.manager.listTaskSessions(p.agentId));
          break;

        case "telegram.agent.completeTaskSession":
          await this.manager.completeTaskSession(p.agentId, p.sessionId);
          respond({ ok: true });
          break;

        // ── Data ───────────────────────────────────────────────────────────

        case "telegram.events.get":
          respond(this.manager.getEvents(p.agentId, p.limit));
          break;

        case "telegram.parsed.get":
          respond(this.manager.getParsed(p.agentId, p.limit));
          break;

        // ── Plugin credentials config ──────────────────────────────────────

        case "telegram.config.get": {
          const cfg = this.storage.loadPluginConfig();
          respond({
            configured: cfg !== null,
            apiId: cfg?.apiId ?? null,
            // Never return the hash in plaintext; only signal whether it's set
            apiHashSet: !!cfg?.apiHash,
            // Proxy info (password never returned)
            proxyConfigured: !!(cfg?.proxy?.ip && cfg?.proxy?.port),
            proxyIp: cfg?.proxy?.ip ?? null,
            proxyPort: cfg?.proxy?.port ?? null,
            proxyUsername: cfg?.proxy?.username ?? null,
          });
          break;
        }

        case "telegram.config.set": {
          const apiId = parseInt(String(p.apiId ?? "0"), 10);
          const apiHash = String(p.apiHash ?? "").trim();
          if (!apiId || !apiHash) {
            fail("apiId and apiHash are required");
            break;
          }
          // Optional proxy fields
          const proxyIp = String(p.proxyIp ?? "").trim();
          const proxyPort = parseInt(String(p.proxyPort ?? "0"), 10);
          const proxy: ProxyConfig | undefined =
            proxyIp && proxyPort
              ? {
                  socksType: 5,
                  ip: proxyIp,
                  port: proxyPort,
                  ...(p.proxyUsername ? { username: String(p.proxyUsername) } : {}),
                  ...(p.proxyPassword ? { password: String(p.proxyPassword) } : {}),
                }
              : undefined;
          this.storage.savePluginConfig({ apiId, apiHash, ...(proxy ? { proxy } : {}) });
          respond({ ok: true });
          break;
        }

        // Proxy-only update — preserves existing apiId/apiHash, only modifies proxy
        case "telegram.config.setProxy": {
          const existing = this.storage.loadPluginConfig();
          if (!existing) {
            fail("API credentials not configured yet");
            break;
          }
          const proxyIp = String(p.proxyIp ?? "").trim();
          const proxyPort = parseInt(String(p.proxyPort ?? "0"), 10);
          // Pass clear:true to remove proxy without changing credentials
          if (p.clear) {
            this.storage.savePluginConfig({ ...existing, proxy: undefined });
            respond({ ok: true, cleared: true });
            break;
          }
          if (!proxyIp || !proxyPort) {
            fail("proxyIp and proxyPort are required (or pass clear:true to remove proxy)");
            break;
          }
          const proxy: ProxyConfig = {
            socksType: 5,
            ip: proxyIp,
            port: proxyPort,
            ...(p.proxyUsername ? { username: String(p.proxyUsername) } : {}),
            ...(p.proxyPassword ? { password: String(p.proxyPassword) } : {}),
          };
          this.storage.savePluginConfig({ ...existing, proxy });
          respond({ ok: true });
          break;
        }

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
          res.json({ ok: true, data: safeSerialize(data) });
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

/**
 * Deeply serialize a value to a plain JSON-safe object.
 *
 * gramjs callTool results (e.g. sendMessage, getMessages) return live gramjs
 * objects that contain PromisedNetSockets — non-cloneable internal TCP socket
 * wrappers. If these objects are returned as tool results, the pi-agent framework
 * stores them in the agent's message history and calls structuredClone on the
 * context at every subsequent turn, causing:
 *   DataCloneError: class PromisedNetSockets { ... } could not be cloned.
 *
 * Solution: force all tool results through JSON round-trip before they leave
 * TelegramPlugin, stripping any non-serializable values (replaced with null by
 * the replacer). This guarantees the agent context only ever contains plain data.
 */
function safeSerialize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, val) => {
        // Drop functions, Promises, Buffers, class instances with non-plain proto
        if (typeof val === "function") return undefined;
        if (typeof val === "bigint") return val.toString();
        if (val instanceof Promise) return undefined;
        if (Buffer.isBuffer(val)) return val.toString("base64");
        return val;
      }),
    );
  } catch {
    // If serialization fails entirely, return a safe placeholder
    return { serialized: false, type: typeof value };
  }
}
