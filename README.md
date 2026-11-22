# stalkmyleetcode — The Coding Club Ledger

LeetCode friends leaderboard built with Node, Express, and plain HTML/CSS/JavaScript. No frontend build step. Chart.js and canvas-confetti are loaded from CDNs.

## Run locally

1. Run `npm install`.
2. Copy `.env.example` to `.env` and set the values below in your shell (or use a local environment loader).
3. Run `npm start`; open `http://localhost:3000`.

## Environment variables

- `MONGODB_URI` — MongoDB Atlas connection string. Required for player membership, snapshots, duels, quests, reactions, messages, league points, settings, and playlist data to persist and be shared across Vercel instances. Without it, the app falls back to temporary in-memory storage.
- `ADMIN_PASSWORD` — Long random passphrase for the signed, HttpOnly admin session. Required to add/remove players, create quests and playlists, moderate messages, and change integration settings.
- `CRON_SECRET` — Long random secret used to authorize Vercel Cron requests.
- `TIMEZONE` — IANA time zone for stats and streak reminders; defaults to `Asia/Kolkata`.
- `DISCORD_WEBHOOK_URL` — Optional incoming webhook URL from Discord Server Settings → Integrations → Webhooks.
- `TELEGRAM_BOT_TOKEN` — Optional token from Telegram's BotFather.
- `TELEGRAM_CHAT_ID` — Destination chat ID for the Telegram bot.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — Optional Web Push credentials. Generate a key pair with `npx web-push generate-vapid-keys` to enable browser alerts for new accepts and leaderboard overtakes.

Set the same variables under Vercel Project Settings → Environment Variables. Secrets are never returned to the browser. MongoDB indexes are created automatically at startup. Configure Atlas Network Access and a database user before deploying with `MONGODB_URI`.

## API additions

`GET /api/health`, `/api/admin/*`, `/api/duels`, `/api/quests`, `/api/league`, `/api/snapshots`, `/api/timemachine`, `/api/export`, `/api/badge/:username.svg`, `/api/users/:username/insights`, `/api/recommendations/:username`, `/api/help`, `/api/reactions`, `/api/messages`, and `/api/playlist`.

Vercel runs sync at 04:00 UTC and the streak reminder at 15:00 UTC (20:30 IST). Vercel Hobby supports daily crons; use cron-job.org for a 15-minute sync cadence if needed.

## Data notes

LeetCode's profile calendar provides daily activity counts; recent submissions are limited to the latest 15 entries, so language and acceptance insights and problem-help matches are based on that window. The recommendation endpoint points to topic-specific unsolved practice pages rather than claiming it knows each player's complete solved set. Browser localStorage remains in use for theme and local focus sessions; shared season data uses MongoDB when configured.
