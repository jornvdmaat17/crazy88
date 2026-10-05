const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS game (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  duration_min INTEGER NOT NULL DEFAULT 60,
  goal_points INTEGER NOT NULL DEFAULT 500,
  started_at INTEGER,
  ends_at INTEGER,
  end_pressed_at INTEGER
);
INSERT OR IGNORE INTO game (id) VALUES (1);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('team', 'reviewer', 'admin')),
  team_id INTEGER REFERENCES teams(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  points INTEGER NOT NULL,
  exclusive INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  prompt_id INTEGER NOT NULL REFERENCES prompts(id),
  filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT,
  assigned_to TEXT,
  assigned_at INTEGER
);
CREATE INDEX IF NOT EXISTS photos_status ON photos (status, created_at);
CREATE INDEX IF NOT EXISTS photos_team_prompt ON photos (team_id, prompt_id);
`;

function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
