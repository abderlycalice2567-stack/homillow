// Homillow service worker — offline shell cache + Web Push reminders.
const CACHE = 'homillow-v18';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache API or websocket traffic — always live.
  if (url.pathname.startsWith('/api') || e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('/index.html')))
  );
});

// ---------- Web Push ----------
self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: 'Homillow', body: e.data ? e.data.text() : '' }; }
  const title = p.title || 'Homillow reminder';
  const options = {
    body: p.body || '',
    tag: p.tag || undefined,          // collapses repeat reminders for the same item
    renotify: !!p.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: p.data || { url: '/' },
    actions: Array.isArray(p.actions) ? p.actions.slice(0, 2) : [],
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  const type = d.taskId ? 'task' : d.billId ? 'bill' : d.eventId ? 'event' : (d.memberId ? 'birthday' : '');
  const sourceId = d.taskId || d.billId || d.eventId || d.memberId || '';
  const action = e.action || 'view';
  // The app holds the auth token (never the push payload). So actions are executed BY
  // the client: message any open tab, or deep-link a new one that runs it on load.
  const msg = { type: 'notification-action', action, source: type, sourceId, familyId: d.familyId };
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.postMessage(msg); return c.focus(); } }
    const url = action !== 'view'
      ? `/?na=${encodeURIComponent(action)}&nt=${encodeURIComponent(type)}&ns=${encodeURIComponent(sourceId)}&nf=${encodeURIComponent(d.familyId || '')}`
      : (d.url || '/');
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
