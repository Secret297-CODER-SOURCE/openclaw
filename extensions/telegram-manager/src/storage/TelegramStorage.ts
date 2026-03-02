import fs from "fs";
import path from "path";
// plugins/telegram/src/storage/TelegramStorage.ts
import Database from "better-sqlite3";
import { AgentRecord, BehaviorConfig, TelegramEvent } from "../types";

export class TelegramStorage {
  private db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
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

      CREATE INDEX IF NOT EXISTS idx_tg_events_agent ON tg_events(agent_id);
      CREATE INDEX IF NOT EXISTS idx_tg_parsed_agent ON tg_parsed(agent_id);
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
}
