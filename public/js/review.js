import {
  api, esc, toast, requireRole, logout, connectLive, syncClock, serverTime,
  fmtDuration, startTicker, PHASE_LABEL,
} from '/js/common.js';

const $ = (id) => document.getElementById(id);
const me = await requireRole('reviewer', 'admin');
if (me.role === 'admin') $('admin-link').classList.remove('hidden');

let current = null;
let shownId;
let state = null;
let busy = false;
let dragging = false;
let reviewed = 0;

async function fetchNext() {
  if (busy || dragging) return;
  const data = await api('/api/review/next');
  state = data.state;
  syncClock(state.serverNow);
  $('pending').textContent = data.pending;
  $('phase').textContent = PHASE_LABEL[state.phase];
  const nextId = data.photo?.id ?? null;
  if (nextId !== shownId) {
    current = data.photo;
    shownId = nextId;
    renderCard();
  }
}

function renderCard() {
  $('actions').classList.toggle('hidden', !current);
  if (!current) {
    $('stage').innerHTML = `
      <div class="card empty">
        <h2>Alles beoordeeld</h2>
        <p class="muted">Nieuwe foto's verschijnen hier vanzelf.</p>
      </div>`;
    return;
  }
  $('stage').innerHTML = `
    <div class="swipe-card" id="card">
      <div class="info">
        <div class="row">
          <span class="chip">${esc(current.team)}</span>
          <span class="chip">${current.points} ptn</span>
          ${current.exclusive ? '<span class="chip special">★ Exclusief</span>' : ''}
        </div>
        <div class="prompt-text">${esc(current.prompt)}</div>
      </div>
      <div class="photo"><img src="${esc(current.url)}" alt="Ingestuurde foto"></div>
      <div class="stamp yes">JA</div>
      <div class="stamp no">NEE</div>
    </div>`;
  attachSwipe($('card'));
}

function resetCard(card) {
  card.style.transform = '';
  card.querySelectorAll('.stamp').forEach((s) => { s.style.opacity = 0; });
}

// Resolves to the (possibly empty) reason, or null when cancelled.
function askReason() {
  const dlg = $('reason-dialog');
  $('reason').value = '';
  dlg.returnValue = '';
  dlg.showModal();
  // Don't pop up the phone keyboard over the quick reasons; on desktop, type straight away.
  (matchMedia('(pointer: fine)').matches ? $('reason') : $('reason-reject')).focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'reject' ? $('reason').value.trim() : null), { once: true });
  });
}

$('reason-presets').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('reason').value = b.textContent;
  $('reason-dialog').close('reject');
});
$('reason-cancel').addEventListener('click', () => $('reason-dialog').close());

async function decide(approve) {
  if (!current || busy) return;
  busy = true;
  const card = $('card');
  let reason;
  if (!approve) {
    reason = await askReason();
    if (reason === null) {
      resetCard(card);
      busy = false;
      return;
    }
  }
  card.style.transform = `translateX(${approve ? 120 : -120}vw) rotate(${approve ? 20 : -20}deg)`;
  try {
    const result = await api(`/api/review/${current.id}`, { method: 'POST', body: { approve, reason } });
    reviewed++;
    $('done').textContent = reviewed;
    if (approve && result.status === 'rejected') toast(result.reason, true);
    else if (result.autoRejectedTeamIds.length) toast('Exclusieve prompt geclaimd, andere inzendingen afgekeurd');
  } catch (err) {
    toast(err.message, true);
  }
  current = null;
  busy = false;
  await fetchNext();
}

function attachSwipe(card) {
  let startX = 0;
  let dx = 0;
  const yes = card.querySelector('.stamp.yes');
  const no = card.querySelector('.stamp.no');
  card.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    dx = 0;
    card.setPointerCapture(e.pointerId);
    card.classList.add('dragging');
  });
  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
    yes.style.opacity = Math.max(0, Math.min(1, dx / 100));
    no.style.opacity = Math.max(0, Math.min(1, -dx / 100));
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove('dragging');
    if (Math.abs(dx) > 110) return decide(dx > 0);
    resetCard(card);
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

$('btn-yes').addEventListener('click', () => decide(true));
$('btn-no').addEventListener('click', () => decide(false));
document.addEventListener('keydown', (e) => {
  if ($('reason-dialog').open) return;
  if (e.key === 'ArrowRight') decide(true);
  if (e.key === 'ArrowLeft') decide(false);
});
$('logout').addEventListener('click', logout);

startTicker(() => {
  if (!state) return;
  const active = state.phase === 'active' || state.phase === 'ending';
  $('timer').textContent = active ? fmtDuration(state.endsAt - serverTime()) : '';
});

connectLive({ refresh: fetchNext, queue: fetchNext });
await fetchNext();
