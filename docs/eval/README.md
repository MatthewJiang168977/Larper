# Pick-quality measurements

Design: [quality-engine.md](../plans/quality-engine.md), section 4.

## Regression gate (CI)

`apps/api/src/eval/eval.spec.ts` runs with the API's tests. It ranks a **synthetic** fixture
(made-up places, made-up ratings; nothing here describes a real place) and fails if, against
`baseline.json`, the top-1 great rate drops by more than 0.05 or the bad-or-closed rate rises
by more than 0.02. `fixture.md` is the last report.

```bash
pnpm --filter @larper/api eval                      # run it and write fixture.md
pnpm --filter @larper/api eval -- --update-baseline # only when a change is meant to move it
```

It says whether a change made the ranker behave differently on a fixed world. It does not
say whether the picks are any good.

## Real data

This does. Both commands only read the database (read-only transaction).

```bash
cd apps/api && pnpm build
DATABASE_URL=... node dist/ops/golden-export.js                 # data/golden-places.csv
DATABASE_URL=... node dist/ops/eval-snapshot.js --out ../../pilot/eval-places.json
node dist/eval/cli.js --places ../../pilot/eval-places.json     # docs/eval/real-<date>.md
```

The repository is public: `golden-export` writes insider notes only with `--notes`, and the
snapshot (Overture data) stays in the gitignored `pilot/`.

Read `Top-3 picks with any rating` first. While it is low, the other numbers say little.

## Funnel

```bash
DATABASE_URL=... ADMIN_USER_IDS=<your user id> DEMO_CLERK_USER_ID=<demo user> node dist/ops/funnel-report.js
```
