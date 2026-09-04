# 🏡 Homillow — your whole family, one calm place

A Family Operating System: shared calendar, "who's responsible" assignments, real-time
sync between spouses, conflict detection, tasks/chores, grocery list, and a daily briefing.
MVP built as a mobile-first PWA with a secure Node backend.

## Run it

```bash
cd server
npm install
npm start          # http://localhost:4000
```

- On the same Mac: **http://localhost:4000**
- On a phone on the same wifi: **http://<your-lan-ip>:4000**

Sign up → create your family → invite your spouse with the generated code → both phones
stay in sync live.

## Stack
- **Backend:** Node + Express, `node:sqlite` (built-in, no native deps), WebSockets for real-time.
- **Auth:** bcrypt password hashing, JWT (7-day), rate-limited login/register.
- **Frontend:** vanilla JS PWA (installable, offline shell), mobile-first.

## Security posture (MVP)
- **Family isolation** enforced on every request and every WebSocket (a user only ever
  touches families they're a member of — verified: outsiders get 403).
- Parameterized SQL everywhere (no injection); output escaped in the UI (no XSS).
- Helmet security headers + strict CSP; JSON body size capped; async errors caught.
- Secrets (`.secret`) and the DB are git-ignored. `npm audit`: 0 vulnerabilities.

## MVP scope (Phase 1 — done)
Family accounts · shared calendar · recurring events · assignments · real-time sync ·
conflict detection · tasks/chores · grocery · daily briefing · secure auth · mobile PWA.

## Next (Phase 2+)
Push notifications · school/transportation · meal planning · bills · couple/family time ·
calendar import · then the AI Family Assistant (Phase 3). Production hosting + app-store wrappers.
