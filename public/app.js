'use strict';
const $ = (s, r = document) => r.querySelector(s);
const app = document.getElementById('app');
// apply saved theme before first paint
document.documentElement.dataset.theme = localStorage.getItem('hearth_theme') || 'light';
function setTheme(t) { localStorage.setItem('hearth_theme', t); document.documentElement.dataset.theme = t; }

const state = {
  token: localStorage.getItem('hearth_token') || null,
  user: null,
  families: [],
  familyId: Number(localStorage.getItem('hearth_family')) || null,
  members: [],
  me: null,
  view: 'home',
  ws: null,
  weather: null,
  data: { briefing: null, events: [], tasks: [], grocery: [], goals: [], moments: [], prayers: [] },
};

// ---------- utils ----------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove(); return true;
  }
}
// little burst of joy when something gets done
function celebrate(x, y) {
  if (navigator.vibrate) { try { navigator.vibrate(14); } catch {} } // subtle haptic
  const emojis = ['🎉', '✨', '⭐', '🌟', '💫', '🥳', '🙌'];
  const px = x ?? window.innerWidth / 2, py = y ?? window.innerHeight / 2;
  for (let i = 0; i < 9; i++) {
    const s = document.createElement('div');
    s.className = 'confetti'; s.textContent = emojis[i % emojis.length];
    s.style.left = px + 'px'; s.style.top = py + 'px';
    s.style.setProperty('--dx', (Math.random() * 160 - 80).toFixed(0) + 'px');
    s.style.setProperty('--dr', (Math.random() * 1.4 - 0.7).toFixed(2) + 'turn');
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 1100);
  }
}
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch('/api' + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let body = null; try { body = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(body?.error || 'Request failed');
    err.status = res.status;
    err.code = body?.error;          // e.g. 'premium_required'
    err.feature = body?.feature;     // human-friendly upsell message
    throw err;
  }
  return body;
}
function setToken(t) { state.token = t; if (t) localStorage.setItem('hearth_token', t); else localStorage.removeItem('hearth_token'); }
function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtDay(iso) { return new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }); }
function memberById(id) { return state.members.find((m) => m.id === id); }
function initials(n) { return (n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase(); }

const WMO = (c) => {
  if (c === 0) return { emoji: '☀️', label: 'Clear' };
  if (c <= 3) return { emoji: '⛅', label: 'Partly cloudy' };
  if (c <= 48) return { emoji: '🌫️', label: 'Foggy' };
  if (c <= 67) return { emoji: '🌧️', label: 'Rainy' };
  if (c <= 77) return { emoji: '❄️', label: 'Snowy' };
  if (c <= 82) return { emoji: '🌦️', label: 'Showers' };
  if (c <= 86) return { emoji: '🌨️', label: 'Snow' };
  return { emoji: '⛈️', label: 'Storms' };
};
function loadWeather() {
  try {
    const cached = JSON.parse(localStorage.getItem('hearth_weather') || 'null');
    if (cached && Date.now() - cached.at < 3600e3) state.weather = cached;
  } catch {}
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const { latitude, longitude } = pos.coords;
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude.toFixed(2)}&longitude=${longitude.toFixed(2)}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`);
      const d = await r.json();
      const w = WMO(d.current.weather_code);
      state.weather = { at: Date.now(), temp: Math.round(d.current.temperature_2m), ...w };
      localStorage.setItem('hearth_weather', JSON.stringify(state.weather));
      if (state.view === 'home') render();
    } catch {}
  }, () => {}, { timeout: 8000, maximumAge: 3600e3 });
}

// next occurrence of a 'YYYY-MM-DD' birthday
function nextBirthday(bd) {
  if (!bd || typeof bd !== 'string') return null;
  const p = bd.split('-'); if (p.length < 3) return null;
  const yr = +p[0], mo = +p[1], da = +p[2];
  if (!mo || !da) return null;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  let next = new Date(now.getFullYear(), mo - 1, da);
  if (next < now) next = new Date(now.getFullYear() + 1, mo - 1, da);
  return { date: next, days: Math.round((next - now) / 864e5), turning: next.getFullYear() - yr };
}

// ---------- auth views ----------
function renderAuth(mode = 'login') {
  app.innerHTML = `
  <div class="screen"><div class="center-wrap"><div class="auth-card">
    <div class="brandmark"><div class="logo">🏡</div><h1>Homillow</h1><p>Your whole family, one calm place.</p></div>
    <div id="err"></div>
    ${mode === 'register' ? `<div class="field"><label>Your name</label><input id="name" autocomplete="name" /></div>` : ''}
    <div class="field"><label>Email</label><input id="email" type="email" autocomplete="email" /></div>
    <div class="field"><label>Password</label><input id="password" type="password" autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}" /></div>
    <button class="btn" id="go">${mode === 'register' ? 'Create account' : 'Sign in'}</button>
    ${mode === 'register' ? `<div class="consent">By creating an account, you agree to Homillow's <a href="/terms.html" target="_blank" rel="noopener">Terms of Service</a> and <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</div>` : ''}
    <div class="linkrow">${mode === 'register'
      ? `Already have an account? <a id="swap">Sign in</a>`
      : `New to Homillow? <a id="swap">Create account</a>`}</div>
  </div></div></div>`;
  $('#swap').onclick = () => renderAuth(mode === 'register' ? 'login' : 'register');
  $('#go').onclick = async () => {
    const email = $('#email').value, password = $('#password').value;
    const name = mode === 'register' ? $('#name').value : '';
    try {
      const out = await api(mode === 'register' ? '/register' : '/login', { method: 'POST', body: { email, password, name } });
      setToken(out.token); state.user = out.user; await boot();
    } catch (e) { $('#err').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

// ---------- family setup ----------
function renderFamilySetup() {
  app.innerHTML = `
  <div class="screen"><div class="center-wrap"><div class="auth-card">
    <div class="brandmark"><div class="logo">🏡</div><h1>Welcome, ${esc(state.user.name.split(' ')[0])}</h1><p>Create your family, or join one.</p></div>
    <div id="err"></div>
    <div class="field"><label>Family name</label><input id="famname" placeholder="The Calice Family" /></div>
    <div class="row2">
      <div class="field"><label>Your label</label><input id="dname" placeholder="Dad" /></div>
      <div class="field"><label>Color</label><input id="color" type="color" value="#c2582f" /></div>
    </div>
    <button class="btn" id="create">Create family</button>
    <div class="linkrow">Have an invite code? <a id="join">Join a family</a></div>
  </div></div></div>`;
  $('#create').onclick = async () => {
    try {
      const out = await api('/families', { method: 'POST', body: { name: $('#famname').value, displayName: $('#dname').value, color: $('#color').value } });
      selectFamily(out.id); await boot();
    } catch (e) { $('#err').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  $('#join').onclick = renderJoin;
}
function renderJoin() {
  app.innerHTML = `
  <div class="screen"><div class="center-wrap"><div class="auth-card">
    <div class="brandmark"><div class="logo">🔑</div><h1>Join a family</h1><p>Enter the invite code you were given.</p></div>
    <div id="err"></div>
    <div class="field"><label>Invite code</label><input id="code" /></div>
    <div class="row2">
      <div class="field"><label>Your label</label><input id="dname" placeholder="Mom" /></div>
      <div class="field"><label>Color</label><input id="color" type="color" value="#3f7d9c" /></div>
    </div>
    <button class="btn" id="joinbtn">Join</button>
    <div class="linkrow"><a id="back">Back</a></div>
  </div></div></div>`;
  $('#back').onclick = renderFamilySetup;
  $('#joinbtn').onclick = async () => {
    try {
      const out = await api('/invites/accept', { method: 'POST', body: { code: $('#code').value.trim(), displayName: $('#dname').value, color: $('#color').value } });
      selectFamily(out.family_id); await boot();
    } catch (e) { $('#err').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

function selectFamily(id) { state.familyId = id; localStorage.setItem('hearth_family', String(id)); }

// ---------- websocket ----------
function connectWS() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Pass the JWT as a WebSocket subprotocol (a request header), never in the URL,
  // so the token stays out of access logs and browser history.
  const ws = new WebSocket(`${proto}://${location.host}/?familyId=${state.familyId}`, [state.token]);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (['events', 'tasks', 'grocery', 'members', 'goals', 'moments', 'prayers'].includes(m.type)) refresh(true);
  };
  ws.onclose = () => { setTimeout(() => { if (state.token && state.familyId) connectWS(); }, 3000); };
  state.ws = ws;
}

// ---------- data ----------
async function refresh(quiet) {
  if (!state.familyId) return;
  const f = state.familyId;
  const [fam, brief, ev, tk, gr, gl, mo, pr] = await Promise.all([
    api(`/families/${f}`), api(`/families/${f}/briefing`),
    api(`/families/${f}/events`), api(`/families/${f}/tasks`), api(`/families/${f}/grocery`),
    api(`/families/${f}/goals`), api(`/families/${f}/moments`), api(`/families/${f}/prayers`),
  ]);
  state.members = fam.members; state.me = fam.me; state.familyName = fam.family.name;
  state.billing = fam.billing || { plan: 'free', premium: false, billing_enabled: false, free_member_limit: 4 };
  state.data = { briefing: brief, events: ev.events, tasks: tk.tasks, grocery: gr.items, goals: gl.goals, moments: mo.moments, prayers: pr.prayers };
  if (!quiet) {} render();
}

// ---------- billing / upgrade flow ----------
function isPremiumNow() { return !!(state.billing?.premium); }
function isAdmin() { return state.me?.role === 'admin'; }

// Kick off Stripe Checkout (admins only). plan: 'monthly' | 'annual'.
async function startUpgrade(plan = 'monthly') {
  if (!isAdmin()) { alert('Ask a family admin to upgrade to Premium.'); return; }
  try {
    const out = await api(`/families/${state.familyId}/billing/checkout`, { method: 'POST', body: { plan } });
    if (out?.url) window.location.href = out.url;         // hand off to Stripe's hosted page
  } catch (e) {
    alert(e.status === 503 ? 'Billing isn’t switched on yet — check back soon.' : (e.message || 'Could not start upgrade.'));
  }
}

// Open the Stripe portal to manage / cancel.
async function openBillingPortal() {
  try {
    const out = await api(`/families/${state.familyId}/billing/portal`, { method: 'POST' });
    if (out?.url) window.location.href = out.url;
  } catch (e) { alert(e.message || 'Could not open billing.'); }
}

// Shown when an action hits the paywall (402 premium_required).
function promptUpgrade(message) {
  const msg = message || 'This is part of Homillow Premium.';
  if (!isAdmin()) { alert(`${msg}\n\nAsk a family admin to upgrade.`); return; }
  if (confirm(`${msg}\n\nUpgrade to Homillow Premium now?`)) startUpgrade('monthly');
}

// ---------- main shell ----------
function render() {
  if (!state.token) return renderAuth('login');
  if (!state.familyId) return renderFamilySetup();
  const h0 = new Date().getHours();
  document.body.dataset.tod = h0 < 12 ? 'morning' : h0 < 18 ? 'afternoon' : 'evening';
  const meColor = state.me?.color || '#c2582f';
  app.innerHTML = `
    <div class="app-head">
      <div><h2>${headTitle()}</h2><div class="fam">${esc(state.familyName || '')}</div></div>
      <div class="avatar" style="background:${esc(meColor)}">${esc(initials(state.me?.display_name))}</div>
    </div>
    <div class="content" id="content"></div>
    <button class="fab" id="fab">+</button>
    <div class="tabbar">
      ${tab('home', '🏠', 'Home')}${tab('calendar', '📅', 'Calendar')}${tab('tasks', '✅', 'Tasks')}${tab('grocery', '🛒', 'Grocery')}${tab('altar', '🙏', 'Altar')}${tab('family', '👨‍👩‍👧', 'Family')}
    </div>`;
  $('#fab').onclick = onFab;
  document.querySelectorAll('.tabbar button').forEach((b) => b.onclick = () => { state.view = b.dataset.v; render(); });
  const c = $('#content');
  if (state.view === 'home') renderHome(c);
  else if (state.view === 'calendar') renderCalendar(c);
  else if (state.view === 'tasks') renderTasks(c);
  else if (state.view === 'grocery') renderGrocery(c);
  else if (state.view === 'altar') renderAltar(c);
  else if (state.view === 'family') renderFamily(c);
}
function tab(v, ic, label) { return `<button data-v="${v}" class="${state.view === v ? 'active' : ''}"><span class="ic">${ic}</span>${label}</button>`; }
function headTitle() {
  if (state.view === 'home') {
    const h = new Date().getHours();
    const g = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const emo = h < 12 ? '☀️' : h < 18 ? '🌤️' : '🌙';
    const nm = (state.me?.display_name || '').split(' ')[0];
    return `${g}${nm ? ', ' + esc(nm) : ''} ${emo}`;
  }
  return { calendar: 'Calendar', tasks: 'Tasks & Chores', grocery: 'Grocery', altar: 'Family Altar', family: 'Family' }[state.view] || 'Homillow';
}

const CAT_ICON = { work: '💼', school: '🎒', sports: '⚽', medical: '🩺', church: '⛪', family: '🏡', couple: '❤️', personal: '⭐', household: '🧹', important: '❗' };
function catIcon(c) { return CAT_ICON[c] || '📌'; }
function avatar(m, size = 26) {
  if (!m) return '';
  return `<span class="av" style="background:${esc(m.color)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px" title="${esc(m.display_name)}">${esc(initials(m.display_name))}</span>`;
}
function whoAvatars(ids) { return `<div class="who">${ids.map((id) => avatar(memberById(id), 24)).join('')}</div>`; }
function chip(m) { return m ? `<span class="chip" style="background:${esc(m.color)}">${esc(m.display_name)}</span>` : ''; }

// rotating warm messages so the app never feels repetitive
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
const ENCOURAGE = ['You’ve got this. 💪', 'Everything’s under control.', 'One calm step at a time.', 'Look at you, running the show.'];
const PROGRESS_MSG = ['Keep it rolling — you’re close.', 'Nice momentum today.', 'Every check-off counts.'];
const ALLDONE = ['You’re all caught up!', 'Home is running smoothly.', 'Another family win.', 'You’re keeping the family moving.'];
const DONE_MSG = ['Nice! One less thing to worry about.', 'Done and dusted. ✨', 'Boom — off the list.', 'One less thing on your plate.'];

// ---------- HOME / briefing ----------
function renderHome(c) {
  const b = state.data.briefing; if (!b) { c.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const now = new Date();
  const h = now.getHours();
  const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const emo = h < 12 ? '☀️' : h < 18 ? '🌤️' : '🌙';
  const first = (state.me?.display_name || '').split(' ')[0];
  const count = b.timeline.length;

  // welcoming header — this is "our family's space," not a dashboard
  const w = state.weather;
  const wchip = w ? `<div class="weather">${w.emoji} ${w.temp}°<span>${esc(w.label)}</span></div>` : '';
  let html = `<div class="hero-home">
    <div class="hero-top">
      <div><div class="hg">${greet}${first ? ', ' + esc(first) : ''} ${emo}</div>
      <div class="hd">${esc(now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))}</div></div>
      ${wchip}
    </div>
    <div class="hs">${count ? "Here's what your family has going on today." : 'A calm, open day ahead.'}</div>
  </div>`;

  // birthday nudge (today or within 3 days)
  const bdays = state.members.map((m) => ({ m, b: nextBirthday(m.birthdate) }))
    .filter((x) => x.b && x.b.days <= 3).sort((a, b2) => a.b.days - b2.b.days);
  if (bdays.length) {
    const x = bdays[0];
    html += `<div class="bday-banner">🎂 <b>${esc(x.m.display_name)}'s birthday</b> ${x.b.days === 0 ? 'is today!' : 'in ' + x.b.days + ' day' + (x.b.days > 1 ? 's' : '')} — turning ${x.b.turning}.</div>`;
  }

  if (b.conflicts.length) {
    html += b.conflicts.map((x) => `<div class="conflict">⚠️ <b>Heads up:</b> “${esc(x.a)}” and “${esc(x.b)}” overlap at ${esc(fmtTime(x.at))}.</div>`).join('');
  }

  // the beautiful daily family card
  html += `<div class="card today-card">
    <div class="card-head"><h3>Today</h3>${count ? `<span class="count-pill">${count} ${count === 1 ? 'thing' : 'things'}</span>` : ''}</div>`;
  if (!count) {
    html += `<div class="empty-warm"><div class="ee">🌤️</div><div class="et">Your day is wide open.</div><div class="es">Some breathing room — enjoy it.</div></div>`;
  } else {
    html += `<div class="timeline">` + b.timeline.map((e) => {
      const m = e.participantIds[0] ? memberById(e.participantIds[0]) : null;
      return `<div class="tl-row">
        <div class="tl-time">${e.all_day ? 'All day' : esc(fmtTime(e.occ_start))}</div>
        <div class="tl-dot" style="background:${m ? esc(m.color) : '#cabfb0'}"></div>
        <div class="tl-main"><div class="tl-t">${catIcon(e.category)} ${esc(e.title)}</div>
        ${e.location ? `<div class="tl-loc">📍 ${esc(e.location)}</div>` : ''}
        ${e.participantIds.length ? whoAvatars(e.participantIds) : '<span class="muted small">Unassigned</span>'}</div>
      </div>`;
    }).join('') + `</div>`;
    html += `<div class="card-foot">${pick(ENCOURAGE)}</div>`;
  }
  html += `</div>`;

  // today's verse — the faith layer, gently present on the home screen
  if (b.devotional) html += devotionalCard(b.devotional, true);

  // today's progress — encouraging, never guilt
  const tasks = state.data.tasks || [];
  const total = tasks.length, done = tasks.filter((t) => t.done).length;
  if (total) {
    const pct = Math.round((done / total) * 100);
    html += `<div class="card">
      <div class="card-head"><h3>Today's progress</h3><span class="muted small">${done} of ${total} done</span></div>
      <div class="pbar"><div class="pfill" style="width:${pct}%"></div></div>
      <div class="pmsg">${done === total ? '🎉 ' + pick(ALLDONE) : pick(PROGRESS_MSG)}</div>
    </div>`;
  }

  // quick glances — one-tap into the areas that need attention
  html += `<div class="quick-row">
    <button class="quick" data-go="grocery"><span class="qi">🛒</span><span class="qn">${b.groceryOpen}</span><span class="ql">to buy</span></button>
    <button class="quick" data-go="tasks"><span class="qi">✅</span><span class="qn">${b.tasksDue.length}</span><span class="ql">tasks</span></button>
    <button class="quick" data-go="altar"><span class="qi">🙏</span><span class="qn">${b.prayersOpen ?? 0}</span><span class="ql">prayers</span></button>
    <button class="quick" data-go="calendar"><span class="qi">📅</span><span class="qn">${count}</span><span class="ql">today</span></button>
  </div>`;

  c.innerHTML = html;
  c.querySelectorAll('[data-go]').forEach((el) => el.onclick = () => { state.view = el.dataset.go; render(); });
}
function eventRow(e) {
  return `<div class="event-row">
    <div class="event-time">${e.all_day ? 'All day' : esc(fmtTime(e.occ_start || e.start_utc))}</div>
    <div class="event-main"><div class="t">${catIcon(e.category)} ${esc(e.title)}</div>
    <div class="sub">${e.location ? '📍 ' + esc(e.location) + ' · ' : ''}<span class="pill">${esc(e.category)}</span></div>
    ${e.participantIds?.length ? whoAvatars(e.participantIds) : ''}</div></div>`;
}

// ---------- CALENDAR ----------
function renderCalendar(c) {
  const evs = state.data.events;
  if (!evs.length) { c.innerHTML = `<div class="empty-warm big"><div class="ee">🗓️</div><div class="et">Your calendar's a blank canvas.</div><div class="es">Tap the + to add your first event.</div></div>`; return; }
  const groups = {};
  for (const e of evs) { const k = new Date(e.occ_start).toDateString(); (groups[k] ||= []).push(e); }
  c.innerHTML = Object.entries(groups).map(([day, list]) => `
    <div class="section-title">${esc(fmtDay(list[0].occ_start))}</div>
    <div class="card">${list.map((e) => `<div data-id="${e.id}" class="ev-tap">${eventRow(e)}</div>`).join('')}</div>`).join('');
  c.querySelectorAll('.ev-tap').forEach((el) => el.onclick = () => openEvent(Number(el.dataset.id)));
}

// ---------- TASKS ----------
function renderTasks(c) {
  const ts = state.data.tasks;
  if (!ts.length) { c.innerHTML = `<div class="empty-warm big"><div class="ee">🌿</div><div class="et">Nothing waiting for you.</div><div class="es">Add a chore with + whenever you're ready.</div></div>`; return; }
  c.innerHTML = `<div class="card">${ts.map((t) => {
    const m = t.assigned_to ? memberById(t.assigned_to) : null;
    return `<div class="list-item">
      <div class="check ${t.done ? 'on' : ''}" data-toggle="${t.id}">${t.done ? '✓' : ''}</div>
      <div class="li-main ${t.done ? 'done' : ''}"><div class="t">${esc(t.title)}</div>
      <div class="li-sub">${m ? esc(m.display_name) : 'Unassigned'}${t.due_utc ? ' · due ' + esc(new Date(t.due_utc).toLocaleDateString()) : ''}${t.points ? ' · ⭐' + t.points : ''}</div></div>
      <button class="trash" data-del="${t.id}">🗑</button></div>`;
  }).join('')}</div>`;
  c.querySelectorAll('[data-toggle]').forEach((el) => el.onclick = async (e) => {
    const t = ts.find((x) => x.id === Number(el.dataset.toggle));
    if (!t.done) { celebrate(e.clientX, e.clientY); toast(pick(DONE_MSG)); }
    await api(`/families/${state.familyId}/tasks/${t.id}`, { method: 'PATCH', body: { done: !t.done } }); refresh();
  });
  c.querySelectorAll('[data-del]').forEach((el) => el.onclick = async () => {
    await api(`/families/${state.familyId}/tasks/${el.dataset.del}`, { method: 'DELETE' }); refresh();
  });
}

// ---------- GROCERY ----------
function renderGrocery(c) {
  const items = state.data.grocery;
  c.innerHTML = `<div class="card">
    <div class="row2"><div class="field" style="margin:0"><input id="gadd" placeholder="Add item & press Enter" /></div></div>
    ${items.length ? '' : '<div class="empty-warm"><div class="ee">🧺</div><div class="et">Your grocery list is ready when you are.</div></div>'}
    <div id="glist" style="margin-top:8px">${items.map((it) => `
      <div class="list-item">
        <div class="check ${it.checked ? 'on' : ''}" data-toggle="${it.id}">${it.checked ? '✓' : ''}</div>
        <div class="li-main ${it.checked ? 'done' : ''}"><div class="t">${esc(it.name)}</div><div class="li-sub">${esc(it.category)}</div></div>
        <button class="trash" data-del="${it.id}">🗑</button></div>`).join('')}</div></div>`;
  const input = $('#gadd');
  input.onkeydown = async (e) => { if (e.key === 'Enter' && input.value.trim()) {
    await api(`/families/${state.familyId}/grocery`, { method: 'POST', body: { name: input.value.trim() } }); input.value = ''; refresh();
  }};
  c.querySelectorAll('[data-toggle]').forEach((el) => el.onclick = async (e) => {
    const it = items.find((x) => x.id === Number(el.dataset.toggle));
    if (!it.checked) { celebrate(e.clientX, e.clientY); toast(pick(DONE_MSG)); }
    await api(`/families/${state.familyId}/grocery/${it.id}`, { method: 'PATCH', body: { checked: !it.checked } }); refresh();
  });
  c.querySelectorAll('[data-del]').forEach((el) => el.onclick = async () => {
    await api(`/families/${state.familyId}/grocery/${el.dataset.del}`, { method: 'DELETE' }); refresh();
  });
}

// ---------- FAMILY ALTAR ----------
const PRAYER_ANSWERED = ['Praise God — answered! 🙌', 'He heard you. 🙏', 'Faithful, every time. ✨', 'Answered prayer — never forget it.'];
function devotionalCard(dev, compact) {
  if (!dev) return '';
  return `<div class="card verse-card" style="background:linear-gradient(135deg,#6C8AE4,#8a6ce4);color:#fff">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;margin-bottom:8px">🕊️ Today's verse</div>
    <div style="font-size:${compact ? '17px' : '19px'};line-height:1.5;font-weight:600">“${esc(dev.verse)}”</div>
    <div style="margin-top:8px;opacity:.9;font-size:14px">— ${esc(dev.ref)}</div>
    ${compact ? '' : `<div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.25);font-size:14px;line-height:1.5"><b>Reflect together:</b> ${esc(dev.prompt)}</div>`}
  </div>`;
}
function renderAltar(c) {
  const dev = state.data.briefing?.devotional;
  const prayers = state.data.prayers || [];
  const active = prayers.filter((p) => !p.answered);
  const answered = prayers.filter((p) => p.answered);
  let html = devotionalCard(dev, false);

  const locked = state.billing?.billing_enabled && !isPremiumNow();
  html += `<div class="card">
    <div class="card-head"><h3>🙏 Our prayer list</h3><span class="muted small">${active.length} active</span></div>`;
  if (locked) {
    html += `<div class="upgrade-banner">
        <div class="ub-title">✨ The Family Altar is part of Homillow Premium</div>
        <div class="ub-sub">Keep a shared prayer list, celebrate answered prayers, and pray together as a family.</div>
        <button class="btn-primary" id="altar-upgrade">Upgrade to Premium</button>
      </div>`;
  } else {
    html += `<div class="field" style="margin:0"><input id="padd" placeholder="Add a prayer request & press Enter" /></div>`;
  }
  html += `<div style="margin-top:10px">`;
  if (!active.length) {
    html += `<div class="empty-warm"><div class="ee">🕯️</div><div class="et">Bring your family's needs here.</div><div class="es">Add a request above — then celebrate when God answers.</div></div>`;
  } else {
    html += active.map((p) => {
      const m = memberById(p.created_by) || state.members.find((x) => x.user_id === p.created_by);
      return `<div class="list-item">
        <div class="check" data-answer="${p.id}" title="Mark answered"></div>
        <div class="li-main"><div class="t">${esc(p.title)}</div>
        <div class="li-sub">${p.note ? esc(p.note) + ' · ' : ''}${esc(new Date(p.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</div></div>
        <button class="trash" data-del="${p.id}">🗑</button></div>`;
    }).join('');
  }
  html += `</div></div>`;

  if (answered.length) {
    html += `<div class="section-title">🙌 Answered prayers</div><div class="card">` + answered.map((p) => `
      <div class="list-item">
        <div class="check on" data-unanswer="${p.id}" title="Move back to active">✓</div>
        <div class="li-main done"><div class="t">${esc(p.title)}</div>
        <div class="li-sub">Answered ${p.answered_at ? esc(new Date(p.answered_at).toLocaleDateString([], { month: 'short', day: 'numeric' })) : ''}</div></div>
        <button class="trash" data-del="${p.id}">🗑</button></div>`).join('') + `</div>`;
  }

  c.innerHTML = html;
  const upBtn = $('#altar-upgrade');
  if (upBtn) upBtn.onclick = () => startUpgrade('monthly');
  const input = $('#padd');
  if (input) input.onkeydown = async (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      try {
        await api(`/families/${state.familyId}/prayers`, { method: 'POST', body: { title: input.value.trim() } });
        input.value = ''; refresh();
      } catch (err) {
        if (err.code === 'premium_required') promptUpgrade(err.feature);
        else alert(err.message || 'Could not add prayer.');
      }
    }
  };
  c.querySelectorAll('[data-answer]').forEach((el) => el.onclick = async (e) => {
    celebrate(e.clientX, e.clientY); toast(pick(PRAYER_ANSWERED));
    await api(`/families/${state.familyId}/prayers/${el.dataset.answer}`, { method: 'PATCH', body: { answered: true } }); refresh();
  });
  c.querySelectorAll('[data-unanswer]').forEach((el) => el.onclick = async () => {
    await api(`/families/${state.familyId}/prayers/${el.dataset.unanswer}`, { method: 'PATCH', body: { answered: false } }); refresh();
  });
  c.querySelectorAll('[data-del]').forEach((el) => el.onclick = async () => {
    if (confirm('Remove this prayer?')) { await api(`/families/${state.familyId}/prayers/${el.dataset.del}`, { method: 'DELETE' }); refresh(); }
  });
}

// ---------- FAMILY ----------
function renderFamily(c) {
  const now = Date.now();
  const couple = (state.data.events || [])
    .filter((e) => e.category === 'couple' && Date.parse(e.occ_end || e.occ_start) >= now)
    .slice(0, 4);

  // ❤️ Our Time — the couple space, warmer and more intimate than the rest
  let html = `<div class="card us-card">
    <div class="us-head">❤️ Our Time</div>
    <div class="us-sub">Protecting time for each other matters.</div>`;
  if (couple.length) {
    html += `<div style="margin-top:12px">` + couple.map((e) => `
      <div class="event-row"><div class="event-time">${e.all_day ? '—' : esc(fmtTime(e.occ_start))}</div>
      <div class="event-main"><div class="t">❤️ ${esc(e.title)}</div>
      <div class="sub">${esc(new Date(e.occ_start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}${e.location ? ' · 📍 ' + esc(e.location) : ''}</div></div></div>`).join('') + `</div>`;
  } else {
    html += `<div class="us-empty">No couple time on the calendar yet. A little planned time together goes a long way. 🤍</div>`;
  }
  html += `<button class="btn" id="addcouple" style="margin-top:14px;background:#b8556b">Schedule couple time</button></div>`;

  // 🎂 Birthdays
  const bdayList = state.members.map((m) => ({ m, b: nextBirthday(m.birthdate) })).filter((x) => x.b)
    .sort((a, b2) => a.b.days - b2.b.days).slice(0, 6);
  html += `<div class="card"><div class="card-head"><h3>🎂 Birthdays</h3></div>`;
  if (bdayList.length) {
    html += bdayList.map((x) => `<div class="list-item"><span class="av" style="background:${esc(x.m.color)};width:34px;height:34px;font-size:13px">${esc(initials(x.m.display_name))}</span>
      <div class="li-main"><div class="t">${esc(x.m.display_name)}</div><div class="li-sub">${esc(x.b.date.toLocaleDateString([], { month: 'long', day: 'numeric' }))} · ${x.b.days === 0 ? 'Today! 🎉' : x.b.days + ' day' + (x.b.days > 1 ? 's' : '') + ' away · turning ' + x.b.turning}</div></div></div>`).join('');
  } else {
    html += `<div class="empty-warm"><div class="ee">🎈</div><div class="et">No birthdays yet.</div><div class="es">Tap a family member below to add theirs.</div></div>`;
  }
  html += `</div>`;

  // 🎯 Family goals
  const goals = state.data.goals || [];
  html += `<div class="card"><div class="card-head"><h3>🎯 Family goals</h3><button class="mini-add" id="addgoal">+ Add</button></div>`;
  if (goals.length) {
    html += goals.map((gl) => {
      const pct = Math.round((gl.current_num / gl.target_num) * 100);
      return `<div class="goal">
        <div class="goal-top"><div class="goal-t">${gl.done ? '🏆 ' : ''}${esc(gl.title)}</div><div class="goal-n">${gl.current_num}/${gl.target_num}</div></div>
        <div class="pbar"><div class="pfill" style="width:${pct}%"></div></div>
        <div class="goal-acts">${gl.done ? '<span class="goal-win">Achieved! 🎉</span>' : `<button class="mini" data-goalinc="${gl.id}">+1</button>`}
        <button class="mini ghost" data-goaldel="${gl.id}">Remove</button></div></div>`;
    }).join('');
  } else {
    html += `<div class="empty-warm"><div class="ee">🎯</div><div class="et">Set a goal together.</div><div class="es">Two date nights a month. One family trip. You decide.</div></div>`;
  }
  html += `</div>`;

  // 📸 Family moments
  const moments = state.data.moments || [];
  html += `<div class="card"><div class="card-head"><h3>📸 Family moments</h3><button class="mini-add" id="addmoment">+ Add</button></div>`;
  if (moments.length) {
    html += `<div class="moments">` + moments.map((mo) => `<div class="moment" data-momdel="${mo.id}">
      <div class="mo-emoji">${esc(mo.emoji)}</div><div class="mo-main"><div class="mo-t">${esc(mo.title)}</div>
      <div class="mo-d">${mo.moment_date ? esc(new Date(mo.moment_date).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })) : ''}${mo.note ? ' · ' + esc(mo.note) : ''}</div></div></div>`).join('') + `</div>`;
  } else {
    html += `<div class="empty-warm"><div class="ee">📸</div><div class="et">Capture what matters.</div><div class="es">Birthdays, trips, milestones — the why behind it all.</div></div>`;
  }
  html += `</div>`;

  // 📅 This week at a glance
  const wk = Date.now() + 7 * 864e5;
  const evWeek = (state.data.events || []).filter((e) => { const s = Date.parse(e.occ_start); return s >= Date.now() - 864e5 && s <= wk; }).length;
  const tks = state.data.tasks || []; const tdone = tks.filter((t) => t.done).length;
  const coupleWeek = (state.data.events || []).filter((e) => e.category === 'couple' && Date.parse(e.occ_start) <= wk && Date.parse(e.occ_end || e.occ_start) >= Date.now()).length;
  html += `<div class="card recap-card"><div class="card-head"><h3>Your week at a glance</h3></div>
    <div class="recap-grid">
      <div class="recap"><div class="rn">${evWeek}</div><div class="rl">events</div></div>
      <div class="recap"><div class="rn">${tdone}/${tks.length}</div><div class="rl">tasks done</div></div>
      <div class="recap"><div class="rn">${coupleWeek}</div><div class="rl">couple time ❤️</div></div>
    </div>
    <div class="card-foot">${evWeek || tdone ? 'You’re keeping it all moving. 💛' : 'A calm week so far.'}</div></div>`;

  // Our Family — the people behind the schedule
  html += `<div class="card"><div class="card-head"><h3>Our Family</h3><span class="muted small">${state.members.length} member${state.members.length !== 1 ? 's' : ''}</span></div>
    <div class="fam-grid">${state.members.map((m) => `
      <div class="fam-card" data-mid="${m.id}"><span class="av" style="background:${esc(m.color)};width:52px;height:52px;font-size:20px">${esc(initials(m.display_name))}</span>
      <div class="fam-name">${esc(m.display_name)}</div><div class="fam-role">${esc(m.role)}</div></div>`).join('')}</div>
    <div class="muted small" style="text-align:center;margin-top:8px">Tap anyone to set their color or birthday</div></div>`;

  if (state.me?.role === 'admin') {
    html += `<div class="card"><h3>Invite someone</h3>
      <div class="field"><label>Their role</label><select id="invrole"><option value="adult">Adult</option><option value="admin">Admin (parent)</option><option value="child">Child</option></select></div>
      <button class="btn secondary" id="makeinv">Generate invite code</button><div id="invout" style="margin-top:12px"></div></div>`;
  }
  // 💎 Homillow Premium — plan status + upgrade/manage
  if (state.billing?.billing_enabled) {
    const prem = isPremiumNow();
    html += `<div class="card"><div class="card-head"><h3>${prem ? '💎 Homillow Premium' : '✨ Homillow'}</h3>
      <span class="muted small">${prem ? 'Premium' : 'Free plan'}</span></div>`;
    if (prem) {
      html += `<div class="li-sub" style="margin-bottom:12px">Family Altar unlocked · unlimited members. Thank you for supporting Homillow. 🙏</div>`;
      if (isAdmin()) html += `<button class="btn secondary" id="managebill">Manage subscription</button>`;
    } else {
      html += `<div class="li-sub" style="margin-bottom:12px">Unlock the <b>Family Altar</b> (shared prayers + devotional) and <b>unlimited members</b>. Free covers calendar, tasks & grocery for up to ${state.billing.free_member_limit} members.</div>`;
      if (isAdmin()) {
        html += `<div class="row2">
          <button class="btn-primary" id="up-month" style="flex:1">Monthly</button>
          <button class="btn secondary" id="up-year" style="flex:1">Yearly (save)</button>
        </div>`;
      } else {
        html += `<div class="muted small">Ask a family admin to upgrade.</div>`;
      }
    }
    html += `</div>`;
  }
  html += `<div class="card"><div class="card-head"><h3>⚙️ Settings</h3></div>
    <div class="setting-row"><div class="li-main"><div class="t">Dark mode</div><div class="li-sub">Easy on the eyes at night</div></div>
    <button class="toggle ${document.documentElement.dataset.theme === 'dark' ? 'on' : ''}" id="themetoggle" aria-label="Toggle dark mode"><span class="knob"></span></button></div>
    <button class="btn ghost" id="logout" style="margin-top:14px">Sign out</button></div>`;
  c.innerHTML = html;
  c.querySelectorAll('[data-mid]').forEach((el) => el.onclick = () => openMemberModal(memberById(Number(el.dataset.mid))));
  if ($('#addgoal')) $('#addgoal').onclick = openGoalModal;
  c.querySelectorAll('[data-goalinc]').forEach((el) => el.onclick = async (e) => {
    const g = (state.data.goals || []).find((x) => x.id === Number(el.dataset.goalinc));
    const r = await api(`/families/${state.familyId}/goals/${el.dataset.goalinc}`, { method: 'PATCH', body: { increment: true } });
    if (r.goal.done && !(g && g.done)) { celebrate(e.clientX, e.clientY); toast('Family goal achieved! 🎉'); }
    refresh();
  });
  c.querySelectorAll('[data-goaldel]').forEach((el) => el.onclick = async () => { await api(`/families/${state.familyId}/goals/${el.dataset.goaldel}`, { method: 'DELETE' }); refresh(); });
  if ($('#addmoment')) $('#addmoment').onclick = openMomentModal;
  c.querySelectorAll('[data-momdel]').forEach((el) => el.onclick = async () => { if (confirm('Remove this moment?')) { await api(`/families/${state.familyId}/moments/${el.dataset.momdel}`, { method: 'DELETE' }); refresh(); } });
  if ($('#themetoggle')) $('#themetoggle').onclick = () => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); render(); };
  if ($('#up-month')) $('#up-month').onclick = () => startUpgrade('monthly');
  if ($('#up-year')) $('#up-year').onclick = () => startUpgrade('annual');
  if ($('#managebill')) $('#managebill').onclick = openBillingPortal;
  if ($('#makeinv')) $('#makeinv').onclick = async () => {
    let out;
    try {
      out = await api(`/families/${state.familyId}/invites`, { method: 'POST', body: { role: $('#invrole').value } });
    } catch (err) {
      if (err.code === 'premium_required') return promptUpgrade(err.feature);
      return alert(err.message || 'Could not create invite.');
    }
    const link = location.origin;
    const msg = `Join our family on Homillow 🏡\n\n1. Open ${link}\n2. Create your account\n3. Tap "Join a family" and enter this code:\n\n${out.code}\n\n(Code expires in 7 days.)`;
    $('#invout').innerHTML = `
      <div class="small muted" style="margin-bottom:6px">Invite code — expires in 7 days:</div>
      <div class="codebox">${esc(out.code)}</div>
      <div class="row2" style="margin-top:12px">
        <button class="btn" id="shareinv" style="flex:1">📤 Send invite</button>
        <button class="btn secondary" id="copyinv" style="flex:1">Copy</button>
      </div>
      <div class="small muted" style="margin-top:10px">They open the link, make an account, tap <b>Join a family</b>, and enter the code.</div>`;
    $('#shareinv').onclick = async () => {
      if (navigator.share) {
        try { await navigator.share({ title: 'Join our family on Homillow', text: msg }); }
        catch { /* user cancelled — no-op */ }
      } else {
        await copyText(msg); toast('Invite copied — paste it into a text');
      }
    };
    $('#copyinv').onclick = async () => { await copyText(msg); toast('Invite copied ✓'); };
  };
  if ($('#addcouple')) $('#addcouple').onclick = () => openEventModal('couple');
  $('#logout').onclick = () => { setToken(null); localStorage.removeItem('hearth_family'); state.familyId = null; state.user = null; if (state.ws) state.ws.close(); render(); };
}

// ---------- add / edit ----------
function onFab() {
  if (state.view === 'tasks') return openTaskModal();
  if (state.view === 'grocery') { $('#gadd')?.focus(); return; }
  if (state.view === 'altar') { $('#padd')?.focus(); return; }
  openEventModal();
}
function modal(inner) {
  const back = document.createElement('div'); back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${inner}</div>`;
  back.onclick = (e) => { if (e.target === back) back.remove(); };
  document.body.appendChild(back); return back;
}
function memberPicker(selected = []) {
  return `<div class="memberpick" id="mp">${state.members.map((m) => `
    <div class="m ${selected.includes(m.id) ? 'sel' : ''}" data-id="${m.id}" style="${selected.includes(m.id) ? 'background:' + esc(m.color) : ''}">${esc(m.display_name)}</div>`).join('')}</div>`;
}
function wirePicker(back) {
  back.querySelectorAll('#mp .m').forEach((el) => el.onclick = () => {
    const on = el.classList.toggle('sel');
    el.style.background = on ? memberById(Number(el.dataset.id)).color : '';
  });
}
function pickedIds(back) { return [...back.querySelectorAll('#mp .m.sel')].map((el) => Number(el.dataset.id)); }

function localInputToISO(v) { return v ? new Date(v).toISOString() : null; }
function nowLocalInput(addH = 0) {
  const d = new Date(Date.now() + addH * 3600e3); d.setMinutes(0, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function openEventModal(preset) {
  const cats = ['family', 'couple', 'work', 'school', 'sports', 'medical', 'church', 'personal', 'household', 'important'];
  const back = modal(`
    <h3>${preset === 'couple' ? '❤️ Schedule couple time' : 'New event'}</h3><div id="merr"></div>
    <div class="field"><label>Title</label><input id="e-title" placeholder="${preset === 'couple' ? 'Date night' : 'Soccer practice'}" /></div>
    <div class="row2">
      <div class="field"><label>Start</label><input id="e-start" type="datetime-local" value="${nowLocalInput(1)}" /></div>
      <div class="field"><label>End</label><input id="e-end" type="datetime-local" value="${nowLocalInput(2)}" /></div>
    </div>
    <div class="row2">
      <div class="field"><label>Category</label><select id="e-cat">${cats.map((x) => `<option ${x === preset ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label>Repeat</label><select id="e-rec">${['none','daily','weekly','monthly','yearly'].map((x) => `<option>${x}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Location</label><input id="e-loc" placeholder="Optional" /></div>
    <div class="field"><label>Who's responsible?</label>${memberPicker()}</div>
    <button class="btn" id="e-save">Add to calendar</button>`);
  wirePicker(back);
  $('#e-save', back).onclick = async () => {
    try {
      const out = await api(`/families/${state.familyId}/events`, { method: 'POST', body: {
        title: $('#e-title', back).value, start_utc: localInputToISO($('#e-start', back).value),
        end_utc: localInputToISO($('#e-end', back).value), category: $('#e-cat', back).value,
        recurrence: $('#e-rec', back).value, location: $('#e-loc', back).value, participantIds: pickedIds(back),
      }});
      back.remove();
      if (out.conflicts?.length) toast(`Added — but ⚠️ ${out.conflicts.length} conflict(s) detected`);
      else toast('Event added');
      refresh();
    } catch (e) { $('#merr', back).innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}
async function openEvent(id) {
  const e = state.data.events.find((x) => x.id === id); if (!e) return;
  const back = modal(`
    <h3>${esc(e.title)}</h3>
    <p class="muted small">${esc(fmtDay(e.occ_start))} · ${e.all_day ? 'All day' : esc(fmtTime(e.occ_start)) + '–' + esc(fmtTime(e.occ_end))}</p>
    ${e.location ? `<p class="small">📍 ${esc(e.location)}</p>` : ''}
    ${e.participantIds.length ? whoChips(e.participantIds) : '<p class="muted small">No one assigned yet.</p>'}
    <div style="height:14px"></div>
    <button class="btn ghost" id="del">Delete event</button>`);
  $('#del', back).onclick = async () => { await api(`/families/${state.familyId}/events/${e.id}`, { method: 'DELETE' }); back.remove(); toast('Deleted'); refresh(); };
}
function openTaskModal() {
  const back = modal(`
    <h3>New task / chore</h3><div id="merr"></div>
    <div class="field"><label>Task</label><input id="t-title" placeholder="Take out trash" /></div>
    <div class="field"><label>Assign to</label>${memberPicker()}</div>
    <div class="row2">
      <div class="field"><label>Due (optional)</label><input id="t-due" type="date" /></div>
      <div class="field"><label>Points (optional)</label><input id="t-pts" type="number" min="0" value="0" /></div>
    </div>
    <button class="btn" id="t-save">Add task</button>`);
  // single-assignee: clicking one clears others
  back.querySelectorAll('#mp .m').forEach((el) => el.onclick = () => {
    const was = el.classList.contains('sel');
    back.querySelectorAll('#mp .m').forEach((x) => { x.classList.remove('sel'); x.style.background = ''; });
    if (!was) { el.classList.add('sel'); el.style.background = memberById(Number(el.dataset.id)).color; }
  });
  $('#t-save', back).onclick = async () => {
    try {
      const ids = pickedIds(back);
      await api(`/families/${state.familyId}/tasks`, { method: 'POST', body: {
        title: $('#t-title', back).value, assigned_to: ids[0] || null,
        due_utc: $('#t-due', back).value ? new Date($('#t-due', back).value).toISOString() : null,
        points: Number($('#t-pts', back).value) || 0,
      }});
      back.remove(); toast('Task added'); refresh();
    } catch (e) { $('#merr', back).innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

function openMemberModal(m) {
  if (!m) return;
  const canEdit = state.me?.role === 'admin' || state.me?.id === m.id;
  const back = modal(`
    <h3>${esc(m.display_name)}</h3><div id="merr"></div>
    ${canEdit ? `
    <div class="field"><label>Name / label</label><input id="m-name" value="${esc(m.display_name)}" /></div>
    <div class="row2">
      <div class="field"><label>Color</label><input id="m-color" type="color" value="${/^#[0-9a-fA-F]{6}$/.test(m.color) ? esc(m.color) : '#c2582f'}" /></div>
      <div class="field"><label>Birthday</label><input id="m-bday" type="date" value="${m.birthdate ? esc(m.birthdate) : ''}" /></div>
    </div>
    <button class="btn" id="m-save">Save</button>` : `<p class="muted small">Only ${esc(m.display_name)} or a parent can edit this profile.</p>`}`);
  if (canEdit) $('#m-save', back).onclick = async () => {
    try {
      await api(`/families/${state.familyId}/members/${m.id}`, { method: 'PATCH', body: { display_name: $('#m-name', back).value, color: $('#m-color', back).value, birthdate: $('#m-bday', back).value || null } });
      back.remove(); toast('Saved ✓'); refresh();
    } catch (e) { $('#merr', back).innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}
function openGoalModal() {
  const back = modal(`
    <h3>New family goal</h3><div id="merr"></div>
    <div class="field"><label>Goal</label><input id="g-title" placeholder="Two date nights a month" /></div>
    <div class="field"><label>Target count</label><input id="g-target" type="number" min="1" value="1" /></div>
    <button class="btn" id="g-save">Add goal</button>`);
  $('#g-save', back).onclick = async () => {
    try {
      await api(`/families/${state.familyId}/goals`, { method: 'POST', body: { title: $('#g-title', back).value, target_num: Number($('#g-target', back).value) || 1 } });
      back.remove(); toast('Goal added 🎯'); refresh();
    } catch (e) { $('#merr', back).innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}
function openMomentModal() {
  const emojis = ['✨', '🎂', '🏖️', '🎄', '⚽', '🎓', '🍼', '🏡', '❤️', '🎉', '✈️', '🐾'];
  const back = modal(`
    <h3>Add a family moment</h3><div id="merr"></div>
    <div class="field"><label>What happened?</label><input id="mo-title" placeholder="First family vacation" /></div>
    <div class="field"><label>Date</label><input id="mo-date" type="date" /></div>
    <div class="field"><label>Note (optional)</label><input id="mo-note" placeholder="A memory to keep" /></div>
    <div class="field"><label>Icon</label><div class="emoji-pick" id="mo-emoji">${emojis.map((e, i) => `<span class="ep ${i === 0 ? 'sel' : ''}" data-e="${e}">${e}</span>`).join('')}</div></div>
    <button class="btn" id="mo-save">Save moment</button>`);
  let chosen = '✨';
  back.querySelectorAll('#mo-emoji .ep').forEach((el) => el.onclick = () => { back.querySelectorAll('#mo-emoji .ep').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); chosen = el.dataset.e; });
  $('#mo-save', back).onclick = async () => {
    try {
      await api(`/families/${state.familyId}/moments`, { method: 'POST', body: { title: $('#mo-title', back).value, emoji: chosen, moment_date: $('#mo-date', back).value || null, note: $('#mo-note', back).value } });
      back.remove(); toast('Moment saved ✨'); refresh();
    } catch (e) { $('#merr', back).innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

// ---------- boot ----------
async function boot() {
  if (!state.token) return renderAuth('login');
  try {
    const me = await api('/me'); state.user = me.user; state.families = me.families;
    if (!me.families.length) { state.familyId = null; localStorage.removeItem('hearth_family'); return renderFamilySetup(); }
    if (!state.familyId || !me.families.some((f) => f.id === state.familyId)) selectFamily(me.families[0].id);
    await refresh(); connectWS(); loadWeather();
  } catch (e) {
    if (String(e.message).includes('authenticated')) { setToken(null); return renderAuth('login'); }
    console.error(e); toast(e.message);
  }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
