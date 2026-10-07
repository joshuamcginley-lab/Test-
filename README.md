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
