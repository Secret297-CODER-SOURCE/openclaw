import fs from "fs";
import path from "path";
// plugins/telegram/src/storage/TelegramStorage.ts
import Database from "better-sqlite3";
import {
  AgentRecord,
  AgentMission,
  AgentCommunicationMessage,
  AgentSettings,
  BehaviorConfig,
  TelegramEvent,
  ChatNode,
  FlowNode,
  FlowDiagram,
  TrainingPair,
} from "../types";

export type ProxyConfig = {
  socksType: 5;
  ip: string;
  port: number;
  username?: string;
  password?: string;
};

export type TelegramPluginConfig = {
  apiId: number;
  apiHash: string;
  proxy?: ProxyConfig;
  /** Anthropic API key saved by the user via the UI (optional). */
  anthropicApiKey?: string;
};

export class TelegramStorage {
  private db: Database.Database;
  private configFile: string;

  /**
   * For shared-scope tables whose PRIMARY KEY includes agent_id, use this
   * sentinel instead of the actual agentId so all agents read/write the same row.
   */
  private static readonly SHARED_ID = "__shared__";
  /** The telegram plugin data directory (e.g. ~/.openclaw/data/telegram). */
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.configFile = path.join(dataDir, "plugin-config.json");
    this.db = new Database(path.join(dataDir, "telegram.db"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tg_agents (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'stopped',
        credentials TEXT NOT NULL,
        behaviors   TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        last_error  TEXT,
        stats       TEXT NOT NULL DEFAULT '{"sent":0,"received":0,"parsed":0}'
      );

      CREATE TABLE IF NOT EXISTS tg_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id   TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        type       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        ts         TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tg_parsed (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id   TEXT NOT NULL,
        source     TEXT NOT NULL,
        data_type  TEXT NOT NULL,
        content    TEXT NOT NULL,
        captured   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_missions (
        id                   TEXT PRIMARY KEY,
        master_agent_id      TEXT NOT NULL,
        title                TEXT NOT NULL,
        goal                 TEXT NOT NULL,
        system_prompt        TEXT,
        participant_agent_ids TEXT NOT NULL DEFAULT '[]',
        status               TEXT NOT NULL DEFAULT 'active',
        created_at           TEXT NOT NULL,
        completed_at         TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_communication_messages (
        id             TEXT PRIMARY KEY,
        from_agent_id  TEXT NOT NULL,
        from_agent_name TEXT NOT NULL,
        to_agent_id    TEXT NOT NULL,
        content        TEXT NOT NULL,
        mission_id     TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        reply_to_id    TEXT
      );

      CREATE TABLE IF NOT EXISTS tg_conversations (
        chat_key    TEXT PRIMARY KEY,
        messages    TEXT NOT NULL DEFAULT '[]',
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tg_chat_nodes (
        id           TEXT PRIMARY KEY,
        agent_id     TEXT NOT NULL,
        role         TEXT NOT NULL,
        text         TEXT NOT NULL,
        next_node_id TEXT,
        branches     TEXT NOT NULL DEFAULT '[]',
        position     TEXT,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tg_flow_nodes (
        id                  TEXT PRIMARY KEY,
        agent_id            TEXT NOT NULL,
        scope               TEXT NOT NULL DEFAULT 'personal',
        title               TEXT NOT NULL,
        description         TEXT,
        chat_node_ids       TEXT NOT NULL DEFAULT '[]',
        next_flow_node_ids  TEXT NOT NULL DEFAULT '[]',
        position            TEXT,
        created_at          TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tg_training_pairs (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        input       TEXT NOT NULL,
        response    TEXT NOT NULL,
        source_file TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
      );

      -- Full training snapshot (groups + labels + analysisResults) keyed by agent+scope
      CREATE TABLE IF NOT EXISTS tg_training_snapshots (
        agent_id    TEXT NOT NULL,
        scope       TEXT NOT NULL DEFAULT 'personal',
        data_json   TEXT NOT NULL DEFAULT '{}',
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (agent_id, scope)
      );

      CREATE TABLE IF NOT EXISTS tg_flow_diagrams (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        scope       TEXT NOT NULL DEFAULT 'personal',
        title       TEXT NOT NULL,
        nodes_json  TEXT NOT NULL DEFAULT '[]',
        edges_json  TEXT NOT NULL DEFAULT '[]',
        groups_json TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      -- Stores the AI-distributed knowledge base: training pairs mapped to diagram nodes.
      -- One row per (agent_id, scope) pair; replaced atomically on each save.
      CREATE TABLE IF NOT EXISTS tg_diagram_knowledge (
        agent_id   TEXT NOT NULL,
        scope      TEXT NOT NULL DEFAULT 'personal',
        data_json  TEXT NOT NULL DEFAULT '{"entries":[]}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, scope)
      );

      -- Stores AI coaching tips per dialog, persisted so they survive restarts.
      CREATE TABLE IF NOT EXISTS tg_coaching_tips (
        agent_id     TEXT NOT NULL,
        chat_id      TEXT NOT NULL,
        content      TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, chat_id)
      );

      -- Per-agent settings: active diagram, work mode, schedule.
      CREATE TABLE IF NOT EXISTS tg_agent_settings (
        agent_id      TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL DEFAULT '{}',
        updated_at    TEXT NOT NULL
      );

      -- Tracks which diagram node each conversation is currently at (schema work mode).
      -- Keyed by (agent_id, chat_id); deleted when the script reaches an end node.
      CREATE TABLE IF NOT EXISTS tg_conversation_state (
        agent_id   TEXT NOT NULL,
        chat_id    TEXT NOT NULL,
        node_id    TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, chat_id)
      );

      -- Per-client long-term memory: accumulated across schema sessions.
      -- Survives server restarts; injected into schema prompts so the agent
      -- remembers who the client is and what was discussed in past sessions.
      CREATE TABLE IF NOT EXISTS tg_chat_memories (
        agent_id       TEXT NOT NULL,
        chat_id        TEXT NOT NULL,
        memory_text    TEXT NOT NULL DEFAULT '',
        sessions_count INTEGER NOT NULL DEFAULT 0,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (agent_id, chat_id)
      );

      -- Lead records collected from conversations (auto-extracted or manual).
      CREATE TABLE IF NOT EXISTS tg_leads (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        chat_id     TEXT NOT NULL,
        data_json   TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tg_contacts (
        agent_id           TEXT NOT NULL,
        chat_id            TEXT NOT NULL,
        first_name         TEXT,
        last_name          TEXT,
        username           TEXT,
        last_client_msg_at TEXT NOT NULL,
        first_msg_at       TEXT NOT NULL,
        PRIMARY KEY (agent_id, chat_id)
      );

      CREATE TABLE IF NOT EXISTS tg_reengagement (
        agent_id    TEXT NOT NULL,
        chat_id     TEXT NOT NULL,
        delay_days  INTEGER NOT NULL,
        period_ref  TEXT NOT NULL,
        sent_at     TEXT NOT NULL,
        PRIMARY KEY (agent_id, chat_id, delay_days, period_ref)
      );

      CREATE INDEX IF NOT EXISTS idx_tg_contacts_agent ON tg_contacts(agent_id, last_client_msg_at);

      CREATE TABLE IF NOT EXISTS tg_followup_queue (
        id         TEXT PRIMARY KEY,
        agent_id   TEXT NOT NULL,
        chat_id    TEXT NOT NULL,
        chat_key   TEXT NOT NULL,
        send_at    TEXT NOT NULL,
        sent       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tg_followup_agent ON tg_followup_queue(agent_id, sent, send_at);
      CREATE INDEX IF NOT EXISTS idx_tg_leads_agent ON tg_leads(agent_id);
      CREATE INDEX IF NOT EXISTS idx_tg_events_agent ON tg_events(agent_id);
      CREATE INDEX IF NOT EXISTS idx_tg_parsed_agent ON tg_parsed(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_missions_master ON agent_missions(master_agent_id);
      CREATE INDEX IF NOT EXISTS idx_comm_msgs_mission ON agent_communication_messages(mission_id);
      CREATE INDEX IF NOT EXISTS idx_chat_nodes_agent ON tg_chat_nodes(agent_id);
      CREATE INDEX IF NOT EXISTS idx_flow_nodes_agent ON tg_flow_nodes(agent_id);
      CREATE INDEX IF NOT EXISTS idx_training_pairs_agent ON tg_training_pairs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_flow_diagrams_agent ON tg_flow_diagrams(agent_id, scope);
    `);

    // Incremental migration: add scope column to tg_flow_nodes for existing DBs
    const cols = this.db.prepare("PRAGMA table_info(tg_flow_nodes)").all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "scope")) {
      this.db.exec("ALTER TABLE tg_flow_nodes ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal'");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_flow_nodes_scope ON tg_flow_nodes(scope)");
    }

    // Incremental migration: add message_text column to tg_reengagement for existing DBs
    const reengCols = this.db.prepare("PRAGMA table_info(tg_reengagement)").all() as Array<{
      name: string;
    }>;
    if (!reengCols.some((c) => c.name === "message_text")) {
      this.db.exec("ALTER TABLE tg_reengagement ADD COLUMN message_text TEXT");
    }

    // Incremental migration: create ai_traces table for AI generation audit log
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_traces (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        chat_id     TEXT NOT NULL,
        type        TEXT NOT NULL DEFAULT 'reactivation',
        input_data  TEXT NOT NULL,
        output_data TEXT NOT NULL,
        meta        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_traces_agent ON ai_traces(agent_id, created_at);
    `);
  }

  // ─── Agents ───────────────────────────────────────────────────────────────

  saveAgent(r: AgentRecord): void {
    this.db
      .prepare(`
      INSERT OR REPLACE INTO tg_agents
        (id, name, type, status, credentials, behaviors, created_at, updated_at, last_error, stats)
      VALUES
        (@id,@name,@type,@status,@credentials,@behaviors,@createdAt,@updatedAt,@lastError,@stats)
    `)
      .run({
        id: r.id,
        name: r.name,
        type: r.type,
        status: r.status,
        credentials: JSON.stringify(r.credentials),
        behaviors: JSON.stringify(r.behaviors),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        lastError: r.lastError ?? null,
        stats: JSON.stringify(r.stats),
      });
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.db.prepare("SELECT * FROM tg_agents WHERE id = ?").get(id) as any;
    return row ? this.toRecord(row) : null;
  }

  getAllAgents(): AgentRecord[] {
    return (this.db.prepare("SELECT * FROM tg_agents ORDER BY created_at DESC").all() as any[]).map(
      this.toRecord,
    );
  }

  updateStatus(id: string, status: string, lastError?: string): void {
    this.db
      .prepare(`UPDATE tg_agents SET status=?,last_error=?,updated_at=? WHERE id=?`)
      .run(status, lastError ?? null, new Date().toISOString(), id);
  }

  updateBehaviors(id: string, behaviors: BehaviorConfig[]): void {
    this.db
      .prepare(`UPDATE tg_agents SET behaviors=?,updated_at=? WHERE id=?`)
      .run(JSON.stringify(behaviors), new Date().toISOString(), id);
  }

  updateSession(id: string, sessionString: string): void {
    const row = this.db.prepare("SELECT credentials FROM tg_agents WHERE id=?").get(id) as any;
    if (!row) return;
    const creds = JSON.parse(row.credentials);
    creds.sessionString = sessionString;
    this.db
      .prepare(`UPDATE tg_agents SET credentials=?,updated_at=? WHERE id=?`)
      .run(JSON.stringify(creds), new Date().toISOString(), id);
  }

  incrementStat(id: string, field: "sent" | "received" | "parsed"): void {
    const row = this.db.prepare("SELECT stats FROM tg_agents WHERE id=?").get(id) as any;
    if (!row) return;
    const stats = JSON.parse(row.stats);
    stats[field] = (stats[field] || 0) + 1;
    this.db.prepare("UPDATE tg_agents SET stats=? WHERE id=?").run(JSON.stringify(stats), id);
  }

  deleteAgent(id: string): void {
    this.db.prepare("DELETE FROM tg_agents WHERE id=?").run(id);
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  saveEvent(e: TelegramEvent): void {
    this.db
      .prepare(`
      INSERT INTO tg_events (agent_id, agent_name, type, payload, ts)
      VALUES (?,?,?,?,?)
    `)
      .run(e.agentId, e.agentName, e.type, JSON.stringify(e.payload), e.timestamp);
  }

  getEvents(agentId?: string, limit = 200): TelegramEvent[] {
    const rows = agentId
      ? (this.db
          .prepare("SELECT * FROM tg_events WHERE agent_id=? ORDER BY id DESC LIMIT ?")
          .all(agentId, limit) as any[])
      : (this.db.prepare("SELECT * FROM tg_events ORDER BY id DESC LIMIT ?").all(limit) as any[]);
    return rows.map((r) => ({
      agentId: r.agent_id,
      agentName: r.agent_name,
      type: r.type,
      payload: JSON.parse(r.payload),
      timestamp: r.ts,
    }));
  }

  // ─── Parsed data ──────────────────────────────────────────────────────────

  saveParsed(agentId: string, source: string, dataType: string, content: unknown): void {
    this.db
      .prepare(`
      INSERT INTO tg_parsed (agent_id, source, data_type, content, captured)
      VALUES (?,?,?,?,?)
    `)
      .run(agentId, source, dataType, JSON.stringify(content), new Date().toISOString());
  }

  getParsed(agentId: string, limit = 1000): any[] {
    return (
      this.db
        .prepare("SELECT * FROM tg_parsed WHERE agent_id=? ORDER BY id DESC LIMIT ?")
        .all(agentId, limit) as any[]
    ).map((r) => ({ ...r, content: JSON.parse(r.content) }));
  }

  // ─── Missions ─────────────────────────────────────────────────────────────

  saveMission(mission: AgentMission): void {
    this.db
      .prepare(`
      INSERT OR REPLACE INTO agent_missions
        (id, master_agent_id, title, goal, system_prompt, participant_agent_ids, status, created_at, completed_at)
      VALUES
        (@id, @masterAgentId, @title, @goal, @systemPrompt, @participantAgentIds, @status, @createdAt, @completedAt)
    `)
      .run({
        id: mission.id,
        masterAgentId: mission.masterAgentId,
        title: mission.title,
        goal: mission.goal,
        systemPrompt: mission.systemPrompt ?? null,
        participantAgentIds: JSON.stringify(mission.participantAgentIds),
        status: mission.status,
        createdAt: mission.createdAt,
        completedAt: mission.completedAt ?? null,
      });
  }

  getMission(id: string): AgentMission | null {
    const row = this.db.prepare("SELECT * FROM agent_missions WHERE id = ?").get(id) as any;
    return row ? this.toMission(row) : null;
  }

  getAllMissions(): AgentMission[] {
    return (
      this.db.prepare("SELECT * FROM agent_missions ORDER BY created_at DESC").all() as any[]
    ).map(this.toMission);
  }

  updateMissionStatus(id: string, status: string, completedAt?: string): void {
    this.db
      .prepare("UPDATE agent_missions SET status=?, completed_at=? WHERE id=?")
      .run(status, completedAt ?? null, id);
  }

  deleteMission(id: string): void {
    this.db.prepare("DELETE FROM agent_missions WHERE id=?").run(id);
  }

  // ─── Communication messages ───────────────────────────────────────────────

  saveCommMessage(msg: AgentCommunicationMessage): void {
    this.db
      .prepare(`
      INSERT OR REPLACE INTO agent_communication_messages
        (id, from_agent_id, from_agent_name, to_agent_id, content, mission_id, timestamp, reply_to_id)
      VALUES
        (@id, @fromAgentId, @fromAgentName, @toAgentId, @content, @missionId, @timestamp, @replyToId)
    `)
      .run({
        id: msg.id,
        fromAgentId: msg.fromAgentId,
        fromAgentName: msg.fromAgentName,
        toAgentId: msg.toAgentId,
        content: msg.content,
        missionId: msg.missionId,
        timestamp: msg.timestamp,
        replyToId: msg.replyToId ?? null,
      });
  }

  getCommMessages(missionId: string, limit = 100): AgentCommunicationMessage[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM agent_communication_messages WHERE mission_id=? ORDER BY timestamp ASC LIMIT ?",
        )
        .all(missionId, limit) as any[]
    ).map(this.toCommMessage);
  }

  // ─── Conversation history ─────────────────────────────────────────────────

  /** Load persisted AI conversation history for a given chat key. */
  loadConversationHistory(chatKey: string): { role: "user" | "assistant"; content: string }[] {
    const row = this.db
      .prepare("SELECT messages FROM tg_conversations WHERE chat_key=?")
      .get(chatKey) as { messages: string } | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.messages);
    } catch {
      // Corrupted row — return empty so the conversation restarts cleanly.
      return [];
    }
  }

  /**
   * Return the ISO timestamp of the last saved message for this chat,
   * or null when there is no prior conversation.
   * Used to compute elapsed time since last contact.
   */
  getConversationLastAt(chatKey: string): string | null {
    const row = this.db
      .prepare("SELECT updated_at FROM tg_conversations WHERE chat_key=?")
      .get(chatKey) as { updated_at: string } | undefined;
    return row?.updated_at ?? null;
  }

  /** Persist AI conversation history for a given chat key. */
  saveConversationHistory(
    chatKey: string,
    messages: { role: "user" | "assistant"; content: string }[],
  ): void {
    let serialized: string;
    try {
      serialized = JSON.stringify(messages);
    } catch {
      // Non-serializable content (should never happen with Anthropic responses,
      // but guard defensively to avoid crashing the caller).
      return;
    }
    this.db
      .prepare(`
        INSERT INTO tg_conversations (chat_key, messages, updated_at)
        VALUES (?,?,?)
        ON CONFLICT(chat_key) DO UPDATE SET messages=excluded.messages, updated_at=excluded.updated_at
      `)
      .run(chatKey, serialized, new Date().toISOString());
  }

  // ─── Chat Nodes ───────────────────────────────────────────────────────────

  saveChatNode(node: ChatNode): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO tg_chat_nodes
          (id, agent_id, role, text, next_node_id, branches, position, created_at)
        VALUES
          (@id, @agentId, @role, @text, @nextNodeId, @branches, @position, @createdAt)
      `)
      .run({
        id: node.id,
        agentId: node.agentId,
        role: node.role,
        text: node.text,
        nextNodeId: node.nextNodeId ?? null,
        branches: JSON.stringify(node.branches ?? []),
        position: node.position ? JSON.stringify(node.position) : null,
        createdAt: node.createdAt,
      });
  }

  getChatNodes(agentId: string): ChatNode[] {
    return (
      this.db
        .prepare("SELECT * FROM tg_chat_nodes WHERE agent_id = ? ORDER BY created_at ASC")
        .all(agentId) as any[]
    ).map(this.toChatNode);
  }

  deleteChatNode(id: string): void {
    this.db.prepare("DELETE FROM tg_chat_nodes WHERE id = ?").run(id);
  }

  clearChatNodes(agentId: string): void {
    this.db.prepare("DELETE FROM tg_chat_nodes WHERE agent_id = ?").run(agentId);
  }

  // ─── Flow Nodes ───────────────────────────────────────────────────────────

  saveFlowNode(node: FlowNode): void {
    const scope = node.scope ?? "personal";
    this.db
      .prepare(`
        INSERT OR REPLACE INTO tg_flow_nodes
          (id, agent_id, scope, title, description, chat_node_ids, next_flow_node_ids, position, created_at)
        VALUES
          (@id, @agentId, @scope, @title, @description, @chatNodeIds, @nextFlowNodeIds, @position, @createdAt)
      `)
      .run({
        id: node.id,
        agentId: node.agentId,
        scope,
        title: node.title,
        description: node.description ?? null,
        chatNodeIds: JSON.stringify(node.chatNodeIds),
        nextFlowNodeIds: JSON.stringify(node.nextFlowNodeIds),
        position: node.position ? JSON.stringify(node.position) : null,
        createdAt: node.createdAt,
      });
  }

  /** Get flow nodes by agent + scope.
   * personal: rows owned by agentId with scope='personal'
   * shared: all rows with scope='shared' (cross-agent)
   */
  getFlowNodes(agentId: string, scope: "personal" | "shared" = "personal"): FlowNode[] {
    const sql =
      scope === "shared"
        ? "SELECT * FROM tg_flow_nodes WHERE scope = 'shared' ORDER BY created_at ASC"
        : "SELECT * FROM tg_flow_nodes WHERE agent_id = ? AND scope = 'personal' ORDER BY created_at ASC";
    const rows = (
      scope === "shared" ? this.db.prepare(sql).all() : this.db.prepare(sql).all(agentId)
    ) as Array<Record<string, unknown>>;
    return rows.map(this.toFlowNode);
  }

  deleteFlowNode(id: string): void {
    this.db.prepare("DELETE FROM tg_flow_nodes WHERE id = ?").run(id);
  }

  // ─── Training Pairs ───────────────────────────────────────────────────────

  saveTrainingPairs(pairs: TrainingPair[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO tg_training_pairs (id, agent_id, input, response, source_file, created_at)
      VALUES (@id, @agentId, @input, @response, @sourceFile, @createdAt)
    `);
    const insertMany = this.db.transaction((rows: TrainingPair[]) => {
      for (const p of rows) {
        stmt.run({
          id: p.id,
          agentId: p.agentId,
          input: p.input,
          response: p.response,
          sourceFile: p.sourceFile,
          createdAt: p.createdAt,
        });
      }
    });
    insertMany(pairs);
  }

  getTrainingPairs(agentId: string): TrainingPair[] {
    return (
      this.db
        .prepare("SELECT * FROM tg_training_pairs WHERE agent_id = ? ORDER BY created_at ASC")
        .all(agentId) as any[]
    ).map(this.toTrainingPair);
  }

  clearTrainingPairs(agentId: string): void {
    this.db.prepare("DELETE FROM tg_training_pairs WHERE agent_id = ?").run(agentId);
  }

  // ─── Training Snapshots ───────────────────────────────────────────────────

  /** Persist the full training UI state (groups, labels, analysisResults) as a JSON blob. */
  saveTrainingSnapshot(agentId: string, scope: string, data: Record<string, unknown>): void {
    // Shared scope uses a sentinel agent_id so every agent reads/writes the same row.
    const effectiveId = scope === "shared" ? TelegramStorage.SHARED_ID : agentId;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tg_training_snapshots (agent_id, scope, data_json, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(effectiveId, scope, JSON.stringify(data), new Date().toISOString());
  }

  /** Retrieve a previously saved training snapshot, or null if not found. */
  getTrainingSnapshot(agentId: string, scope: string): Record<string, unknown> | null {
    const effectiveId = scope === "shared" ? TelegramStorage.SHARED_ID : agentId;
    const row = this.db
      .prepare("SELECT data_json FROM tg_training_snapshots WHERE agent_id = ? AND scope = ?")
      .get(effectiveId, scope) as any;
    if (!row) return null;
    try {
      return JSON.parse(row.data_json) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  // ─── Diagram knowledge base ──────────────────────────────────────────────

  /**
   * Retrieve the AI-distributed knowledge base for a given agent + scope.
   * Returns null when no knowledge base has been saved yet.
   */
  getKnowledgeBase(agentId: string, scope: "personal" | "shared"): Record<string, unknown> | null {
    const effectiveId = scope === "shared" ? TelegramStorage.SHARED_ID : agentId;
    const row = this.db
      .prepare("SELECT data_json FROM tg_diagram_knowledge WHERE agent_id = ? AND scope = ?")
      .get(effectiveId, scope) as { data_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data_json) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Persist the knowledge base for an agent + scope, replacing any previous value. */
  saveKnowledgeBase(
    agentId: string,
    scope: "personal" | "shared",
    data: Record<string, unknown>,
  ): void {
    const effectiveId = scope === "shared" ? TelegramStorage.SHARED_ID : agentId;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tg_diagram_knowledge (agent_id, scope, data_json, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(effectiveId, scope, JSON.stringify(data), new Date().toISOString());
  }

  // ─── Coaching tips ───────────────────────────────────────────────────────

  /** Load all coaching tips for an agent (or shared pool), keyed by chatId. */
  getCoachingTips(
    agentId: string,
    scope: "personal" | "shared" = "personal",
  ): Record<string, { chatId: string; content: string; generatedAt: string }> {
    const effectiveId = scope === "shared" ? TelegramStorage.SHARED_ID : agentId;
    const rows = this.db
      .prepare(
        "SELECT chat_id, content, generated_at FROM tg_coaching_tips WHERE agent_id = ? ORDER BY generated_at DESC",
      )
      .all(effectiveId) as Array<{ chat_id: string; content: string; generated_at: string }>;
    const result: Record<string, { chatId: string; content: string; generatedAt: string }> = {};
    for (const row of rows) {
      result[row.chat_id] = {
        chatId: row.chat_id,
        content: row.content,
        generatedAt: row.generated_at,
      };
    }
    return result;
  }

  /** Persist a single coaching tip, replacing any previous value. */
  saveCoachingTip(
    agentId: string,
    chatId: string,
    content: string,
    generatedAt: string,
    scope: "personal" | "shared" = "personal",
  ): void {
    const effectiveId = scope === "shared" ? TelegramStorage.SHARED_ID : agentId;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tg_coaching_tips (agent_id, chat_id, content, generated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(effectiveId, chatId, content, generatedAt);
  }

  // ─── Agent settings (work mode, schedule, active diagram) ────────────────

  /** Load settings for an agent. Returns defaults when no row exists yet. */
  getAgentSettings(agentId: string): AgentSettings {
    const row = this.db
      .prepare("SELECT settings_json FROM tg_agent_settings WHERE agent_id = ?")
      .get(agentId) as { settings_json: string } | undefined;
    const defaults: AgentSettings = { useSchema: false, scheduleMode: "always", replyTo: "all" };
    if (!row) return defaults;
    try {
      const parsed = JSON.parse(row.settings_json) as AgentSettings;
      // Migrate legacy workMode field to new independent flags
      if ((parsed as unknown as Record<string, unknown>)["workMode"] && !parsed.scheduleMode) {
        const legacy = (parsed as unknown as Record<string, unknown>)["workMode"] as string;
        parsed.scheduleMode = legacy === "schedule" ? "schedule" : "always";
        parsed.useSchema = legacy === "schema";
      }
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  }

  /** Persist settings for an agent. */
  saveAgentSettings(agentId: string, settings: AgentSettings): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tg_agent_settings (agent_id, settings_json, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(agentId, JSON.stringify(settings), new Date().toISOString());
  }

  // ─── Conversation script state (schema work mode) ─────────────────────────

  /**
   * Return the diagram node ID where this conversation is currently at.
   * Returns null if the conversation has no tracked state (new or completed).
   */
  getConversationNodeId(agentId: string, chatId: string): string | null {
    const row = this.db
      .prepare("SELECT node_id FROM tg_conversation_state WHERE agent_id = ? AND chat_id = ?")
      .get(agentId, chatId) as { node_id: string } | undefined;
    return row?.node_id ?? null;
  }

  /** Upsert the current diagram node position for this conversation. */
  setConversationNodeId(agentId: string, chatId: string, nodeId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tg_conversation_state (agent_id, chat_id, node_id, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(agentId, chatId, nodeId, new Date().toISOString());
  }

  /** Return all tracked conversation states for an agent (chatId → nodeId). */
  getAllConversationStates(agentId: string): Array<{ chatId: string; nodeId: string }> {
    const rows = this.db
      .prepare("SELECT chat_id, node_id FROM tg_conversation_state WHERE agent_id = ?")
      .all(agentId) as Array<{ chat_id: string; node_id: string }>;
    return rows.map((r) => ({ chatId: r.chat_id, nodeId: r.node_id }));
  }

  /** Remove the conversation state (called when the script reaches an end node). */
  deleteConversationState(agentId: string, chatId: string): void {
    this.db
      .prepare("DELETE FROM tg_conversation_state WHERE agent_id = ? AND chat_id = ?")
      .run(agentId, chatId);
  }

  // ─── Per-client long-term memory ────────────────────────────────────────

  /** Load the accumulated memory for a specific client chat. */
  getChatMemory(
    agentId: string,
    chatId: string,
  ): { memoryText: string; sessionsCount: number } | null {
    const row = this.db
      .prepare(
        "SELECT memory_text, sessions_count FROM tg_chat_memories WHERE agent_id = ? AND chat_id = ?",
      )
      .get(agentId, chatId) as { memory_text: string; sessions_count: number } | undefined;
    if (!row || !row.memory_text) return null;
    return { memoryText: row.memory_text, sessionsCount: row.sessions_count };
  }

  /** Persist updated memory for a specific client chat. */
  saveChatMemory(agentId: string, chatId: string, memoryText: string, sessionsCount: number): void {
    this.db
      .prepare(
        `INSERT INTO tg_chat_memories (agent_id, chat_id, memory_text, sessions_count, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, chat_id) DO UPDATE SET
           memory_text    = excluded.memory_text,
           sessions_count = excluded.sessions_count,
           updated_at     = excluded.updated_at`,
      )
      .run(agentId, chatId, memoryText, sessionsCount, new Date().toISOString());
  }

  // ─── Lead records ────────────────────────────────────────────────────────

  saveLead(lead: import("../types.js").TelegramLead): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tg_leads (id, agent_id, chat_id, data_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lead.id,
        lead.agentId,
        lead.chatId,
        JSON.stringify(lead),
        lead.createdAt,
        lead.updatedAt,
      );
  }

  getLeads(agentId: string): import("../types.js").TelegramLead[] {
    const rows = this.db
      .prepare("SELECT data_json FROM tg_leads WHERE agent_id = ? ORDER BY created_at DESC")
      .all(agentId) as Array<{ data_json: string }>;
    return rows.map((r) => JSON.parse(r.data_json) as import("../types.js").TelegramLead);
  }

  deleteLead(leadId: string): void {
    this.db.prepare("DELETE FROM tg_leads WHERE id = ?").run(leadId);
  }

  /** Insert or merge fields into a lead keyed by agent+chat. */
  upsertLeadFields(
    agentId: string,
    chatId: string,
    fields: Partial<import("../types.js").TelegramLead>,
  ): void {
    const row = this.db
      .prepare("SELECT data_json FROM tg_leads WHERE agent_id = ? AND chat_id = ?")
      .get(agentId, chatId) as { data_json: string } | undefined;
    const now = new Date().toISOString();
    const lead: import("../types.js").TelegramLead = row
      ? { ...JSON.parse(row.data_json), ...fields, updatedAt: now }
      : { id: `${agentId}:${chatId}`, agentId, chatId, createdAt: now, updatedAt: now, ...fields };
    this.saveLead(lead);
  }

  // ─── Contact registry ────────────────────────────────────────────────────

  /** Upsert contact info; always updates last_client_msg_at to now. */
  upsertContact(
    agentId: string,
    chatId: string,
    info: { firstName?: string; lastName?: string; username?: string },
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tg_contacts (agent_id, chat_id, first_name, last_name, username, last_client_msg_at, first_msg_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, chat_id) DO UPDATE SET
           first_name         = COALESCE(excluded.first_name, first_name),
           last_name          = COALESCE(excluded.last_name, last_name),
           username           = COALESCE(excluded.username, username),
           last_client_msg_at = excluded.last_client_msg_at`,
      )
      .run(
        agentId,
        chatId,
        info.firstName ?? null,
        info.lastName ?? null,
        info.username ?? null,
        now,
        now,
      );
  }

  /**
   * Return contacts whose last_client_msg_at falls in the window
   * [windowStart, windowEnd) and haven't had a re-engagement sent for
   * the given delayDays+periodRef combination.
   */
  getContactsForReEngagement(
    agentId: string,
    delayDays: number,
    windowStart: string,
    windowEnd: string,
  ): Array<{
    chatId: string;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    lastClientMsgAt: string;
  }> {
    return this.db
      .prepare(
        `SELECT c.chat_id as chatId, c.first_name as firstName, c.last_name as lastName,
                c.username as username, c.last_client_msg_at as lastClientMsgAt
         FROM tg_contacts c
         WHERE c.agent_id = ?
           AND c.last_client_msg_at >= ?
           AND c.last_client_msg_at < ?
           AND CAST(c.chat_id AS INTEGER) > 0
           AND NOT EXISTS (
             SELECT 1 FROM tg_reengagement r
             WHERE r.agent_id = c.agent_id
               AND r.chat_id = c.chat_id
               AND r.delay_days = ?
               AND r.period_ref = c.last_client_msg_at
           )`,
      )
      .all(agentId, windowStart, windowEnd, delayDays) as Array<{
      chatId: string;
      firstName: string | null;
      lastName: string | null;
      username: string | null;
      lastClientMsgAt: string;
    }>;
  }

  /**
   * Diagnostic counters for a re-engagement exact-day window.
   * Helps explain why `found=0` (no contacts in window vs deduped by tg_reengagement).
   */
  getReEngagementWindowStats(
    agentId: string,
    delayDays: number,
    windowStart: string,
    windowEnd: string,
  ): {
    trackedTotal: number;
    inWindow: number;
    dedupBlocked: number;
    eligible: number;
  } {
    const trackedTotal = Number(
      (
        this.db.prepare(`SELECT COUNT(*) AS n FROM tg_contacts WHERE agent_id = ?`).get(agentId) as
          | { n?: number }
          | undefined
      )?.n ?? 0,
    );
    const inWindow = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n
           FROM tg_contacts
           WHERE agent_id = ?
             AND last_client_msg_at >= ?
             AND last_client_msg_at < ?`,
          )
          .get(agentId, windowStart, windowEnd) as { n?: number } | undefined
      )?.n ?? 0,
    );
    const eligible = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n
           FROM tg_contacts c
           WHERE c.agent_id = ?
             AND c.last_client_msg_at >= ?
             AND c.last_client_msg_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM tg_reengagement r
               WHERE r.agent_id = c.agent_id
                 AND r.chat_id = c.chat_id
                 AND r.delay_days = ?
                 AND r.period_ref = c.last_client_msg_at
             )`,
          )
          .get(agentId, windowStart, windowEnd, delayDays) as { n?: number } | undefined
      )?.n ?? 0,
    );
    return {
      trackedTotal,
      inWindow,
      dedupBlocked: Math.max(0, inWindow - eligible),
      eligible,
    };
  }

  /**
   * Returns contacts silent for MORE than `olderThanDays` days who haven't
   * received an "и более" re-engagement (delay_days=9999) in the past
   * `olderThanDays` days.
   */
  getContactsForReEngagementMore(
    agentId: string,
    olderThanDays: number,
  ): Array<{
    chatId: string;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    lastClientMsgAt: string;
  }> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const cooloffStart = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare(
        `SELECT c.chat_id as chatId, c.first_name as firstName, c.last_name as lastName,
                c.username as username, c.last_client_msg_at as lastClientMsgAt
         FROM tg_contacts c
         WHERE c.agent_id = ?
           AND c.last_client_msg_at < ?
           AND CAST(c.chat_id AS INTEGER) > 0
           AND NOT EXISTS (
             SELECT 1 FROM tg_reengagement r
             WHERE r.agent_id = c.agent_id
               AND r.chat_id = c.chat_id
               AND r.delay_days = 9999
               AND r.sent_at >= ?
           )`,
      )
      .all(agentId, cutoff, cooloffStart) as Array<{
      chatId: string;
      firstName: string | null;
      lastName: string | null;
      username: string | null;
      lastClientMsgAt: string;
    }>;
  }

  /**
   * Diagnostic counters for `delayMore` mode (>N days inactive).
   */
  getReEngagementMoreStats(
    agentId: string,
    olderThanDays: number,
  ): {
    trackedTotal: number;
    olderThanCutoff: number;
    cooloffBlocked: number;
    eligible: number;
  } {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const cooloffStart = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

    const trackedTotal = Number(
      (
        this.db.prepare(`SELECT COUNT(*) AS n FROM tg_contacts WHERE agent_id = ?`).get(agentId) as
          | { n?: number }
          | undefined
      )?.n ?? 0,
    );
    const olderThanCutoff = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n
           FROM tg_contacts
           WHERE agent_id = ?
             AND last_client_msg_at < ?`,
          )
          .get(agentId, cutoff) as { n?: number } | undefined
      )?.n ?? 0,
    );
    const eligible = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n
           FROM tg_contacts c
           WHERE c.agent_id = ?
             AND c.last_client_msg_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM tg_reengagement r
               WHERE r.agent_id = c.agent_id
                 AND r.chat_id = c.chat_id
                 AND r.delay_days = 9999
                 AND r.sent_at >= ?
             )`,
          )
          .get(agentId, cutoff, cooloffStart) as { n?: number } | undefined
      )?.n ?? 0,
    );

    return {
      trackedTotal,
      olderThanCutoff,
      cooloffBlocked: Math.max(0, olderThanCutoff - eligible),
      eligible,
    };
  }

  /**
   * Return all contacts for an agent with their last activity timestamps.
   * Used for diagnostics when re-engagement finds 0 contacts.
   */
  getAllContactsDebug(agentId: string): Array<{
    chatId: string;
    firstName: string | null;
    username: string | null;
    lastClientMsgAt: string;
    sentDays: string; // comma-sep list of delay_days already sent
  }> {
    return this.db
      .prepare(
        `SELECT c.chat_id as chatId, c.first_name as firstName, c.username as username,
                c.last_client_msg_at as lastClientMsgAt,
                COALESCE(GROUP_CONCAT(r.delay_days), '') as sentDays
         FROM tg_contacts c
         LEFT JOIN tg_reengagement r ON r.agent_id = c.agent_id AND r.chat_id = c.chat_id
         WHERE c.agent_id = ?
           AND CAST(c.chat_id AS INTEGER) > 0
         GROUP BY c.chat_id
         ORDER BY c.last_client_msg_at DESC
         LIMIT 30`,
      )
      .all(agentId) as Array<{
      chatId: string;
      firstName: string | null;
      username: string | null;
      lastClientMsgAt: string;
      sentDays: string;
    }>;
  }

  /** Record that a re-engagement message was sent for this contact+delay. */
  markReEngagementSent(
    agentId: string,
    chatId: string,
    delayDays: number,
    periodRef: string,
    messageText?: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tg_reengagement (agent_id, chat_id, delay_days, period_ref, sent_at, message_text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(agentId, chatId, delayDays, periodRef, new Date().toISOString(), messageText ?? null);
  }

  /**
   * Return the most recent re-engagement sends for an agent, newest first.
   * Includes the contact name and the actual message text that was sent.
   */
  getReEngagementHistory(
    agentId: string,
    limit = 20,
  ): Array<{
    chatId: string;
    firstName: string | null;
    username: string | null;
    sentAt: string;
    delayDays: number;
    messageText: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT r.chat_id AS chatId,
                c.first_name AS firstName,
                c.username AS username,
                r.sent_at AS sentAt,
                r.delay_days AS delayDays,
                r.message_text AS messageText
         FROM tg_reengagement r
         LEFT JOIN tg_contacts c ON c.agent_id = r.agent_id AND c.chat_id = r.chat_id
         WHERE r.agent_id = ?
         ORDER BY r.sent_at DESC
         LIMIT ?`,
      )
      .all(agentId, limit) as Array<{
      chatId: string;
      firstName: string | null;
      username: string | null;
      sentAt: string;
      delayDays: number;
      messageText: string | null;
    }>;
  }

  /**
   * Delete a specific re-engagement history item.
   */
  deleteReEngagementHistoryItem(agentId: string, chatId: string, sentAt: string): void {
    this.db
      .prepare(
        `DELETE FROM tg_reengagement_history
         WHERE agent_id = ? AND chat_id = ? AND sent_at = ?`,
      )
      .run(agentId, chatId, sentAt);
  }

  // ─── AI Traces (audit log for AI generation) ─────────────────────────────

  /** Save a full AI generation trace (fire-and-forget safe — never throws). */
  saveAiTrace(trace: {
    id: string;
    agentId: string;
    chatId: string;
    type: string;
    inputData: Record<string, unknown>;
    outputData: Record<string, unknown>;
    meta: Record<string, unknown>;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO ai_traces (id, agent_id, chat_id, type, input_data, output_data, meta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          trace.id,
          trace.agentId,
          trace.chatId,
          trace.type,
          JSON.stringify(trace.inputData),
          JSON.stringify(trace.outputData),
          JSON.stringify(trace.meta),
          new Date().toISOString(),
        );
    } catch {
      // Never throw — tracing must not affect main flow
    }
  }

  /** Return recent AI traces for an agent, newest first. */
  getAiTraces(
    agentId: string,
    limit = 30,
  ): Array<{
    id: string;
    chatId: string;
    type: string;
    inputData: string;
    outputData: string;
    meta: string;
    createdAt: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, chat_id AS chatId, type, input_data AS inputData,
                output_data AS outputData, meta, created_at AS createdAt
         FROM ai_traces
         WHERE agent_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(agentId, limit) as Array<{
      id: string;
      chatId: string;
      type: string;
      inputData: string;
      outputData: string;
      meta: string;
      createdAt: string;
    }>;
  }

  /**
   * Returns true if a re-engagement message was sent to this chat within the
   * last `withinDays` days. Used to decide whether to respond to incoming
   * messages in "silent" offline mode.
   */
  wasRecentlyReEngaged(agentId: string, chatId: string, withinDays: number): boolean {
    const since = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000).toISOString();
    const row = this.db
      .prepare(
        `SELECT 1 FROM tg_reengagement
         WHERE agent_id = ? AND chat_id = ? AND sent_at >= ?
         LIMIT 1`,
      )
      .get(agentId, chatId, since);
    return !!row;
  }

  // ─── Follow-up queue ─────────────────────────────────────────────────────

  /** Save a scheduled follow-up message to the queue. */
  addFollowup(id: string, agentId: string, chatId: string, chatKey: string, sendAt: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tg_followup_queue (id, agent_id, chat_id, chat_key, send_at, sent, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(id, agentId, chatId, chatKey, sendAt, new Date().toISOString());
  }

  /** Return all unsent follow-ups for an agent (including future ones — for re-scheduling on restart). */
  getAllPendingFollowups(
    agentId: string,
  ): Array<{ id: string; chatId: string; chatKey: string; sendAt: string }> {
    return this.db
      .prepare(
        `SELECT id, chat_id as chatId, chat_key as chatKey, send_at as sendAt
           FROM tg_followup_queue WHERE agent_id = ? AND sent = 0 ORDER BY send_at ASC`,
      )
      .all(agentId) as Array<{ id: string; chatId: string; chatKey: string; sendAt: string }>;
  }

  /** Mark a follow-up as sent so it won't fire again. */
  markFollowupSent(id: string): void {
    this.db.prepare("UPDATE tg_followup_queue SET sent = 1 WHERE id = ?").run(id);
  }

  /** Cancel all pending follow-ups for a specific chat (e.g. client replied on their own). */
  cancelFollowupsForChat(agentId: string, chatId: string): void {
    this.db
      .prepare(
        "UPDATE tg_followup_queue SET sent = 1 WHERE agent_id = ? AND chat_id = ? AND sent = 0",
      )
      .run(agentId, chatId);
  }

  // ─── Agent workspace ─────────────────────────────────────────────────────

  /** Returns the workspace directory path for a given agent (may not exist yet). */
  getAgentWorkspaceDir(agentId: string): string {
    return path.join(this.dataDir, "agents", agentId, "workspace");
  }

  // ─── Plugin credentials config ───────────────────────────────────────────

  /** Persist apiId + apiHash to a JSON file in the plugin data directory. */
  savePluginConfig(cfg: TelegramPluginConfig): void {
    fs.writeFileSync(this.configFile, JSON.stringify(cfg, null, 2), "utf-8");
  }

  /**
   * Load apiId + apiHash.
   * Priority: plugin-config.json → TG_API_ID / TG_API_HASH env vars.
   * Returns null when neither source has both values.
   */
  loadPluginConfig(): TelegramPluginConfig | null {
    let apiId = 0;
    let apiHash = "";

    let proxy: ProxyConfig | undefined;

    // Try file-based config first
    try {
      if (fs.existsSync(this.configFile)) {
        const data = JSON.parse(fs.readFileSync(this.configFile, "utf-8")) as Record<
          string,
          unknown
        >;
        apiId = parseInt(String(data.apiId ?? "0"), 10);
        apiHash = String(data.apiHash ?? "");
        // Load optional proxy config
        if (data.proxy && typeof data.proxy === "object") {
          const p = data.proxy as Record<string, unknown>;
          const pIp = String(p.ip ?? "").trim();
          const pPort = parseInt(String(p.port ?? "0"), 10);
          if (pIp && pPort) {
            proxy = {
              socksType: 5,
              ip: pIp,
              port: pPort,
              ...(p.username ? { username: String(p.username) } : {}),
              ...(p.password ? { password: String(p.password) } : {}),
            };
          }
        }
      }
    } catch {
      // ignore parse errors, fall through to env
    }

    // Env vars override or fill in missing values
    if (process.env.TG_API_ID) apiId = parseInt(process.env.TG_API_ID, 10);
    if (process.env.TG_API_HASH) apiHash = process.env.TG_API_HASH;

    if (!apiId || !apiHash) return null;
    return { apiId, apiHash, ...(proxy ? { proxy } : {}) };
  }

  private toChatNode(row: any): ChatNode {
    return {
      id: row.id,
      agentId: row.agent_id,
      role: row.role,
      text: row.text,
      nextNodeId: row.next_node_id ?? undefined,
      branches: JSON.parse(row.branches ?? "[]"),
      position: row.position ? JSON.parse(row.position) : undefined,
      createdAt: row.created_at,
    };
  }

  private toFlowNode(row: Record<string, unknown>): FlowNode {
    const scope = (row.scope as string | undefined) ?? "personal";
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      scope: scope === "shared" ? "shared" : "personal",
      title: row.title as string,
      description: (row.description as string | undefined) ?? undefined,
      chatNodeIds: JSON.parse((row.chat_node_ids as string) ?? "[]"),
      nextFlowNodeIds: JSON.parse((row.next_flow_node_ids as string) ?? "[]"),
      position: row.position ? JSON.parse(row.position as string) : undefined,
      createdAt: row.created_at as string,
    };
  }

  private toTrainingPair(row: any): TrainingPair {
    return {
      id: row.id,
      agentId: row.agent_id,
      input: row.input,
      response: row.response,
      sourceFile: row.source_file,
      createdAt: row.created_at,
    };
  }

  private toRecord(row: any): AgentRecord {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      credentials: JSON.parse(row.credentials),
      behaviors: JSON.parse(row.behaviors),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError: row.last_error ?? undefined,
      stats: JSON.parse(row.stats),
    };
  }

  private toMission(row: any): AgentMission {
    return {
      id: row.id,
      masterAgentId: row.master_agent_id,
      title: row.title,
      goal: row.goal,
      systemPrompt: row.system_prompt ?? undefined,
      participantAgentIds: JSON.parse(row.participant_agent_ids),
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
    };
  }

  private toCommMessage(row: any): AgentCommunicationMessage {
    return {
      id: row.id,
      fromAgentId: row.from_agent_id,
      fromAgentName: row.from_agent_name,
      toAgentId: row.to_agent_id,
      content: row.content,
      missionId: row.mission_id,
      timestamp: row.timestamp,
      replyToId: row.reply_to_id ?? undefined,
    };
  }

  // ─── Flow Diagrams ────────────────────────────────────────────────────────

  getDiagram(agentId: string, scope: "personal" | "shared" = "personal"): FlowDiagram | null {
    const effectiveId = scope === "shared" ? TelegramStorage.SHARED_ID : agentId;
    const row = this.db
      .prepare(
        "SELECT * FROM tg_flow_diagrams WHERE agent_id = ? AND scope = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(effectiveId, scope) as Record<string, unknown> | undefined;
    return row ? this.toFlowDiagram(row) : null;
  }

  /** Fetch a single diagram by its primary-key ID (any agent/scope). */
  getDiagramById(id: string): FlowDiagram | null {
    const row = this.db.prepare("SELECT * FROM tg_flow_diagrams WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toFlowDiagram(row) : null;
  }

  /** List all saved diagrams for an agent+scope, newest first. */
  listDiagrams(agentId: string, scope: "personal" | "shared" = "personal"): FlowDiagram[] {
    const effectiveId = scope === "shared" ? TelegramStorage.SHARED_ID : agentId;
    const rows = this.db
      .prepare(
        "SELECT * FROM tg_flow_diagrams WHERE agent_id = ? AND scope = ? ORDER BY updated_at DESC",
      )
      .all(effectiveId, scope) as Record<string, unknown>[];
    return rows.map((r) => this.toFlowDiagram(r));
  }

  /** Delete a diagram by its primary-key id. */
  deleteDiagram(id: string): void {
    this.db.prepare("DELETE FROM tg_flow_diagrams WHERE id = ?").run(id);
  }

  /** Rename a diagram (update title only). */
  renameDiagram(id: string, title: string): void {
    this.db
      .prepare("UPDATE tg_flow_diagrams SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, new Date().toISOString(), id);
  }

  saveDiagram(d: FlowDiagram): void {
    // Use sentinel agent_id for shared diagrams so all agents read the same rows.
    const agentId = d.scope === "shared" ? TelegramStorage.SHARED_ID : d.agentId;
    this.db
      .prepare(`
        INSERT OR REPLACE INTO tg_flow_diagrams
          (id, agent_id, scope, title, nodes_json, edges_json, groups_json, created_at, updated_at)
        VALUES
          (@id, @agentId, @scope, @title, @nodesJson, @edgesJson, @groupsJson, @createdAt, @updatedAt)
      `)
      .run({
        id: d.id,
        agentId,
        scope: d.scope,
        title: d.title,
        nodesJson: JSON.stringify(d.nodes),
        edgesJson: JSON.stringify(d.edges),
        groupsJson: JSON.stringify(d.groups),
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      });
  }

  private toFlowDiagram(row: Record<string, unknown>): FlowDiagram {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      scope: (row.scope as "personal" | "shared") ?? "personal",
      title: row.title as string,
      nodes: JSON.parse((row.nodes_json as string) || "[]"),
      edges: JSON.parse((row.edges_json as string) || "[]"),
      groups: JSON.parse((row.groups_json as string) || "[]"),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
