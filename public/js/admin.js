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

// Only text fields count: a focused button (e.g. the Delete just clicked) must not block a redraw.
const editing = (el) => el.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]), textarea');

function render() {
  const { state, scores, prompts, pending } = view;
  $('phase').textContent = PHASE_LABEL[state.phase];
  $('pending').textContent = pending;
  $('pending-top').textContent = pending;

  if (!editing($('settings'))) {
    $('duration').value = state.durationMin;
    $('goal').value = state.goalPoints;
    $('interval').value = state.scoreIntervalMin;
  }
  $('scores-help').textContent = state.scoreIntervalMin
    ? `Live scores. Teams zien de scores van andere teams elke ${state.scoreIntervalMin} ${state.scoreIntervalMin === 1 ? 'minuut' : 'minuten'}.`
    : 'Live scores. Teams zien de scores van andere teams pas als het spel voorbij is.';
  $('duration').disabled = state.phase !== 'lobby';
  $('start').disabled = state.phase !== 'lobby';
  $('end').disabled = state.phase !== 'active';
  $('game-help').textContent = {
    lobby: `${scores.length} team(s) doen mee. Start als iedereen binnen is.`,
    active: 'Beëindigen geeft iedereen nog 5 minuten om te uploaden, daarna sluit het uploaden.',
    ending: 'Laatste 5 minuten lopen. Beoordelen gaat door nadat het uploaden sluit.',
    ended: 'Spel voorbij. Blijf de wachtende foto\'s beoordelen; de galerij werkt live bij.',
  }[state.phase];

  $('scores').innerHTML = scores.length
    ? scores.map((s, i) => `<li><span>${i + 1}. ${esc(s.name)}</span><span>${s.score}${state.goalPoints ? ` / ${state.goalPoints}` : ''}</span></li>`).join('')
    : '<li class="muted">Nog geen teams</li>';

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
      <td class="small muted">${p.claimed_by ? `🔒 ${esc(p.claimed_by)}` : `${p.photo_count} foto('s)`}</td>
      <td><button class="secondary small" data-delete ${p.photo_count ? 'disabled title="Heeft foto\'s"' : ''}>Verwijderen</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">Nog geen prompts. Voeg ze hieronder toe.</td></tr>';
}

$('prompts').addEventListener('change', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const get = (n) => row.querySelector(`[name=${n}]`);
  act(() => api(`/api/admin/prompts/${row.dataset.id}`, {
    method: 'PUT',
    body: { text: get('text').value, points: Number(get('points').value), exclusive: get('exclusive').checked },
  }), 'Opgeslagen');
});

$('prompts').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row || !e.target.matches('[data-delete]')) return;
  if (!confirm('Deze prompt verwijderen?')) return;
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
  }, 'Prompt toegevoegd');
});

function parseBulk(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line, i) => {
    const m = line.match(/^(!?)\s*(\d+)\s*\|\s*(.+)$/);
    if (!m) throw new Error(`Regel ${i + 1} is niet "punten | tekst": ${line}`);
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
  }, `${list.length} prompts toegevoegd`);
});

const toLine = (p) => `${p.exclusive ? '!' : ''}${p.points} | ${p.text}`;
const fillBulkEdit = () => { $('bulk-edit').lines.value = view.prompts.map(toLine).join('\n'); };

// Filled only on open/reload, so live updates never overwrite what is being typed.
$('bulk-edit-box').addEventListener('toggle', (e) => { if (e.target.open) fillBulkEdit(); });
$('bulk-reload').addEventListener('click', fillBulkEdit);

$('bulk-edit').addEventListener('submit', (e) => {
  e.preventDefault();
  let list;
  try {
    list = parseBulk(e.target.lines.value);
  } catch (err) {
    return toast(err.message, true);
  }
  if (!confirm(`De hele lijst overschrijven met ${list.length} prompts?`)) return;
  act(async () => {
    const res = await api('/api/admin/prompts', { method: 'PUT', body: { prompts: list } });
    e.target.lines.value = res.prompts.map(toLine).join('\n');
    return res;
  }, 'Lijst opgeslagen');
});

$('settings').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = { goalPoints: Number($('goal').value), scoreIntervalMin: Number($('interval').value) };
  if (view.state.phase === 'lobby') body.durationMin = Number($('duration').value);
  act(() => api('/api/admin/settings', { method: 'POST', body }), 'Instellingen opgeslagen');
});

$('start').addEventListener('click', () => {
  const s = view.state;
  if (!confirm(`Het spel starten voor ${view.scores.length} team(s)? Het duurt ${s.durationMin} minuten.`)) return;
  act(() => api('/api/admin/start', { method: 'POST' }), 'Spel gestart!');
});

$('end').addEventListener('click', () => {
  if (!confirm('Het spel beëindigen? Teams krijgen nog 5 minuten, daarna sluit het uploaden.')) return;
  act(() => api('/api/admin/end', { method: 'POST' }), 'Laatste 5 minuten gestart');
});

$('reset').addEventListener('click', () => {
  if (!confirm('Het spel resetten? Alle teams, foto\'s en scores worden verwijderd. Prompts en instellingen blijven.')) return;
  act(() => api('/api/admin/reset', { method: 'POST' }), 'Spel gereset, terug naar de lobby');
});

$('logout').addEventListener('click', logout);

startTicker(() => {
  if (!view) return;
  const { phase, endsAt } = view.state;
  $('timer').textContent = phase === 'active' || phase === 'ending' ? fmtDuration(endsAt - serverTime()) : '';
});

connectLive({ refresh: () => load() });
await load();
