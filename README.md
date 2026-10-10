# fishr.ai

A fishing log that runs in the browser and installs to a phone's home screen. Anglers log each trip (water, spot, time, water temperature, conditions, method, every fish with size and lure) and the app shows which waters, times of day, temperatures and lures produce fish.

- **No account needed.** Each person's log is saved on their own device (browser storage).
- **Works offline.** A service worker caches the app, so trips can be logged with no signal.
- **Backup and move devices.** Settings → Save backup (JSON) / Restore backup, plus CSV export for spreadsheets.
- **Units.** lb/in or kg/cm, °C or °F. Data is stored in lb, inches and °C.
- **Sample season.** New users can explore 47 real trips before logging their own.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Page markup |
| `styles.css` | Design (AI-startup theme, dark-first with light mode) |
| `app.js` | All app logic: storage, form, stats, patterns, backup |
| `cloud.js` | Optional fishr Cloud: passkey sign-in and sync |
| `ai.js` | Ask fishr and fishr ID |
| `guide.js` | "How fishr works" guide on the Guide tab |
| `sw.js` | Offline caching |
| `manifest.webmanifest`, `icons/` | Home-screen install |
| `sample.json` | Sample season data |

## Run locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploy

Hosted on Cloudflare Pages. It's a static site with no build step: framework preset None, build command empty, output directory `/`. `_headers` sets caching for the offline worker.

When you change any script or `styles.css`, bump `VERSION` in `sw.js` and the matching `?v=` on every script and stylesheet link in `index.html` and in the `APP` list in `sw.js`, so a page only ever loads scripts from its own release. `tests/unit/scripts.test.mjs` fails if they disagree.

## Shared catch links (server)

`functions/` holds Cloudflare Pages Functions that store shared catch cards in an R2 bucket:

- `POST /api/share` saves the card JPEG (max 1.5 MB) and returns a short link.
- `GET /c/<id>` serves link-preview tags with the real photo, then opens the app's catch page.
- `GET /img/<id>` serves the stored image.

They need an R2 bucket named `firetiger-catches` bound to the Pages project as `CATCHES`. Until that binding exists, sharing falls back to the long `#catch=` link.

## Conditions (weather, pressure, river levels)

- `conditions.js` pulls weather, barometric pressure (and its 3-hour trend), wind and 48-hour rain from Open-Meteo for each trip, using the forecast API for recent dates and the archive for older ones. Settings → "Add weather to past trips" fills in older trips.
- `functions/api/water.js` finds the nearest real-time river gauge (Environment and Climate Change Canada in Canada, the U.S. Geological Survey in the US; the closer one wins near the border) and rates today's flow against the last 14 days as Low / Normal / High, with a 24-hour trend. Guide and Insights use both.

## Spots map and Pro waitlist

- `map.js`: Trips → Map shows each water (sized by trips, coloured by fish per trip) and pinned spots on OpenStreetMap tiles via Leaflet, loaded on first use. Waters without a location can be placed by tapping the map.
- `pro.js` + `functions/api/waitlist.js`: the fishr Pro waitlist. Sign-ups need a ticked consent box and are stored in R2 under `waitlist/`. Export them as CSV with `GET /api/waitlist?export=csv` and an `x-admin-key` header matching the `WAITLIST_KEY` environment variable.

## fishr Cloud (optional sync)

Settings → Storage switches between **On this phone** (the default) and **Cloud**. Cloud accounts use passkeys (Face ID, Touch ID, fingerprint): no passwords or email.

- `cloud.js`: passkey sign-in, the Storage settings, and sync. Each trip is compared with what was last synced, so any change gets sent; the newest version of a trip wins, and deletes sync too. Photos upload privately and download on other devices when first shown.
- `functions/_auth.js`: passkey (WebAuthn) checks, sessions and the database tables (created automatically on first use).
- `functions/api/auth/[action].js` (sign up, sign in, sign out, account info), `functions/api/sync.js`, `functions/api/photo/[id].js`, `functions/api/account.js` (delete everything).
- Needs a D1 database (`fishr-logs`) bound to the Pages project as `DB`, plus the existing `CATCHES` R2 bucket (photos go under `u/<user id>/`).
- Cloud is free during the beta. To make it a Pro feature, add the environment variable `CLOUD_PRO_ONLY=true`; then only accounts with `plan = 'pro'` in the `users` table can sync, and everyone else keeps their log on their phone.
- Passkeys only work on the domain they were made on, so `www.` and the old pages.dev address redirect to `CANONICAL_HOST`.

## fishr AI: Ask fishr and fishr ID

Both call Claude (Claude Haiku 5.5) from Pages Functions, using the official Anthropic SDK bundled into `functions/_vendor/anthropic-sdk.js` (no build step needed; how to update it is at the top of that file).

- **Ask fishr** (`ai.js` card on the Guide tab, `functions/api/ai/ask.js`): answers questions from the angler's own log in fishr Cloud plus the conditions on the Guide tab. The showcase season can be asked about without an account.
- **fishr ID** (`functions/api/ai/identify.js`): names the fish in a photo using structured output. Opens from its own card on the Guide tab, the welcome screen ("What did you catch?"), or the button on each catch in the log form (automatic on a new photo for Cloud accounts). Anyone can try a few a day; "Log this catch" carries the photo and species into a new trip.
- `functions/_ai.js`: the client, daily allowances, and the log-to-text formatting.
- **Setup:** add the secret `ANTHROPIC_API_KEY` (from console.anthropic.com, which bills separately from a Claude subscription). Without it the Ask fishr card stays hidden.
- **Daily allowances** (environment variables, all optional): `AI_DAILY_CHAT` (5), `AI_DAILY_PHOTO` (10), `AI_DAILY_SAMPLE` (3 showcase questions per visitor), `AI_DAILY_ID_GUEST` (3 fishr IDs per visitor without an account), `AI_DAILY_CHAT_PRO` (50), `AI_DAILY_PHOTO_PRO` (100), and `AI_DAILY_TOTAL` (300 calls a day across everyone, a hard ceiling on spend). `AI_PRO_ONLY=true` limits both features to Pro accounts.

## Admin, privacy and crash reports

- `/privacy.html` — privacy policy (PIPEDA/CASL), with a form that removes an email from the waitlist.
- `/admin.html` — enter the `ADMIN_KEY` secret (set in Cloudflare) to see anonymous usage (the funnel from opening fishr to still logging a month later, and phones that logged a trip each week), the waitlist count, download sign-ups as CSV (each row has a signed one-tap unsubscribe link) and read recent crash reports.
- Bite alerts: `alerts.js` (Settings switch) subscribes the device for web push and sends `functions/api/push/[action].js` its push address, location (~1 km), time zone and town. `.github/workflows/bite-alerts.yml` calls `/api/push/run` hourly; `functions/_alerts.js` decides (Friday 6 pm, Saturday 8 am and 6 pm for the weekend; 6 pm daily for the weekly best window; thresholds are 85+/top 10% and 90+/top 5% of the past 4 weeks' windows at that spot), using the shared Bite Index in `bite-core.js`. `functions/_webpush.js` encrypts (RFC 8291) and signs (VAPID) each message. Needs Cloudflare secrets `VAPID_PUBLIC`, `VAPID_PRIVATE`, `PUSH_CRON_KEY` and the GitHub Actions secret `PUSH_CRON_KEY` (all made on `/admin`).
- Usage counts: `usage.js` sends each milestone name once per device to `functions/api/usage.js`, which keeps only daily totals in D1 (`usage_counts`). Settings has an off switch; nothing is sent from localhost unless `localStorage["fishr.usage.test"] = "1"`.
- `report.js` sends anonymous crash reports to `/api/errors`, stored in R2 for 90 days.
- `/api/unsubscribe?e=&t=` — signed unsubscribe links for waitlist emails.
