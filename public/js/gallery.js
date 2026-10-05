import { esc, requireRole, homeFor, connectLive } from '/js/common.js';

const $ = (id) => document.getElementById(id);
const me = await requireRole('team', 'reviewer', 'admin');
$('back').href = homeFor(me.role);

let data = null;
let filter = 'all';
const LABEL = { approved: '✓ Approved', rejected: '✗ Rejected', pending: '⏳ Pending' };

async function load() {
  const res = await fetch('/api/gallery');
  if (res.status === 403) {
    $('closed').classList.remove('hidden');
    $('content').classList.add('hidden');
    return;
  }
  if (res.status === 401) {
    location.href = '/';
    return;
  }
  data = await res.json();
  $('closed').classList.add('hidden');
  $('content').classList.remove('hidden');
  render();
}

function render() {
  const { scores, prompts, state } = data;
  $('scores').innerHTML = scores.map((s, i) => `
    <li><span>${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} ${esc(s.name)}</span><span>${s.score} pts</span></li>
  `).join('');
  const pending = prompts.reduce((n, p) => n + p.photos.filter((ph) => ph.status === 'pending').length, 0);
  $('pending-note').textContent = state.phase !== 'ended'
    ? 'Game still running, scores are not final.'
    : pending ? `${pending} photo(s) still being reviewed, scores may change.` : '';

  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
  const sections = prompts.map((p) => {
    const photos = p.photos.filter((ph) => filter === 'all' || ph.status === filter);
    if (!photos.length) return '';
    return `
      <section class="card">
        <div class="row">
          <h3 class="grow" style="margin:0">${esc(p.text)}</h3>
          <span class="chip">${p.points} pts</span>
          ${p.exclusive ? `<span class="chip special">★ ${p.winner ? `Won by ${esc(p.winner)}` : 'Unclaimed'}</span>` : ''}
        </div>
        <div class="gallery-grid" style="margin-top:10px">
          ${photos.map((ph) => `
            <div class="gphoto ${ph.status} ${p.exclusive && ph.status === 'approved' ? 'winner' : ''}"
                 data-id="${ph.id}" data-cap="${esc(`${ph.team} · ${LABEL[ph.status]}${ph.reject_reason ? ` (${ph.reject_reason})` : ''}`)}">
              <img src="/api/photos/${ph.id}" alt="" loading="lazy">
              <div class="cap"><b>${esc(ph.team)}</b><span class="chip ${ph.status}" style="margin:0">${LABEL[ph.status]}</span></div>
            </div>`).join('')}
        </div>
      </section>`;
  }).join('');
  $('prompts').innerHTML = sections || '<p class="muted empty">No photos here.</p>';
}

$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  filter = b.dataset.filter;
  render();
});

$('prompts').addEventListener('click', (e) => {
  const tile = e.target.closest('.gphoto');
  if (!tile) return;
  $('lb-img').src = `/api/photos/${tile.dataset.id}`;
  $('lb-cap').textContent = tile.dataset.cap;
  $('lightbox').classList.remove('hidden');
});
$('lightbox').addEventListener('click', () => $('lightbox').classList.add('hidden'));

connectLive({ refresh: load });
await load();
