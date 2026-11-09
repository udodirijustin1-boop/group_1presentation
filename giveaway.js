'use strict';
// -----------------------------------------------------------------------------
// N50,000 Campaign Giveaway backend (Node version, replaces the old repair app).
// Mounted by server.js. Endpoints:
//   accounts   POST /api/register  /api/login  /api/logout   GET /api/me
//   referral   GET  /api/leaderboard
//   payout     POST /api/payout            (winners only - account name, account
//                                            number, bank name; nothing else)
//   owner      GET  /api/admin/entries                  (header X-Admin-Token)
//              POST /api/admin/entries/:id/winner        (header X-Admin-Token)
 // Winners submit only what's needed to receive a bank transfer.
// Data is stored in a JSON file (giveaway.json) - no database to install.
// -----------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const CAMPAIGN_NAME = 'N50,000 Campaign Giveaway';
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SESSION_DAYS = 14;

const NIGERIAN_BANKS = [
  'Access Bank', 'Citibank Nigeria', 'Ecobank Nigeria', 'Fidelity Bank', 'First Bank of Nigeria',
  'First City Monument Bank (FCMB)', 'Globus Bank', 'Guaranty Trust Bank (GTBank)', 'Heritage Bank',
  'Jaiz Bank', 'Keystone Bank', 'Kuda Bank', 'Moniepoint MFB', 'Opay', 'PalmPay', 'Parallex Bank',
  'Polaris Bank', 'Premium Trust Bank', 'Providus Bank', 'Stanbic IBTC Bank', 'Standard Chartered Bank',
  'Sterling Bank', 'SunTrust Bank', 'Titan Trust Bank', 'Union Bank of Nigeria', 'United Bank for Africa (UBA)',
  'Unity Bank', 'VFD Microfinance Bank', 'Wema Bank', 'Zenith Bank'
];

// ---- Settings ----------------------------------------------------------------
const cfg = {
  dataFile: () => process.env.DATA_FILE || path.join(__dirname, 'giveaway.json'),
  adminToken: () => process.env.ADMIN_TOKEN || '',
  baseUrl: () => (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  cookieSecure: () => (process.env.COOKIE_SECURE || (cfg.baseUrl().startsWith('https') ? '1' : '0')) === '1'
};

function sessionSecret() {
  if (process.env.SECRET_KEY) return process.env.SECRET_KEY;
  const f = path.join(__dirname, '.secret_key');
  try {
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    return fs.readFileSync(f, 'utf8').trim();
  } catch (e) {
    console.warn('[giveaway] Could not persist .secret_key (' + e.message + '). Set SECRET_KEY so logins survive restarts.');
    return crypto.randomBytes(32).toString('hex');
  }
}
const SECRET = sessionSecret();

// ---- Storage (JSON file, written atomically) --------------------------------
let data = { users: [], nextUserId: 1 };

function loadData() {
  const file = cfg.dataFile();
  try {
    data = Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (e.code === 'ENOENT') return;
    const backup = file + '.corrupt-' + Date.now();
    try { fs.copyFileSync(file, backup); } catch (_) { /* ignore */ }
    console.error('[giveaway] Could not read ' + file + ' (' + e.message + '). Saved a copy to ' + backup + ' and starting empty.');
  }
}
function save() {
  const file = cfg.dataFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
loadData();

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// ---- Passwords (login only - never sent anywhere, never recoverable) --------
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex');
}
async function checkPw(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  const calc = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hash, 'hex');
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}
let DUMMY_HASH = null;
const dummyHash = async () => DUMMY_HASH || (DUMMY_HASH = await hashPw('not-a-real-password'));

// ---- Sessions (signed cookie) ------------------------------------------------
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function setSession(res, uid) {
  const payload = Buffer.from(JSON.stringify({ uid, exp: Date.now() + SESSION_DAYS * 86400000 })).toString('base64url');
  res.append('Set-Cookie', `gs=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${cfg.cookieSecure() ? '; Secure' : ''}`);
}
function clearSession(res) {
  res.append('Set-Cookie', `gs=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cfg.cookieSecure() ? '; Secure' : ''}`);
}
function sessionUid(req) {
  const part = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('gs='));
  if (!part) return null;
  const [payload, sig] = part.slice(3).split('.');
  if (!payload || !sig) return null;
  const good = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return p.exp > Date.now() ? p.uid : null;
  } catch (_) { return null; }
}

// ---- Small helpers ------------------------------------------------------------
const err = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v) => (v == null ? '' : String(v));
const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && !Buffer.isBuffer(req.body) ? req.body : {});
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const hits = new Map();
function throttled(key, limit = 10, windowSec = 600) {
  const t = Date.now();
  const recent = (hits.get(key) || []).filter((x) => t - x < windowSec * 1000);
  if (recent.length >= limit) { hits.set(key, recent); return true; }
  recent.push(t); hits.set(key, recent);
  return false;
}

function referralCount(u) {
  return data.users.filter((x) => x.referred_by === u.referral_code).length;
}

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone,
    referral_code: u.referral_code, referral_count: referralCount(u),
    is_winner: !!u.is_winner, payout_submitted: !!(u.payout && u.payout.submitted_at)
  };
}

function newReferralCode() {
  let code;
  do { code = crypto.randomBytes(4).toString('hex'); } while (data.users.some((u) => u.referral_code === code));
  return code;
}


// ---- Router ---------------------------------------------------------------
module.exports = function createGiveawayRouter(opts = {}) {
  const router = express.Router();
  const jsonBody = express.json({ limit: '16kb' });

  function notify(text) {
    if (!opts.notify) return;
    Promise.resolve(opts.notify(text)).catch(() => {});
  }

  const currentUser = (req) => {
    const uid = sessionUid(req);
    return uid ? data.users.find((u) => u.id === uid) || null : null;
  };
  const loginRequired = (handler) => wrap((req, res) => {
    const u = currentUser(req);
    return u ? handler(req, res, u) : err(res, 'Please log in.', 401);
  });

  router.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/api/campaign', (req, res) => res.json({ name: CAMPAIGN_NAME, banks: NIGERIAN_BANKS }));

  // ---------- accounts / entry ----------
  router.post('/api/register', jsonBody, wrap(async (req, res) => {
    if (throttled('reg:' + req.ip)) return err(res, 'Too many attempts. Try again later.', 429);
    const d = body(req);
    const name = str(d.name).trim(), email = str(d.email).trim().toLowerCase();
    const phone = str(d.phone).trim(), pw = str(d.password);
    const refCode = str(d.ref).trim().toLowerCase();
    if (!name || name.length > 100) return err(res, 'Enter your name.');
    if (!EMAIL.test(email) || email.length > 200) return err(res, 'Enter a valid email.');
    if (phone.replace(/\D/g, '').length < 7 || phone.length > 30) return err(res, 'Enter a valid WhatsApp number.');
    if (pw.length < 8 || pw.length > 200) return err(res, 'Use a password of 8 or more characters.');
    if (data.users.some((u) => u.email === email)) return err(res, 'An account with this email already exists. Log in instead.', 409);
    const hash = await hashPw(pw);
    if (data.users.some((u) => u.email === email)) return err(res, 'An account with this email already exists. Log in instead.', 409);
    const referrer = refCode ? data.users.find((u) => u.referral_code === refCode) : null;
    const user = {
      id: data.nextUserId++, name, email, phone, pw_hash: hash,
      referral_code: newReferralCode(), referred_by: referrer ? referrer.referral_code : null,
      is_winner: false, payout: null, created_at: now()
    };
    data.users.push(user);
    save();
    setSession(res, user.id);
    notify(`New entry - ${CAMPAIGN_NAME}\nName: ${name}\nPhone: ${phone}\nEmail: ${email}${referrer ? `\nReferred by: ${referrer.name}` : ''}`);
    return res.status(201).json({ user: publicUser(user) });
  }));

  router.post('/api/login', jsonBody, wrap(async (req, res) => {
    if (throttled('login:' + req.ip)) return err(res, 'Too many attempts. Try again later.', 429);
    const d = body(req);
    const u = data.users.find((x) => x.email === str(d.email).trim().toLowerCase());
    const ok = await checkPw(str(d.password), u ? u.pw_hash : await dummyHash());
    if (!(u && ok)) return err(res, 'Wrong email or password.', 401);
    setSession(res, u.id);
    return res.json({ user: publicUser(u) });
  }));

  router.post('/api/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

  router.get('/api/me', loginRequired((req, res, user) => res.json({ user: publicUser(user) })));

  router.get('/api/leaderboard', (req, res) => {
    const rows = data.users
      .map((u) => ({ name: u.name, referral_count: referralCount(u) }))
      .filter((r) => r.referral_count > 0)
      .sort((a, b) => b.referral_count - a.referral_count)
      .slice(0, 20)
      .map((r) => ({ name: r.name.replace(/(?<=.).(?=.*\s)/g, '*'), referral_count: r.referral_count })); // light privacy mask
    res.json({ leaderboard: rows });
  });

  // ---------- payout (any entrant; account name/number/bank name ONLY) ----------
  // Collected from everyone at entry so winners can be paid out quickly once picked -
  // not gated on is_winner. Still never asks for card numbers, BVN, NIN, or a bank login.
  router.post('/api/payout', jsonBody, loginRequired((req, res, user) => {
    if (user.payout && user.payout.submitted_at) return err(res, 'Payout details were already submitted.', 409);
    const d = body(req);
    const accountName = str(d.account_name).trim();
    const accountNumber = str(d.account_number).replace(/\D/g, '');
    const bankName = str(d.bank_name).trim();
    if (!accountName || accountName.length > 120) return err(res, 'Enter the account name.');
    if (accountNumber.length !== 10) return err(res, 'Enter a valid 10-digit account number.');
    if (!NIGERIAN_BANKS.includes(bankName)) return err(res, 'Choose your bank from the list.');
    user.payout = { account_name: accountName, account_number: accountNumber, bank_name: bankName, submitted_at: now() };
    save();
    const label = user.is_winner ? 'Winner payout details' : 'Payout details (entrant)';
    notify(`${label} - ${CAMPAIGN_NAME}\nName: ${user.name}\nPhone: ${user.phone}\nEmail: ${user.email}\nAccount name: ${accountName}\nAccount number: ${accountNumber}\nBank: ${bankName}`);
    return res.json({ ok: true });
  }));

  // ---------- owner view ----------
  function checkAdmin(req, res) {
    const t = cfg.adminToken();
    const h = (v) => crypto.createHash('sha256').update(v).digest();
    if (!t || !crypto.timingSafeEqual(h(str(req.get('x-admin-token'))), h(t))) { err(res, 'Not allowed.', 403); return false; }
    return true;
  }

  router.get('/api/admin/entries', (req, res) => {
    if (!checkAdmin(req, res)) return;
    const rows = data.users.slice().sort((a, b) => referralCount(b) - referralCount(a)).map((u) => ({
      id: u.id, name: u.name, email: u.email, phone: u.phone, referral_count: referralCount(u),
      referred_by: u.referred_by, is_winner: !!u.is_winner, created_at: u.created_at,
      payout: u.payout && u.payout.submitted_at ? u.payout : null
    }));
    res.json({ entries: rows });
  });

  router.post('/api/admin/entries/:id/winner', jsonBody, wrap((req, res) => {
    if (!checkAdmin(req, res)) return;
    const u = data.users.find((x) => x.id === Number(req.params.id));
    if (!u) return err(res, 'Entry not found.', 404);
    u.is_winner = true;
    save();
    notify(`Winner selected - ${CAMPAIGN_NAME}\nName: ${u.name}\nPhone: ${u.phone}\nEmail: ${u.email}\nThey can now submit payout details on the site.`);
    return res.json({ ok: true });
  }));

  router.use((e, req, res, next) => {
    if (e && e.type === 'entity.too.large') return err(res, 'Request too large.', 413);
    if (e && (e.type === 'entity.parse.failed' || e.status === 400)) return err(res, 'Invalid request.', 400);
    console.error('[giveaway] Unexpected error:', e);
    return err(res, 'Something went wrong. Please try again.', 500);
  });

  return router;
};
