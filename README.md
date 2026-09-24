# playwright-fr

## Prerequisites: four port-forwards, run by the operator

Nothing in this suite works until four `kubectl port-forward` processes are running. The operator brings these up before running anything; the suite never starts them itself and fails with an actionable message if they are missing.

```bash
kubectl port-forward -n be-crud     svc/be-crud-v5       3000:3000
kubectl port-forward -n integration svc/webhooks-api     8081:80
kubectl port-forward -n snc         svc/scorecard-v2-api 3001:80
kubectl port-forward -n ingestion   svc/digestion        3002:80
```

The backend-crud forward **must bind local port 3000 exactly**. The Host header `localhost:3000` is what puts the request onto backend-crud's intra-service path (`app/middleware/session.js`); binding any other local port silently breaks authentication, because the request then falls onto the public Cognito path instead and fails the public-host check for `localhost`. See "There is no login" below — the same no-token story covers all four services, not only backend-crud.

The third forward, `scorecard-v2-api`, is `hapi-server-scorecards`, which is where the threshold-event routes actually live (`POST /v2/threshold-events/search`, `POST /v2/threshold-events/transfer`) — not backend-crud, despite the `/v2/` path looking like it. `SCORECARDS_BASE_URL` defaults to `http://localhost:3001` to match this forward.

The fourth forward is `hapi-plugin-digestion-api` (deployed as HelmRelease `digestion-api` / image `hapi-server-digestion-api` in `_tools/fluxcd-deployment/ingestion/digestion.yaml`). Its k8s Service name is `digestion`, not `digestion-api` — confirmed from three other services' own configmaps that already call it in-cluster at `http://digestion.ingestion.svc.cluster.local` with no port suffix (`geofence/realtime-geofencing-config.yaml`, `snc/scorecard-v2-config.yaml`, `parts/parts-config.yaml`), i.e. port 80. This is where the Rosco secondary-tracker resolution lives (AGENT-BRIEF non-obvious fact 2: the ingestion branch reads a `{secondaryTracker:<device_id>}` Redis key populated asynchronously after a tracker is created); `DIGESTION_BASE_URL` defaults to `http://localhost:3002` to match this forward, and `provisionAssetWithTennaCam` polls it before handing a run context to any scenario.

A fifth tunnel is optional, needed only for the SQL driver-events reader (`DRIVER_EVENTS_READER=sql`) and the SQL probes in `PLAN/05-VERIFICATION.md`:

```bash
_tools/engineering-tools/scripts/db-tunnel.sh --environment dv3
# opens localhost:54200
```

Everything else in this file assumes the first four are already up.

## What this is

A Playwright acceptance suite for the Rosco Facial Recognition operation flow (TS-43579), covering design-doc cases O1 to O24 (registration and audit cases are out of scope). Nothing in the feature is implemented yet; most tests are expected to fail until it ships. See `PLAN/README.md` for the full documentation pack, `TRACEABILITY.md` for case-to-spec coverage, and `OUT-OF-SCOPE.md` for what is deliberately not automated.

## There is no login

This suite never authenticates. It reaches backend-crud over the intra-service path described above: every request carries a `requestor` header and an `account_id`, and carries **no `Authorization` header at all**. `user_id` falls back to `TENNA_MICROSERVICE_USER_ID`, the same identity the ingestion pipeline itself writes as. There is no Cognito user, no token, no impersonation call anywhere in this suite, and none should be added — doing so would flip the request onto the public Cognito branch, which then fails the localhost host check. `src/api/client.ts` implements this; there is no `src/auth/` and no `src/environments.ts`.

The threshold-event routes on `hapi-server-scorecards` declare `auth: 'jwt'` in their own source, but the proven service-to-service path — the one TrackIt itself uses to call the same service — carries no token either, only the same `requestor` and `account_id` headers. `src/api/client.ts`'s `serviceCall` method reuses those headers against `SCORECARDS_BASE_URL` for exactly this reason, so threshold-event calls need no separate credential story from everything else in this suite.

## Guardrail: this suite never points at production

Every scenario writes to a real account. `ENV` in `.env` selects `dv2`, `dv3`, `qa1`, `demo` or `stg`; there is no `prd` option, and none should ever be added. `ALLOW_MUTATIONS` must be set to `1` explicitly before any test runs, on top of that. If you are looking at this file wondering whether it is safe to point at production: it is not, do not add the environment, and do not bypass the mutation guard to make it work anyway.

## Setup

```bash
npm install
cp .env.example .env
# fill in ACCOUNT_ID at minimum
```

The target account needs `account_integrations.partner = 'rosco'`. The facial-recognition licence (`TennaCAM Facial Recog`) is enabled by the preflight step through the API before any scenario runs; it is no longer a manual step or an open question, so nothing needs enabling by hand.

## One asset per spec file, and files run in parallel

Each spec file hardcodes a fleet name, and that fleet's asset is provisioned once for the file and reused by every scenario in it. Files run in parallel across workers (`fullyParallel: false`, `workers > 1`); scenarios inside a file stay serial, because the trip-recency guard is asset-scoped and two concurrent trips on one asset would make the suite lie. Fleets: `fr-live`, `fr-trip-lookup`, `fr-delayed`, `fr-guards`, `fr-race`, `fr-licence`, `fr-phase2`.

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

## What "red" means right now

Almost everything. `tests/setup/provision.spec.ts` is the one spec expected to pass today, because it only touches endpoints that already exist. Every `o-*.spec.ts` file is expected to fail until its blockers in `PLAN/06-BLOCKERS.md` ship — most immediately, `POST /v5/rosco-events/publish` still cannot carry a Type 6 or Type 7 event, so `EMITTER=webhook` over the port-forward (the default) is the only working emission path until that schema widens. `PLAN/02-BUILD-STEPS.md` has the three-question triage for telling a red-because-absent test apart from a red-because-broken one before filing anything as a regression.

## Layout

```
playwright-fr/
  playwright.config.ts      ENV-driven; fullyParallel: false, workers > 1; projects: preflight -> operation
  src/
    scenario/types.ts        the Scenario contract (do not edit)
    fixture/types.ts          the Fixture contract (do not edit)
    types.ts                 shared domain types (do not edit)
    scenarios/*.ts            one file per O-case family, each exporting a readonly Scenario[]
    ...                       api/, emit/, read/, db/, fixtures/ (modules A-D)
  fixtures/                  JSON fixtures, one file per fixture-driven case
  tools/play.ts               stand-alone fixture player
  tests/
    setup/provision.spec.ts
    o-live.spec.ts  o-trip-lookup.spec.ts  o-delayed.spec.ts  o-guards.spec.ts
    o-race.spec.ts  o-licence.spec.ts  o-phase2.spec.ts
  PLAN/                       the full documentation pack; start at PLAN/README.md
  TRACEABILITY.md  OUT-OF-SCOPE.md
```
