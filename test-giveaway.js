// Checks for the giveaway site running inside server.js. Run with: node test-giveaway.js
// Telegram is faked, so nothing real is sent.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'giveaway-'));
const PORT = 3800 + Math.floor(Math.random() * 90);
Object.assign(process.env, {
  PORT: String(PORT), DATA_FILE: path.join(tmp, 'data.json'),
  SECRET_KEY: 't', ADMIN_TOKEN: 'adm',
  TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_IDS: '111,222', BASE_URL: `http://localhost:${PORT}`
});

const realFetch = global.fetch;
const telegram = [];
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.includes('api.telegram.org')) { telegram.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  return realFetch(url, opts);
};
require('./server.js');

const base = `http://127.0.0.1:${PORT}`;
function client() {
  let cookie = '';
  return async (method, url, j, extra = {}) => {
    const r = await fetch(base + url, {
      method, redirect: 'manual',
      headers: Object.assign({}, cookie ? { Cookie: cookie } : {}, j !== undefined ? { 'Content-Type': 'application/json' } : {}, extra.headers || {}),
      body: j !== undefined ? JSON.stringify(j) : undefined
    });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) cookie = sc[sc.length - 1].split(';')[0];
    const text = await r.text(); let body = {}; try { body = JSON.parse(text); } catch (_) {}
    return { status: r.status, body, headers: r.headers, text };
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signup = (c, email, name = 'Ada', ref) =>
  c('POST', '/api/register', { name, email, phone: '08012345678', password: 'password1', ref });

const tests = {
  async page_and_campaign() {
    const c = client();
    const r = await c('GET', '/'); assert.strictEqual(r.status, 200); assert.ok(r.text.includes('N50,000'));
    const camp = await c('GET', '/api/campaign');
    assert.strictEqual(camp.body.name, 'N50,000 Campaign Giveaway');
    assert.ok(camp.body.banks.includes('Guaranty Trust Bank (GTBank)'));
  },
  async registration_does_not_require_identity_provider() {
    const c = client();
    const r = await signup(c, 'no-identity@b.com');
    assert.strictEqual(r.status, 201);
    assert.ok(!Object.hasOwn(r.body.user, 'identity_verified'));
  },
  async entry_and_duplicate() {
    const c = client();
    const r = await signup(c, 'a@b.com');
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.user.referral_count, 0);
    assert.ok(r.body.user.referral_code);
    assert.strictEqual((await signup(client(), 'a@b.com')).status, 409);
    assert.ok(!JSON.stringify((await c('GET', '/api/me')).body).includes('pw_hash'));
  },
  async login_and_tamper() {
    const c = client();
    await signup(c, 'login@b.com');
    await c('POST', '/api/logout');
    assert.strictEqual((await c('GET', '/api/me')).status, 401);
    assert.strictEqual((await c('POST', '/api/login', { email: 'login@b.com', password: 'wrong' })).status, 401);
    assert.strictEqual((await c('POST', '/api/login', { email: 'LOGIN@b.com', password: 'password1' })).status, 200);
    const forged = await fetch(base + '/api/me', { headers: { Cookie: 'gs=eyJ1aWQiOjEsImV4cCI6OTk5OTk5OTk5OTk5OX0.forged' } });
    assert.strictEqual(forged.status, 401);
  },
  async referral_tracking_and_leaderboard() {
    const ref = client();
    const r = await signup(ref, 'ref@b.com', 'Referrer');
    const code = r.body.user.referral_code;
    for (let i = 0; i < 3; i++) await signup(client(), `f${i}@b.com`, 'Friend' + i, code);
    await signup(client(), 'nobody@b.com', 'NoRef', 'not-a-real-code'); // bad ref code silently ignored
    const me = await ref('GET', '/api/me');
    assert.strictEqual(me.body.user.referral_count, 3);
    const board = await ref('GET', '/api/leaderboard');
    assert.ok(board.body.leaderboard[0].referral_count >= 3);
    await sleep(200);
    assert.ok(telegram.some((t) => t.text.includes('New entry') && t.text.includes('Referred by: Referrer')));
  },
  async payout_open_to_any_entrant_and_validates() {
    const c = client();
    const r = await signup(c, 'win@b.com', 'Winner');
    const uid = r.body.user.id;
    assert.strictEqual((await c('GET', '/api/admin/entries')).status, 403);
    assert.strictEqual((await c('GET', '/api/admin/entries', undefined, { headers: { 'X-Admin-Token': 'wrong' } })).status, 403);
    // Payout can be submitted before any winner is marked - open to every entrant.
    assert.strictEqual((await c('GET', '/api/me')).body.user.is_winner, false);
    assert.strictEqual((await c('POST', '/api/payout', { account_name: '', account_number: '123', bank_name: 'Access Bank' })).status, 400);
    assert.strictEqual((await c('POST', '/api/payout', { account_name: 'Winner', account_number: '123', bank_name: 'Access Bank' })).status, 400); // not 10 digits
    assert.strictEqual((await c('POST', '/api/payout', { account_name: 'Winner', account_number: '1234567890', bank_name: 'Not A Real Bank' })).status, 400);
    const ok = await c('POST', '/api/payout', { account_name: 'Winner Name', account_number: '1234567890', bank_name: 'Kuda Bank' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await c('POST', '/api/payout', { account_name: 'Winner Name', account_number: '1234567890', bank_name: 'Kuda Bank' })).status, 409); // already submitted
    // Now mark this entrant a winner; their payout details are already on file.
    const mark = await c('POST', `/api/admin/entries/${uid}/winner`, {}, { headers: { 'X-Admin-Token': 'adm' } });
    assert.strictEqual(mark.status, 200);
    assert.strictEqual((await c('GET', '/api/me')).body.user.is_winner, true);
    const admin = await c('GET', '/api/admin/entries', undefined, { headers: { 'X-Admin-Token': 'adm' } });
    const row = admin.body.entries.find((e) => e.id === uid);
    assert.strictEqual(row.payout.account_number, '1234567890');
    assert.strictEqual(row.payout.bank_name, 'Kuda Bank');
    assert.strictEqual(row.is_winner, true);
    await sleep(200);
    const titles = telegram.map((t) => t.text.split('\n')[0]);
    assert.ok(titles.some((t) => t.startsWith('Winner selected')));
    assert.ok(titles.some((t) => t.startsWith('Payout details (entrant)'))); // submitted before being marked a winner
    assert.ok(telegram.some((t) => t.text.includes('Account number: 1234567890')));
    assert.ok(!telegram.some((t) => t.text.toLowerCase().includes('bvn') || t.text.toLowerCase().includes('nin')));
    // A non-winner entrant can also submit payout details ahead of time.
    const other = client();
    await signup(other, 'other@b.com', 'Other');
    const otherOk = await other('POST', '/api/payout', { account_name: 'Other Name', account_number: '9876543210', bank_name: 'Zenith Bank' });
    assert.strictEqual(otherOk.status, 200);
  },
  async only_bank_fields_are_ever_stored() {
    const raw = fs.readFileSync(process.env.DATA_FILE, 'utf8');
    assert.ok(!/bvn|nin/i.test(raw));
    const parsed = JSON.parse(raw);
    const winner = parsed.users.find((u) => u.email === 'win@b.com');
    assert.deepStrictEqual(Object.keys(winner.payout).sort(), ['account_name', 'account_number', 'bank_name', 'submitted_at'].sort());
  },
  async old_shop_telegram_endpoint_still_works() {
    const c = client();
    const good = { name: 'Bo', email: 'bo@x.com', address: '1 Road', zip: '800001', total: 25.5, items: [{ name: 'Aero Wireless Earbuds', quantity: 2, price: 12.75 }] };
    const r = await c('POST', '/api/orders/telegram', good);
    assert.deepStrictEqual([r.status, r.body.ok, r.body.successCount], [200, true, 2]);
    assert.ok(telegram.some((t) => t.text.startsWith('New order - $25.50')));
  },
  async throttling() {
    const c = client(); let last;
    for (let i = 0; i < 11; i++) last = await c('POST', '/api/login', { email: 'x@y.com', password: 'wrongpass' });
    assert.strictEqual(last.status, 429);
  }
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '\n  ', e.message); }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nAll tests passed');
  process.exit(failed ? 1 : 0);
})();
