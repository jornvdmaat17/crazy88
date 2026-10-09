// Copies all uploaded photos into one folder per prompt, named after the team and status:
//   <out>/03 - Prompt text/Team name (approved).jpg
// Usage: node server/export-photos.js [outDir]   (reads DATA_DIR like the server does)
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUT_DIR = path.resolve(process.argv[2] || '/tmp/crazy88-photos');

// Safe on every OS: no path separators or reserved characters, no trailing dots/spaces, not too long.
function safeName(s, max = 80) {
  const clean = s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, max).replace(/[. ]+$/, '') || '_';
}

const db = new Database(path.join(DATA_DIR, 'crazy88.db'), { readonly: true, fileMustExist: true });
const photos = db.prepare(`
  SELECT ph.filename, ph.status, p.id AS prompt_id, p.text, t.name AS team
  FROM photos ph
  JOIN prompts p ON p.id = ph.prompt_id
  JOIN teams t ON t.id = ph.team_id
  ORDER BY p.sort_order, t.name, ph.created_at
`).all();

const prompts = db.prepare('SELECT id FROM prompts ORDER BY sort_order').all();
const width = String(prompts.length).length;
const promptNr = new Map(prompts.map((p, i) => [p.id,String(i + 1).padStart(Math.max(width, 2), '0')]));

fs.mkdirSync(OUT_DIR, { recursive: true });
const used = new Set();
let copied = 0;
let missing = 0;

for (const ph of photos) {
  const dir = path.join(OUT_DIR, `${promptNr.get(ph.prompt_id)} - ${safeName(ph.text)}`);
  const ext = path.extname(ph.filename);
  const base = `${safeName(ph.team, 40)} (${ph.status})`;
  let file = path.join(dir, base + ext);
  for (let n = 2; used.has(file); n++) file = path.join(dir, `${base} ${n}${ext}`);
  used.add(file);

  const src = path.join(UPLOAD_DIR, ph.filename);
  if (!fs.existsSync(src)) {
    missing++;
    continue;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, file);
  copied++;
}

console.log(`Copied ${copied} photos into ${OUT_DIR}` + (missing ? ` (${missing} missing on disk)` : ''));
