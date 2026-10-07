# Firetiger Fishing Log

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
| `styles.css` | Design (firetiger crankbait theme, light and dark) |
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

It's a static site with no build step. `netlify.toml` publishes the repo root.

When you change `app.js` or `styles.css`, bump `VERSION` in `sw.js` so installed copies pick up the update.
