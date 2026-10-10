# fishr tests

Every bug that's been fixed has a test here, so it can't quietly come back.

```
cd tests && npm install && npx playwright install chromium   # once
node tests/run.mjs                                           # everything (browser suites 3 at a time)
node tests/run.mjs regressions                               # one suite (any suite whose name contains this)
JOBS=1 node tests/run.mjs                                    # browser suites one at a time
```

## What to run before pushing

GitHub runs everything on every push (below), so local runs match the risk of the change:

- **Wording, renames, styling:** the suites that check that screen (e.g. `bite-index`, `stats-insights`), plus
  `scripts.test` when any script or the version changes. A few minutes.
- **Logic** (sync, Cloud, scoring, alerts, the Guide, anything in `functions/`): the full run.
- **Layout:** also compare screenshots at the standard text size, and check large text (1.35× and 1.5×) on a small phone.

Needs Node 22 or newer (the stand-in database uses `node:sqlite`).

- `unit/`: the server code (passkeys, sync, AI endpoints) against a stand-in D1 database and R2 bucket, plus a check that the page scripts load together (no name declared in two files).
- `e2e/`: the real app in Chromium, served by `helpers/devserver.mjs`, which runs the real Pages Functions
  with a fake Claude API, so tests never spend money. `sweep` opens every screen at five sizes in light and dark;
  `regressions` and `cloud-regressions` reproduce specific bugs that were fixed.
- `fixtures/`: the sample season, test photos and recorded weather.

GitHub runs all of this on every push (`.github/workflows/tests.yml`).
