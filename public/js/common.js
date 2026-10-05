export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    location.href = '/';
    throw new Error('Not logged in');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
export function toast(msg, isError = false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.append(el);
  }
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, isError ? 4500 : 2500);
}

export async function requireRole(...roles) {
  const me = await api('/api/me');
  if (!roles.includes(me.role)) {
    location.href = homeFor(me.role);
    throw new Error('wrong role');
  }
  return me;
}

export function homeFor(role) {
  return { team: '/team', reviewer: '/review', admin: '/admin' }[role] || '/';
}

export async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/';
}

// Server clock offset so countdowns agree across phones.
let offset = 0;
export function syncClock(serverNow) {
  if (serverNow) offset = serverNow - Date.now();
}
export const serverTime = () => Date.now() + offset;

export function fmtDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return (h ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
}

export function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const PHASE_LABEL = { lobby: 'Waiting to start', active: 'Game on', ending: 'Final minutes!', ended: 'Game over' };

// Live updates: the server only says "something changed", pages refetch what they need.
export function connectLive(handlers) {
  const socket = window.io({ transports: ['websocket', 'polling'] });
  const debounced = {};
  for (const [event, fn] of Object.entries(handlers)) {
    socket.on(event, () => {
      clearTimeout(debounced[event]);
      debounced[event] = setTimeout(fn, 250);
    });
  }
  socket.on('connect', () => handlers.refresh?.());
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') location.href = '/';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') handlers.refresh?.();
  });
  return socket;
}

export function startTicker(fn) {
  fn();
  return setInterval(fn, 1000);
}
