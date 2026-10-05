const ENDGAME_MS = 5 * 60 * 1000;
const SNAPSHOT_MS = 5 * 60 * 1000;
const ASSIGNMENT_TIMEOUT_MS = 2 * 60 * 1000;

class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function createGame(db, { now = Date.now } = {}) {
  let snapshot = null;

  const settings = () => db.prepare('SELECT * FROM game WHERE id = 1').get();

  function phase(g = settings()) {
    if (!g.started_at) return 'lobby';
    if (now() >= g.ends_at) return 'ended';
    return g.end_pressed_at ? 'ending' : 'active';
  }

  function state() {
    const g = settings();
    return {
      phase: phase(g),
      durationMin: g.duration_min,
      goalPoints: g.goal_points,
      startedAt: g.started_at,
      endsAt: g.ends_at,
      serverNow: now(),
    };
  }

  function liveScores() {
    return db.prepare(`
      SELECT t.id, t.name, COALESCE(SUM(p.points), 0) AS score
      FROM teams t
      LEFT JOIN (SELECT DISTINCT team_id, prompt_id FROM photos WHERE status = 'approved') a ON a.team_id = t.id
      LEFT JOIN prompts p ON p.id = a.prompt_id
      GROUP BY t.id
      ORDER BY score DESC, t.name
    `).all();
  }

  function teamScore(teamId) {
    return liveScores().find((s) => s.id === teamId)?.score ?? 0;
  }

  // Other teams' scores are only revealed every 5 minutes of game time, to keep tension.
  function scoreboard() {
    const p = phase();
    if (p === 'lobby') return { scores: liveScores(), at: null, nextAt: null, live: true };
    if (p === 'ended') return { scores: liveScores(), at: now(), nextAt: null, live: true };
    if (!snapshot) refreshSnapshot();
    return { scores: snapshot.scores, at: snapshot.at, nextAt: snapshot.at + SNAPSHOT_MS, live: false };
  }

  function refreshSnapshot() {
    const g = settings();
    const bucket = Math.floor((now() - g.started_at) / SNAPSHOT_MS);
    snapshot = { bucket, at: g.started_at + bucket * SNAPSHOT_MS, scores: liveScores() };
  }

  let lastPhase = phase();

  // Called periodically; reports what changed so the server can notify clients.
  function tick() {
    const changes = { phase: false, scoreboard: false };
    const p = phase();
    if (p !== lastPhase) {
      changes.phase = true;
      lastPhase = p;
    }
    if (p === 'active' || p === 'ending') {
      const g = settings();
      const bucket = Math.floor((now() - g.started_at) / SNAPSHOT_MS);
      if (!snapshot || snapshot.bucket !== bucket) {
        refreshSnapshot();
        changes.scoreboard = true;
      }
    }
    return changes;
  }

  // --- teams & sessions ---

  function joinTeam(name) {
    const clean = String(name || '').trim().replace(/\s+/g, ' ');
    if (clean.length < 1 || clean.length > 40) throw new GameError('Team name must be 1-40 characters');
    const existing = db.prepare('SELECT * FROM teams WHERE name = ?').get(clean);
    if (existing) return existing;
    const info = db.prepare('INSERT INTO teams (name, created_at) VALUES (?, ?)').run(clean, now());
    return db.prepare('SELECT * FROM teams WHERE id = ?').get(info.lastInsertRowid);
  }

  function createSession(token, role, teamId = null) {
    db.prepare('INSERT INTO sessions (token, role, team_id, created_at) VALUES (?, ?, ?, ?)').run(token, role, teamId, now());
  }

  function getSession(token, maxAgeMs) {
    if (!token) return null;
    const s = db.prepare(`
      SELECT s.*, t.name AS team_name FROM sessions s LEFT JOIN teams t ON t.id = s.team_id WHERE s.token = ?
    `).get(token);
    if (!s || now() - s.created_at > maxAgeMs) return null;
    return s;
  }

  function deleteSession(token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  function teams() {
    return db.prepare('SELECT id, name, created_at FROM teams ORDER BY created_at').all();
  }

  // --- prompts ---

  function prompts() {
    return db.prepare(`
      SELECT p.*, (
        SELECT t.name FROM photos ph JOIN teams t ON t.id = ph.team_id
        WHERE ph.prompt_id = p.id AND ph.status = 'approved' AND p.exclusive = 1 LIMIT 1
      ) AS claimed_by,
      (SELECT COUNT(*) FROM photos ph WHERE ph.prompt_id = p.id) AS photo_count
      FROM prompts p ORDER BY sort_order, id
    `).all().map((p) => ({ ...p, exclusive: !!p.exclusive }));
  }

  function validatePrompt({ text, points, exclusive }) {
    const t = String(text || '').trim();
    const pts = Number(points);
    if (!t || t.length > 300) throw new GameError('Prompt text must be 1-300 characters');
    if (!Number.isInteger(pts) || pts < 0 || pts > 100000) throw new GameError('Points must be a whole number');
    return { text: t, points: pts, exclusive: exclusive ? 1 : 0 };
  }

  function addPrompts(list) {
    const valid = list.map(validatePrompt);
    const insert = db.prepare(`
      INSERT INTO prompts (text, points, exclusive, sort_order)
      VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM prompts))
    `);
    db.transaction(() => valid.forEach((p) => insert.run(p.text, p.points, p.exclusive)))();
  }

  function updatePrompt(id, data) {
    const p = validatePrompt(data);
    const existing = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
    if (!existing) throw new GameError('Prompt not found', 404);
    if (p.exclusive !== existing.exclusive) {
      const approved = db.prepare("SELECT COUNT(*) AS n FROM photos WHERE prompt_id = ? AND status = 'approved'").get(id).n;
      if (approved > 0) throw new GameError('Cannot change exclusive flag after a photo was approved');
    }
    db.prepare('UPDATE prompts SET text = ?, points = ?, exclusive = ? WHERE id = ?').run(p.text, p.points, p.exclusive, id);
  }

  function deletePrompt(id) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE prompt_id = ?').get(id).n;
    if (n > 0) throw new GameError('Cannot delete a prompt that already has photos');
    db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
  }

  // --- game control ---

  function updateSettings({ durationMin, goalPoints }) {
    const g = settings();
    if (goalPoints !== undefined) {
      const goal = Number(goalPoints);
      if (!Number.isInteger(goal) || goal < 1) throw new GameError('Goal must be a positive whole number');
      db.prepare('UPDATE game SET goal_points = ? WHERE id = 1').run(goal);
    }
    if (durationMin !== undefined) {
      const d = Number(durationMin);
      if (!Number.isInteger(d) || d < 1 || d > 24 * 60) throw new GameError('Duration must be 1-1440 minutes');
      if (g.started_at) throw new GameError('Duration can only be changed before the game starts');
      db.prepare('UPDATE game SET duration_min = ? WHERE id = 1').run(d);
    }
  }

  function start() {
    const g = settings();
    if (g.started_at) throw new GameError('Game already started');
    const n = db.prepare('SELECT COUNT(*) AS n FROM prompts').get().n;
    if (n === 0) throw new GameError('Add prompts before starting');
    const t = now();
    db.prepare('UPDATE game SET started_at = ?, ends_at = ? WHERE id = 1').run(t, t + g.duration_min * 60000);
    snapshot = null;
  }

  function triggerEnd() {
    const g = settings();
    const p = phase(g);
    if (p === 'lobby') throw new GameError('Game has not started');
    if (p !== 'active') throw new GameError('Game is already ending');
    const t = now();
    db.prepare('UPDATE game SET end_pressed_at = ?, ends_at = ? WHERE id = 1').run(t, Math.min(g.ends_at, t + ENDGAME_MS));
  }

  // Back to the lobby for another round: prompts and settings stay, teams and photos go.
  // Returns the photo filenames so the caller can delete the files.
  function reset() {
    return db.transaction(() => {
      const files = db.prepare('SELECT filename FROM photos').all().map((p) => p.filename);
      db.prepare('DELETE FROM photos').run();
      db.prepare("DELETE FROM sessions WHERE role = 'team'").run();
      db.prepare('DELETE FROM teams').run();
      db.prepare('UPDATE game SET started_at = NULL, ends_at = NULL, end_pressed_at = NULL WHERE id = 1').run();
      snapshot = null;
      return files;
    })();
  }

  // --- photos ---

  function assertCanUpload(teamId, promptId) {
    const p = phase();
    if (p === 'lobby') throw new GameError('The game has not started yet');
    if (p === 'ended') throw new GameError('The game is over, no more uploads');
    const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(promptId);
    if (!prompt) throw new GameError('Prompt not found', 404);
    const mine = db.prepare('SELECT status FROM photos WHERE team_id = ? AND prompt_id = ?').all(teamId, promptId);
    if (mine.some((ph) => ph.status === 'approved')) throw new GameError('You already completed this prompt');
    if (mine.some((ph) => ph.status === 'pending')) throw new GameError('Your photo for this prompt is still being reviewed');
    if (prompt.exclusive) {
      const claim = db.prepare(`
        SELECT t.name FROM photos ph JOIN teams t ON t.id = ph.team_id
        WHERE ph.prompt_id = ? AND ph.status = 'approved'
      `).get(promptId);
      if (claim) throw new GameError(`Already claimed by ${claim.name}`);
    }
  }

  function addPhoto(teamId, promptId, filename) {
    assertCanUpload(teamId, promptId);
    const info = db.prepare('INSERT INTO photos (team_id, prompt_id, filename, created_at) VALUES (?, ?, ?, ?)')
      .run(teamId, promptId, filename, now());
    return info.lastInsertRowid;
  }

  function getPhoto(id) {
    return db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  }

  const reviewView = (id) => db.prepare(`
    SELECT ph.id, ph.created_at, t.name AS team, p.text AS prompt, p.points, p.exclusive
    FROM photos ph JOIN teams t ON t.id = ph.team_id JOIN prompts p ON p.id = ph.prompt_id
    WHERE ph.id = ?
  `).get(id);

  // Each reviewer gets their own photo; a photo assigned to someone who went quiet is handed out again.
  function nextForReviewer(reviewerKey) {
    return db.transaction(() => {
      const mine = db.prepare("SELECT id FROM photos WHERE status = 'pending' AND assigned_to = ? ORDER BY created_at LIMIT 1").get(reviewerKey);
      if (mine) {
        db.prepare('UPDATE photos SET assigned_at = ? WHERE id = ?').run(now(), mine.id);
        return reviewView(mine.id);
      }
      const free = db.prepare(`
        SELECT id FROM photos
        WHERE status = 'pending' AND (assigned_to IS NULL OR assigned_at < ?)
        ORDER BY created_at LIMIT 1
      `).get(now() - ASSIGNMENT_TIMEOUT_MS);
      if (!free) return null;
      db.prepare('UPDATE photos SET assigned_to = ?, assigned_at = ? WHERE id = ?').run(reviewerKey, now(), free.id);
      return reviewView(free.id);
    })();
  }

  function pendingCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM photos WHERE status = 'pending'").get().n;
  }

  // Returns { status, reason, teamId, autoRejectedTeamIds }.
  function decide(photoId, approve, reviewer) {
    return db.transaction(() => {
      const ph = db.prepare(`
        SELECT ph.*, p.exclusive FROM photos ph JOIN prompts p ON p.id = ph.prompt_id WHERE ph.id = ?
      `).get(photoId);
      if (!ph) throw new GameError('Photo not found', 404);
      if (ph.status !== 'pending') throw new GameError('This photo was already reviewed', 409);
      const t = now();
      const setStatus = db.prepare('UPDATE photos SET status = ?, reject_reason = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?');

      if (!approve) {
        setStatus.run('rejected', null, t, reviewer, photoId);
        return { status: 'rejected', reason: null, teamId: ph.team_id, autoRejectedTeamIds: [] };
      }

      if (ph.exclusive) {
        const claim = db.prepare(`
          SELECT t.name FROM photos x JOIN teams t ON t.id = x.team_id
          WHERE x.prompt_id = ? AND x.status = 'approved'
        `).get(ph.prompt_id);
        if (claim) {
          const reason = `Already claimed by ${claim.name}`;
          setStatus.run('rejected', reason, t, reviewer, photoId);
          return { status: 'rejected', reason, teamId: ph.team_id, autoRejectedTeamIds: [] };
        }
      }

      setStatus.run('approved', null, t, reviewer, photoId);
      let autoRejectedTeamIds = [];
      if (ph.exclusive) {
        const team = db.prepare('SELECT name FROM teams WHERE id = ?').get(ph.team_id);
        const others = db.prepare("SELECT id, team_id FROM photos WHERE prompt_id = ? AND status = 'pending'").all(ph.prompt_id);
        others.forEach((o) => setStatus.run('rejected', `Claimed by ${team.name}`, t, 'system', o.id));
        autoRejectedTeamIds = [...new Set(others.map((o) => o.team_id))];
      }
      return { status: 'approved', reason: null, teamId: ph.team_id, autoRejectedTeamIds };
    })();
  }

  // --- views ---

  function teamView(teamId) {
    const team = db.prepare('SELECT id, name FROM teams WHERE id = ?').get(teamId);
    const mine = db.prepare('SELECT id, prompt_id, status, reject_reason, created_at FROM photos WHERE team_id = ? ORDER BY created_at')
      .all(teamId);
    const byPrompt = new Map();
    for (const ph of mine) {
      if (!byPrompt.has(ph.prompt_id)) byPrompt.set(ph.prompt_id, []);
      byPrompt.get(ph.prompt_id).push(ph);
    }
    const promptList = prompts().map((p) => {
      const attempts = byPrompt.get(p.id) || [];
      const latest = attempts[attempts.length - 1];
      return {
        id: p.id,
        text: p.text,
        points: p.points,
        exclusive: p.exclusive,
        claimedBy: p.claimed_by,
        status: latest ? latest.status : null,
        rejectReason: latest ? latest.reject_reason : null,
        latestPhotoId: latest ? latest.id : null,
        attempts: attempts.length,
      };
    });
    return {
      team,
      score: teamScore(teamId),
      state: state(),
      scoreboard: scoreboard(),
      teamCount: teams().length,
      prompts: phase() === 'lobby' ? [] : promptList,
      promptCount: promptList.length,
    };
  }

  function adminView() {
    return {
      state: state(),
      scores: liveScores(),
      teams: teams(),
      prompts: prompts(),
      pending: pendingCount(),
    };
  }

  function gallery() {
    const photos = db.prepare(`
      SELECT ph.id, ph.prompt_id, ph.status, ph.reject_reason, ph.created_at, t.name AS team
      FROM photos ph JOIN teams t ON t.id = ph.team_id ORDER BY ph.created_at
    `).all();
    return {
      state: state(),
      scores: liveScores(),
      prompts: prompts().map((p) => ({
        id: p.id,
        text: p.text,
        points: p.points,
        exclusive: p.exclusive,
        winner: p.claimed_by,
        photos: photos.filter((ph) => ph.prompt_id === p.id),
      })),
    };
  }

  return {
    state, phase, tick, scoreboard, liveScores,
    joinTeam, createSession, getSession, deleteSession, teams,
    prompts, addPrompts, updatePrompt, deletePrompt,
    updateSettings, start, triggerEnd, reset,
    addPhoto, assertCanUpload, getPhoto, nextForReviewer, pendingCount, decide,
    teamView, adminView, gallery,
  };
}

module.exports = { createGame, GameError, ENDGAME_MS, SNAPSHOT_MS };
