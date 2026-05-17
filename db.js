'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'agenticos.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    from_user   TEXT,
    direction   TEXT NOT NULL CHECK(direction IN ('in','out')),
    text        TEXT NOT NULL,
    agent_id    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT NOT NULL,
    payload     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scheduler_jobs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    cron        TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    prompt      TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    last_run    TEXT,
    last_status TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mission_tasks (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','error')),
    agent_id     TEXT,
    task_run_id  TEXT,
    priority     TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    started_at   TEXT,
    completed_at TEXT
  );
`);

// Safe migrations for existing DBs
try { db.exec(`ALTER TABLE messages ADD COLUMN agent_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE mission_tasks ADD COLUMN description TEXT`); } catch {}

module.exports = db;
