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

When you change `app.js` or `styles.css`, bump `VERSION` in `sw.js` so installed copies pick up the update.

## Shared catch links (server)

`functions/` holds Cloudflare Pages Functions that store shared catch cards in an R2 bucket:

- `POST /api/share` saves the card JPEG (max 1.5 MB) and returns a short link.
- `GET /c/<id>` serves link-preview tags with the real photo, then opens the app's catch page.
- `GET /img/<id>` serves the stored image.

They need an R2 bucket named `firetiger-catches` bound to the Pages project as `CATCHES`. Until that binding exists, sharing falls back to the long `#catch=` link.

## Conditions (weather, pressure, river levels)

- `conditions.js` pulls weather, barometric pressure (and its 3-hour trend), wind and 48-hour rain from Open-Meteo for each trip, using the forecast API for recent dates and the archive for older ones. Settings → "Add weather to past trips" fills in older trips.
- `functions/api/water.js` finds the nearest real-time river gauge (Environment and Climate Change Canada) and rates today's flow against the last 14 days as Low / Normal / High, with a 24-hour trend. Copilot and Insights use both.

## Spots map and Pro waitlist

- `map.js`: Trips → Map shows each water (sized by trips, coloured by fish per trip) and pinned spots on OpenStreetMap tiles via Leaflet, loaded on first use. Waters without a location can be placed by tapping the map.
- `pro.js` + `functions/api/waitlist.js`: the fishr Pro waitlist. Sign-ups need a ticked consent box and are stored in R2 under `waitlist/`. Export them as CSV with `GET /api/waitlist?export=csv` and an `x-admin-key` header matching the `WAITLIST_KEY` environment variable.

## Admin, privacy and crash reports

- `/privacy.html` — privacy policy (PIPEDA/CASL), with a form that removes an email from the waitlist.
- `/admin.html` — enter the `ADMIN_KEY` secret (set in Cloudflare) to see the waitlist count, download sign-ups as CSV (each row has a signed one-tap unsubscribe link) and read recent crash reports.
- `report.js` sends anonymous crash reports to `/api/errors`, stored in R2 for 90 days.
- `/api/unsubscribe?e=&t=` — signed unsubscribe links for waitlist emails.
