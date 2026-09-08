import crypto from 'crypto';
import db from './db.js';

// Email is sent through Resend's REST API (no SDK dependency — Node's global fetch
// does the job). When RESEND_API_KEY isn't set, sends are skipped and logged so the
// app stays fully usable pre-configuration; a send failure never breaks a request.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
export const emailConfigured = RESEND_API_KEY.length > 0;

// Verified-domain sender. Override with EMAIL_FROM if the from-name/address changes.
const EMAIL_FROM = process.env.EMAIL_FROM || 'Homillow <noreply@homillow.com>';
// Public base URL used to build the links inside emails. Trailing slashes trimmed.
const APP_URL = (process.env.APP_URL || 'https://homillow.com').replace(/\/+$/, '');

// ---------- low-level send ----------
export async function sendEmail({ to, subject, html, text }) {
  if (!emailConfigured) {
    console.warn(`[email] RESEND_API_KEY not set — skipping "${subject}" to ${to}`);
    return { skipped: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[email] send failed (${res.status}) to ${to}: ${body.slice(0, 300)}`);
      return { ok: false, status: res.status };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error(`[email] send error to ${to}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------- single-use tokens (email verify + password reset) ----------
// Only a SHA-256 hash of each token is stored, so a database leak can't be replayed
// to verify or reset an account. The raw token lives only in the emailed link.
const TOKEN_TTL_MS = { verify: 24 * 60 * 60 * 1000, reset: 60 * 60 * 1000 }; // 24h / 1h
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createToken(userId, kind) {
  const raw = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + (TOKEN_TTL_MS[kind] || TOKEN_TTL_MS.verify)).toISOString();
  // One live link per kind: retire any prior unused tokens for this user first.
  db.prepare("UPDATE auth_tokens SET used_at = datetime('now') WHERE user_id = ? AND kind = ? AND used_at IS NULL")
    .run(userId, kind);
  db.prepare('INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES (?,?,?,?)')
    .run(userId, kind, sha256(raw), expires);
  return raw;
}

// Valid + unused + unexpired + right kind → marks it used and returns user_id, else null.
// Single-use: replaying the same link fails on the second try.
export function consumeToken(raw, kind) {
  if (!raw || typeof raw !== 'string') return null;
  const row = db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = ?').get(sha256(raw), kind);
  if (!row || row.used_at) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  db.prepare("UPDATE auth_tokens SET used_at = datetime('now') WHERE id = ?").run(row.id);
  return row.user_id;
}

// ---------- templates ----------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shell(bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px;">
    <div style="text-align:center;font-size:30px;">🏡</div>
    <h1 style="text-align:center;color:#c2582f;font-size:22px;margin:6px 0 20px;">Homillow</h1>
    <div style="background:#ffffff;border-radius:14px;padding:28px 24px;color:#2b2b2b;font-size:15px;line-height:1.6;">
      ${bodyHtml}
    </div>
    <p style="text-align:center;color:#8a8a8a;font-size:12px;margin-top:20px;">Your whole family, one calm place.<br><a href="${APP_URL}" style="color:#8a8a8a;">homillow.com</a></p>
  </div></body></html>`;
}
function button(href, label) {
  return `<div style="text-align:center;margin:24px 0;"><a href="${href}" style="background:#c2582f;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:10px;font-weight:600;display:inline-block;">${label}</a></div>
  <p style="color:#8a8a8a;font-size:12px;word-break:break-all;">Or paste this link into your browser:<br>${href}</p>`;
}

// ---------- high-level senders ----------
export async function sendVerificationEmail(user, rawToken) {
  const link = `${APP_URL}/api/verify-email?token=${encodeURIComponent(rawToken)}`;
  const first = escapeHtml((user.name || 'there').split(' ')[0]);
  const html = shell(`
    <p>Hi ${first},</p>
    <p>Welcome to Homillow — your account is set up! 🎉 Please confirm your email address so we can keep your family's account secure and send you things like password resets.</p>
    ${button(link, 'Confirm my email')}
    <p style="color:#8a8a8a;font-size:13px;">This link expires in 24 hours. If you didn't create a Homillow account, you can safely ignore this email.</p>`);
  const text = `Welcome to Homillow! Confirm your email: ${link}\n\nThis link expires in 24 hours. If you didn't create a Homillow account, ignore this email.`;
  return sendEmail({ to: user.email, subject: 'Welcome to Homillow — confirm your email', html, text });
}

export async function sendPasswordResetEmail(user, rawToken) {
  const link = `${APP_URL}/?reset=${encodeURIComponent(rawToken)}`;
  const first = escapeHtml((user.name || 'there').split(' ')[0]);
  const html = shell(`
    <p>Hi ${first},</p>
    <p>We received a request to reset your Homillow password. Tap below to choose a new one:</p>
    ${button(link, 'Reset my password')}
    <p style="color:#8a8a8a;font-size:13px;">This link expires in 1 hour. If you didn't ask to reset your password, you can safely ignore this email — your password won't change.</p>`);
  const text = `Reset your Homillow password: ${link}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email — your password won't change.`;
  return sendEmail({ to: user.email, subject: 'Reset your Homillow password', html, text });
}
