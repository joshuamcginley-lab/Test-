# fishr tests

Every bug that's been fixed has a test here, so it can't quietly come back.

```
cd tests && npm install && npx playwright install chromium   # once
node tests/run.mjs                                           # everything (about 10 minutes)
node tests/run.mjs regressions                               # one suite
```

Needs Node 22 or newer (the stand-in database uses `node:sqlite`).

- `unit/`: the server code (passkeys, sync, AI endpoints) against a stand-in D1 database and R2 bucket.
- `e2e/`: the real app in Chromium, served by `helpers/devserver.mjs`, which runs the real Pages Functions
  with a fake Claude API, so tests never spend money. `sweep` opens every screen at five sizes in light and dark;
  `regressions` and `cloud-regressions` reproduce specific bugs that were fixed.
- `fixtures/`: the sample season, test photos and recorded weather.

GitHub runs all of this on every push (`.github/workflows/tests.yml`).
