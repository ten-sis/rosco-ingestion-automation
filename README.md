# playwright-fr

## Prerequisites: four port-forwards and an optional DB tunnel

Nothing in this suite works until four `kubectl port-forward` processes are running. One command opens all of them against the Dv3A cluster, each under a supervisor that restarts it if kubectl drops, plus the read-only dv3 RDS tunnel:

```bash
scripts/tunnels.sh up        # --context <name> for another nonprod cluster, --no-db to skip the DB
scripts/tunnels.sh status
scripts/tunnels.sh down      # --keep-db to leave the DB tunnel open
```

The script refuses any kube context containing `prd` or `prod`. PIDs and logs are in `.runs/tunnels/`.

The webhook, scorecards and Digestion forwards default to local ports 8081, 3001 and 3002. Set `WEBHOOK_PORT`, `SCORECARDS_PORT` or `DIGESTION_PORT` in `.env` (or the shell) to move one. `scripts/tunnels.sh` opens the forward on that port and the suite calls it there. The backend-crud forward has no setting, because it must be 3000 (below). A full `WEBHOOK_BASE_URL`, `SCORECARDS_BASE_URL` or `DIGESTION_BASE_URL` still overrides the port when set.

The equivalent manual commands with the default ports (every one of these Services listens on port 80 in the cluster):

```bash
kubectl port-forward -n be-crud     svc/be-crud-v5       3000:80
kubectl port-forward -n integration svc/webhooks-api     8081:80
kubectl port-forward -n snc         svc/scorecard-v2-api 3001:80
kubectl port-forward -n ingestion   svc/digestion        3002:80
```

Every run starts with the read-only `connectivity` project (`tests/connectivity/`), which checks each tunnel, confirms the account name matches `EXPECTED_ACCOUNT_NAME`, and confirms the rosco integration and the FR licence are already on. Every other project depends on it, so a dead tunnel fails in seconds with the tunnel named. `npm run test:connectivity` runs only that gate; `npm run test:unit` runs the offline unit specs without it.

The backend-crud forward **must bind local port 3000 exactly**. The Host header `localhost:3000` is what puts the request onto backend-crud's intra-service path (`app/middleware/session.js`); binding any other local port silently breaks authentication, because the request then falls onto the public Cognito path instead and fails the public-host check for `localhost`. See "There is no login" below — the same no-token story covers all four services, not only backend-crud.

The third forward, `scorecard-v2-api`, is `hapi-server-scorecards`, which is where the threshold-event routes actually live (`POST /v2/threshold-events/search`, `POST /v2/threshold-events/transfer`) — not backend-crud, despite the `/v2/` path looking like it. `SCORECARDS_BASE_URL` defaults to `http://localhost:<SCORECARDS_PORT>` (3001) to match this forward.

The fourth forward is `hapi-plugin-digestion-api` (deployed as HelmRelease `digestion-api` / image `hapi-server-digestion-api` in `_tools/fluxcd-deployment/ingestion/digestion.yaml`). Its k8s Service name is `digestion`, not `digestion-api` — confirmed from three other services' own configmaps that already call it in-cluster at `http://digestion.ingestion.svc.cluster.local` with no port suffix (`geofence/realtime-geofencing-config.yaml`, `snc/scorecard-v2-config.yaml`, `parts/parts-config.yaml`), i.e. port 80. This is where the Rosco secondary-tracker resolution lives (AGENT-BRIEF non-obvious fact 2: the ingestion branch reads a `{secondaryTracker:<device_id>}` Redis key populated asynchronously after a tracker is created); `DIGESTION_BASE_URL` defaults to `http://localhost:<DIGESTION_PORT>` (3002) to match this forward, and `provisionAssetWithTennaCam` polls it before handing a run context to any scenario.

A fifth tunnel is optional, needed only for the SQL driver-events reader (`DRIVER_EVENTS_READER=sql`) and the SQL probes in `PLAN/05-VERIFICATION.md`:

```bash
scripts/tunnels.sh up    # includes it; or _tools/engineering-tools/scripts/db-tunnel.sh --environment dv3
# opens localhost:54334 (dv3 read replica)
```

Everything else in this file assumes the first four are already up.

## What this is

A Playwright acceptance suite for the Rosco Facial Recognition operation flow (TS-43579), covering the design doc's operation cases (registration and audit cases are out of scope). The feature is deployed on dv3, so a run exercises the real pipeline. Events are simulated: telemetry from a fixture TennaCAM and emulated Rosco payloads. See `PLAN/README.md` for the full documentation pack, `TRACEABILITY.md` for case-to-spec coverage, and `OUT-OF-SCOPE.md` for what is deliberately not automated.

## There is no login

This suite never authenticates. It reaches backend-crud over the intra-service path described above: every request carries a `requestor` header and an `account_id`, and carries **no `Authorization` header at all**. `user_id` falls back to `TENNA_MICROSERVICE_USER_ID`, the same identity the ingestion pipeline itself writes as. There is no Cognito user, no token, no impersonation call anywhere in this suite, and none should be added — doing so would flip the request onto the public Cognito branch, which then fails the localhost host check. `src/api/client.ts` implements this; there is no `src/auth/` and no `src/environments.ts`.

The threshold-event routes on `hapi-server-scorecards` declare `auth: 'jwt'` in their own source, but the proven service-to-service path — the one TrackIt itself uses to call the same service — carries no token either, only the same `requestor` and `account_id` headers. `src/api/client.ts`'s `serviceCall` method reuses those headers against `SCORECARDS_BASE_URL` for exactly this reason, so threshold-event calls need no separate credential story from everything else in this suite.

## Guardrail: this suite never points at production

Every scenario writes to a real account. `ENV` in `.env` is a label only (used in fixture names and the run manifest) — it does not choose which cluster you hit, that is whatever your port-forwards are bound to and what `CRUD_BASE_URL`/`WEBHOOK_BASE_URL`/`SCORECARDS_BASE_URL`/`DIGESTION_BASE_URL` resolve to. `src/env.ts`'s `assertNotProduction` runs against `ENV` and every one of those URLs on access, and rejects `prd`/`prod`/`production` and lookalike substrings (`.prd.`, `rds.amazonaws.com`, ...); `assertIntraServiceHost` separately requires `CRUD_BASE_URL` to be exactly `localhost:3000`, which only a nonprod port-forward can ever be. `ALLOW_MUTATIONS` must be set to `1` explicitly before any test runs, on top of that. If you are looking at this file wondering whether it is safe to point at production: it is not, do not bypass these guards to make it work anyway, and do not add a `prd` value anywhere they check.

## Setup

```bash
npm install
cp .env.example .env
# fill in ACCOUNT_ID at minimum
```

The target account needs `account_integrations.partner = 'rosco'`. The preflight step flips the facial-recognition licence (`TennaCAM Facial Recog`) to enabled through the API before any scenario runs, but it can only flip an existing row: `POST /v4/account-licenses` cannot safely create the first one (`account_license/v4/controller.js:31-39` needs `req.session.account_id`, which the intra-service bypass never sets), so the account must already carry an `account_licenses` row for this licence, in any state, before this suite touches it. Someone with Tenna-account credentials seeds that row once per test account; preflight throws an actionable error if it is missing (`PLAN/06-BLOCKERS.md`).

## One asset per spec file, and files run in parallel

Each spec file hardcodes a fleet name, and that fleet's asset is provisioned once for the file and reused by every scenario in it. Files run in parallel across workers (`fullyParallel: false`, `workers > 1`); scenarios inside a file stay serial, because the trip-recency guard is asset-scoped and two concurrent trips on one asset would make the suite lie. Fleets: `fr-live`, `fr-trip-lookup`, `fr-trip-lookup-gaps` (O12c and O6, split out so their long start waits run in parallel), `fr-delayed`, `fr-guards`, `fr-race`, `fr-licence`, `fr-phase2`. The default is 6 workers (`PW_WORKERS`), one per scenario file.

### Assets are reused across runs

Each fleet has one asset per account, and every run reuses it. Provisioning looks the asset up by its fleet number, `[FRTest]-<fleet>` (for example `[FRTest]-fr-live`), and reuses the fixture TennaCAM already installed on it. It creates the asset or the tracker only when it's missing. A second asset for a fleet is `[FRTest]-<fleet>-secondary`. So a new run, a worker restarted after a failed test, or a run the next day all land on the same asset. At setup, provisioning clears the asset's assignee and closes a trip an earlier run left open.

Two exceptions:

- `fr-phase2` creates new assets every time, because O21 needs an asset's very first trip.
- Set `FIXTURE_NAMESPACE` (for example to your initials) to get your own set, `[FRTest]-<namespace>-<fleet>`. Do this if someone else may run the same fleets on the same account at the same time, since you'd otherwise share one asset.

If an asset has a tracker installed that this suite didn't create, provisioning stops rather than drive telemetry through a real device. Background and design are in `PLAN/07-ASSET-REUSE.md`.

`ACCOUNT_ID` and `ASSET_ID` in `.env` apply to the whole run. `ASSET_ID_<FLEET>` and `ACCOUNT_ID_<FLEET>` (fleet name upper-cased, non-alphanumerics replaced by underscores — e.g. `ASSET_ID_FR_LIVE`) pin a single suite, for iterating on one file without disturbing the others. `EXPECTED_ACCOUNT_NAME_<FLEET>` follows the same pattern and is **required** for `fr-licence`: that fleet always runs on `ACCOUNT_ID_FR_LICENCE`, a different account from the shared `ACCOUNT_ID`, so it has a different real name and can never pass the environment-identity check against the global `EXPECTED_ACCOUNT_NAME` alone.

## Fixtures and the play utility

Where a scenario's case id has a matching file under `fixtures/*.json`, that fixture is the single source of truth for its trip and its identifications; the scenario itself carries only preconditions and expectations. The format is `src/fixture/types.ts`: one fixture is one trip plus a `driver_identifications` array, with two clocks on every entry (`atSec`, the logical offset stamped into the payload; `deliverAtSec`, when it is actually sent, defaulting to `atSec`) and three delay modes for the trip's own events (`none`, `full-burst`, `partial-burst`). Three canonical examples exist: `fixtures/O2-live-open-trip.json`, `fixtures/O3.1-delayed-trip-different-driver.json`, `fixtures/O3.3-partially-delayed-trip.json`.

`tools/play.ts` runs any fixture by hand, against a real asset, independent of the test suite:

```bash
npx tsx tools/play.ts --fixture <id> --account <uuid> --asset <uuid> --serial <gms> --vehicle <device> [--dry-run] [--list]
```

## Trips are short and live

Two to five minutes, never longer (`MAX_TRIP_SECONDS` in `src/constants.ts`). A live trip anchors its own start at now and plays forward while the test runs, with a telemetry frame (`ON_PERIODIC` or another GMS event) at least every 58 seconds (`PING_INTERVAL_SECONDS`), so the tracker is never seen as gone quiet.

## Run commands

```bash
# everything except phase 2 (the trip-start consumer, not part of the initial deployment)
ACCOUNT_ID=<id> ALLOW_MUTATIONS=1 npm run test:all

# just the live-identification cases
npm run test:live

# just the cases that wait past the scorecard backfill cron's 5-minute run
npm run test:slow

# the phase-2 trip-start consumer cases, once that consumer is built
npm run test:phase2

# everything, unfiltered
npm test

# type-check only, no environment needed
npm run typecheck

# list every scenario Playwright would run, no environment needed
npm run lint:dryrun

# the HTML report from the last run
npm run report
```

Every run that includes scenarios also writes `.runs/summary-<timestamp>.md` (gitignored): each case with the design doc's own case and expected outcome, what the scenario asserts, the result, and for a failure the step or checkpoint it failed at. It ends with the doc cases that have no scenario. `src/reporting/summaryReporter.ts` writes it.

## Event timestamps and delivery

Every event is stamped `t0 + atSec`, and `t0` is set just after each scenario's preconditions (`anchorTimeline` in `src/scenario/runner.ts`). No event is sent before the time it claims. The consumer skips the asset write when the standing assignment is newer than the identification's own timestamp (the design doc's O7 rule), so every identification has to be stamped after the precondition's assignment. A scenario that sends a delayed trip in a burst waits first, until the trip's backdated timestamps all land after its preconditions. That's up to about 10 minutes for O6 and O12c, and it's logged.

## Current state (2026-09-28, Dv3A)

This is what a real run against the Dv3A cluster does today.

### Default run: read-only, green

`npm run test:all` without `ALLOW_MUTATIONS` runs 51 tests: 50 pass and 1 is skipped. The 7 `connectivity` tests go first, then the 44 offline `unit` tests. The skipped one is the DB check, which only runs when `DB_URL` is set or `DRIVER_EVENTS_READER=sql`. A green default run proves every tunnel is up, the account is the expected one, and the account already has the rosco integration and an active FR licence. It exercises none of the facial-recognition pipeline. With a tunnel down, the matching connectivity test fails in milliseconds with the tunnel named, and every other test is reported as "did not run".

### Mutating run

With `ALLOW_MUTATIONS=1`, preflight provisions for real on the `[FRTest]-fr-setup` asset. The first time, it creates the asset, creates a TennaCAM 2.0 tracker with a fixture Rosco `vehicle_id`, links it to the account, installs it on the asset and verifies it. Later runs reuse all of that. Either way it waits for Digestion to resolve the camera (a couple of seconds on dv3). Each fleet has its own four driver contacts, `[FRTest]-<fleet> Driver` Alpha to Delta, also created once and reused. They're per fleet so a scenario that deactivates a driver (O8, O8b) can't affect a file running in parallel.

Runs before 2026-09-28 reported most asset-assignee expectations as "the pipeline never acted". That was a harness bug, not the feature: the runner stamped every event before the scenario's preconditions, so the consumer correctly skipped every asset write as older than the standing assignment. See "Event timestamps and delivery" above.

### Known product gaps seen on dv3

- `EMITTER=becrud` now targets `POST /v5/rosco-driver-events/publish`, which carries Type 6 and Type 7 (`POST /v5/rosco-events/publish` never will). It has not been run from this suite against dv3 yet, so `EMITTER=webhook` is still the proven path.
- The facial-recognition licence row itself cannot be created from here (see Setup, above); an account with no `account_licenses` row for it at all fails preflight rather than the suite creating one.

### Known assumptions still open (`PLAN/06-BLOCKERS.md`)

- **Contact status on a driver-event row.** There is no `contact_active` column. The consumer records a contact already disabled at insert as `flags.contact_is_active: false`, and the readers derive `contact_active` from that. A contact deactivated after its row is written is caught by the trip-end guard's live re-check, not by the row (O8). O8b covers a contact already disabled when the identification arrives.
- **O17's identification is stamped ahead of when it is sent.** The scenario compresses a multi-day trip into minutes but keeps the day-two identification's `atSec` at 93600 (about 26 hours after the trip's own anchor) so it stays recognisably "day two." Every other fixture in the suite stamps at or behind its delivery time; O17 is the one deliberate exception, kept because backdating the trip itself would collide with the trip-recency guard on the shared asset.

### Harness fixes made against the live environment

Each of these was hidden until the suite first ran against a real cluster, and each one blocked every scenario.

- The backend-crud Service listens on port 80, so the forward is `3000:80`. The docs used to say `3000:3000`, which cannot bind.
- The dv3 DB tunnel listens on local port 54334, not 54200.
- dv3 names the licence `TennaCAM Facial Recog.` with a trailing period, and returns the join as an `account_licenses` array. Licence lookups now ignore trailing periods (`licenceNameMatches`).
- `POST /v5/assets` requires `category_id` and a `fleet` number that is unique on the account. The category comes from `ASSET_CATEGORY_ID` when set, otherwise it is borrowed from an existing asset on the account.
- `PATCH /v5/tracker-asset-associations/:id/verify` requires `{ certification_passed: true }`.
- Digestion's `GET /trackers?make=rosco&serial=<vehicle_id>&include=secondary` puts `asset_id`/`account_id` on the primary tracker row, not inside `secondaryTracker`. The old parser never saw a resolved camera and timed out after 180 seconds.

### Pinning an asset

`ASSET_ID` / `ASSET_ID_<FLEET>` uses that asset instead of the fleet's own. Its fixture TennaCAM is reused if one is installed, and one is created if not. A pinned asset with a real tracker installed is refused.

### Cleanup

Reuse keeps the count steady at one asset per fleet (plus `-secondary` assets and `fr-phase2`'s fresh ones), but nothing deletes fixtures automatically. Each run's manifest under `.runs/[FRTest]-*.json` (gitignored) lists every fixture it used, with `"reused": true` on the ones it found rather than created. Assets from before reuse was added have names like `[FRTest]-fr-live-[FRTest]-1790300381973` and are never picked up again.

## Layout

```
playwright-fr/
  playwright.config.ts      ENV-driven; fullyParallel: false, workers > 1; projects: connectivity -> unit, preflight -> operation
  scripts/tunnels.sh        opens, checks and closes the port-forwards and the DB tunnel
  src/
    scenario/types.ts        the Scenario contract (do not edit)
    fixture/types.ts          the Fixture contract (do not edit)
    types.ts                 shared domain types (do not edit)
    scenarios/*.ts            one file per O-case family, each exporting a readonly Scenario[]
    ...                       api/, emit/, read/, db/, fixtures/ (modules A-D)
  fixtures/                  JSON fixtures, one file per fixture-driven case
  tools/play.ts               stand-alone fixture player
  tests/
    connectivity/services.spec.ts  connectivity/account-readiness.spec.ts   read-only gate
    setup/provision.spec.ts
    o-live.spec.ts  o-trip-lookup.spec.ts  o-trip-lookup-gaps.spec.ts  o-delayed.spec.ts  o-guards.spec.ts
    o-race.spec.ts  o-licence.spec.ts  o-phase2.spec.ts
  PLAN/                       the full documentation pack; start at PLAN/README.md
  TRACEABILITY.md  OUT-OF-SCOPE.md
```
