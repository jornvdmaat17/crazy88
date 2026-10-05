const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const multer = require('multer');
const cookie = require('cookie');
const { Server } = require('socket.io');
const { openDb } = require('./db');
const { createGame, GameError } = require('./game');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CODES = {
  team: process.env.TEAM_CODE,
  reviewer: process.env.REVIEWER_CODE,
  admin: process.env.ADMIN_CODE,
};
const SESSION_MS = 3 * 24 * 60 * 60 * 1000;
const COOKIE = 'c88';

for (const [role, code] of Object.entries(CODES)) {
  if (!code) {
    console.error(`Missing ${role.toUpperCase()}_CODE environment variable`);
    process.exit(1);
  }
}
if (new Set(Object.values(CODES).map((c) => c.toLowerCase())).size !== 3) {
  console.error('TEAM_CODE, REVIEWER_CODE and ADMIN_CODE must all be different');
  process.exit(1);
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const game = createGame(openDb(path.join(DATA_DIR, 'crazy88.db')));

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.use(express.json({ limit: '200kb' }));

const server = http.createServer(app);
const io = new Server(server);

function notify({ queue = false } = {}) {
  io.emit('refresh');
  if (queue) io.to('reviewers').emit('queue');
}

// --- auth ---

function sessionFrom(cookieHeader) {
  const token = cookie.parse(cookieHeader || '')[COOKIE];
  return game.getSession(token, SESSION_MS);
}

function auth(...roles) {
  return (req, res, next) => {
    const s = sessionFrom(req.headers.cookie);
    if (!s) return res.status(401).json({ error: 'Not logged in' });
    if (roles.length && !roles.includes(s.role)) return res.status(403).json({ error: 'Not allowed' });
    req.session = s;
    next();
  };
}

const loginAttempts = new Map();
function rateLimited(ip) {
  const t = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter((x) => t - x < 60_000);
  recent.push(t);
  loginAttempts.set(ip, recent);
  return recent.length > 20;
}

function roleForCode(code) {
  const c = String(code || '').trim().toLowerCase();
  return Object.keys(CODES).find((role) => CODES[role].toLowerCase() === c) || null;
}

app.post('/api/login', (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
  const role = roleForCode(req.body.code);
  if (!role) return res.status(401).json({ error: 'Unknown code' });
  let teamId = null;
  if (role === 'team') {
    const team = game.joinTeam(req.body.teamName);
    teamId = team.id;
    notify();
  }
  const token = crypto.randomBytes(24).toString('base64url');
  game.createSession(token, role, teamId);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS });
  res.json({ role });
});

app.post('/api/logout', (req, res) => {
  const token = cookie.parse(req.headers.cookie || '')[COOKIE];
  if (token) game.deleteSession(token);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', auth(), (req, res) => {
  res.json({ role: req.session.role, teamName: req.session.team_name });
});

// --- team ---

app.get('/api/team', auth('team'), (req, res) => {
  res.json(game.teamView(req.session.team_id));
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = { 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype] || '.jpg';
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype)),
});

app.post('/api/photos', auth('team'), (req, res, next) => {
  try {
    game.assertCanUpload(req.session.team_id, Number(req.query.promptId));
  } catch (err) {
    return next(err);
  }
  upload.single('photo')(req, res, (err) => {
    if (err) return next(new GameError(err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (max 15 MB)' : 'Upload failed'));
    if (!req.file) return next(new GameError('Please choose a photo (JPEG, PNG, WebP or HEIC)'));
    try {
      const id = game.addPhoto(req.session.team_id, Number(req.query.promptId), req.file.filename);
      notify({ queue: true });
      res.json({ id });
    } catch (e) {
      fs.rm(req.file.path, { force: true }, () => {});
      next(e);
    }
  });
});

// Teams see their own photos during the game and everyone's once it has ended.
app.get('/api/photos/:id', auth(), (req, res) => {
  const photo = game.getPhoto(Number(req.params.id));
  if (!photo) return res.sendStatus(404);
  const s = req.session;
  const allowed = s.role !== 'team' || photo.team_id === s.team_id || game.phase() === 'ended';
  if (!allowed) return res.sendStatus(403);
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(UPLOAD_DIR, photo.filename));
});

// --- review (reviewers and admin) ---

app.get('/api/review/next', auth('reviewer', 'admin'), (req, res) => {
  res.json({ photo: game.nextForReviewer(req.session.token), pending: game.pendingCount(), state: game.state() });
});

app.post('/api/review/:id', auth('reviewer', 'admin'), (req, res) => {
  const result = game.decide(Number(req.params.id), req.body.approve === true, req.session.role);
  notify({ queue: result.autoRejectedTeamIds.length > 0 });
  res.json(result);
});

// --- admin ---

app.get('/api/admin', auth('admin'), (req, res) => res.json(game.adminView()));

app.post('/api/admin/settings', auth('admin'), (req, res) => {
  game.updateSettings(req.body);
  notify();
  res.json(game.adminView());
});

app.post('/api/admin/start', auth('admin'), (req, res) => {
  game.start();
  game.tick();
  notify();
  res.json(game.adminView());
});

app.post('/api/admin/end', auth('admin'), (req, res) => {
  game.triggerEnd();
  game.tick();
  notify();
  res.json(game.adminView());
});

app.post('/api/admin/reset', auth('admin'), (req, res) => {
  const files = game.reset();
  files.forEach((f) => fs.rm(path.join(UPLOAD_DIR, f), { force: true }, () => {}));
  game.tick();
  notify({ queue: true });
  res.json(game.adminView());
});

app.post('/api/admin/prompts', auth('admin'), (req, res) => {
  const list = Array.isArray(req.body.prompts) ? req.body.prompts : [req.body];
  game.addPrompts(list);
  notify();
  res.json(game.adminView());
});

app.put('/api/admin/prompts/:id', auth('admin'), (req, res) => {
  game.updatePrompt(Number(req.params.id), req.body);
  notify();
  res.json(game.adminView());
});

app.delete('/api/admin/prompts/:id', auth('admin'), (req, res) => {
  game.deletePrompt(Number(req.params.id));
  notify();
  res.json(game.adminView());
});

// --- gallery ---

app.get('/api/gallery', auth(), (req, res) => {
  if (req.session.role === 'team' && game.phase() !== 'ended') {
    return res.status(403).json({ error: 'The gallery opens when the game ends' });
  }
  res.json(game.gallery());
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (err instanceof GameError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// --- realtime ---

io.use((socket, next) => {
  const s = sessionFrom(socket.handshake.headers.cookie);
  if (!s) return next(new Error('unauthorized'));
  socket.join(s.role === 'team' ? 'teams' : 'reviewers');
  next();
});

setInterval(() => {
  const changes = game.tick();
  if (changes.phase || changes.scoreboard) notify();
}, 1000);

server.listen(PORT, () => console.log(`Crazy 88 running on http://localhost:${PORT}`));
