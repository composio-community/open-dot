import "server-only";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// The desktop app points this at its Application Support folder; in development it's .data/ in the project.
export const DATA_DIR = process.env.DOTS_DATA_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), ".data");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
  look TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', local_access INTEGER NOT NULL DEFAULT 0,
  thread TEXT, pending TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, dot_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', title TEXT,
  card TEXT, source TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_dot ON messages(dot_id, created_at);
CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, dot_id TEXT, action TEXT NOT NULL, decision TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, dot_id TEXT NOT NULL, text TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.65,
  access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, dot_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, dot_id TEXT NOT NULL, name TEXT NOT NULL, instruction TEXT NOT NULL, schedule TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY, dot_id TEXT NOT NULL, composio_id TEXT NOT NULL, slug TEXT NOT NULL, toolkit TEXT NOT NULL,
  name TEXT NOT NULL, config TEXT NOT NULL, instruction TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, dot_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  source TEXT NOT NULL, box_path TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, lead_id TEXT NOT NULL, members TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, dot_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat', ref TEXT,
  thread TEXT, pending TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_dot ON conversations(dot_id, updated_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS passwords (id TEXT PRIMARY KEY, site TEXT NOT NULL, username TEXT NOT NULL, secret TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

const g = globalThis as unknown as { __dotsDb?: DatabaseSync };

export function db(): DatabaseSync {
  if (!g.__dotsDb) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const conn = new DatabaseSync(path.join(DATA_DIR, "dots.db"));
    conn.exec("PRAGMA journal_mode = WAL;");
    conn.exec(SCHEMA);
    migrate(conn);
    g.__dotsDb = conn;
  }
  return g.__dotsDb;
}

/** Additive migrations for databases created by earlier versions. */
function migrate(conn: DatabaseSync) {
  const cols = conn.prepare("PRAGMA table_info(dots)").all().map((c) => (c as { name: string }).name);
  if (!cols.includes("model")) conn.exec("ALTER TABLE dots ADD COLUMN model TEXT");
  if (!cols.includes("box_id")) conn.exec("ALTER TABLE dots ADD COLUMN box_id TEXT");
  const convCols = conn.prepare("PRAGMA table_info(conversations)").all().map((c) => (c as { name: string }).name);
  // Model-facing history for providers that don't keep conversation state (OpenRouter).
  if (convCols.length && !convCols.includes("history")) conn.exec("ALTER TABLE conversations ADD COLUMN history TEXT");
  const msgCols = conn.prepare("PRAGMA table_info(messages)").all().map((c) => (c as { name: string }).name);
  if (!msgCols.includes("attachments")) conn.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
  if (!msgCols.includes("channel_id")) conn.exec("ALTER TABLE messages ADD COLUMN channel_id TEXT");
  if (!msgCols.includes("conversation_id")) {
    conn.exec("ALTER TABLE messages ADD COLUMN conversation_id TEXT");
    // Each dot's existing single chat becomes its first conversation (keeping its model thread).
    const dots = conn.prepare("SELECT id, thread, pending FROM dots").all() as { id: string; thread: string | null; pending: string | null }[];
    for (const d of dots) {
      const span = conn
        .prepare("SELECT MIN(created_at) a, MAX(created_at) b, COUNT(*) n FROM messages WHERE dot_id = ? AND channel_id IS NULL")
        .get(d.id) as { a: number | null; b: number | null; n: number };
      if (!span.n) continue;
      const convId = `conv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      conn.prepare("INSERT INTO conversations (id, dot_id, title, thread, pending, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(convId, d.id, "First chat", d.thread, d.pending, span.a, span.b);
      conn.prepare("UPDATE messages SET conversation_id = ? WHERE dot_id = ? AND channel_id IS NULL").run(convId, d.id);
    }
  }

  conn.exec("CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages(conversation_id, created_at)");

  const memCols = conn.prepare("PRAGMA table_info(memories)").all().map((c) => (c as { name: string }).name);
  if (!memCols.includes("importance")) conn.exec("ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.65");
  if (!memCols.includes("access_count")) conn.exec("ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0");
  if (!memCols.includes("last_accessed_at")) conn.exec("ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER");
  if (!memCols.includes("updated_at")) {
    conn.exec("ALTER TABLE memories ADD COLUMN updated_at INTEGER");
    conn.exec("UPDATE memories SET updated_at = created_at WHERE updated_at IS NULL");
  }
  conn.exec("CREATE INDEX IF NOT EXISTS memories_dot_updated ON memories(dot_id, updated_at)");

  // Memory v3: rowid-keyed local FTS indexes. Rowid deletes/updates avoid scanning an
  // UNINDEXED string id column. Existing content is rebuilt lazily on first memory search so
  // a large chat archive does not block the app's first database call after an upgrade.
  const ftsVersion = conn.prepare("SELECT value FROM settings WHERE key = 'memory_fts_version'").get() as { value?: string } | undefined;
  const hasV3Schema = ftsVersion?.value === "3" || ftsVersion?.value === "3-pending";
  if (!hasV3Schema) {
    conn.exec(`
      DROP TRIGGER IF EXISTS memory_fts_ai;
      DROP TRIGGER IF EXISTS memory_fts_ad;
      DROP TRIGGER IF EXISTS memory_fts_au;
      DROP TRIGGER IF EXISTS message_fts_ai;
      DROP TRIGGER IF EXISTS message_fts_ad;
      DROP TRIGGER IF EXISTS message_fts_au;
      DROP TABLE IF EXISTS memory_fts;
      DROP TABLE IF EXISTS message_fts;
    `);
  }
  conn.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      text, tokenize='unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
      text, tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memories
    WHEN length(trim(new.text)) > 0 BEGIN
      INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memory_fts WHERE rowid = old.rowid;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE OF text, dot_id ON memories BEGIN
      DELETE FROM memory_fts WHERE rowid = old.rowid;
      INSERT INTO memory_fts(rowid, text) SELECT new.rowid, new.text WHERE length(trim(new.text)) > 0;
    END;

    CREATE TRIGGER IF NOT EXISTS message_fts_ai AFTER INSERT ON messages
    WHEN new.role IN ('user', 'dot') AND length(trim(new.text)) > 0 BEGIN
      INSERT INTO message_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS message_fts_ad AFTER DELETE ON messages BEGIN
      DELETE FROM message_fts WHERE rowid = old.rowid;
    END;
    CREATE TRIGGER IF NOT EXISTS message_fts_au AFTER UPDATE OF text, role, dot_id, conversation_id ON messages BEGIN
      DELETE FROM message_fts WHERE rowid = old.rowid;
      INSERT INTO message_fts(rowid, text)
      SELECT new.rowid, new.text WHERE new.role IN ('user', 'dot') AND length(trim(new.text)) > 0;
    END;
  `);
  if (!hasV3Schema) {
    conn.prepare("INSERT INTO settings(key, value) VALUES ('memory_fts_version', '3-pending') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  }

}

export function getSetting(key: string): string | null {
  const r = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setSetting(key: string, value: string | null) {
  if (value === null) db().prepare("DELETE FROM settings WHERE key = ?").run(key);
  else db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
