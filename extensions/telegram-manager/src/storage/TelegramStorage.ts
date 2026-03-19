import fs from "fs";
import path from "path";
// plugins/telegram/src/storage/TelegramStorage.ts
import Database from "better-sqlite3";
import {
  AgentRecord,
  AgentMission,
  AgentCommunicationMessage,
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
};

export class TelegramStorage {
  private db: Database.Database;
  private configFile: string;
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
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tg_training_snapshots (agent_id, scope, data_json, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(agentId, scope, JSON.stringify(data), new Date().toISOString());
  }

  /** Retrieve a previously saved training snapshot, or null if not found. */
  getTrainingSnapshot(agentId: string, scope: string): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT data_json FROM tg_training_snapshots WHERE agent_id = ? AND scope = ?")
      .get(agentId, scope) as any;
    if (!row) return null;
    try {
      return JSON.parse(row.data_json) as Record<string, unknown>;
    } catch {
      return null;
    }
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
    const row = this.db
      .prepare(
        "SELECT * FROM tg_flow_diagrams WHERE agent_id = ? AND scope = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(agentId, scope) as Record<string, unknown> | undefined;
    return row ? this.toFlowDiagram(row) : null;
  }

  saveDiagram(d: FlowDiagram): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO tg_flow_diagrams
          (id, agent_id, scope, title, nodes_json, edges_json, groups_json, created_at, updated_at)
        VALUES
          (@id, @agentId, @scope, @title, @nodesJson, @edgesJson, @groupsJson, @createdAt, @updatedAt)
      `)
      .run({
        id: d.id,
        agentId: d.agentId,
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
