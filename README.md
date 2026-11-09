# N50,000 Campaign Giveaway + Voltaic Telegram backend

One Node/Express service (`server.js`) serves the giveaway site (`index.html`), the giveaway API (`giveaway.js`: entries, referrals, winner payouts) and the original Voltaic Telegram order endpoint. New entries, winner selections and payout submissions are sent to your Telegram chats.

## What it does
1. A visitor enters their name, email, WhatsApp number and password to register.
2. They get a personal referral link (`/?ref=CODE`) to share with their WhatsApp contacts. Anyone who registers through that link counts toward their referral total, shown on their dashboard and the public leaderboard.
3. On their dashboard, every entrant can also submit their payout details — **only** account name, account number and bank name, nothing else — so they're ready to be paid as soon as a winner is picked.
4. You review entries (`/api/admin/entries`) and referral counts, then mark a winner (`/api/admin/entries/:id/winner`). Their payout details (if already submitted) are right there in the entries list. You credit them yourself by bank transfer.

The registration API does not perform identity-provider checks. Card numbers and online banking logins are never requested.

## Run on your computer
1. Install Node.js (nodejs.org, LTS version).
2. In this folder:

       npm install
       npm start

3. Open http://localhost:3000

Copy `.env.example` to `.env` and fill it in (at least `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_IDS` for alerts, `ADMIN_TOKEN` for the admin endpoints). Restart after editing `.env`.

Entries are saved in `giveaway.json` next to `server.js`. Check everything works with `npm test` (uses fake Telegram, nothing real is sent).

## Managing the giveaway
List all entries, sorted by referral count:

    curl -H "X-Admin-Token: YOUR_ADMIN_TOKEN" http://localhost:3000/api/admin/entries

Mark an entry (by its `id` from the list above) as a winner:

    curl -X POST -H "X-Admin-Token: YOUR_ADMIN_TOKEN" http://localhost:3000/api/admin/entries/ID/winner

The winner then sees the payout form next time they load the site while logged in. Their account details also arrive on Telegram the moment they submit them.

## Railway
1. Connect this GitHub repository to Railway (it runs `npm start`).
2. Set Variables: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS`, `SECRET_KEY`, `ADMIN_TOKEN`, `BASE_URL`. `ALLOWED_ORIGINS` can stay blank.
3. Add a Volume mounted at `/data` and set `DATA_FILE=/data/giveaway.json`, otherwise entries are wiped on each redeploy.
4. `/health` returns the health status.

**Do not commit `.env` or real keys to GitHub.**


