// Copies all uploaded photos into one folder per prompt, the same layout as the admin page's zip download:
//   <out>/03 - Prompt text/Team name (approved).jpg
// Usage: node server/export-photos.js [outDir]   (reads DATA_DIR like the server does)
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { createGame } = require('./game');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUT_DIR = path.resolve(process.argv[2] || '/tmp/crazy88-photos');

const game = createGame(openDb(path.join(DATA_DIR, 'crazy88.db')));
let copied = 0;
let missing = 0;
for (const f of game.exportList()) {
  const src = path.join(UPLOAD_DIR, f.filename);
  if (!fs.existsSync(src)) {
    missing++;
    continue;
  }
  const dest = path.join(OUT_DIR, f.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  copied++;
}
console.log(`Copied ${copied} photos into ${OUT_DIR}` + (missing ? ` (${missing} missing on disk)` : ''));
