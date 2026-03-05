// plugins/telegram/src/agents/AgentCommunicationBus.ts
//
// Manages inter-agent communication via missions. A master agent creates a
// mission with a goal and assigns sub-agents as participants. The bus routes
// messages between agents, persisting them in the database and emitting
// events for real-time delivery.

import { randomUUID } from "crypto";
import type { TelegramStorage } from "../storage/TelegramStorage";
import type { AgentMission, AgentCommunicationMessage, ILogger, TelegramEvent } from "../types";

export class AgentCommunicationBus {
  private eventListeners: ((e: TelegramEvent) => void)[] = [];

  constructor(
    private storage: TelegramStorage,
    /** Callback to call a tool on an agent — provided by AgentManager */
    private callTool: (
      agentId: string,
      tool: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>,
    /** Callback to look up an agent name by id */
    private getAgentName: (agentId: string) => string,
    private logger?: ILogger,
  ) {}

  // ─── Event propagation ────────────────────────────────────────────────────

  onEvent(fn: (e: TelegramEvent) => void): void {
    this.eventListeners.push(fn);
  }

  private emit(e: TelegramEvent): void {
    this.eventListeners.forEach((fn) => fn(e));
  }

  // ─── Missions ─────────────────────────────────────────────────────────────

  createMission(
    masterAgentId: string,
    title: string,
    goal: string,
    participantIds: string[],
    systemPrompt?: string,
  ): AgentMission {
    const mission: AgentMission = {
      id: randomUUID(),
      masterAgentId,
      title,
      goal,
      ...(systemPrompt ? { systemPrompt } : {}),
      participantAgentIds: participantIds,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    this.storage.saveMission(mission);
    return mission;
  }

  completeMission(missionId: string): void {
    const completedAt = new Date().toISOString();
    this.storage.updateMissionStatus(missionId, "completed", completedAt);
  }

  getMissions(): AgentMission[] {
    return this.storage.getAllMissions();
  }

  getMission(id: string): AgentMission | null {
    return this.storage.getMission(id);
  }

  // ─── Messages ─────────────────────────────────────────────────────────────

  async sendAgentMessage(
    fromAgentId: string,
    toAgentId: string,
    missionId: string,
    content: string,
    replyToId?: string,
  ): Promise<AgentCommunicationMessage> {
    const fromAgentName = this.getAgentName(fromAgentId);

    const msg: AgentCommunicationMessage = {
      id: randomUUID(),
      fromAgentId,
      fromAgentName,
      toAgentId,
      content,
      missionId,
      timestamp: new Date().toISOString(),
      ...(replyToId ? { replyToId } : {}),
    };

    // Persist to DB
    this.storage.saveCommMessage(msg);

    // Attempt to deliver via the sending agent's Telegram channel.
    // The message is sent to an internal channel identified by the toAgentId.
    // Failures here are non-fatal — the message is already persisted.
    try {
      await this.callTool(fromAgentId, "sendMessage", {
        target: toAgentId,
        message: `[Mission:${missionId}] ${content}`,
      });
    } catch (err) {
      // Delivery failure is non-fatal; message is stored and can be polled
      this.logger?.warn(
        `[CommBus] delivery failed from=${fromAgentId} to=${toAgentId} mission=${missionId}: ${String(err)}`,
      );
    }

    // Emit event so the receiving agent can process it
    this.emit({
      agentId: toAgentId,
      agentName: this.getAgentName(toAgentId),
      type: "agent_message",
      payload: {
        fromAgentId,
        fromAgentName,
        missionId,
        content,
        messageId: msg.id,
        ...(replyToId ? { replyToId } : {}),
      },
      timestamp: msg.timestamp,
    });

    return msg;
  }

  getMissionMessages(missionId: string, limit?: number): AgentCommunicationMessage[] {
    return this.storage.getCommMessages(missionId, limit);
  }
}
