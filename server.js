// @ts-nocheck
// -----------------------------------------------------------------------------
// Voltaic - Telegram order notification backend
//
// This tiny Express service accepts order submissions from the storefront and
// forwards them as formatted messages to one or more Telegram chats via the
// Telegram Bot API. It also pings those same chats on startup so an operator
// knows the service is alive after a deploy or restart.
// -----------------------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// On Railway the app sits behind a proxy; trust it so each visitor's real IP is used
// for rate limiting (otherwise everyone would share one limit).
if (process.env.RAILWAY_ENVIRONMENT || process.env.TRUST_PROXY) app.set('trust proxy', 1);

// ---- Configuration (all sourced from environment variables) ---------------
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// TELEGRAM_CHAT_IDS is a comma-separated list, e.g. "111111,222222"
const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// ALLOWED_ORIGINS restricts which frontends may call the order endpoint.
// If left empty, the origin check is skipped entirely (open CORS-less mode).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Fail loudly at boot if critical config is missing, so misconfiguration is
// obvious in deploy logs rather than surfacing later as silent 503s.
if (!BOT_TOKEN) {
  console.error('[config] TELEGRAM_BOT_TOKEN is not set. Telegram delivery will fail until this is configured.');
}
if (!CHAT_IDS.length) {
  console.error('[config] TELEGRAM_CHAT_IDS is empty. No chats will receive order or startup notifications.');
}
if (!ALLOWED_ORIGINS.length) {
  console.warn('[config] ALLOWED_ORIGINS is empty. Origin checking is DISABLED for /api/orders/telegram.');
}

// ---- Global middleware ------------------------------------------------------
app.disable('x-powered-by'); // don't advertise the framework in response headers
app.use(helmet({
  crossOriginResourcePolicy: false,
  // The storefront currently uses inline <script> code. Disable Helmet's
  // default Content-Security-Policy so that code can execute normally.
  // Other Helmet security headers remain enabled.
  contentSecurityPolicy: false
})); // standard security headers
// ---- N50,000 Campaign Giveaway API (entries, referrals, winner payouts) -------
// Lives in giveaway.js. New entries and winner payout submissions are sent to the
// same Telegram chats this service already uses.
async function notifyAllChats(text) {
  if (!BOT_TOKEN || !CHAT_IDS.length) return;
  await Promise.all(CHAT_IDS.map((id) => sendTelegramMessage(id, String(text).slice(0, 3500))));
}
app.use(require('./giveaway')({ notify: notifyAllChats }));

app.use(express.json({ limit: '16kb' })); // small limit: order payloads are tiny, guards against abuse

// Rate limit order submissions to slow down spam/abuse of the Telegram relay.
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // max 20 order attempts per IP per window
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'Too many order attempts. Please try again later.' },
  // Log whenever a client actually gets throttled, since this can indicate
  // either abuse or a legitimate frontend retry-loop bug.
  handler: (req, res, _next, options) => {
    console.warn(`[rate-limit] Blocked order attempt from ${req.ip} (path: ${req.path})`);
    res.status(options.statusCode).json(options.message);
  }
});

// Origin allowlist check, scoped only to the order endpoint.
app.use('/api/orders/telegram', (req, res, next) => {
  if (!ALLOWED_ORIGINS.length) return next(); // check disabled, see warning above
  const origin = req.get('origin');
  if (!origin || ALLOWED_ORIGINS.includes(origin)) return next();
  console.warn(`[cors] Rejected request from disallowed origin: "${origin}"`);
  return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
});

// ---- Helpers ----------------------------------------------------------------

/**
 * Strips control characters and truncates a value to a max length.
 * Used to sanitize every piece of user-supplied text before it's ever
 * logged, stored, or sent to Telegram.
 */
function clean(value, max = 500) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

/** Basic email shape check - not exhaustive, just enough to catch typos/garbage. */
function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Builds the human-readable Telegram message body for a validated order. */
function buildOrderMessage(order) {
  const lines = order.items.map((item) => {
    const qty = Number(item.quantity);
    const price = Number(item.price);
    const safeName = clean(item.name, 180);
    const lineTotal = price * qty;
    return `\n- ${safeName}${qty > 1 ? ` x${qty}` : ''} ($${lineTotal.toFixed(2)})`;
  });

  return `New order - $${order.total.toFixed(2)}${lines.join('')}\n\nName: ${order.name}\nEmail: ${order.email}\nAddress: ${order.address}\nZIP: ${order.zip}`;
}

/**
 * Sends a single message to a single Telegram chat.
 * Never throws - returns true/false so callers can tally success/failure
 * across multiple chat IDs without one failure aborting the rest.
 */
async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10-second timeout

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    // Telegram can return a 200 with ok:false, or a non-200 status - handle both.
    const data = await response.json().catch((parseErr) => {
      console.error(`[telegram] Failed to parse response JSON for chat ${chatId}:`, parseErr.message);
      return { ok: false };
    });

    if (response.ok && data.ok) {
      return true;
    }

    // Log the HTTP status alongside Telegram's own error description for easier debugging.
    console.error(
      `[telegram] Delivery failed for chat ${chatId} (HTTP ${response.status}): ${data.description || 'no description returned'}`
    );
    return false;
  } catch (error) {
    clearTimeout(timeout);
    // Network-level failure (DNS, timeout, connection reset, etc.)
    if (error.name === 'AbortError') {
      console.error(`[telegram] Request timed out for chat ${chatId} after 10 seconds.`);
    } else {
      console.error(`[telegram] Network error sending to chat ${chatId}:`, error.message);
    }
    return false;
  }
}

/**
 * Notifies all configured chats that the backend just started up.
 * Runs once, right after the HTTP server starts listening.
 */
async function notifyStartup() {
  if (!BOT_TOKEN || !CHAT_IDS.length) {
    console.warn('[startup] Skipping startup notification: Telegram bot is not fully configured.');
    return;
  }

  const timestamp = new Date().toISOString();
  const message = `✅ Voltaic Telegram backend is online.\nStarted: ${timestamp}\nPort: ${PORT}`;

  console.log(`[startup] Sending startup notification to ${CHAT_IDS.length} chat(s)...`);
  const results = await Promise.all(CHAT_IDS.map((chatId) => sendTelegramMessage(chatId, message)));
  const successCount = results.filter(Boolean).length;
  const failedCount = results.length - successCount;

  if (failedCount > 0) {
    console.warn(`[startup] Startup notification: ${successCount} succeeded, ${failedCount} failed. Check chat IDs / bot permissions.`);
  } else {
    console.log(`[startup] Startup notification delivered to all ${successCount} chat(s).`);
  }
}

// Serve the storefront page (now the giveaway site) from this same Railway service.
// Keeping the HTML and API on one origin makes the frontend's
// /api/orders/telegram endpoint resolve correctly in production.
const STOREFRONT = path.join(__dirname, 'index.html');

app.get('/', (_req, res) => {
  res.sendFile(STOREFRONT);
});

app.get('/index.html', (_req, res) => {
  res.sendFile(STOREFRONT);
});

// ---- Routes -------------------------------------------------------------------

app.post('/api/orders/telegram', orderLimiter, async (req, res) => {
  if (!BOT_TOKEN || !CHAT_IDS.length) {
    console.error('[order] Rejected order: Telegram backend is not configured (missing bot token or chat IDs).');
    return res.status(503).json({ ok: false, error: 'Order notifications are temporarily unavailable.' });
  }

  const body = req.body || {};
  const name = clean(body.name, 120);
  const email = clean(body.email, 254);
  const address = clean(body.address, 500);
  const zip = clean(body.zip, 30);
  const total = Number(body.total);
  const items = Array.isArray(body.items) ? body.items : [];

  // --- Top-level field validation ---
  if (!name || !validEmail(email) || !address ||  !zip || !Number.isFinite(total) || total < 0 || items.length < 1 || items.length > 50) {
    console.warn(
      `[order] Rejected order with invalid top-level fields from ${req.ip} ` +
      `(name: ${!!name}, email: ${validEmail(email)}, address: ${!!address}, zip: ${!!zip}, ` +
      `total: ${Number.isFinite(total)}, itemCount: ${items.length})`
    );
    return res.status(400).json({ ok: false, error: 'Invalid order details.' });
  }

  // --- Per-item validation ---
  const normalizedItems = [];
  for (const [index, item] of items.entries()) {
    const itemName = clean(item && item.name, 180);
    const quantity = Number(item && item.quantity);
    const price = Number(item && item.price);
    if (!itemName || !Number.isInteger(quantity) || quantity < 1 || quantity > 99 || !Number.isFinite(price) || price < 0) {
      console.warn(`[order] Rejected order: invalid item at index ${index} from ${req.ip}.`);
      return res.status(400).json({ ok: false, error: 'Invalid order items.' });
    }
    normalizedItems.push({ name: itemName, quantity, price });
  }

  const message = buildOrderMessage({ name, email, address, zip, total, items: normalizedItems });

  console.log(`[order] Validated order from ${req.ip} for $${total.toFixed(2)} (${normalizedItems.length} item(s)). Dispatching to Telegram...`);

  const results = await Promise.all(CHAT_IDS.map((chatId) => sendTelegramMessage(chatId, message)));

  const successCount = results.filter(Boolean).length;
  const failedCount = results.length - successCount;

  if (successCount === 0) {
    // Every chat failed - this is a hard failure the storefront should surface to the customer/operator.
    console.error(`[order] Order notification FAILED for all ${results.length} chat(s). Order total: $${total.toFixed(2)}.`);
    return res.status(502).json({ ok: false, successCount: 0, failedCount, error: 'Order notification could not be delivered.' });
  }

  if (failedCount > 0) {
    // Partial failure - still return success, but log so it can be investigated.
    console.warn(`[order] Order notification partially failed: ${successCount} succeeded, ${failedCount} failed.`);
  } else {
    console.log(`[order] Order notification delivered to all ${successCount} chat(s).`);
  }

  return res.json({ ok: true, successCount, failedCount });
});

// Simple liveness probe for uptime monitors / load balancers.
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- Startup ------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Voltaic Telegram backend + giveaway site listening on port ${PORT}`);
  notifyStartup();
});

// Surface otherwise-silent crashes: without these handlers, an unhandled
// rejection or exception can kill the process (or hang it) with nothing
// useful in the logs to explain why.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[fatal] Uncaught exception:', error);
  // Exit so a process manager (PM2, systemd, Docker, etc.) can restart with a clean state.
  process.exit(1);
});
