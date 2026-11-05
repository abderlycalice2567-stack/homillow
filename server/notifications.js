// Homillow — centralized notification & reminder engine.
//
// One engine serves every module (calendar, tasks, birthdays/anniversaries, bills).
// Each time-sensitive item calls scheduleSource(); that (re)generates rows in the
// `reminders` table. A background tick fires the due ones through each recipient's
// chosen channels (in-app bell, Web Push, email), records a copy in `notifications`,
// and rolls recurring items forward. Cancelling/completing an item removes its
// pending reminders so nothing stale ever fires.
import db from './db.js';
import { sendEmail } from './email.js';

// ---------- Web Push (VAPID) — loaded lazily so a missing dep never blocks boot ----------
let webpush = null;
let pushReady = false;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:homillow.family@gmail.com';
export const pushConfigured = () => pushReady;
export const vapidPublicKey = () => (pushReady ? VAPID_PUBLIC : '');

async function initPush() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn('[notif] Web Push OFF: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push skipped, in-app + email still work.');
    return;
  }
  try {
    webpush = (await import('web-push')).default;
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    pushReady = true;
    console.log('[notif] Web Push configured.');
  } catch (e) {
    console.warn(`[notif] Web Push unavailable (web-push not installed?): ${e.message}`);
  }
}

// ---------- WS broadcaster (wired from server.js) ----------
let broadcast = () => {};
export function setBroadcaster(fn) { if (typeof fn === 'function') broadcast = fn; }

// ---------- preferences ----------
export const DEFAULT_PREFS = {
  timezone: 'America/New_York',
  channels: { push: true, email: false, inapp: true },
  categories: { task: true, event: true, bill: true, birthday: true, anniversary: true },
  // Default "minutes before" offsets per category. Per-item overrides win over these.
  offsets: {
    task: [1440, 180],          // 1 day, 3 hours before
    event: [1440, 180, 30],     // 1 day, 3 hours, 30 min before
    bill: [10080, 2880, 0],     // 7 days, 2 days, on the due date
    birthday: [10080, 1440],    // 7 days, 1 day before
    anniversary: [10080, 1440],
  },
  overdue: { enabled: true, everyHours: 24, maxCount: 3 },
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
  privateMode: false, // hide amounts / sensitive detail from push + email payloads
};

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (over && typeof over === 'object') for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over === undefined ? base : over;
}

export function getPrefs(userId) {
  const row = db.prepare('SELECT prefs_json FROM notification_prefs WHERE user_id = ?').get(userId);
  let stored = {};
  if (row) { try { stored = JSON.parse(row.prefs_json); } catch {} }
  return deepMerge(DEFAULT_PREFS, stored);
}

export function setPrefs(userId, patch) {
  const merged = deepMerge(getPrefs(userId), patch || {});
  // Never persist the DEFAULT baseline's full tree with runaway keys — store the merged
  // view (small, bounded) so reads are cheap and future default changes still layer in.
  db.prepare(`INSERT INTO notification_prefs (user_id, prefs_json, updated_at)
    VALUES (?,?,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = datetime('now')`)
    .run(userId, JSON.stringify(merged));
  return merged;
}

// ---------- push subscriptions ----------
export function savePushSub(userId, sub, userAgent = '') {
  if (!sub || !sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return false;
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    VALUES (?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(userAgent).slice(0, 300));
  return true;
}
export function removePushSub(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

async function sendWebPush(userId, payload) {
  if (!pushReady) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
      );
    } catch (err) {
      // 404/410 => the browser dropped this subscription; prune it so we stop trying.
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      } else {
        console.warn(`[notif] push send failed (user ${userId}): ${err?.message}`);
      }
    }
  }
}

// ---------- time helpers (timezone + DST aware) ----------
// Offset in ms such that  localWallTime = utcTime + offset  for the given zone/instant.
function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  const asIfUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return asIfUTC - utcMs;
}
// The UTC instant for a wall-clock time in a given zone. Refines once for DST edges.
function zonedWallToUtcMs(y, mo, d, hh, mm, tz) {
  const asUTC = Date.UTC(y, mo - 1, d, hh, mm, 0);
  let offset = tzOffsetMs(asUTC, tz);
  let ms = asUTC - offset;
  const off2 = tzOffsetMs(ms, tz);
  if (off2 !== offset) ms = asUTC - off2;
  return ms;
}
function localParts(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  return { y: +map.year, mo: +map.month, d: +map.day, hh: +map.hour, mm: +map.minute };
}
const hm = (s, fb) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? { h: +m[1], m: +m[2] } : fb;
};

// If `fireMs` lands inside the user's quiet hours, push it to the quiet-window end.
// Handles windows that wrap past midnight (e.g. 22:00 -> 07:00).
function applyQuietHours(fireMs, prefs) {
  const q = prefs.quietHours;
  if (!q?.enabled) return fireMs;
  const tz = prefs.timezone || DEFAULT_PREFS.timezone;
  const start = hm(q.start, { h: 22, m: 0 });
  const end = hm(q.end, { h: 7, m: 0 });
  const lp = localParts(fireMs, tz);
  const cur = lp.hh * 60 + lp.mm;
  const s = start.h * 60 + start.m;
  const e = end.h * 60 + end.m;
  const inQuiet = s < e ? (cur >= s && cur < e) : (cur >= s || cur < e);
  if (!inQuiet) return fireMs;
  // Move to `end` today; if the window wraps and we're past midnight already, that's
  // still today's `end`. If end <= now-of-day in a non-wrapping window, roll to next day.
  let endMs = zonedWallToUtcMs(lp.y, lp.mo, lp.d, end.h, end.m, tz);
  if (endMs <= fireMs) endMs = zonedWallToUtcMs(lp.y, lp.mo, lp.d, end.h, end.m, tz) + 864e5;
  return endMs;
}

// ---------- family / recipient resolution ----------
function membersOf(familyId) {
  return db.prepare('SELECT id, user_id, role, display_name, birthdate, anniversary FROM memberships WHERE family_id = ?').all(familyId);
}
function userForMembership(mid) {
  if (!mid) return null;
  const r = db.prepare('SELECT user_id FROM memberships WHERE id = ?').get(mid);
  return r ? r.user_id : null;
}
function adultUserIds(familyId) {
  return membersOf(familyId).filter((m) => m.role === 'admin' || m.role === 'adult').map((m) => m.user_id);
}

const parseOffsets = (json) => {
  if (!json) return null;
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.map(Number).filter((n) => Number.isFinite(n) && n >= 0) : null; }
  catch { return null; }
};

// ---------- reminder scheduling ----------
// Insert a reminder idempotently. dedup_key collapses the same item+recipient+
// occurrence+offset so re-running scheduleSource (reconcile) never duplicates.
function insertReminder(r) {
  db.prepare(`INSERT OR IGNORE INTO reminders
    (family_id, source_type, source_id, recipient_user, dedup_key, fire_at_utc, category, title, body, data_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(r.family_id, r.source_type, r.source_id, r.recipient_user, r.dedup_key,
      new Date(r.fire_at_ms).toISOString(), r.category, r.title, r.body, JSON.stringify(r.data || {}));
}

// Remove still-pending reminders for an item (on complete / pay / delete / before re-sched).
export function cancelSource(sourceType, sourceId) {
  db.prepare("DELETE FROM reminders WHERE source_type = ? AND source_id = ? AND status = 'scheduled'")
    .run(sourceType, sourceId);
}

function nextEventOccurrenceMs(ev, nowMs) {
  const start = Date.parse(ev.start_utc);
  if (ev.recurrence === 'none') return start >= nowMs - 36e5 ? start : null;
  const d = new Date(start);
  let guard = 0;
  while (guard++ < 1200) {
    const s = d.getTime();
    if (s >= nowMs - 36e5) return s;
    if (ev.recurrence === 'daily') d.setDate(d.getDate() + 1);
    else if (ev.recurrence === 'weekly') d.setDate(d.getDate() + 7);
    else if (ev.recurrence === 'monthly') d.setMonth(d.getMonth() + 1);
    else if (ev.recurrence === 'yearly') d.setFullYear(d.getFullYear() + 1);
    else return null;
  }
  return null;
}

// The 9am-local instant for the next future occurrence of a MM-DD anniversary/birthday.
function nextAnnualMs(dateStr, tz, nowMs) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return null;
  const mo = +m[2], d = +m[3];
  const yNow = localParts(nowMs, tz).y;
  for (const y of [yNow, yNow + 1]) {
    const ms = zonedWallToUtcMs(y, mo, d, 9, 0, tz);
    if (ms >= nowMs - 36e5) return ms;
  }
  return null;
}

// Core: (re)build the schedule for one source item. Idempotent.
export function scheduleSource(sourceType, familyId, sourceId) {
  try {
    const now = Date.now();
    if (sourceType === 'task') return scheduleTask(familyId, sourceId, now);
    if (sourceType === 'event') return scheduleEvent(familyId, sourceId, now);
    if (sourceType === 'bill') return scheduleBill(familyId, sourceId, now);
  } catch (e) {
    console.error(`[notif] scheduleSource(${sourceType}:${sourceId}) failed: ${e.message}`);
  }
}

function recipientsFor(prefsCategory, userIds) {
  // De-dup + drop users who disabled this category.
  const out = [];
  const seen = new Set();
  for (const uid of userIds) {
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const prefs = getPrefs(uid);
    if (prefs.categories?.[prefsCategory] === false) continue;
    out.push({ uid, prefs });
  }
  return out;
}

function scheduleTask(familyId, id, now) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ? AND family_id = ?').get(id, familyId);
  cancelSource('task', id);
  if (!t || t.done || !t.due_utc) return;
  const due = Date.parse(t.due_utc);
  if (Number.isNaN(due)) return;
  const targetUser = userForMembership(t.assigned_to) || t.created_by;
  const recips = recipientsFor('task', [targetUser]);
  const occ = new Date(due).toISOString().slice(0, 10);
  for (const { uid, prefs } of recips) {
    const offs = parseOffsets(t.remind_offsets) || prefs.offsets.task;
    for (const off of offs) {
      const fire = applyQuietHours(due - off * 60000, prefs);
      if (fire <= now) continue;
      insertReminder({
        family_id: familyId, source_type: 'task', source_id: id, recipient_user: uid,
        dedup_key: `task:${id}:${uid}:${occ}:${off}`, fire_at_ms: fire, category: 'task',
        title: 'Task reminder', body: `${t.title} — due ${friendly(due, prefs.timezone)}`,
        data: { targetUtc: t.due_utc, taskId: id, familyId, actions: ['complete', 'snooze'] },
      });
    }
    // Overdue nudge(s): fire after the due time if it's still not done.
    if (prefs.overdue?.enabled) {
      const every = Math.max(1, prefs.overdue.everyHours || 24);
      const max = Math.max(1, Math.min(10, prefs.overdue.maxCount || 3));
      for (let n = 1; n <= max; n++) {
        const fire = applyQuietHours(due + n * every * 36e5, prefs);
        if (fire <= now) continue;
        insertReminder({
          family_id: familyId, source_type: 'task', source_id: id, recipient_user: uid,
          dedup_key: `task:${id}:${uid}:${occ}:overdue${n}`, fire_at_ms: fire, category: 'task',
          title: 'Overdue task', body: `Still open: ${t.title}`,
          data: { targetUtc: t.due_utc, taskId: id, familyId, overdue: true, actions: ['complete', 'snooze'] },
        });
      }
    }
  }
}

function scheduleEvent(familyId, id, now) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ? AND family_id = ?').get(id, familyId);
  cancelSource('event', id);
  if (!ev) return;
  const occMs = nextEventOccurrenceMs(ev, now);
  if (occMs == null) return;
  const parts = db.prepare('SELECT membership_id FROM event_participants WHERE event_id = ?').all(id).map((r) => r.membership_id);
  const userIds = parts.length ? parts.map(userForMembership) : [ev.created_by];
  const recips = recipientsFor('event', userIds);
  const occ = new Date(occMs).toISOString().slice(0, 16);
  for (const { uid, prefs } of recips) {
    const offs = parseOffsets(ev.remind_offsets) || prefs.offsets.event;
    for (const off of offs) {
      const fire = applyQuietHours(occMs - off * 60000, prefs);
      if (fire <= now) continue;
      insertReminder({
        family_id: familyId, source_type: 'event', source_id: id, recipient_user: uid,
        dedup_key: `event:${id}:${uid}:${occ}:${off}`, fire_at_ms: fire, category: 'event',
        title: ev.category === 'couple' ? 'Date night reminder' : 'Event reminder',
        body: `${ev.title} — ${friendly(occMs, prefs.timezone)}${ev.location ? ` @ ${ev.location}` : ''}`,
        data: { targetUtc: new Date(occMs).toISOString(), eventId: id, familyId, actions: ['view', 'snooze'] },
      });
    }
  }
}

function scheduleBill(familyId, id, now) {
  const b = db.prepare('SELECT * FROM bills WHERE id = ? AND family_id = ?').get(id, familyId);
  cancelSource('bill', id);
  if (!b || b.paid) return;
  const targetUser = userForMembership(b.assigned_to);
  const userIds = targetUser ? [targetUser] : adultUserIds(familyId);
  const recips = recipientsFor('bill', userIds);
  for (const { uid, prefs } of recips) {
    const dueMs = zonedWallToUtcMs(...ymd(b.due_date), 9, 0, prefs.timezone);
    const occ = b.due_date;
    for (const off of prefs.offsets.bill) {
      const fire = applyQuietHours(dueMs - off * 60000, prefs);
      if (fire <= now) continue;
      insertReminder({
        family_id: familyId, source_type: 'bill', source_id: id, recipient_user: uid,
        dedup_key: `bill:${id}:${uid}:${occ}:${off}`, fire_at_ms: fire, category: 'bill',
        title: off === 0 ? 'Bill due today' : 'Upcoming bill',
        body: billBody(b, prefs, off),
        data: { targetUtc: new Date(dueMs).toISOString(), billId: id, familyId, private: !!prefs.privateMode, actions: ['paid', 'snooze'] },
      });
    }
    // Overdue (unpaid after due date).
    if (prefs.overdue?.enabled) {
      const every = Math.max(1, prefs.overdue.everyHours || 24);
      const max = Math.max(1, Math.min(10, prefs.overdue.maxCount || 3));
      for (let n = 1; n <= max; n++) {
        const fire = applyQuietHours(dueMs + n * every * 36e5, prefs);
        if (fire <= now) continue;
        insertReminder({
          family_id: familyId, source_type: 'bill', source_id: id, recipient_user: uid,
          dedup_key: `bill:${id}:${uid}:${occ}:overdue${n}`, fire_at_ms: fire, category: 'bill',
          title: 'Overdue bill', body: billBody(b, prefs, -1),
          data: { targetUtc: new Date(dueMs).toISOString(), billId: id, familyId, overdue: true, private: !!prefs.privateMode, actions: ['paid', 'snooze'] },
        });
      }
    }
  }
}

// Birthdays + anniversaries for the whole family (recomputed on reconcile — yearly).
function scheduleAnnuals(familyId, now) {
  const members = membersOf(familyId);
  const recipients = adultUserIds(familyId); // everyone who can plan/buy gifts
  for (const m of members) {
    for (const [kind, dateStr, cat] of [['birthday', m.birthdate, 'birthday'], ['anniversary', m.anniversary, 'anniversary']]) {
      if (!dateStr) continue;
      for (const uid of recipients) {
        const prefs = getPrefs(uid);
        if (prefs.categories?.[cat] === false) continue;
        const occMs = nextAnnualMs(dateStr, prefs.timezone, now);
        if (occMs == null) continue;
        const occ = new Date(occMs).toISOString().slice(0, 10);
        for (const off of prefs.offsets[cat]) {
          const fire = applyQuietHours(occMs - off * 60000, prefs);
          if (fire <= now) continue;
          insertReminder({
            family_id: familyId, source_type: cat, source_id: m.id, recipient_user: uid,
            dedup_key: `${cat}:${m.id}:${uid}:${occ}:${off}`, fire_at_ms: fire, category: cat,
            title: cat === 'birthday' ? '🎂 Birthday coming up' : '💍 Anniversary coming up',
            body: cat === 'birthday' ? `${m.display_name}'s birthday is ${friendlyDate(occMs, prefs.timezone)}` : `Anniversary: ${friendlyDate(occMs, prefs.timezone)}`,
            data: { targetUtc: new Date(occMs).toISOString(), memberId: m.id, familyId, actions: ['view'] },
          });
        }
      }
    }
  }
}

export function scheduleAnnualsFor(familyId) { try { scheduleAnnuals(familyId, Date.now()); } catch (e) { console.error(`[notif] annuals(${familyId}) failed: ${e.message}`); } }

const ymd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? [+m[1], +m[2], +m[3]] : [1970, 1, 1]; };
function billBody(b, prefs, off) {
  const amt = prefs.privateMode ? '' : (b.amount_cents ? ` ($${(b.amount_cents / 100).toFixed(2)})` : '');
  if (off === -1) return `Still unpaid: ${b.name}${amt}`;
  if (off === 0) return `${b.name}${amt} is due today`;
  return `${b.name}${amt} is coming due`;
}
function friendly(ms, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  } catch { return new Date(ms).toISOString(); }
}
function friendlyDate(ms, tz) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(ms)); }
  catch { return new Date(ms).toISOString().slice(0, 10); }
}

// ---------- dispatch ----------
// A reminder is "sent" once the in-app record is written; push + email are best-effort
// side channels whose failures are logged but never re-queue (prevents duplicates).
async function dispatch(rem) {
  const data = safeParse(rem.data_json);
  const now = Date.now();

  // 1) Source still needs reminding? (guards against stale/raced fires)
  if (!sourceStillActive(rem, data)) { markStatus(rem.id, 'skipped'); return; }

  // 2) Re-check quiet hours at fire time; defer rather than drop.
  const prefs = getPrefs(rem.recipient_user);
  const deferred = applyQuietHours(now, prefs);
  if (deferred > now + 60000) {
    db.prepare("UPDATE reminders SET fire_at_utc = ? WHERE id = ?").run(new Date(deferred).toISOString(), rem.id);
    return;
  }

  // 3) Drop reminders for a moment that's already well past (e.g. after downtime).
  const targetMs = data.targetUtc ? Date.parse(data.targetUtc) : null;
  if (targetMs && !data.overdue && targetMs < now - 6 * 36e5) { markStatus(rem.id, 'skipped'); return; }

  // 4) In-app record (the canonical "sent").
  const info = db.prepare(`INSERT INTO notifications (user_id, family_id, category, title, body, data_json)
    VALUES (?,?,?,?,?,?)`).run(rem.recipient_user, rem.family_id, rem.category, rem.title, rem.body, rem.data_json);
  const notif = db.prepare('SELECT * FROM notifications WHERE id = ?').get(info.lastInsertRowid);

  // 5) Realtime nudge to any open tab. The family room is shared, so tag the intended
  // recipient and let the client drop notifications that aren't for the logged-in user.
  try { broadcast(rem.family_id, { type: 'notification', userId: rem.recipient_user, notification: publicNotif(notif) }); } catch {}

  // 6) Side channels, honoring the user's channel prefs + private mode.
  const payload = buildPayload(rem, data);
  if (prefs.channels?.push !== false) sendWebPush(rem.recipient_user, payload).catch(() => {});
  if (prefs.channels?.email === true) sendReminderEmail(rem).catch(() => {});

  markStatus(rem.id, 'sent');
}

function sourceStillActive(rem, data) {
  if (rem.source_type === 'task') { const t = db.prepare('SELECT done FROM tasks WHERE id = ?').get(rem.source_id); return t && !t.done; }
  if (rem.source_type === 'bill') { const b = db.prepare('SELECT paid FROM bills WHERE id = ?').get(rem.source_id); return b && !b.paid; }
  if (rem.source_type === 'event') return !!db.prepare('SELECT id FROM events WHERE id = ?').get(rem.source_id);
  if (rem.source_type === 'birthday' || rem.source_type === 'anniversary') return !!db.prepare('SELECT id FROM memberships WHERE id = ?').get(rem.source_id);
  return true;
}
function buildPayload(rem, data) {
  // Lock-screen privacy: private bills never leak the amount into push/email payloads.
  const body = data.private ? privateLine(rem.category) : rem.body;
  return {
    title: data.private ? 'Homillow reminder' : rem.title,
    body,
    tag: `${rem.source_type}:${rem.source_id}`,
    category: rem.category,
    data: { url: '/', familyId: rem.family_id, ...stripSensitive(data) },
    actions: (data.actions || []).map(actionSpec).filter(Boolean),
  };
}
const privateLine = (c) => c === 'bill' ? 'You have a bill due soon.' : 'You have a new reminder.';
function stripSensitive(d) { const { actions, private: _p, ...rest } = d; return rest; }
function actionSpec(a) {
  const map = {
    complete: { action: 'complete', title: '✓ Done' },
    paid: { action: 'paid', title: '✓ Mark paid' },
    snooze: { action: 'snooze', title: '😴 Snooze 1h' },
    view: { action: 'view', title: 'View' },
  };
  return map[a] || null;
}
async function sendReminderEmail(rem) {
  const u = db.prepare('SELECT email, name FROM users WHERE id = ?').get(rem.recipient_user);
  if (!u?.email) return;
  const data = safeParse(rem.data_json);
  const body = data.private ? privateLine(rem.category) : rem.body;
  await sendEmail({
    to: u.email,
    subject: `Homillow: ${rem.title}`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;"><p><strong>${esc(rem.title)}</strong></p><p>${esc(body)}</p><p style="color:#8a8a8a;font-size:12px;">— Homillow, your whole family in one calm place.</p></div>`,
    text: `${rem.title}\n${body}\n\n— Homillow`,
  });
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
function markStatus(id, status) {
  db.prepare("UPDATE reminders SET status = ?, sent_at = datetime('now') WHERE id = ?").run(status, id);
}
export function publicNotif(n) {
  return { id: n.id, category: n.category, title: n.title, body: n.body, data: safeParse(n.data_json), read: !!n.read_at, created_at: n.created_at };
}

// ---------- in-app notification center ----------
export function listNotifications(userId, limit = 50) {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, Math.min(100, limit));
  const unread = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;
  return { notifications: rows.map(publicNotif), unread };
}
export function markRead(userId, id) {
  if (id === 'all') { db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(userId); return; }
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND id = ?").run(userId, Number(id));
}

// ---------- notification actions (from SW / bell) ----------
export function snooze(userId, sourceType, sourceId, minutes = 60) {
  const fire = Date.now() + Math.max(5, Math.min(1440, minutes)) * 60000;
  const rem = db.prepare('SELECT * FROM reminders WHERE source_type = ? AND source_id = ? AND recipient_user = ? ORDER BY id DESC LIMIT 1').get(sourceType, sourceId, userId);
  const base = rem || { family_id: null, category: sourceType, title: 'Snoozed reminder', body: '', data_json: '{}' };
  if (!base.family_id) return;
  db.prepare(`INSERT OR IGNORE INTO reminders
    (family_id, source_type, source_id, recipient_user, dedup_key, fire_at_utc, category, title, body, data_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(base.family_id, sourceType, sourceId, userId, `${sourceType}:${sourceId}:${userId}:snooze:${fire}`,
      new Date(fire).toISOString(), base.category, base.title, base.body, base.data_json);
}

// ---------- scheduler ----------
let tickTimer = null, reconcileTimer = null, running = false;

async function tick() {
  if (running) return; running = true;
  try {
    const nowIso = new Date().toISOString();
    const due = db.prepare("SELECT * FROM reminders WHERE status = 'scheduled' AND fire_at_utc <= ? ORDER BY fire_at_utc LIMIT 200").all(nowIso);
    for (const rem of due) {
      try { await dispatch(rem); }
      catch (e) {
        const attempts = (rem.attempts || 0) + 1;
        if (attempts >= 5) db.prepare("UPDATE reminders SET status='failed', attempts=?, last_error=? WHERE id=?").run(attempts, String(e.message).slice(0, 300), rem.id);
        else db.prepare("UPDATE reminders SET attempts=?, last_error=?, fire_at_utc=? WHERE id=?").run(attempts, String(e.message).slice(0, 300), new Date(Date.now() + attempts * 6e4).toISOString(), rem.id);
      }
    }
  } finally { running = false; }
}

// Roll recurring items (recurring events, bills, birthdays, anniversaries) forward:
// re-running scheduleSource is idempotent thanks to dedup_key, so once an occurrence
// passes, the next occurrence's reminders appear automatically.
function reconcile() {
  try {
    const now = Date.now();
    const fams = db.prepare('SELECT id FROM families').all();
    for (const f of fams) {
      for (const e of db.prepare("SELECT id FROM events WHERE family_id = ? AND recurrence != 'none'").all(f.id)) scheduleEvent(f.id, e.id, now);
      for (const b of db.prepare("SELECT id FROM bills WHERE family_id = ? AND paid = 0").all(f.id)) scheduleBill(f.id, b.id, now);
      scheduleAnnuals(f.id, now);
    }
  } catch (e) { console.error(`[notif] reconcile failed: ${e.message}`); }
}

export async function startEngine() {
  await initPush();
  reconcile();
  tick().catch(() => {});
  tickTimer = setInterval(() => tick().catch(() => {}), 60 * 1000);       // fire due reminders every minute
  reconcileTimer = setInterval(reconcile, 10 * 60 * 1000);                // roll recurring items forward every 10 min
  if (tickTimer.unref) tickTimer.unref();
  if (reconcileTimer.unref) reconcileTimer.unref();
  console.log('[notif] reminder engine started (tick 60s, reconcile 10m).');
}
export function stopEngine() { clearInterval(tickTimer); clearInterval(reconcileTimer); }
