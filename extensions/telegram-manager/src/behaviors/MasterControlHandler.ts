import { randomUUID } from "crypto";
// plugins/telegram/src/behaviors/MasterControlHandler.ts
import fs from "fs";
import os from "os";
import path from "path";
import type { BehaviorConfig, IAgentManager, ILogger, TaskSession } from "../types";

// ─── Gateway config ────────────────────────────────────────────────────────────

function resolveGatewayToken(): string {
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envToken) return envToken;
  try {
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
    const raw = fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf-8");
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    return cfg?.gateway?.auth?.token?.trim() || "";
  } catch {
    return "";
  }
}

function resolveGatewayPort(): number {
  return parseInt(process.env.OPENCLAW_GATEWAY_PORT?.trim() || "18789", 10);
}

function resolveModel(): string {
  return process.env.TG_AI_MODEL?.trim() || "claude-3-5-sonnet-20241022";
}

// ─── Default system prompt ─────────────────────────────────────────────────────

const DEFAULT_SYSTEM = `You are the OpenClaw master control agent.
You manage a pool of Telegram sub-agents (userbots and bots) on behalf of the operator.
Use the available tools to fulfill requests. You can:
- List agents and check their status
- Start, stop, or restart individual agents
- Send messages through any agent to any Telegram chat
- Assign AI-driven task sessions to agents for specific conversations
- Complete or cancel task sessions
- Set or update an agent's auto-reply goal
- View recent message events

Be concise. Confirm every action taken. If something fails, explain the error briefly.`;

// ─── Tool schemas (OpenAI function-calling format) ─────────────────────────────

const CONTROL_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_agents",
      description: "List all Telegram agents with their id, name, type, and current status.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "start_agent",
      description: "Start a stopped or errored Telegram agent.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Agent id from list_agents" },
        },
        required: ["agent_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_agent",
      description: "Stop a running Telegram agent.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Agent id" },
        },
        required: ["agent_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "restart_agent",
      description: "Restart a Telegram agent (stop then start).",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Agent id" },
        },
        required: ["agent_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description: "Send a Telegram message through a specific agent to a target chat or user.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "The agent to send from" },
          target: {
            type: "string",
            description: "Recipient: @username, numeric chat ID, or phone number",
          },
          message: { type: "string", description: "Text of the message to send" },
        },
        required: ["agent_id", "target", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_events",
      description: "Get recent incoming and outgoing message events for an agent.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Agent id" },
          limit: { type: "number", description: "Max events to return (default 20)" },
        },
        required: ["agent_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assign_task",
      description:
        "Assign an AI-driven task session to an agent for a specific chat. " +
        "The agent will handle that conversation autonomously until the task is marked complete.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Agent id" },
          chat_id: { type: "string", description: "Target Telegram chat ID or @username" },
          task: { type: "string", description: "Goal or task description for the AI agent" },
          opening_message: {
            type: "string",
            description: "Optional first message to send when the session starts",
          },
        },
        required: ["agent_id", "chat_id", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_task_sessions",
      description: "List active task sessions on an agent.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Agent id" },
        },
        required: ["agent_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "Mark a task session as completed.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Agent id" },
          session_id: {
            type: "string",
            description: "Session id from list_task_sessions",
          },
        },
        required: ["agent_id", "session_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_agent_goal",
      description:
        "Set or update the auto-reply goal for an agent. " +
        "The agent will pursue this objective in every auto-reply conversation.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Agent id" },
          goal: { type: "string", description: "The goal or objective for the agent" },
        },
        required: ["agent_id", "goal"],
      },
    },
  },
];

// ─── Minimal OpenAI-compat response types ─────────────────────────────────────

interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type OaiMessage =
  | { role: "system" | "user" | "assistant"; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OaiResponse {
  choices?: Array<{
    finish_reason: string;
    message: { role: string; content: string | null; tool_calls?: OaiToolCall[] };
  }>;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * Agentic loop that runs when the operator sends a message to the master
 * control channel. Routes requests through the OpenClaw gateway's
 * OpenAI-compatible endpoint with function-calling tools that map directly to
 * AgentManager operations.
 */
export class MasterControlHandler {
  constructor(
    private readonly manager: IAgentManager,
    private readonly logger: ILogger,
  ) {}

  /** Process one operator message and return the final text reply. */
  async handle(text: string, systemPromptOverride?: string): Promise<string> {
    const port = resolveGatewayPort();
    const token = resolveGatewayToken();
    const model = resolveModel();
    const systemPrompt = systemPromptOverride ?? DEFAULT_SYSTEM;

    const messages: OaiMessage[] = [{ role: "user", content: text }];
    const maxIterations = 8;

    for (let i = 0; i < maxIterations; i++) {
      let response: OaiResponse;
      try {
        response = await this.callGateway(port, token, model, systemPrompt, messages);
      } catch (e) {
        this.logger.error("[MasterControl] gateway call failed", { e: String(e) });
        return `⚠️ AI error: ${e instanceof Error ? e.message : String(e)}`;
      }

      const choice = response.choices?.[0];
      if (!choice) break;

      const { finish_reason, message } = choice;

      // No tool calls → final text response.
      if (finish_reason !== "tool_calls" || !message.tool_calls?.length) {
        return message.content?.trim() || "Done.";
      }

      // Append the assistant turn (includes tool_calls metadata).
      messages.push({
        role: "assistant",
        content: message.content ?? "",
        tool_calls: message.tool_calls,
      });

      // Execute each tool call and collect results.
      for (const tc of message.tool_calls) {
        let result: unknown;
        try {
          const args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
          result = await this.executeTool(tc.function.name, args);
        } catch (e) {
          result = { error: String(e) };
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
    }

    return "Unable to complete request.";
  }

  // ─── Gateway call ──────────────────────────────────────────────────────────

  private async callGateway(
    port: number,
    token: string,
    model: string,
    systemPrompt: string,
    messages: OaiMessage[],
  ): Promise<OaiResponse> {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        tools: CONTROL_TOOLS,
        tool_choice: "auto",
        max_tokens: 2048,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Gateway ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json() as Promise<OaiResponse>;
  }

  // ─── Tool execution ────────────────────────────────────────────────────────

  private async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "list_agents": {
        return this.manager.list().map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          status: a.status,
          lastError: a.lastError ?? null,
        }));
      }

      case "start_agent": {
        await this.manager.start(args["agent_id"] as string);
        return { ok: true };
      }

      case "stop_agent": {
        await this.manager.stop(args["agent_id"] as string);
        return { ok: true };
      }

      case "restart_agent": {
        await this.manager.restart(args["agent_id"] as string);
        return { ok: true };
      }

      case "send_message": {
        const result = await this.manager.callTool(args["agent_id"] as string, "sendMessage", {
          target: args["target"],
          message: args["message"],
        });
        return result ?? { ok: true };
      }

      case "get_events": {
        return this.manager.getEvents(
          args["agent_id"] as string,
          (args["limit"] as number | undefined) ?? 20,
        );
      }

      case "assign_task": {
        const session: TaskSession = {
          id: randomUUID(),
          chatId: args["chat_id"] as string,
          task: args["task"] as string,
          status: "active",
          startedAt: new Date().toISOString(),
          initiatedBy: "master_control",
        };
        await this.manager.assignTaskSession(args["agent_id"] as string, session);
        // Send opening message if provided.
        if (args["opening_message"]) {
          await this.manager.callTool(args["agent_id"] as string, "sendMessage", {
            target: args["chat_id"],
            message: args["opening_message"],
          });
        }
        return { ok: true, sessionId: session.id };
      }

      case "list_task_sessions": {
        return this.manager.listTaskSessions(args["agent_id"] as string);
      }

      case "complete_task": {
        await this.manager.completeTaskSession(
          args["agent_id"] as string,
          args["session_id"] as string,
        );
        return { ok: true };
      }

      case "set_agent_goal": {
        const agentId = args["agent_id"] as string;
        const goal = args["goal"] as string;
        const record = this.manager.get(agentId);
        if (!record) throw new Error(`Agent not found: ${agentId}`);
        // Update existing auto_reply behavior or create one.
        const behaviors: BehaviorConfig[] = [...(record.behaviors ?? [])];
        const idx = behaviors.findIndex((b) => b.type === "auto_reply");
        if (idx >= 0) {
          behaviors[idx] = { ...behaviors[idx], goal } as BehaviorConfig;
        } else {
          behaviors.push({ type: "auto_reply", enabled: true, replyMode: "ai", goal });
        }
        await this.manager.setBehaviors(agentId, behaviors);
        return { ok: true };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }
}
