const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDb } = require('../server/db');

test('opening a database from before score_interval_min adds the column with default 5', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c88-')), 'old.db');
  const old = new Database(file);
  old.exec(`
    CREATE TABLE game (id INTEGER PRIMARY KEY CHECK (id = 1), duration_min INTEGER NOT NULL DEFAULT 60,
      goal_points INTEGER NOT NULL DEFAULT 500, started_at INTEGER, ends_at INTEGER, end_pressed_at INTEGER);
    INSERT INTO game (id, goal_points) VALUES (1, 300);
  `);
  old.close();
  const db = openDb(file);
  assert.deepEqual(db.prepare('SELECT goal_points, score_interval_min FROM game').get(), { goal_points: 300, score_interval_min: 5 });
  db.close();
  openDb(file).close();
});
