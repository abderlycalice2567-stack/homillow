import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// JWT secret: prefer env; otherwise generate once and persist locally (never committed).
function loadSecret() {
  if (process.env.HEARTH_JWT_SECRET && process.env.HEARTH_JWT_SECRET.length >= 32) {
    return process.env.HEARTH_JWT_SECRET;
  }
  const path = join(__dirname, '.secret');
  try {
    return fs.readFileSync(path, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(path, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();
const TOKEN_TTL = '7d';

export async function hashPassword(pw) {
  return bcrypt.hash(pw, 12);
}
export async function verifyPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}
// Valid, correctly-formatted bcrypt hash used to blunt user-enumeration timing
// on unknown-email logins (compare always runs, never throws on bad format).
export const DUMMY_HASH = bcrypt.hashSync('hearth-dummy-compare', 12);

export function issueToken(user) {
  return jwt.sign({ sub: user.id, name: user.name }, SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token) {
  try {
    // Pin the algorithm: never let a token's own header pick the verification
    // algorithm (blocks alg-confusion / 'none' downgrade attacks).
    return jwt.verify(token, SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

// Express middleware: require a valid bearer token; attaches req.userId.
export function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  req.userId = payload.sub;
  next();
}

// Family isolation gate: the caller must be a member of the family in :familyId.
// Never trust a client-supplied family id without this check. Attaches req.membership.
export function requireFamily(req, res, next) {
  const familyId = Number(req.params.familyId);
  if (!Number.isInteger(familyId)) return res.status(400).json({ error: 'Bad family id' });
  const membership = db
    .prepare('SELECT * FROM memberships WHERE family_id = ? AND user_id = ?')
    .get(familyId, req.userId);
  if (!membership) return res.status(403).json({ error: 'Not a member of this family' });
  req.familyId = familyId;
  req.membership = membership;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.membership?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

export { SECRET };
