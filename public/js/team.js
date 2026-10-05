import {
  api, esc, toast, requireRole, logout, connectLive, syncClock, serverTime,
  fmtDuration, fmtClock, startTicker, PHASE_LABEL,
} from '/js/common.js';

const $ = (id) => document.getElementById(id);
let view = null;
let filter = 'todo';
const uploading = new Set();

await requireRole('team');

async function load() {
  view = await api('/api/team');
  syncClock(view.state.serverNow);
  render();
}

function promptBucket(p) {
  if (p.status === 'approved') return 'done';
  if (p.status === 'pending' || uploading.has(p.id)) return 'pending';
  if (p.exclusive && p.claimedBy) return 'done';
  return 'todo';
}

function render() {
  const { team, score, state, scoreboard, prompts } = view;
  const phase = state.phase;
  $('team-name').textContent = team.name;
  $('score').textContent = score;
  $('goal').textContent = state.goalPoints;
  $('phase').textContent = PHASE_LABEL[phase];
  $('lobby').classList.toggle('hidden', phase !== 'lobby');
  $('team-count').textContent = view.teamCount;
  $('game').classList.toggle('hidden', phase === 'lobby');
  $('ending-banner').classList.toggle('hidden', phase !== 'ending');
  $('ended-banner').classList.toggle('hidden', phase !== 'ended');

  renderMeter(score, state.goalPoints, scoreboard.scores.filter((s) => s.id !== team.id));
  renderStandings(scoreboard, team.id, score);
  renderPrompts(prompts, phase);
  updateTimer();
}

function pct(score, goal) {
  return Math.min(100, (score / goal) * 100);
}

function renderMeter(score, goal, others) {
  const meter = $('meter');
  meter.querySelectorAll('.marker').forEach((m) => m.remove());
  $('fill').style.width = pct(score, goal) + '%';
  // Teams with close scores get stacked on separate rows so labels don't overlap.
  const rowEnds = [];
  for (const o of [...others].sort((a, b) => a.score - b.score)) {
    const p = pct(o.score, goal);
    let row = rowEnds.findIndex((end) => p - end > 22);
    if (row === -1) row = rowEnds.length;
    rowEnds[row] = p;
    const m = document.createElement('div');
    m.className = 'marker';
    m.style.setProperty('--p', p + '%');
    m.style.setProperty('--row', row);
    m.textContent = `${o.name} ${o.score}`;
    meter.append(m);
  }
  meter.style.marginTop = `${26 + Math.max(0, rowEnds.length - 1) * 16}px`;
}

function renderStandings(board, myId, myScore) {
  const scores = board.scores.map((s) => (s.id === myId ? { ...s, score: myScore } : s))
    .sort((a, b) => b.score - a.score);
  $('standings').innerHTML = scores.map((s) => `
    <li class="${s.id === myId ? 'me' : ''}"><span>${esc(s.name)}</span><span>${s.score}</span></li>
  `).join('');
  if (board.live) {
    $('standings-note').textContent = view.state.phase === 'lobby' ? 'Teams in the game' : 'Final';
  } else {
    $('standings-note').textContent = `Others as of ${fmtClock(board.at)} · next update ${fmtClock(board.nextAt)}`;
  }
}

function statusChip(p) {
  if (uploading.has(p.id)) return '<span class="chip pending">Uploading…</span>';
  if (p.status === 'approved') return '<span class="chip approved">✓ Approved</span>';
  if (p.status === 'pending') return '<span class="chip pending">⏳ In review</span>';
  if (p.exclusive && p.claimedBy) return `<span class="chip">🔒 Claimed by ${esc(p.claimedBy)}</span>`;
  if (p.status === 'rejected') return `<span class="chip rejected">✗ Rejected${p.rejectReason ? ': ' + esc(p.rejectReason) : ''} · try again</span>`;
  return '';
}

function renderPrompts(prompts, phase) {
  const canUpload = phase === 'active' || phase === 'ending';
  const list = prompts.filter((p) => promptBucket(p) === filter);
  document.querySelectorAll('.tabs button').forEach((b) => {
    const n = prompts.filter((p) => promptBucket(p) === b.dataset.filter).length;
    b.textContent = `${{ todo: 'To do', pending: 'In review', done: 'Done' }[b.dataset.filter]} (${n})`;
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  if (!list.length) {
    $('prompts').innerHTML = `<p class="muted empty">${filter === 'todo' ? 'Nothing left here. Legends.' : 'Nothing here yet.'}</p>`;
    return;
  }
  $('prompts').innerHTML = list.map((p) => {
    const bucket = promptBucket(p);
    const thumb = p.latestPhotoId && p.status !== 'rejected'
      ? `<img class="thumb" src="/api/photos/${p.latestPhotoId}" alt="" loading="lazy">` : '';
    const button = bucket === 'todo' && canUpload
      ? `<button class="upload-btn" data-prompt="${p.id}" aria-label="Upload photo">📷</button>` : '';
    return `
      <div class="prompt ${p.exclusive ? 'special' : ''} ${bucket === 'done' ? 'done' : ''}">
        <div class="pts">${p.points}</div>
        <div class="body">
          <div class="text">${esc(p.text)}</div>
          ${p.exclusive ? '<span class="chip special">★ Only one team can claim this</span>' : ''}
          ${statusChip(p)}
        </div>
        ${thumb}${button}
      </div>`;
  }).join('');
}

// Phone photos are large; shrink before upload so it is fast on mobile data.
async function compress(file) {
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    const max = 1600;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
    return blob || file;
  } catch {
    return file;
  }
}

async function uploadPhoto(promptId, file) {
  uploading.add(promptId);
  render();
  try {
    const blob = await compress(file);
    const body = new FormData();
    body.append('photo', blob, 'photo.jpg');
    const res = await fetch(`/api/photos?promptId=${promptId}`, { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    toast('Photo sent for review!');
  } catch (err) {
    toast(err.message, true);
  } finally {
    uploading.delete(promptId);
    await load();
  }
}

// One persistent input: the prompt list re-renders on live updates while the camera is open.
const fileInput = $('file-input');
let targetPrompt = null;
$('prompts').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-prompt]');
  if (!b) return;
  targetPrompt = Number(b.dataset.prompt);
  fileInput.value = '';
  fileInput.click();
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0] && targetPrompt) uploadPhoto(targetPrompt, fileInput.files[0]);
});

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  filter = b.dataset.filter;
  render();
});

$('logout').addEventListener('click', logout);

function updateTimer() {
  if (!view) return;
  const { phase, endsAt } = view.state;
  const left = endsAt ? endsAt - serverTime() : 0;
  $('timer').textContent = phase === 'active' || phase === 'ending' ? fmtDuration(left) : '';
  $('timer').classList.toggle('urgent', phase === 'ending' || left < 5 * 60 * 1000);
}
startTicker(updateTimer);

connectLive({ refresh: load });
await load();
