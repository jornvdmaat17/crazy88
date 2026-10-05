import {
  api, esc, toast, requireRole, logout, connectLive, syncClock, serverTime,
  fmtDuration, startTicker, PHASE_LABEL,
} from '/js/common.js';

const $ = (id) => document.getElementById(id);
let view = null;
let tableDirty = false;

await requireRole('admin');

async function load(data) {
  view = data || await api('/api/admin');
  syncClock(view.state.serverNow);
  render();
}

async function act(fn, okMsg) {
  try {
    await load(await fn());
    if (okMsg) toast(okMsg);
  } catch (err) {
    toast(err.message, true);
    await load();
  }
}

const editing = (el) => el.contains(document.activeElement);

function render() {
  const { state, scores, prompts, pending } = view;
  $('phase').textContent = PHASE_LABEL[state.phase];
  $('pending').textContent = pending;
  $('pending-top').textContent = pending;

  if (!editing($('settings'))) {
    $('duration').value = state.durationMin;
    $('goal').value = state.goalPoints;
  }
  $('duration').disabled = state.phase !== 'lobby';
  $('start').disabled = state.phase !== 'lobby';
  $('end').disabled = state.phase !== 'active';
  $('game-help').textContent = {
    lobby: `${scores.length} team(s) joined. Start when everyone is in.`,
    active: 'Ending gives everyone 5 more minutes to upload, then uploads close.',
    ending: 'Final 5 minutes running. Reviews continue after uploads close.',
    ended: 'Game over. Keep reviewing pending photos; the gallery updates live.',
  }[state.phase];

  $('scores').innerHTML = scores.length
    ? scores.map((s, i) => `<li><span>${i + 1}. ${esc(s.name)}</span><span>${s.score} / ${state.goalPoints}</span></li>`).join('')
    : '<li class="muted">No teams yet</li>';

  $('prompt-count').textContent = prompts.length;
  if (editing($('prompts'))) {
    tableDirty = true;
    return;
  }
  tableDirty = false;
  $('prompts').innerHTML = prompts.map((p) => `
    <tr data-id="${p.id}">
      <td><input name="text" value="${esc(p.text)}" maxlength="300"></td>
      <td class="pts"><input name="points" type="number" min="0" value="${p.points}"></td>
      <td><input name="exclusive" type="checkbox" ${p.exclusive ? 'checked' : ''}></td>
      <td class="small muted">${p.claimed_by ? `🔒 ${esc(p.claimed_by)}` : `${p.photo_count} photo(s)`}</td>
      <td><button class="secondary small" data-delete ${p.photo_count ? 'disabled title="Has photos"' : ''}>Delete</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No prompts yet. Add some below.</td></tr>';
}

$('prompts').addEventListener('change', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const get = (n) => row.querySelector(`[name=${n}]`);
  act(() => api(`/api/admin/prompts/${row.dataset.id}`, {
    method: 'PUT',
    body: { text: get('text').value, points: Number(get('points').value), exclusive: get('exclusive').checked },
  }), 'Saved');
});

$('prompts').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row || !e.target.matches('[data-delete]')) return;
  if (!confirm('Delete this prompt?')) return;
  act(() => api(`/api/admin/prompts/${row.dataset.id}`, { method: 'DELETE' }));
});

$('prompts').addEventListener('focusout', () => {
  setTimeout(() => { if (tableDirty && !editing($('prompts'))) render(); }, 0);
});

$('add').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  act(async () => {
    const res = await api('/api/admin/prompts', {
      method: 'POST',
      body: { text: f.get('text'), points: Number(f.get('points')), exclusive: f.get('exclusive') === 'on' },
    });
    e.target.text.value = '';
    return res;
  }, 'Prompt added');
});

function parseBulk(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line, i) => {
    const m = line.match(/^(!?)\s*(\d+)\s*\|\s*(.+)$/);
    if (!m) throw new Error(`Line ${i + 1} is not "points | text": ${line}`);
    return { exclusive: m[1] === '!', points: Number(m[2]), text: m[3] };
  });
}

$('bulk').addEventListener('submit', (e) => {
  e.preventDefault();
  let list;
  try {
    list = parseBulk(e.target.lines.value);
  } catch (err) {
    return toast(err.message, true);
  }
  if (!list.length) return;
  act(async () => {
    const res = await api('/api/admin/prompts', { method: 'POST', body: { prompts: list } });
    e.target.lines.value = '';
    return res;
  }, `${list.length} prompts added`);
});

$('settings').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = { goalPoints: Number($('goal').value) };
  if (view.state.phase === 'lobby') body.durationMin = Number($('duration').value);
  act(() => api('/api/admin/settings', { method: 'POST', body }), 'Settings saved');
});

$('start').addEventListener('click', () => {
  const s = view.state;
  if (!confirm(`Start the game for ${view.scores.length} team(s)? It runs ${s.durationMin} minutes.`)) return;
  act(() => api('/api/admin/start', { method: 'POST' }), 'Game started!');
});

$('end').addEventListener('click', () => {
  if (!confirm('End the game? Teams get 5 more minutes, then uploads close.')) return;
  act(() => api('/api/admin/end', { method: 'POST' }), 'Final 5 minutes started');
});

$('reset').addEventListener('click', () => {
  if (!confirm('Reset the game? All teams, photos and scores are deleted. Prompts and settings are kept.')) return;
  act(() => api('/api/admin/reset', { method: 'POST' }), 'Game reset, back to the lobby');
});

$('logout').addEventListener('click', logout);

startTicker(() => {
  if (!view) return;
  const { phase, endsAt } = view.state;
  $('timer').textContent = phase === 'active' || phase === 'ending' ? fmtDuration(endsAt - serverTime()) : '';
});

connectLive({ refresh: () => load() });
await load();
