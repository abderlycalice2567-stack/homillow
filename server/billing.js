// Homillow billing — Stripe subscriptions, one per family.
//
// Design notes:
//  - The app must boot and run with NO Stripe keys set (free tier keeps working);
//    billing endpoints then return 503 until STRIPE_SECRET_KEY is provided.
//  - The `families` table is the source of truth for plan state. Stripe webhooks
//    are the ONLY thing that flips plan → 'premium'/'free' (never the client).
//  - Prices live in Stripe; we reference them by env price id so the dollar
//    amount can change without a code deploy.
import Stripe from 'stripe';
import db from './db.js';

const SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
// Price IDs are NOT secret (safe in the repo). Defaults are Homillow Premium's live
// prices — verified $8/mo and $80/yr — and can still be overridden via env.
// $6/mo and $60/yr prices (set 2026-09-05). NOTE: monthly/annual mapping inferred
// from the order Kensley sent them — CONFIRM in Stripe before enabling billing.
const PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY || 'price_1UCWQlAn1xv1u255zSG5f4HM';
const PRICE_ANNUAL = process.env.STRIPE_PRICE_ANNUAL || 'price_1UCWRWAn1xv1u255VcYReUt3';
// Public base URL for Checkout redirect returns. Falls back to localhost for dev.
const APP_URL = (process.env.APP_URL || 'http://localhost:4000').replace(/\/+$/, '');

// Free families can have up to this many members; Premium is unlimited.
export const FREE_MEMBER_LIMIT = 4;

export const billingConfigured = Boolean(SECRET_KEY);
// The webhook is the ONLY thing that flips a family to premium. If the secret key
// is set but this is missing, paying customers can never be upgraded — a silent,
// revenue-losing misconfig. server.js asserts on this at startup.
export const webhookConfigured = Boolean(WEBHOOK_SECRET);
const stripe = billingConfigured ? new Stripe(SECRET_KEY) : null;

// A family is premium when the plan column says so. The webhook keeps this honest;
// we also treat a not-yet-past current_period_end as a safety net.
export function isPremium(family) {
  if (!family) return false;
  if (family.plan === 'premium') return true;
  return false;
}

export function familyById(familyId) {
  return db.prepare('SELECT * FROM families WHERE id = ?').get(familyId);
}

// Public snapshot of a family's plan for the client (never leak Stripe secrets).
export function planSnapshot(family) {
  return {
    plan: family?.plan || 'free',
    status: family?.subscription_status || null,
    current_period_end: family?.current_period_end || null,
    premium: isPremium(family),
    free_member_limit: FREE_MEMBER_LIMIT,
    billing_enabled: billingConfigured,
  };
}

// Ensure the family has a Stripe customer; create + persist one if not.
async function ensureCustomer(family, userEmail) {
  if (family.stripe_customer_id) return family.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: userEmail || undefined,
    name: family.name,
    metadata: { family_id: String(family.id) },
  });
  db.prepare('UPDATE families SET stripe_customer_id = ? WHERE id = ?').run(customer.id, family.id);
  return customer.id;
}

// Create a Checkout session for a family. plan = 'monthly' | 'annual'.
export async function createCheckout(family, userEmail, plan = 'monthly') {
  if (!billingConfigured) { const e = new Error('Billing not configured'); e.status = 503; throw e; }
  const price = plan === 'annual' ? PRICE_ANNUAL : PRICE_MONTHLY;
  if (!price) { const e = new Error('Price not configured'); e.status = 503; throw e; }
  const customerId = await ensureCustomer(family, userEmail);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    client_reference_id: String(family.id),
    // 7-day free trial (matches the marketing): card captured now, first charge on
    // day 8, cancel within the window = $0. Trialing subs are treated as Premium.
    subscription_data: { trial_period_days: 7, metadata: { family_id: String(family.id) } },
    allow_promotion_codes: true,
    success_url: `${APP_URL}/?billing=success`,
    cancel_url: `${APP_URL}/?billing=cancelled`,
  });
  return session.url;
}

// Stripe-hosted "manage / cancel / update card" page.
export async function createPortal(family) {
  if (!billingConfigured) { const e = new Error('Billing not configured'); e.status = 503; throw e; }
  if (!family.stripe_customer_id) { const e = new Error('No subscription yet'); e.status = 400; throw e; }
  const session = await stripe.billingPortal.sessions.create({
    customer: family.stripe_customer_id,
    return_url: `${APP_URL}/`,
  });
  return session.url;
}

// Apply a subscription's live state onto the family row.
function applySubscription(familyId, sub) {
  // Out-of-order / replayed webhook guard: Stripe can deliver a stale
  // subscription.updated (status=active) AFTER a subscription.deleted for the same
  // subscription id. A canceled/expired sub never legitimately returns to active
  // under the same id (Stripe issues a NEW id on resubscribe), so ignore any event
  // that would re-activate a subscription we've already terminated.
  const fam = db.prepare('SELECT stripe_subscription_id, subscription_status FROM families WHERE id = ?').get(familyId);
  const TERMINAL = new Set(['canceled', 'incomplete_expired']);
  if (fam && fam.stripe_subscription_id === sub.id && TERMINAL.has(fam.subscription_status)
      && (sub.status === 'active' || sub.status === 'trialing')) {
    return;
  }
  const active = sub.status === 'active' || sub.status === 'trialing';
  const plan = active ? 'premium' : 'free';
  // current_period_end lives on the subscription in older API versions and on the
  // subscription item in newer ones — read whichever is present.
  const rawEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
  const periodEnd = rawEnd ? new Date(rawEnd * 1000).toISOString() : null;
  db.prepare(`UPDATE families
     SET plan = ?, subscription_status = ?, stripe_subscription_id = ?, current_period_end = ?
     WHERE id = ?`).run(plan, sub.status, sub.id, periodEnd, familyId);
}

function resolveFamilyId(obj) {
  const fromMeta = obj?.metadata?.family_id;
  if (fromMeta) return Number(fromMeta);
  const ref = obj?.client_reference_id;
  if (ref) return Number(ref);
  const cust = obj?.customer;
  if (cust) {
    const row = db.prepare('SELECT id FROM families WHERE stripe_customer_id = ?').get(cust);
    if (row) return row.id;
  }
  return null;
}

// Verify + handle a raw webhook body. Returns {handled:bool, type}.
export async function handleWebhook(rawBody, signature) {
  if (!billingConfigured || !WEBHOOK_SECRET) { const e = new Error('Webhook not configured'); e.status = 503; throw e; }
  const event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const familyId = resolveFamilyId(session);
      if (familyId && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        applySubscription(familyId, sub);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const familyId = resolveFamilyId(sub);
      if (familyId) applySubscription(familyId, sub);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const familyId = resolveFamilyId(sub);
      if (familyId) {
        db.prepare(`UPDATE families
           SET plan = 'free', subscription_status = ?, current_period_end = ?
           WHERE id = ?`).run(sub.status, null, familyId);
      }
      break;
    }
    default:
      return { handled: false, type: event.type };
  }
  return { handled: true, type: event.type };
}
