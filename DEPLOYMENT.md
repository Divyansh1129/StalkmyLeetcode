# Local run and deployment notes

## Local development

1. Install dependencies with npm install.
2. Copy .env.example to .env only if you use an environment loader, or set CRON_SECRET in your shell. PowerShell: $env:CRON_SECRET = "your-long-random-secret".
3. Start with npm start and open http://localhost:3000.

The app uses plain HTML, CSS, and browser JavaScript. Chart.js and canvas-confetti load from CDNs.

## Vercel

vercel.json routes requests through Express and schedules /api/cron/sync once daily at 04:00 UTC (09:30 India Standard Time). Add CRON_SECRET under the Vercel project's Environment Variables using a long random value. Vercel Cron sends it as Authorization: Bearer <CRON_SECRET>. The endpoint rejects requests without a matching secret.

Vercel Hobby supports daily cron schedules. To request a 15-minute cadence, configure cron-job.org to call https://YOUR_DOMAIN/api/cron/sync with an Authorization: Bearer YOUR_CRON_SECRET header; keep the secret only in the cron service's protected configuration.

## Storage and history limits

The server currently stores the six starter usernames and fetched profiles in process memory. It has no database or JSON-file storage. Added/removed players and server-side caches can reset between restarts, and Vercel may run separate isolated instances. Browser-only snapshots, rank comparisons, theme choice, and the Hall of Champions are kept in that browser's localStorage; they are not shared across players or devices and will not follow a user to another browser. Rating charts need the same browser to collect snapshots over time. These are useful local enhancements, not durable season history.

For shared, durable player membership, daily snapshots, rating history, and cross-device champions, use MongoDB Atlas (free tier):

1. Create an Atlas free cluster and a database user with a strong password.
2. Configure Atlas Network Access for the app's deployment. Prefer a restricted allowlist where your hosting plan provides stable egress; otherwise follow Vercel's current networking guidance and use a unique, rotated database credential.
3. Copy the Atlas connection string and add it to Vercel as MONGODB_URI (and to a local shell for development). URL-encode special characters in the password.
4. Add a MongoDB driver or Mongoose dependency and wire collections for players, daily per-player snapshots, and weekly season winners. Migrate the current starter usernames as the initial player documents, then read/write membership and snapshots through the database before enabling cross-device history.

MongoDB support is not implemented in this version; setting MONGODB_URI alone will not persist data.

## API

- GET /api/data returns cached player stats; ?refresh=1 forces a refresh from LeetCode.
- POST /api/users validates a LeetCode username and verifies the account exists before adding it.
- DELETE /api/users/:username removes a player.
- GET /api/extras returns the cached LeetCode daily challenge.
- GET /api/cron/sync (or POST) refreshes all players and requires CRON_SECRET.

The wall-of-shame estimate uses the latest accepted submission in LeetCode's recent-submission response (currently limited to 15 items). The contest countdown is an estimate based on the usual weekly Sunday / biweekly Saturday schedule. Daily problem completion is inferred from recent submissions returned by LeetCode.
