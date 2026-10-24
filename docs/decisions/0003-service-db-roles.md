# 0003: One Postgres role per service; the migration creates them

- **Status:** accepted, 2026-10-18
- **Scope:** `db/migrations/0010_service_roles.*`, `infra/helm/larper` (Cluster managed
  roles, `templates/db-roles.yaml`, every Deployment's database env, the migrate Job),
  the database tests and CI's db job
- **Related:** audit 2026-10, item 3

## Context

Every pod connected as `larper`, the owner of the database and every table, through
CNPG's `pg-app` Secret. Any pod could run DDL, read every user's taste and location
history, or drop a table.

## Decision

Four login roles, each granted only the tables and operations its SQL uses. `larper`
stays the owner: it alone runs DDL, and only the migrate Job logs in as it.

| Table | `larper_api` | `larper_relay` | `larper_taste` | `larper_ingest` (+ `load-places`) |
|---|---|---|---|---|
| `users` | S I | | | |
| `taste_profiles` | S I U | | S I U | |
| `quests` | S I U | | | |
| `outbox` | I | S U D | | |
| `processed_events` | | | I | |
| `places` | S | | S | S I U |
| `tags` | S | | | S I U |
| `area_stats`, `area_totals` | S | | | S I D |
| `areas_ingested` | S | | | S I U |
| `jobs` | S I | | | S U |
| `checkin_attempts` | I (+ EXECUTE `prune_checkin_attempts()`) | | | |
| `TEMPORARY` on the database | | | | yes (revoked from PUBLIC) |

Two more login roles, outside the services: `larper_backup_check` (the hourly backup
check, no grant at all) and `larper_demo_reset` (migrations 0012 and 0013, the public
demo's nightly reset: S on `users` and `tags`, S D on `quests`, S I U on
`taste_profiles`, to delete the shared demo account's quests and put its taste back). Each has a connection limit of 1. The API keeps never deleting: check-in attempts past their
90 days go through `prune_checkin_attempts()` (migration 0014), a SECURITY DEFINER
function that deletes only those rows, not a DELETE grant.

S/I/U/D = SELECT/INSERT/UPDATE/DELETE. Why some cells are what they are:

- `SELECT … FOR UPDATE` needs UPDATE (relay on `outbox`, taste-worker on `taste_profiles`,
  ingest on `jobs`). An upsert (`ON CONFLICT DO UPDATE`) needs INSERT and UPDATE, and
  `RETURNING` needs SELECT: the API's outbox and job inserts don't use it, so it has no
  SELECT on `outbox`.
- Identity columns need no sequence grant, and foreign-key checks run as the referenced
  table's owner: the taste-worker writes `taste_profiles` rows without being able to read
  `users`. `roles.db.spec.ts` checks both.
- No role has DDL, TRUNCATE, REFERENCES or TRIGGER, column-level grants, sequence or
  function grants, memberships, or any role attribute but LOGIN.

### How the roles come to exist

Migration 0010 creates any that are missing (`NOLOGIN`) and makes the grants. CNPG's
managed roles (`spec.managed.roles`) then turn on LOGIN, set each password from its
Secret and set its connection limit. Either may come first: CNPG adopts a role the
migration created, and the migration skips one CNPG created, including one created
between its check and its `CREATE ROLE`. Roles and grants are versioned together and
ship in one release.

Creating a role needs CREATEROLE. The owner's own managed-role entry gives it
(`createrole: true`, no `passwordSecret`, so CNPG leaves `pg-app`'s password alone). On
Postgres 16+ that only lets `larper` create and administer roles, not grant itself
anything it doesn't have.

The catch is ordering on an existing cluster. Helm runs the pre-upgrade migrate Job
before it applies the Cluster change, so the first upgrade's migration would run before
CNPG gives `larper` CREATEROLE. A migration that fails halfway leaves golang-migrate
"dirty", needing a manual `force`. So:

- The migrate Job has an init container that waits until `larper` has CREATEROLE or the
  four roles all exist, and prints what to run while it waits. It gives up after
  `migrate.waitForRolesSeconds` (10 min) with the reason, and the Job has an
  `activeDeadlineSeconds` (`migrate.deadlineSeconds`, 20 min), so an upgrade fails
  instead of hanging.
- `scripts/pg-owner-createrole.sh` runs `ALTER ROLE larper CREATEROLE` as the superuser
  on an existing cluster. The up scripts (`up.sh`, `oci-up.sh`, `aks-up.sh`, `eks-up.sh`)
  run it before `helm upgrade`. It's a no-op on a fresh install and after the first
  upgrade, when CNPG keeps the attribute.

On a fresh install the migrate Job is post-install. CNPG creates the roles and gives
`larper` CREATEROLE in some order, and the wait covers the race.

### Passwords

The chart generates each role's password once (`templates/db-roles.yaml`, `lookup` keeps
it on upgrade), in the `kubernetes.io/basic-auth` form CNPG reads. Pods build
`DATABASE_URL` from the Secret's fields and the `pg-rw` host, and the kubelet expands the
password at container start, so it's never in a pod spec. A restore brings the roles back
and CNPG sets their passwords from whatever Secrets exist, so a rebuilt release with new
Secrets works too.

### Connection limits

Each role's `connectionLimit` comes from the profile's values (`postgres.roles`), next to
the pool size its pods use. The chart refuses to render when either holds:

- **A limit is below pool × the service's most pods.** The most pods are its replicas, or
  the HPA's max for the API, plus a rolling update's 25 % surge, plus one `load-places`
  run for ingest.
- **The limits plus `reservedConnections` exceed `max_connections`.**

EKS, for example: API max 6 + 2 surge = 8 pods × 10 = 80. The default and cloud profiles
raise `max_connections` to 150 to fit it. The demo profile keeps 50 and gives the API a
pool of 5.

### Tests

- **`apps/api/src/db/roles.db.spec.ts`:**
  - The grants in `information_schema` must equal a matrix in the test exactly. A new
    table or query fails it until both the migration and the matrix change.
  - Each role, logged in as itself, is refused DDL and the tables it shouldn't touch.
  - The identity-column and foreign-key rules above.
  - The statements the relay and taste-worker run, which have no tests of their own.
- **The services' own tests run as their roles:**
  - The API's DB specs run as `larper_api`.
  - The queue and stats tests run as `larper_ingest`.
  - Fixtures and cleanup, which need DELETE these roles don't have, use
    `TEST_OWNER_DATABASE_URL`.
- **CI's setup (`db/test/`):** a Postgres prepared the way CNPG prepares the stack's.
  CNPG creates two roles before the migrations run, and the migrations create the other
  two. CI then runs 0010 down and up again to prove it re-runs cleanly.

## Consequences

- **Every new table needs its grants in the migration that creates it**, and in the
  test's matrix. There are no default privileges, so a forgotten grant fails CI instead
  of granting too much.
- **Pruning will need DELETE.** `processed_events` and the `done` and `dead` rows in
  `jobs` grow without bound (audit item 7). Whichever role gets the pruning (probably the
  taste-worker for its own `processed_events`, and the ingest-worker or the relay for
  `jobs`) needs DELETE on that table. That gets granted in the migration that ships the
  pruning, not now: today no code deletes from either.
- **`max_connections` went from 100 to 150 on the default and cloud profiles.** Changing
  it restarts Postgres, once, on the first upgrade.
- **Per-role settings are possible.** For example,
  `ALTER ROLE larper_api SET max_parallel_workers_per_gather = 0` could replace the API
  pool's connection option. Not done here.
- **`pg-app` is only used by the migrate Job and the by-hand owner access.** `load-places`
  uses the ingest role's Secret (README).
