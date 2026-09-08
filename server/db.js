import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// On a cloud host, point DB_PATH at a persistent disk (e.g. /data/hearth.db) so
// the database survives redeploys. Locally it falls back to a file beside the code.
const DB_PATH = process.env.DB_PATH || join(__dirname, 'hearth.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// better-sqlite3-style transaction helper on top of node:sqlite.
db.transaction = (fn) => (...args) => {
  db.exec('BEGIN');
  try { const r = fn(...args); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS families (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A user's seat inside a family. Family isolation is enforced by always
-- resolving the caller's membership for the requested family before any read/write.
CREATE TABLE IF NOT EXISTS memberships (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id    INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('admin','adult','child')),
  display_name TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT '#6C8AE4',
  birthdate    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (family_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id  INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  code       TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL CHECK (role IN ('admin','adult','child')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id    INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  location     TEXT,
  category     TEXT NOT NULL DEFAULT 'family',
  start_utc    TEXT NOT NULL,
  end_utc      TEXT NOT NULL,
  all_day      INTEGER NOT NULL DEFAULT 0,
  recurrence   TEXT NOT NULL DEFAULT 'none',
  transport_by INTEGER REFERENCES memberships(id) ON DELETE SET NULL,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_family_start ON events(family_id, start_utc);

CREATE TABLE IF NOT EXISTS event_participants (
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  membership_id INTEGER NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, membership_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id   INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  assigned_to INTEGER REFERENCES memberships(id) ON DELETE SET NULL,
  due_utc     TEXT,
  done        INTEGER NOT NULL DEFAULT 0,
  points      INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_family ON tasks(family_id);

CREATE TABLE IF NOT EXISTS grocery_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id  INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'other',
  checked    INTEGER NOT NULL DEFAULT 0,
  added_by   INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_grocery_family ON grocery_items(family_id);

CREATE TABLE IF NOT EXISTS goals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id   INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  target_num  INTEGER NOT NULL DEFAULT 1,
  current_num INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_goals_family ON goals(family_id);

CREATE TABLE IF NOT EXISTS moments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id   INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  emoji       TEXT NOT NULL DEFAULT '✨',
  moment_date TEXT,
  note        TEXT,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_moments_family ON moments(family_id);

-- Family Altar: shared prayer requests. Same family-isolation rules as everything else.
CREATE TABLE IF NOT EXISTS prayers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id   INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  note        TEXT,
  answered    INTEGER NOT NULL DEFAULT 0,
  answered_at TEXT,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prayers_family ON prayers(family_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id  INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_family ON audit_logs(family_id, created_at);

-- Single-use tokens for email verification and password reset. Only the SHA-256
-- hash of each token is stored (never the raw value), so a DB leak can't be
-- replayed against an account. Rows cascade away if the user is deleted.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('verify','reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON auth_tokens(user_id, kind);
`);

// Backfill for databases created before these columns existed (ignore if present).
try { db.exec('ALTER TABLE memberships ADD COLUMN birthdate TEXT'); } catch {}

// Email verification flag on the user. Defaults to 0 (unverified); existing rows
// created before the email flow shipped will read 0 until they confirm.
try { db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0'); } catch {}

// Billing: a family is the unit that subscribes. 'free' until a Stripe checkout
// completes, then 'premium' while the subscription is active. All Stripe ids are
// stored here so a webhook can resolve the family and flip the plan.
try { db.exec("ALTER TABLE families ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'"); } catch {}
try { db.exec('ALTER TABLE families ADD COLUMN subscription_status TEXT'); } catch {}
try { db.exec('ALTER TABLE families ADD COLUMN stripe_customer_id TEXT'); } catch {}
try { db.exec('ALTER TABLE families ADD COLUMN stripe_subscription_id TEXT'); } catch {}
try { db.exec('ALTER TABLE families ADD COLUMN current_period_end TEXT'); } catch {}

export function audit(familyId, userId, action, detail = '') {
  db.prepare('INSERT INTO audit_logs (family_id, user_id, action, detail) VALUES (?,?,?,?)')
    .run(familyId, userId, action, String(detail).slice(0, 500));
}

export default db;
