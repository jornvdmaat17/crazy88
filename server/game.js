const ENDGAME_MS = 5 * 60 * 1000;
const ASSIGNMENT_TIMEOUT_MS = 2 * 60 * 1000;

// Photo ids restart after a reset or data wipe; the random filename keeps browser caches from showing an old photo.
const photoUrl = (id, filename) => `/api/photos/${id}?v=${filename.split('.')[0]}`;

// A file or folder name that is valid on every OS: no separators or reserved characters, no trailing dots/spaces.
function safeName(s, max) {
  const clean = s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, max).replace(/[. ]+$/, '') || '_';
}

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
      scoreIntervalMin: g.score_interval_min,
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

  // During the game, other teams' scores are only revealed every N minutes (or not at all when N is 0).
  function scoreboard() {
    const g = settings();
    const p = phase(g);
    if (p === 'lobby') return { scores: liveScores(), live: true };
    if (p === 'ended') return { scores: liveScores(), live: true };
    if (g.score_interval_min === 0) return { scores: [], hidden: true };
    if (!snapshot || snapshot.key !== snapshotKey(g)) refreshSnapshot(g);
    return { scores: snapshot.scores, at: snapshot.at, nextAt: snapshot.at + g.score_interval_min * 60000 };
  }

  function snapshotKey(g) {
    if (g.score_interval_min === 0) return 'hidden';
    const interval = g.score_interval_min * 60000;
    return `${interval}:${Math.floor((now() - g.started_at) / interval)}`;
  }

  function refreshSnapshot(g) {
    const interval = g.score_interval_min * 60000;
    const at = g.started_at + Math.floor((now() - g.started_at) / interval) * interval;
    snapshot = { key: snapshotKey(g), at, scores: liveScores() };
  }

  let lastPhase = phase();

  // Called periodically; reports what changed so the server can notify clients.
  function tick() {
    const changes = { phase: false, scoreboard: false };
    const g = settings();
    const p = phase(g);
    if (p !== lastPhase) {
      changes.phase = true;
      lastPhase = p;
    }
    if ((p === 'active' || p === 'ending') && g.score_interval_min > 0 && snapshot?.key !== snapshotKey(g)) {
      refreshSnapshot(g);
      changes.scoreboard = true;
    }
    return changes;
  }

  // --- teams & sessions ---

  function joinTeam(name) {
    const clean = String(name || '').trim().replace(/\s+/g, ' ');
    if (clean.length < 1 || clean.length > 40) throw new GameError('Teamnaam moet 1-40 tekens zijn');
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
    if (!t || t.length > 300) throw new GameError('Prompttekst moet 1-300 tekens zijn');
    if (!Number.isInteger(pts) || pts < 0 || pts > 100000) throw new GameError('Punten moet een heel getal zijn');
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
    if (!existing) throw new GameError('Prompt niet gevonden', 404);
    if (p.exclusive !== existing.exclusive) {
      const approved = db.prepare("SELECT COUNT(*) AS n FROM photos WHERE prompt_id = ? AND status = 'approved'").get(id).n;
      if (approved > 0) throw new GameError('Exclusief kan niet meer worden gewijzigd nadat een foto is goedgekeurd');
    }
    db.prepare('UPDATE prompts SET text = ?, points = ?, exclusive = ? WHERE id = ?').run(p.text, p.points, p.exclusive, id);
  }

  function deletePrompt(id) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE prompt_id = ?').get(id).n;
    if (n > 0) throw new GameError('Een prompt met foto\'s kan niet worden verwijderd');
    db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
  }

  // Overwrites the whole list. Lines are matched to existing prompts by text so their photos stay attached;
  // a prompt that has photos cannot be dropped. All or nothing.
  function replacePrompts(list) {
    const valid = list.map(validatePrompt);
    db.transaction(() => {
      const existing = prompts();
      const byText = new Map();
      for (const p of existing) byText.set(p.text, [...(byText.get(p.text) || []), p]);
      const kept = new Set();
      const insert = db.prepare('INSERT INTO prompts (text, points, exclusive, sort_order) VALUES (?, ?, ?, ?)');
      const setOrder = db.prepare('UPDATE prompts SET sort_order = ? WHERE id = ?');
      valid.forEach((p, i) => {
        const match = byText.get(p.text)?.shift();
        if (!match) return insert.run(p.text, p.points, p.exclusive, i + 1);
        kept.add(match.id);
        updatePrompt(match.id, p);
        setOrder.run(i + 1, match.id);
      });
      for (const p of existing.filter((x) => !kept.has(x.id))) {
        if (p.photo_count) throw new GameError(`"${p.text}" heeft al foto's en kan niet worden verwijderd`);
        db.prepare('DELETE FROM prompts WHERE id = ?').run(p.id);
      }
    })();
  }

  // --- game control ---

  function updateSettings({ durationMin, goalPoints, scoreIntervalMin }) {
    const g = settings();
    if (goalPoints !== undefined) {
      const goal = Number(goalPoints);
      if (!Number.isInteger(goal) || goal < 0) throw new GameError('Doel moet een heel getal zijn (0 = geen doel)');
      db.prepare('UPDATE game SET goal_points = ? WHERE id = 1').run(goal);
    }
    if (scoreIntervalMin !== undefined) {
      const m = Number(scoreIntervalMin);
      if (!Number.isInteger(m) || m < 0 || m > 24 * 60) throw new GameError('Score-interval moet 0-1440 minuten zijn');
      db.prepare('UPDATE game SET score_interval_min = ? WHERE id = 1').run(m);
    }
    if (durationMin !== undefined) {
      const d = Number(durationMin);
      if (!Number.isInteger(d) || d < 1 || d > 24 * 60) throw new GameError('Duur moet 1-1440 minuten zijn');
      if (g.started_at) throw new GameError('Duur kan alleen worden aangepast voordat het spel begint');
      db.prepare('UPDATE game SET duration_min = ? WHERE id = 1').run(d);
    }
  }

  function start() {
    const g = settings();
    if (g.started_at) throw new GameError('Spel is al gestart');
    const n = db.prepare('SELECT COUNT(*) AS n FROM prompts').get().n;
    if (n === 0) throw new GameError('Voeg prompts toe voordat je start');
    const t = now();
    db.prepare('UPDATE game SET started_at = ?, ends_at = ? WHERE id = 1').run(t, t + g.duration_min * 60000);
    snapshot = null;
  }

  function triggerEnd() {
    const g = settings();
    const p = phase(g);
    if (p === 'lobby') throw new GameError('Spel is nog niet gestart');
    if (p !== 'active') throw new GameError('Spel is al aan het eindigen');
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
    if (p === 'lobby') throw new GameError('Het spel is nog niet begonnen');
    if (p === 'ended') throw new GameError('Het spel is voorbij, uploaden kan niet meer');
    const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(promptId);
    if (!prompt) throw new GameError('Prompt niet gevonden', 404);
    const mine = db.prepare('SELECT status FROM photos WHERE team_id = ? AND prompt_id = ?').all(teamId, promptId);
    if (mine.some((ph) => ph.status === 'approved')) throw new GameError('Jullie hebben deze prompt al voltooid');
    if (mine.some((ph) => ph.status === 'pending')) throw new GameError('Jullie foto voor deze prompt wordt nog beoordeeld');
    if (prompt.exclusive) {
      const claim = db.prepare(`
        SELECT t.name FROM photos ph JOIN teams t ON t.id = ph.team_id
        WHERE ph.prompt_id = ? AND ph.status = 'approved'
      `).get(promptId);
      if (claim) throw new GameError(`Al geclaimd door ${claim.name}`);
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

  const reviewView = (id) => {
    const r = db.prepare(`
      SELECT ph.id, ph.filename, ph.created_at, t.name AS team, p.text AS prompt, p.points, p.exclusive
      FROM photos ph JOIN teams t ON t.id = ph.team_id JOIN prompts p ON p.id = ph.prompt_id
      WHERE ph.id = ?
    `).get(id);
    const { filename, ...rest } = r;
    return { ...rest, url: photoUrl(r.id, filename) };
  };

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
  function decide(photoId, approve, reviewer, rejectReason) {
    return db.transaction(() => {
      const ph = db.prepare(`
        SELECT ph.*, p.exclusive FROM photos ph JOIN prompts p ON p.id = ph.prompt_id WHERE ph.id = ?
      `).get(photoId);
      if (!ph) throw new GameError('Foto niet gevonden', 404);
      if (ph.status !== 'pending') throw new GameError('Deze foto is al beoordeeld', 409);
      const t = now();
      const setStatus = db.prepare('UPDATE photos SET status = ?, reject_reason = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?');

      if (!approve) {
        const reason = String(rejectReason ?? '').trim().slice(0, 200) || null;
        setStatus.run('rejected', reason, t, reviewer, photoId);
        return { status: 'rejected', reason, teamId: ph.team_id, autoRejectedTeamIds: [] };
      }

      if (ph.exclusive) {
        const claim = db.prepare(`
          SELECT t.name FROM photos x JOIN teams t ON t.id = x.team_id
          WHERE x.prompt_id = ? AND x.status = 'approved'
        `).get(ph.prompt_id);
        if (claim) {
          const reason = `Al geclaimd door ${claim.name}`;
          setStatus.run('rejected', reason, t, reviewer, photoId);
          return { status: 'rejected', reason, teamId: ph.team_id, autoRejectedTeamIds: [] };
        }
      }

      setStatus.run('approved', null, t, reviewer, photoId);
      let autoRejectedTeamIds = [];
      if (ph.exclusive) {
        const team = db.prepare('SELECT name FROM teams WHERE id = ?').get(ph.team_id);
        const others = db.prepare("SELECT id, team_id FROM photos WHERE prompt_id = ? AND status = 'pending'").all(ph.prompt_id);
        others.forEach((o) => setStatus.run('rejected', `Geclaimd door ${team.name}`, t, 'system', o.id));
        autoRejectedTeamIds = [...new Set(others.map((o) => o.team_id))];
      }
      return { status: 'approved', reason: null, teamId: ph.team_id, autoRejectedTeamIds };
    })();
  }

  // --- views ---

  function teamView(teamId) {
    const team = db.prepare('SELECT id, name FROM teams WHERE id = ?').get(teamId);
    const mine = db.prepare('SELECT id, filename, prompt_id, status, reject_reason, created_at FROM photos WHERE team_id = ? ORDER BY created_at')
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
        latestPhotoUrl: latest ? photoUrl(latest.id, latest.filename) : null,
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
      SELECT ph.id, ph.filename, ph.prompt_id, ph.status, ph.reject_reason, ph.created_at, t.name AS team
      FROM photos ph JOIN teams t ON t.id = ph.team_id ORDER BY ph.created_at
    `).all().map(({ filename, ...ph }) => ({ ...ph, url: photoUrl(ph.id, filename) }));
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

  // Every photo with a readable path for a download: "03 - Prompt text/Team name (approved).jpg".
  function exportList() {
    const nr = new Map(prompts().map((p, i) => [p.id, String(i + 1).padStart(2, '0')]));
    const used = new Set();
    return db.prepare(`
      SELECT ph.filename, ph.status, ph.prompt_id, p.text, t.name AS team
      FROM photos ph JOIN prompts p ON p.id = ph.prompt_id JOIN teams t ON t.id = ph.team_id
      ORDER BY p.sort_order, p.id, t.name, ph.created_at
    `).all().map((ph) => {
      const dir = `${nr.get(ph.prompt_id)} - ${safeName(ph.text, 80)}`;
      const ext = ph.filename.slice(ph.filename.lastIndexOf('.'));
      const base = `${dir}/${safeName(ph.team, 40)} (${ph.status})`;
      let path = base + ext;
      for (let n = 2; used.has(path); n++) path = `${base} ${n}${ext}`;
      used.add(path);
      return { filename: ph.filename, path };
    });
  }

  return {
    state, phase, tick, scoreboard, liveScores,
    joinTeam, createSession, getSession, deleteSession, teams,
    prompts, addPrompts, replacePrompts, updatePrompt, deletePrompt,
    updateSettings, start, triggerEnd, reset,
    addPhoto, assertCanUpload, getPhoto, nextForReviewer, pendingCount, decide,
    teamView, adminView, gallery, exportList,
  };
}

module.exports = { createGame, GameError, ENDGAME_MS };
