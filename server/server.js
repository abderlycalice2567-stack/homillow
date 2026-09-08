import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db, { audit } from './db.js';
import {
  hashPassword, verifyPassword, issueToken, verifyToken,
  requireAuth, requireFamily, requireAdmin, requireAdult, DUMMY_HASH,
} from './auth.js';
import {
  billingConfigured, webhookConfigured, FREE_MEMBER_LIMIT, isPremium, familyById, planSnapshot,
  createCheckout, createPortal, handleWebhook,
} from './billing.js';
import {
  emailConfigured, createToken, consumeToken,
  sendVerificationEmail, sendPasswordResetEmail,
} from './email.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;

const app = express();
app.set('trust proxy', 1);
app.set('query parser', 'simple'); // use Node's querystring, not qs — closes qs DoS surface
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'https://api.open-meteo.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));

// Stripe webhook MUST see the raw, unparsed body to verify the signature, so it is
// mounted before express.json — which otherwise consumes the stream into an object.
app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const result = await handleWebhook(req.body, sig);
    res.json({ received: true, ...result });
  } catch (err) {
    // A bad signature or unconfigured webhook is a 400/503, never a 500 loop.
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.use(express.json({ limit: '256kb' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
// Tighter cap on billing actions — each one hits the Stripe API. The webhook is
// mounted earlier (before this) so Stripe's retries are never rate-limited.
const billingLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

// ---------- validation helpers ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CATEGORIES = ['work', 'school', 'sports', 'medical', 'church', 'family', 'couple', 'personal', 'household', 'important'];
const GROCERY_CATS = ['produce', 'meat', 'dairy', 'pantry', 'household', 'baby', 'cleaning', 'personal', 'other'];
const ROLES = ['admin', 'adult', 'child'];
const RECUR = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isISO = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function membersOf(familyId) {
  return db.prepare('SELECT id, display_name, color, role, user_id, birthdate FROM memberships WHERE family_id = ?').all(familyId);
}
// Validate that every id in list is a membership of this family. Returns clean int array.
function sanitizeMemberIds(familyId, ids) {
  if (!Array.isArray(ids)) return [];
  const valid = new Set(membersOf(familyId).map((m) => m.id));
  return [...new Set(ids.map(Number).filter((n) => valid.has(n)))];
}

// Wrap async handlers so a rejected promise becomes a clean 500, never a hung socket.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Per-family row caps — bound storage growth AND the O(n)/O(n²) work that briefing
// and conflict detection do over a family's rows. Table names come from this fixed
// internal map (never user input), so interpolation here is safe.
const ROW_CAPS = { events: 1000, tasks: 2000, grocery_items: 2000, goals: 500, moments: 3000, prayers: 2000 };
function atCap(table, familyId) {
  const max = ROW_CAPS[table];
  if (!max) return false;
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE family_id = ?`).get(familyId).n >= max;
}
const CAP_MSG = 'This family has reached the maximum number of items. Please remove some before adding more.';

// Premium gate: the family behind :familyId must be on the Premium plan. When
// billing isn't configured yet (no Stripe keys), everything stays unlocked so
// the app is fully usable in dev / pre-launch. Use after requireFamily.
function requirePremium(req, res, next) {
  if (!billingConfigured) return next();
  if (isPremium(familyById(req.familyId))) return next();
  return res.status(402).json({ error: 'premium_required', feature: 'This feature is part of Homillow Premium.' });
}

// ---------- Family Altar: daily devotional ----------
// Curated, public-domain scripture (WEB/KJV) + a short family reflection prompt.
// Rotates by day-of-year so the whole family sees the same one each day.
const DEVOTIONALS = [
  { verse: 'As for me and my house, we will serve the Lord.', ref: 'Joshua 24:15', prompt: 'What is one way your household can serve God together this week?' },
  { verse: 'Trust in the Lord with all your heart, and don’t lean on your own understanding.', ref: 'Proverbs 3:5', prompt: 'Where do you need to trust God instead of your own plan today?' },
  { verse: 'Be kind to one another, tenderhearted, forgiving each other.', ref: 'Ephesians 4:32', prompt: 'Is there anyone in the family you need to forgive or thank today?' },
  { verse: 'This is the day that the Lord has made. We will rejoice and be glad in it.', ref: 'Psalm 118:24', prompt: 'Name one thing you’re grateful for right now.' },
  { verse: 'Let all that you do be done in love.', ref: '1 Corinthians 16:14', prompt: 'What is one loving thing you can do for someone at home today?' },
  { verse: 'I can do all things through Christ who strengthens me.', ref: 'Philippians 4:13', prompt: 'What feels hard today that you can hand to God?' },
  { verse: 'Give thanks in all circumstances, for this is God’s will for you.', ref: '1 Thessalonians 5:18', prompt: 'Share one blessing from the past 24 hours.' },
  { verse: 'Children, obey your parents in the Lord, for this is right.', ref: 'Ephesians 6:1', prompt: 'Parents and kids: what’s one way to honor each other today?' },
  { verse: 'The Lord is my shepherd; I shall not want.', ref: 'Psalm 23:1', prompt: 'What need are you trusting God to provide?' },
  { verse: 'Love is patient and is kind.', ref: '1 Corinthians 13:4', prompt: 'Where can you show a little more patience at home today?' },
  { verse: 'Let us consider how to provoke one another to love and good works.', ref: 'Hebrews 10:24', prompt: 'How can you encourage someone in the family today?' },
  { verse: 'Cast all your anxiety on him, because he cares for you.', ref: '1 Peter 5:7', prompt: 'What worry can the family pray about together today?' },
  { verse: 'A cheerful heart is good medicine.', ref: 'Proverbs 17:22', prompt: 'What made you laugh recently? Share it.' },
  { verse: 'Do to others as you would have them do to you.', ref: 'Luke 6:31', prompt: 'Who could use your kindness today?' },
  { verse: 'Be strong and courageous. Don’t be afraid, for the Lord your God is with you.', ref: 'Joshua 1:9', prompt: 'What are you facing that you need courage for?' },
  { verse: 'Rejoice with those who rejoice; weep with those who weep.', ref: 'Romans 12:15', prompt: 'How is each person in the family really doing today?' },
  { verse: 'Train up a child in the way he should go, and when he is old he will not depart from it.', ref: 'Proverbs 22:6', prompt: 'What value do you most want to pass on to your kids?' },
  { verse: 'The fruit of the Spirit is love, joy, peace, patience, kindness.', ref: 'Galatians 5:22', prompt: 'Which one does your home need more of this week?' },
  { verse: 'Let your light shine before others.', ref: 'Matthew 5:16', prompt: 'How can your family be a light to a neighbor this week?' },
  { verse: 'He gives strength to the weary.', ref: 'Isaiah 40:29', prompt: 'Who in the family is tired and could use rest or help?' },
  { verse: 'Two are better than one, because they have a good reward for their labor.', ref: 'Ecclesiastes 4:9', prompt: 'What’s something the family can tackle together today?' },
  { verse: 'Whatever you do, work heartily, as for the Lord.', ref: 'Colossians 3:23', prompt: 'What ordinary task can you do today as an offering to God?' },
  { verse: 'The Lord bless you and keep you.', ref: 'Numbers 6:24', prompt: 'Speak a blessing over one person in your family today.' },
  { verse: 'Come to me, all you who labor and are heavily burdened, and I will give you rest.', ref: 'Matthew 11:28', prompt: 'What burden can you lay down and rest from today?' },
  { verse: 'Let the peace of Christ rule in your hearts.', ref: 'Colossians 3:15', prompt: 'Where does your home need more peace right now?' },
  { verse: 'Weeping may endure for a night, but joy comes in the morning.', ref: 'Psalm 30:5', prompt: 'What hard thing are you trusting God to turn around?' },
  { verse: 'By this everyone will know that you are my disciples, if you love one another.', ref: 'John 13:35', prompt: 'How will your family show love to one another today?' },
  { verse: 'God is our refuge and strength, a very present help in trouble.', ref: 'Psalm 46:1', prompt: 'What do you need to bring to God as a family today?' },
  { verse: 'Encourage one another and build each other up.', ref: '1 Thessalonians 5:11', prompt: 'Give one genuine compliment to someone at home today.' },
  { verse: 'In everything, do to others what you would have them do to you.', ref: 'Matthew 7:12', prompt: 'What small act of service can you do without being asked?' },
];
function todaysDevotional(d = new Date()) {
  const start = new Date(d.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((d - start) / 864e5);
  return DEVOTIONALS[dayOfYear % DEVOTIONALS.length];
}

// ---------- auth routes ----------
app.post('/api/register', authLimiter, wrap(async (req, res) => {
  const email = str(req.body?.email, 254).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const name = str(req.body?.name, 80);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (password.length > 200) return res.status(400).json({ error: 'Password too long (max 200 characters)' });
  if (!name) return res.status(400).json({ error: 'Name required' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'Email already registered' });
  const hash = await hashPassword(password);
  const info = db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?,?,?)').run(email, hash, name);
  const user = { id: Number(info.lastInsertRowid), name };
  // Fire the welcome/confirmation email but never let its outcome block signup —
  // the account is created and logged in either way; the link just confirms email.
  try {
    const token = createToken(user.id, 'verify');
    sendVerificationEmail({ id: user.id, name, email }, token).catch(() => {});
  } catch (e) { console.error('[register] verify email setup failed:', e.message); }
  res.json({ token: issueToken(user), user: { id: user.id, name, email, email_verified: 0 } });
}));

app.post('/api/login', authLimiter, wrap(async (req, res) => {
  const email = str(req.body?.email, 254).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  // Cap password length before hashing work — avoids spending bcrypt cycles on
  // oversized inputs, and never reveals which accounts exist (generic 401).
  if (password.length > 200) return res.status(401).json({ error: 'Invalid email or password' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Constant-ish response: always run a compare to blunt user-enumeration timing.
  const ok = user ? await verifyPassword(password, user.password_hash) : await verifyPassword(password, DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: issueToken(user), user: { id: user.id, name: user.name, email: user.email, email_verified: user.email_verified ? 1 : 0 } });
}));

// ---------- email verification + password reset ----------
// Landing point for the link in the confirmation email. It's a GET (clicked from an
// inbox), so on success/failure we redirect back into the app with a flag the SPA
// reads to show a toast — never a raw JSON blob in the user's face.
app.get('/api/verify-email', wrap(async (req, res) => {
  const token = typeof req.query?.token === 'string' ? req.query.token : '';
  const userId = consumeToken(token, 'verify');
  if (!userId) return res.redirect('/?verified=0');
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId);
  res.redirect('/?verified=1');
}));

// Re-send the confirmation email to the logged-in user (if not already verified).
app.post('/api/auth/resend-verification', authLimiter, requireAuth, wrap(async (req, res) => {
  const user = db.prepare('SELECT id, name, email, email_verified FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.email_verified) {
    const token = createToken(user.id, 'verify');
    await sendVerificationEmail(user, token);
  }
  res.json({ ok: true });
}));

// Start a password reset. ALWAYS returns the same generic 200 whether or not the
// email exists — this is the endpoint that closes the account-enumeration gap the
// audit flagged: an attacker can't probe which emails have Homillow accounts.
app.post('/api/auth/forgot-password', authLimiter, wrap(async (req, res) => {
  const email = str(req.body?.email, 254).toLowerCase();
  if (EMAIL_RE.test(email)) {
    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
    if (user) {
      try {
        const token = createToken(user.id, 'reset');
        await sendPasswordResetEmail(user, token);
      } catch (e) { console.error('[forgot-password] send failed:', e.message); }
    }
  }
  res.json({ ok: true, message: 'If that email has a Homillow account, a reset link is on its way.' });
}));

// Complete a password reset using the single-use token from the emailed link.
app.post('/api/auth/reset-password', authLimiter, wrap(async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const np = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  if (np.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  if (np.length > 200) return res.status(400).json({ error: 'New password too long (max 200 characters)' });
  const userId = consumeToken(token, 'reset');
  if (!userId) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  const hash = await hashPassword(np);
  // A successful reset also proves control of the inbox → mark the email verified.
  db.prepare('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?').run(hash, userId);
  res.json({ ok: true });
}));

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, email_verified FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const families = db.prepare(`
    SELECT f.id, f.name, m.role, m.display_name, m.color, m.id AS membership_id
    FROM memberships m JOIN families f ON f.id = m.family_id
    WHERE m.user_id = ? ORDER BY f.created_at`).all(req.userId);
  res.json({ user, families });
});

// ---------- account self-service (Settings) ----------
// Change your own name / email / password. The current password is ALWAYS required:
// it re-authenticates the session before any sensitive change, so a stolen 7-day
// token alone can't take over the account. Rate-limited like the other auth routes.
app.patch('/api/me', authLimiter, requireAuth, wrap(async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  if (currentPassword.length > 200 || !(await verifyPassword(currentPassword, user.password_hash))) {
    return res.status(403).json({ error: 'Current password is incorrect' });
  }

  // Only the columns we explicitly whitelist here can be written — the keys are
  // never taken from user input, so the dynamic UPDATE below can't be injected.
  const updates = {};
  if (req.body?.name !== undefined) {
    const name = str(req.body.name, 80);
    if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
    updates.name = name;
  }
  if (req.body?.email !== undefined) {
    const email = str(req.body.email, 254).toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email required' });
    if (email !== user.email) {
      const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, user.id);
      if (taken) return res.status(409).json({ error: 'That email is already in use' });
      updates.email = email;
    }
  }
  if (req.body?.newPassword !== undefined) {
    const np = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    if (np.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    if (np.length > 200) return res.status(400).json({ error: 'New password too long (max 200 characters)' });
    updates.password_hash = await hashPassword(np);
  }

  const keys = Object.keys(updates);
  if (keys.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  db.prepare(`UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map(k => updates[k]), user.id);

  const fresh = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(user.id);
  // The display name is baked into the JWT, so reissue it to keep the client in sync.
  res.json({ token: issueToken(fresh), user: fresh });
}));

// Permanently delete your own account (requires the current password). Families you
// are the SOLE member of are removed with all their data (cascades). If you still
// share a family with other members, we stop and ask you to hand those off first —
// so one person leaving can't silently wipe a household everyone else depends on.
app.delete('/api/me', authLimiter, requireAuth, wrap(async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  if (currentPassword.length > 200 || !(await verifyPassword(currentPassword, user.password_hash))) {
    return res.status(403).json({ error: 'Current password is incorrect' });
  }

  const families = db.prepare('SELECT family_id FROM memberships WHERE user_id = ?').all(user.id);
  const solo = [];
  for (const { family_id } of families) {
    const count = db.prepare('SELECT COUNT(*) AS c FROM memberships WHERE family_id = ?').get(family_id).c;
    if (count > 1) {
      return res.status(409).json({ error: 'You still share a family with other members. Remove them or leave that family before deleting your account.' });
    }
    solo.push(family_id);
  }

  db.transaction(() => {
    // Deleting a family cascades its events/tasks/prayers/grocery/invites/memberships.
    for (const fid of solo) db.prepare('DELETE FROM families WHERE id = ?').run(fid);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  })();

  res.json({ ok: true });
}));

// ---------- family routes ----------
app.post('/api/families', requireAuth, (req, res) => {
  const name = str(req.body?.name, 80);
  const displayName = str(req.body?.displayName, 80) || db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId).name;
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body?.color) ? req.body.color : '#6C8AE4';
  if (!name) return res.status(400).json({ error: 'Family name required' });
  // Cap families a single user can create (each becomes its own Stripe customer +
  // 7-day trial). Blocks one account from farming unlimited free trials. Being
  // invited into others' families is unaffected — this only counts ones you own.
  const owned = db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND role = 'admin'").get(req.userId).n;
  if (owned >= 5) return res.status(400).json({ error: 'You have reached the maximum number of families you can create.' });
  const tx = db.transaction(() => {
    const fam = db.prepare('INSERT INTO families (name) VALUES (?)').run(name);
    db.prepare('INSERT INTO memberships (family_id, user_id, role, display_name, color) VALUES (?,?,?,?,?)')
      .run(fam.lastInsertRowid, req.userId, 'admin', displayName, color);
    return fam.lastInsertRowid;
  });
  const familyId = Number(tx());
  audit(familyId, req.userId, 'family.create', name);
  res.json({ id: familyId, name });
});

app.get('/api/families/:familyId', requireAuth, requireFamily, (req, res) => {
  const family = db.prepare('SELECT id, name FROM families WHERE id = ?').get(req.familyId);
  res.json({ family, members: membersOf(req.familyId), me: req.membership, billing: planSnapshot(familyById(req.familyId)) });
});

// ---------- billing (Stripe subscriptions) ----------
// Start a Checkout session to upgrade this family to Premium. Admin only.
app.post('/api/families/:familyId/billing/checkout', billingLimiter, requireAuth, requireFamily, requireAdmin, wrap(async (req, res) => {
  if (!billingConfigured) return res.status(503).json({ error: 'Billing not enabled yet' });
  const plan = req.body?.plan === 'annual' ? 'annual' : 'monthly';
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId);
  const url = await createCheckout(familyById(req.familyId), user?.email, plan);
  audit(req.familyId, req.userId, 'billing.checkout', plan);
  res.json({ url });
}));

// Open the Stripe-hosted portal to manage/cancel. Admin only.
app.post('/api/families/:familyId/billing/portal', billingLimiter, requireAuth, requireFamily, requireAdmin, wrap(async (req, res) => {
  if (!billingConfigured) return res.status(503).json({ error: 'Billing not enabled yet' });
  const url = await createPortal(familyById(req.familyId));
  res.json({ url });
}));

app.post('/api/families/:familyId/invites', requireAuth, requireFamily, requireAdmin, (req, res) => {
  // Early feedback: don't let a free family at the cap even mint an invite.
  if (billingConfigured && !isPremium(familyById(req.familyId))) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE family_id = ?').get(req.familyId).n;
    if (count >= FREE_MEMBER_LIMIT) {
      return res.status(402).json({ error: 'premium_required', feature: `Free families are limited to ${FREE_MEMBER_LIMIT} members. Upgrade to Homillow Premium to add more.` });
    }
  }
  const role = ROLES.includes(req.body?.role) ? req.body.role : 'adult';
  const code = crypto.randomBytes(6).toString('base64url');
  const expires = new Date(Date.now() + 7 * 864e5).toISOString();
  db.prepare('INSERT INTO invites (family_id, code, role, created_by, expires_at) VALUES (?,?,?,?,?)')
    .run(req.familyId, code, role, req.userId, expires);
  audit(req.familyId, req.userId, 'invite.create', role);
  res.json({ code, role, expires_at: expires });
});

app.post('/api/invites/accept', requireAuth, (req, res) => {
  const code = str(req.body?.code, 64);
  const displayName = str(req.body?.displayName, 80) || db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId).name;
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body?.color) ? req.body.color : '#E48AA0';
  const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
  if (!invite || invite.used_at || Date.parse(invite.expires_at) < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired invite' });
  }
  const already = db.prepare('SELECT id FROM memberships WHERE family_id = ? AND user_id = ?').get(invite.family_id, req.userId);
  if (already) return res.status(409).json({ error: 'Already in this family' });
  // Free plan caps family size; Premium is unlimited. Enforced here because this
  // is the moment a seat is actually taken.
  if (billingConfigured && !isPremium(familyById(invite.family_id))) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE family_id = ?').get(invite.family_id).n;
    if (count >= FREE_MEMBER_LIMIT) {
      return res.status(402).json({ error: 'premium_required', feature: `Free families are limited to ${FREE_MEMBER_LIMIT} members. Upgrade to Homillow Premium to add more.` });
    }
  }
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO memberships (family_id, user_id, role, display_name, color) VALUES (?,?,?,?,?)')
      .run(invite.family_id, req.userId, invite.role, displayName, color);
    db.prepare('UPDATE invites SET used_at = datetime(\'now\') WHERE id = ?').run(invite.id);
  });
  tx();
  audit(invite.family_id, req.userId, 'invite.accept', invite.role);
  broadcast(invite.family_id, { type: 'members' });
  res.json({ family_id: invite.family_id });
});

// ---------- member profiles (name, color, birthday) ----------
app.patch('/api/families/:familyId/members/:mid', requireAuth, requireFamily, (req, res) => {
  const mid = Number(req.params.mid);
  const target = db.prepare('SELECT * FROM memberships WHERE id = ? AND family_id = ?').get(mid, req.familyId);
  if (!target) return res.status(404).json({ error: 'Member not found' });
  if (req.membership.id !== mid && req.membership.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
  const b = req.body || {};
  const display_name = b.display_name !== undefined ? (str(b.display_name, 80) || target.display_name) : target.display_name;
  const color = /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : target.color;
  let birthdate = target.birthdate;
  if (b.birthdate !== undefined) birthdate = isISO(b.birthdate) ? String(b.birthdate).slice(0, 10) : null;
  db.prepare('UPDATE memberships SET display_name=?, color=?, birthdate=? WHERE id=?').run(display_name, color, birthdate, mid);
  audit(req.familyId, req.userId, 'member.update', String(mid));
  broadcast(req.familyId, { type: 'members' });
  res.json({ ok: true });
});

// ---------- family goals ----------
app.get('/api/families/:familyId/goals', requireAuth, requireFamily, (req, res) => {
  res.json({ goals: db.prepare('SELECT * FROM goals WHERE family_id = ? ORDER BY done, created_at DESC').all(req.familyId) });
});
app.post('/api/families/:familyId/goals', requireAuth, requireFamily, (req, res) => {
  if (atCap('goals', req.familyId)) return res.status(400).json({ error: CAP_MSG });
  const title = str(req.body?.title, 120);
  if (!title) return res.status(400).json({ error: 'Goal title required' });
  const target = Number.isInteger(req.body?.target_num) ? Math.max(1, Math.min(100000, req.body.target_num)) : 1;
  const info = db.prepare('INSERT INTO goals (family_id, title, target_num, created_by) VALUES (?,?,?,?)').run(req.familyId, title, target, req.userId);
  broadcast(req.familyId, { type: 'goals' });
  res.json({ goal: db.prepare('SELECT * FROM goals WHERE id = ?').get(info.lastInsertRowid) });
});
app.patch('/api/families/:familyId/goals/:id', requireAuth, requireFamily, (req, res) => {
  const id = Number(req.params.id);
  const g = db.prepare('SELECT * FROM goals WHERE id = ? AND family_id = ?').get(id, req.familyId);
  if (!g) return res.status(404).json({ error: 'Goal not found' });
  const b = req.body || {};
  let current = g.current_num;
  if (Number.isInteger(b.current_num)) current = Math.max(0, Math.min(100000, b.current_num));
  if (b.increment) current = Math.min(g.target_num, current + 1);
  const done = current >= g.target_num ? 1 : (b.done !== undefined ? (b.done ? 1 : 0) : g.done);
  const title = b.title !== undefined ? (str(b.title, 120) || g.title) : g.title;
  db.prepare('UPDATE goals SET title=?, current_num=?, done=? WHERE id=?').run(title, current, done, id);
  broadcast(req.familyId, { type: 'goals' });
  res.json({ goal: db.prepare('SELECT * FROM goals WHERE id = ?').get(id) });
});
app.delete('/api/families/:familyId/goals/:id', requireAuth, requireFamily, requireAdult, (req, res) => {
  const info = db.prepare('DELETE FROM goals WHERE id = ? AND family_id = ?').run(Number(req.params.id), req.familyId);
  if (!info.changes) return res.status(404).json({ error: 'Goal not found' });
  broadcast(req.familyId, { type: 'goals' });
  res.json({ ok: true });
});

// ---------- family moments ----------
app.get('/api/families/:familyId/moments', requireAuth, requireFamily, (req, res) => {
  res.json({ moments: db.prepare('SELECT * FROM moments WHERE family_id = ? ORDER BY COALESCE(moment_date, created_at) DESC').all(req.familyId) });
});
app.post('/api/families/:familyId/moments', requireAuth, requireFamily, (req, res) => {
  if (atCap('moments', req.familyId)) return res.status(400).json({ error: CAP_MSG });
  const title = str(req.body?.title, 120);
  if (!title) return res.status(400).json({ error: 'Title required' });
  const emoji = str(req.body?.emoji, 8) || '✨';
  const md = isISO(req.body?.moment_date) ? String(req.body.moment_date).slice(0, 10) : null;
  const note = str(req.body?.note, 500);
  const info = db.prepare('INSERT INTO moments (family_id, title, emoji, moment_date, note, created_by) VALUES (?,?,?,?,?,?)').run(req.familyId, title, emoji, md, note, req.userId);
  broadcast(req.familyId, { type: 'moments' });
  res.json({ moment: db.prepare('SELECT * FROM moments WHERE id = ?').get(info.lastInsertRowid) });
});
app.delete('/api/families/:familyId/moments/:id', requireAuth, requireFamily, requireAdult, (req, res) => {
  const info = db.prepare('DELETE FROM moments WHERE id = ? AND family_id = ?').run(Number(req.params.id), req.familyId);
  if (!info.changes) return res.status(404).json({ error: 'Moment not found' });
  broadcast(req.familyId, { type: 'moments' });
  res.json({ ok: true });
});

// ---------- Family Altar: prayers ----------
app.get('/api/families/:familyId/prayers', requireAuth, requireFamily, (req, res) => {
  res.json({ prayers: db.prepare('SELECT * FROM prayers WHERE family_id = ? ORDER BY answered, created_at DESC').all(req.familyId) });
});
app.post('/api/families/:familyId/prayers', requireAuth, requireFamily, requirePremium, (req, res) => {
  if (atCap('prayers', req.familyId)) return res.status(400).json({ error: CAP_MSG });
  const title = str(req.body?.title, 200);
  if (!title) return res.status(400).json({ error: 'Prayer request required' });
  const note = str(req.body?.note, 500);
  const info = db.prepare('INSERT INTO prayers (family_id, title, note, created_by) VALUES (?,?,?,?)')
    .run(req.familyId, title, note, req.userId);
  audit(req.familyId, req.userId, 'prayer.create', title);
  broadcast(req.familyId, { type: 'prayers' });
  res.json({ prayer: db.prepare('SELECT * FROM prayers WHERE id = ?').get(info.lastInsertRowid) });
});
app.patch('/api/families/:familyId/prayers/:id', requireAuth, requireFamily, requireAdult, (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare('SELECT * FROM prayers WHERE id = ? AND family_id = ?').get(id, req.familyId);
  if (!p) return res.status(404).json({ error: 'Prayer not found' });
  const b = req.body || {};
  const title = b.title !== undefined ? (str(b.title, 200) || p.title) : p.title;
  const note = b.note !== undefined ? str(b.note, 500) : p.note;
  const answered = b.answered !== undefined ? (b.answered ? 1 : 0) : p.answered;
  const answeredAt = answered ? (p.answered_at || new Date().toISOString()) : null;
  db.prepare('UPDATE prayers SET title=?, note=?, answered=?, answered_at=? WHERE id=?').run(title, note, answered, answeredAt, id);
  if (answered && !p.answered) audit(req.familyId, req.userId, 'prayer.answered', title);
  broadcast(req.familyId, { type: 'prayers' });
  res.json({ prayer: db.prepare('SELECT * FROM prayers WHERE id = ?').get(id) });
});
app.delete('/api/families/:familyId/prayers/:id', requireAuth, requireFamily, requireAdult, (req, res) => {
  const info = db.prepare('DELETE FROM prayers WHERE id = ? AND family_id = ?').run(Number(req.params.id), req.familyId);
  if (!info.changes) return res.status(404).json({ error: 'Prayer not found' });
  broadcast(req.familyId, { type: 'prayers' });
  res.json({ ok: true });
});

// ---------- events ----------
function rowToEvent(e) {
  const parts = db.prepare('SELECT membership_id FROM event_participants WHERE event_id = ?').all(e.id).map((r) => r.membership_id);
  return { ...e, all_day: !!e.all_day, participantIds: parts };
}

function expandOccurrences(ev, fromMs, toMs) {
  const start = Date.parse(ev.start_utc);
  const end = Date.parse(ev.end_utc);
  const dur = Math.max(0, end - start);
  if (ev.recurrence === 'none') {
    if (end >= fromMs && start <= toMs) return [{ ...ev, occ_start: ev.start_utc, occ_end: ev.end_utc }];
    return [];
  }
  const out = [];
  const d = new Date(start);
  let guard = 0;
  while (guard++ < 800) {
    const s = d.getTime();
    if (s > toMs) break;
    if (s + dur >= fromMs) {
      out.push({ ...ev, occ_start: new Date(s).toISOString(), occ_end: new Date(s + dur).toISOString() });
    }
    if (ev.recurrence === 'daily') d.setDate(d.getDate() + 1);
    else if (ev.recurrence === 'weekly') d.setDate(d.getDate() + 7);
    else if (ev.recurrence === 'monthly') d.setMonth(d.getMonth() + 1);
    else if (ev.recurrence === 'yearly') d.setFullYear(d.getFullYear() + 1);
    else break;
  }
  return out;
}

// Expand a set of events but cap the TOTAL occurrences per request. Without this,
// a member can seed hundreds of daily-recurring events and make /events and
// /briefing expand + O(n²) conflict-scan tens of millions of items, pinning the
// single Node instance for every tenant.
const MAX_OCCURRENCES = 2000;
function expandAll(rows, from, to) {
  const occ = [];
  for (const e of rows) {
    for (const o of expandOccurrences(e, from, to)) {
      occ.push(o);
      if (occ.length >= MAX_OCCURRENCES) return occ;
    }
  }
  return occ;
}

app.get('/api/families/:familyId/events', requireAuth, requireFamily, (req, res) => {
  const from = isISO(req.query.from) ? Date.parse(req.query.from) : Date.now() - 30 * 864e5;
  const to = isISO(req.query.to) ? Date.parse(req.query.to) : Date.now() + 60 * 864e5;
  const rows = db.prepare('SELECT * FROM events WHERE family_id = ?').all(req.familyId).map(rowToEvent);
  const occ = expandAll(rows, from, to);
  occ.sort((a, b) => Date.parse(a.occ_start) - Date.parse(b.occ_start));
  res.json({ events: occ });
});

app.post('/api/families/:familyId/events', requireAuth, requireFamily, (req, res) => {
  const b = req.body || {};
  if (atCap('events', req.familyId)) return res.status(400).json({ error: CAP_MSG });
  const title = str(b.title, 160);
  if (!title) return res.status(400).json({ error: 'Title required' });
  if (!isISO(b.start_utc) || !isISO(b.end_utc)) return res.status(400).json({ error: 'Valid start/end required' });
  if (Date.parse(b.end_utc) < Date.parse(b.start_utc)) return res.status(400).json({ error: 'End must be after start' });
  const category = CATEGORIES.includes(b.category) ? b.category : 'family';
  const recurrence = RECUR.includes(b.recurrence) ? b.recurrence : 'none';
  const partIds = sanitizeMemberIds(req.familyId, b.participantIds);
  const transportBy = sanitizeMemberIds(req.familyId, [b.transport_by])[0] ?? null;
  const info = db.prepare(`INSERT INTO events
    (family_id, title, description, location, category, start_utc, end_utc, all_day, recurrence, transport_by, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.familyId, title, str(b.description, 1000), str(b.location, 200), category,
    new Date(b.start_utc).toISOString(), new Date(b.end_utc).toISOString(),
    b.all_day ? 1 : 0, recurrence, transportBy, req.userId);
  const insert = db.prepare('INSERT OR IGNORE INTO event_participants (event_id, membership_id) VALUES (?,?)');
  for (const id of partIds) insert.run(info.lastInsertRowid, id);
  audit(req.familyId, req.userId, 'event.create', title);
  const event = rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid));
  broadcast(req.familyId, { type: 'events' });
  res.json({ event, conflicts: detectConflicts(req.familyId, event) });
});

app.patch('/api/families/:familyId/events/:id', requireAuth, requireFamily, requireAdult, (req, res) => {
  const id = Number(req.params.id);
  const ev = db.prepare('SELECT * FROM events WHERE id = ? AND family_id = ?').get(id, req.familyId);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const b = req.body || {};
  const fields = {
    title: b.title !== undefined ? str(b.title, 160) || ev.title : ev.title,
    description: b.description !== undefined ? str(b.description, 1000) : ev.description,
    location: b.location !== undefined ? str(b.location, 200) : ev.location,
    category: CATEGORIES.includes(b.category) ? b.category : ev.category,
    start_utc: isISO(b.start_utc) ? new Date(b.start_utc).toISOString() : ev.start_utc,
    end_utc: isISO(b.end_utc) ? new Date(b.end_utc).toISOString() : ev.end_utc,
    all_day: b.all_day !== undefined ? (b.all_day ? 1 : 0) : ev.all_day,
    recurrence: RECUR.includes(b.recurrence) ? b.recurrence : ev.recurrence,
  };
  if (Date.parse(fields.end_utc) < Date.parse(fields.start_utc)) return res.status(400).json({ error: 'End must be after start' });
  db.prepare(`UPDATE events SET title=?, description=?, location=?, category=?, start_utc=?, end_utc=?, all_day=?, recurrence=? WHERE id=?`)
    .run(fields.title, fields.description, fields.location, fields.category, fields.start_utc, fields.end_utc, fields.all_day, fields.recurrence, id);
  if (Array.isArray(b.participantIds)) {
    const partIds = sanitizeMemberIds(req.familyId, b.participantIds);
    db.prepare('DELETE FROM event_participants WHERE event_id = ?').run(id);
    const insert = db.prepare('INSERT OR IGNORE INTO event_participants (event_id, membership_id) VALUES (?,?)');
    for (const mid of partIds) insert.run(id, mid);
  }
  audit(req.familyId, req.userId, 'event.update', String(id));
  broadcast(req.familyId, { type: 'events' });
  res.json({ event: rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(id)) });
});

app.delete('/api/families/:familyId/events/:id', requireAuth, requireFamily, requireAdult, (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM events WHERE id = ? AND family_id = ?').run(id, req.familyId);
  if (!info.changes) return res.status(404).json({ error: 'Event not found' });
  audit(req.familyId, req.userId, 'event.delete', String(id));
  broadcast(req.familyId, { type: 'events' });
  res.json({ ok: true });
});

// Conflict = time overlap sharing at least one assigned member, within +/- 60 days.
function detectConflicts(familyId, event) {
  const from = Date.now() - 60 * 864e5, to = Date.now() + 120 * 864e5;
  const mine = new Set(event.participantIds);
  if (!mine.size) return [];
  const rows = db.prepare('SELECT * FROM events WHERE family_id = ? AND id != ?').all(familyId, event.id).map(rowToEvent);
  const occThis = expandOccurrences(event, from, to);
  const conflicts = [];
  // Hard iteration budget so one event insert can never spin the shared event loop,
  // regardless of how many recurring events share a member.
  let budget = 50000;
  for (const other of rows) {
    if (!other.participantIds.some((p) => mine.has(p))) continue;
    const occOther = expandOccurrences(other, from, to);
    for (const a of occThis) for (const o of occOther) {
      if (--budget < 0) return conflicts.slice(0, 10);
      if (Date.parse(a.occ_start) < Date.parse(o.occ_end) && Date.parse(o.occ_start) < Date.parse(a.occ_end)) {
        conflicts.push({ id: other.id, title: other.title, start: o.occ_start });
      }
    }
  }
  return conflicts.slice(0, 10);
}

// ---------- tasks ----------
app.get('/api/families/:familyId/tasks', requireAuth, requireFamily, (req, res) => {
  res.json({ tasks: db.prepare('SELECT * FROM tasks WHERE family_id = ? ORDER BY done, COALESCE(due_utc, created_at)').all(req.familyId) });
});
app.post('/api/families/:familyId/tasks', requireAuth, requireFamily, (req, res) => {
  if (atCap('tasks', req.familyId)) return res.status(400).json({ error: CAP_MSG });
  const title = str(req.body?.title, 160);
  if (!title) return res.status(400).json({ error: 'Title required' });
  const assigned = sanitizeMemberIds(req.familyId, [req.body?.assigned_to])[0] ?? null;
  const due = isISO(req.body?.due_utc) ? new Date(req.body.due_utc).toISOString() : null;
  const points = Number.isInteger(req.body?.points) ? Math.max(0, Math.min(1000, req.body.points)) : 0;
  const info = db.prepare('INSERT INTO tasks (family_id, title, assigned_to, due_utc, points, created_by) VALUES (?,?,?,?,?,?)')
    .run(req.familyId, title, assigned, due, points, req.userId);
  broadcast(req.familyId, { type: 'tasks' });
  res.json({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid) });
});
app.patch('/api/families/:familyId/tasks/:id', requireAuth, requireFamily, (req, res) => {
  const id = Number(req.params.id);
  const t = db.prepare('SELECT * FROM tasks WHERE id = ? AND family_id = ?').get(id, req.familyId);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const done = req.body?.done !== undefined ? (req.body.done ? 1 : 0) : t.done;
  // Children may check chores off (advertised feature) but cannot retitle or
  // reassign tasks — that's a destructive/shared-data edit reserved for adults.
  const isChild = req.membership.role === 'child';
  const title = (!isChild && req.body?.title !== undefined) ? (str(req.body.title, 160) || t.title) : t.title;
  const assigned = (!isChild && req.body?.assigned_to !== undefined) ? (sanitizeMemberIds(req.familyId, [req.body.assigned_to])[0] ?? null) : t.assigned_to;
  const due = (!isChild && req.body?.due_utc !== undefined) ? (isISO(req.body.due_utc) ? req.body.due_utc : null) : t.due_utc;
  const points = (!isChild && req.body?.points !== undefined) ? Math.max(0, Math.min(100000, Math.trunc(Number(req.body.points)) || 0)) : t.points;
  db.prepare('UPDATE tasks SET done=?, title=?, assigned_to=?, due_utc=?, points=? WHERE id=?').run(done, title, assigned, due, points, id);
  broadcast(req.familyId, { type: 'tasks' });
  res.json({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) });
});
app.delete('/api/families/:familyId/tasks/:id', requireAuth, requireFamily, requireAdult, (req, res) => {
  const info = db.prepare('DELETE FROM tasks WHERE id = ? AND family_id = ?').run(Number(req.params.id), req.familyId);
  if (!info.changes) return res.status(404).json({ error: 'Task not found' });
  broadcast(req.familyId, { type: 'tasks' });
  res.json({ ok: true });
});

// ---------- grocery ----------
app.get('/api/families/:familyId/grocery', requireAuth, requireFamily, (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM grocery_items WHERE family_id = ? ORDER BY checked, category, created_at').all(req.familyId) });
});
app.post('/api/families/:familyId/grocery', requireAuth, requireFamily, (req, res) => {
  if (atCap('grocery_items', req.familyId)) return res.status(400).json({ error: CAP_MSG });
  const name = str(req.body?.name, 120);
  if (!name) return res.status(400).json({ error: 'Item name required' });
  const category = GROCERY_CATS.includes(req.body?.category) ? req.body.category : 'other';
  const info = db.prepare('INSERT INTO grocery_items (family_id, name, category, added_by) VALUES (?,?,?,?)')
    .run(req.familyId, name, category, req.userId);
  broadcast(req.familyId, { type: 'grocery' });
  res.json({ item: db.prepare('SELECT * FROM grocery_items WHERE id = ?').get(info.lastInsertRowid) });
});
app.patch('/api/families/:familyId/grocery/:id', requireAuth, requireFamily, (req, res) => {
  const id = Number(req.params.id);
  const it = db.prepare('SELECT * FROM grocery_items WHERE id = ? AND family_id = ?').get(id, req.familyId);
  if (!it) return res.status(404).json({ error: 'Item not found' });
  const checked = req.body?.checked !== undefined ? (req.body.checked ? 1 : 0) : it.checked;
  db.prepare('UPDATE grocery_items SET checked=? WHERE id=?').run(checked, id);
  broadcast(req.familyId, { type: 'grocery' });
  res.json({ item: db.prepare('SELECT * FROM grocery_items WHERE id = ?').get(id) });
});
app.delete('/api/families/:familyId/grocery/:id', requireAuth, requireFamily, requireAdult, (req, res) => {
  const info = db.prepare('DELETE FROM grocery_items WHERE id = ? AND family_id = ?').run(Number(req.params.id), req.familyId);
  if (!info.changes) return res.status(404).json({ error: 'Item not found' });
  broadcast(req.familyId, { type: 'grocery' });
  res.json({ ok: true });
});

// ---------- briefing ----------
app.get('/api/families/:familyId/briefing', requireAuth, requireFamily, (req, res) => {
  // The client sends its own local day boundaries (from/to as UTC ISO instants) so
  // "today" always matches the USER's timezone, not the server's (which is UTC on
  // Render). Fall back to a server-local day only for older clients / direct calls.
  let dayStart, dayEnd;
  if (isISO(req.query.from) && isISO(req.query.to)) {
    dayStart = new Date(req.query.from);
    dayEnd = new Date(req.query.to);
  } else {
    const d = isISO(req.query.date) ? new Date(req.query.date) : new Date();
    dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
    dayEnd = new Date(d); dayEnd.setHours(23, 59, 59, 999);
  }
  const from = dayStart.getTime(), to = dayEnd.getTime();
  const rows = db.prepare('SELECT * FROM events WHERE family_id = ?').all(req.familyId).map(rowToEvent);
  const occ = expandAll(rows, from, to);
  occ.sort((a, b) => Date.parse(a.occ_start) - Date.parse(b.occ_start));
  const members = membersOf(req.familyId);
  const byMember = {};
  for (const m of members) byMember[m.id] = { member: m, events: [] };
  const unassigned = [];
  for (const o of occ) {
    if (o.participantIds.length === 0) unassigned.push(o);
    for (const pid of o.participantIds) byMember[pid]?.events.push(o);
  }
  // conflicts among today's occurrences that share a member
  const conflicts = [];
  for (let i = 0; i < occ.length; i++) for (let j = i + 1; j < occ.length; j++) {
    const a = occ[i], c = occ[j];
    const shared = a.participantIds.some((p) => c.participantIds.includes(p));
    if (shared && Date.parse(a.occ_start) < Date.parse(c.occ_end) && Date.parse(c.occ_start) < Date.parse(a.occ_end)) {
      conflicts.push({ a: a.title, b: c.title, at: c.occ_start });
    }
  }
  const tasksDue = db.prepare('SELECT * FROM tasks WHERE family_id = ? AND done = 0 AND (due_utc IS NULL OR due_utc <= ?)').all(req.familyId, dayEnd.toISOString());
  const groceryOpen = db.prepare('SELECT COUNT(*) n FROM grocery_items WHERE family_id = ? AND checked = 0').get(req.familyId).n;
  const prayersOpen = db.prepare('SELECT COUNT(*) n FROM prayers WHERE family_id = ? AND answered = 0').get(req.familyId).n;
  res.json({ date: dayStart.toISOString(), timeline: occ, byMember: Object.values(byMember), unassigned, conflicts, tasksDue, groceryOpen, prayersOpen, devotional: todaysDevotional(dayStart) });
});

// ---------- static PWA ----------
app.use(express.static(join(__dirname, '..', 'public')));

// ---------- server + websockets ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const rooms = new Map(); // familyId -> Set<ws>

function broadcast(familyId, msg) {
  const set = rooms.get(Number(familyId));
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const ws of set) { if (ws.readyState === 1) ws.send(data); }
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  // Auth token travels ONLY in the Sec-WebSocket-Protocol header, never in the URL,
  // so it can't land in proxy/access logs or browser history. No query fallback.
  const token = (req.headers['sec-websocket-protocol'] || '').split(',')[0].trim();
  const familyId = Number(url.searchParams.get('familyId'));
  const payload = token && verifyToken(token);
  if (!payload || !Number.isInteger(familyId)) { socket.destroy(); return; }
  // Enforce family isolation on the socket: caller must be a member.
  const membership = db.prepare('SELECT id FROM memberships WHERE family_id = ? AND user_id = ?').get(familyId, payload.sub);
  if (!membership) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.familyId = familyId;
    if (!rooms.has(familyId)) rooms.set(familyId, new Set());
    rooms.get(familyId).add(ws);
    ws.on('close', () => rooms.get(familyId)?.delete(ws));
    ws.on('error', () => rooms.get(familyId)?.delete(ws));
    ws.send(JSON.stringify({ type: 'hello' }));
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Final error handler — never leak stack traces; always respond.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[hearth] error:', err?.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong' });
});

server.listen(PORT, () => {
  console.log(`Homillow running on http://localhost:${PORT}`);
  // Billing config sanity — half-configured billing is a silent launch trap.
  if (!billingConfigured) {
    console.warn('[homillow] BILLING OFF: STRIPE_SECRET_KEY not set — paywall disabled, all Premium features are FREE. Do not launch paid tiers like this.');
  } else if (!webhookConfigured) {
    console.warn('[homillow] BILLING HALF-CONFIGURED: STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is MISSING — checkouts will succeed but NO customer can ever be upgraded to premium. Set the webhook secret before launch.');
  } else {
    console.log('[homillow] Billing fully configured (secret key + webhook).');
  }
});

export { app, server };
