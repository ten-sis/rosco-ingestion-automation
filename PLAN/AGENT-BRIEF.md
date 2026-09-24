# Agent brief — TS-43579 facial-recognition operation suite

## REVISION 2 — read this before anything below

The sections after this one are still accurate about the pipeline and the domain. Where they
disagree with this revision, this revision wins.

### 1. There is no authentication. Do not write any.

backend-crud takes the intra-service branch when a request carries NO Authorization header, has a
Host header in `INTRA_SERVICE_REQUEST_HEADER_HOSTS`, and carries a `requestor` header
(`app/middleware/session.js:21-35,60-65`). `localhost:3000` is in that allowlist
(`fluxcd-deployment/be-crud/be-crud-v5.yaml:177-178`), so a `kubectl port-forward` bound to LOCAL
PORT 3000 reaches it with no Cognito and no impersonation token. The session comes from the
`requestor` and `account_id` headers; `user_id` falls back to `TENNA_MICROSERVICE_USER_ID`, the
same identity the ingestion pipeline writes as.

`src/api/client.ts` is written and does this. There is no `src/auth/` and no `src/environments.ts`.
Never add an Authorization header: it would flip the request onto the Cognito branch, which then
fails the public-host check for localhost.

### 2. The operator brings the tunnels up, not the suite.

Two port-forwards, documented at the TOP of README.md as prerequisites:
`kubectl port-forward -n be-crud svc/be-crud-v5 3000:3000` and
`kubectl port-forward -n integration svc/webhooks-api 8081:80`. The backend-crud one must bind
local port 3000 exactly. A third, the DB tunnel, is needed only for the SQL reader.

### 3. Fixtures are JSON files.

One fixture is one file under `fixtures/`. It holds a trip with all of its events and a separate
`driver_identifications` array. The contract is `src/fixture/types.ts`, which is written and must
not be edited. Three canonical examples exist: `fixtures/O2-live-open-trip.json`,
`fixtures/O3.1-delayed-trip-different-driver.json`, `fixtures/O3.3-partially-delayed-trip.json`.

Two clocks on every entry: `atSec` is the logical offset stamped into the payload, `deliverAtSec`
is when it is actually sent and defaults to `atSec`. Delay modes rewrite delivery for the trip's
own events only: `none`, `full-burst` (whole trip sent back to back from `burstStartAtSec`), and
`partial-burst` (events up to `burstThroughAtSec` burst, the rest live from there).

### 4. Trips are short and live by default.

Two to five minutes, never longer (`MAX_TRIP_SECONDS`). A live trip anchors `atSec: 0` at now and
plays forward while the test runs. Emit at least one `ON_PERIODIC` every 58 seconds
(`PING_INTERVAL_SECONDS`) so the tracker is never seen as gone quiet.

### 5. One asset per spec file, and files run in parallel.

Each spec file hardcodes a fleet name, and that fleet owns one asset provisioned once for the file
and reused by every scenario in it. `workers` is 4 and `fullyParallel` is false: files run
concurrently, scenarios inside a file stay serial because the trip-recency guard is asset-scoped.
Group related scenarios into as few suites as possible so as few assets and trackers are created
as possible. Suites: `fr-live`, `fr-trip-lookup`, `fr-delayed`, `fr-guards`, `fr-race`,
`fr-licence`, `fr-phase2`.

`ACCOUNT_ID` and `ASSET_ID` are accepted for the whole run, and per suite as `ASSET_ID_<FLEET>` and
`ACCOUNT_ID_<FLEET>`. `src/env.ts` exports `suiteAssetId(fleet)` and `suiteAccountId(fleet)`.

### 6. Trackers are associated and verified through the API only.

`POST /v5/tracker_account_associations`, then `POST /v5/tracker-asset-associations`, then
`PATCH /v5/tracker-asset-associations/:id/verify`. No SQL, no UI.

### 7. Validate through the API. SQL is the exception.

`DRIVER_EVENTS_READER` defaults to `api`. The SQL reader stays as a fallback for what the API
cannot answer, and a scenario that needs it skips with a message when `DB_URL` is unset.

### 8. Resolved open items.

- O14 is no longer contested. The trip-end search window is floored at the TRIP START, not at the
  previous trip's end. An identification timestamped before its trip started is therefore outside
  the window, is not linked, and changes no assignee. Encode exactly that and drop the
  `@contested` tag.
- O20 moves to `OUT-OF-SCOPE.md`. The audit catches a lost publish and the team reacts to it.
- Digestion's Redis propagation delay is not a concern. Keep the readiness poll, drop the warnings.
- The preflight spec must call the API to ensure the facial recognition licence is enabled, not
  merely report that it is missing.
- `POST /v5/rosco-events/publish` is EXPECTED to carry Types 6 and 7 but does not today: its
  schema requires `event_id` and pins `name` to the enum `["events"]`. Record this in
  `PLAN/06-BLOCKERS.md` as a backend change to be made, owned by the feature team.

### 9. A play utility, usable by hand.

`tools/play.ts` runs one fixture from the command line against an asset, and the scenario runner
uses the same code path. It must be genuinely usable standalone, with `--dry-run`.

Read this in full before writing a line. It is the shared context for every build agent, and it is the reason parallel work does not drift.

## What is being built

A Playwright project that drives the Rosco Facial Recognition **operation** flow end to end against a nonprod Tenna environment, covering the permutation space in the design doc's Developer Test Plan (cases O1 to O24). Registration (R) and audit (A) cases are out of scope.

**Nothing in the feature is implemented yet.** A monorepo search for `rosco_driver_events`, `driver-ident` and `driver-events` returns nothing outside the design folder. The suite is an executable acceptance spec written ahead of the code. Most tests will fail until the feature ships, and that is the intended state.

**Do not run anything against a real environment.** Not `playwright test`, not a curl against dv3, not a database connection. `npm install`, `npx tsc --noEmit` and `npx playwright test --list` are the only commands you may run. If a design question can only be settled by a live call, write the code to the design doc and leave a `// VERIFY:` comment naming what must be confirmed on the first real run.

## The pipeline under test

```
Rosco camera
   -> Rosco cloud
   -> POST /rosco            hapi-plugin-webhooks, auth:false, publishes verbatim
   -> ros.{h}.{h}.raw-events on exchange too_ti
   -> rosco-ingestion-rmq    NEW additive branch for name=identDrv|unDrv
   -> ros.{h}.{h}.driver-events
   -> NEW identification consumer
        1 get tracker (digestion)  2 get contact  3 covering-trip lookup
        4 claim the trip  5 persist the row  6 asset assignee + trip assignee
        6.3 publish ros.{h}.{h}.driver-trip-assignee
   -> live-events processor-scorecard updates the cached trip assignee
```

Plus a **NEW trip-end consumer** on `asset.#.#.trip-ended` that links rows flow 1 could not link, sets the assignees under the same guards, and re-assigns the trip's threshold events.

`{h}.{h}` is the two-character md5 hash of the device serial: `md5(vehicle_id)[0]` and `md5(vehicle_id)[1]`, joined by dots. Source: `js-models/src/rmq/standardHashTemplateObject.js:11-19,137-149`.

## The four write guards (what most cases actually test)

| Guard | Rule |
|---|---|
| The claim | Exactly one identification per trip becomes the assignee source. Advisory lock on (account, trip), partial unique index as backstop |
| Trip recency | Before the **asset** write, if this row's own trip is already closed, look for a later normal trip on the same asset. If one exists, skip the asset write |
| Trip-driver write | Write the trip assignee only when it is null or already equals the intended contact. Anything else is a manual correction and is never reverted |
| Contact status | Re-check the winning contact's live `enabled` and `deleted_at`. Inactive or deleted skips the asset write, the trip write and the re-assignment |

The asset-assignee comparison uses `received_at`, not the event `timestamp`, because the event timestamp is device-side and carries clock skew.

## Endpoints, with citations

All public calls go to `https://services.api.<env>.cloud.tenna.com/be-crud/<path>`. The gateway maps `/be-crud/v5` to the app's `/api/v5`.

### Emission

| What | Call | Notes |
|---|---|---|
| **Primary emitter** | `POST http://localhost:8081/rosco` over `kubectl port-forward -n integration svc/webhooks-api 8081:80` | `auth: false`. Body needs only `vehicle_id`. Published verbatim to `ros.{h}.{h}.raw-events` on exchange `too_ti`. Source: `hapi-plugin-webhooks/src/handlers/roscoHandler.js:173-212`, publish at `:64` |
| Public webhook URL | `https://<host>/integration/v1/webhooks/rosco` | **Unreachable.** Istio allowlists 13 Rosco egress IPs (`fluxcd-deployment/integration/webhooks.yaml:63-78`). Do not build against it |
| **Secondary emitter** | `POST /api/v5/rosco-events/publish` | Proxies to `/rosco` in-cluster (`backend-crud/app/modules/rosco_events/v5/service.js:514-534`). Needs super/admin **and** `tenna.microservices.manage`. **Blocked today**: schema requires `event_id` and pins `name` to `["events"]`. Write the client anyway, behind `EMITTER=becrud` |
| **Trips and telemetry** | `POST /api/v5/automation-tracker` | `permission(["super","admin"])`. Publishes the body to exchange `too_ti` with routeKey `gms.<md5(esn)[0]>.<md5(esn)[1]>`. Schema requires only `options.esn`. Source: `backend-crud/app/modules/automation-tracker/v1/index.js:12`, controller `:22-41`, schema `schema.js:3-15` |

**Read `claude-tasks/TS-13509-timezone-inventory/overnight-dst-trips/play_trip.sh` and its `csv/` directory before writing the telemetry emitter.** It is a working GMS frame replayer against this exact endpoint and it is the reference for frame shape and ordering. Also read `utility-test-driver/src/components/trip-builder-new/trip-builder.tsx` and `src/services/events.ts` for how frames are built per tracker model (`TennaCAM 2.0` + model `TCM-ROGM-05` selects the `845F` frame format).

### Fixtures

| What | Call | Permission |
|---|---|---|
| Create asset | `POST /api/v5/assets` | `assets.asset.create` |
| Search assets | `POST /api/v5/assets/search` | scoped |
| Read asset | `GET /api/v5/assets/:id?include=contacts` | — |
| Patch asset assignee | `PATCH /api/v5/assets/:id` | body must be **exactly** `{"contacts":{"assignee":"<id>"}}` |
| Create tracker | `POST /api/v5/trackers` (array body, returns id array) | `tenna.tracker.manage` |
| Patch tracker | `PATCH /api/v5/trackers/:id` | sets `secondary_tracker_serial_number`, `secondary_tracker_data.device_id` |
| Tracker to account | `POST /api/v5/tracker_account_associations` (array body) | `tenna.warehouse.manage` |
| Install on asset | `POST /api/v5/tracker-asset-associations` (array body) | `assets.trackers.create` |
| Create contact | `POST /api/v5/contacts` | MANAGE_SETTINGS |
| Search contacts | `POST /api/v5/contacts/search` | before the gate |
| **Patch contacts** | `PATCH /api/v5/contacts` | **no id segment, array body, id inside each element** |
| Search trips | `GET /api/v5/trips` with query filters | **There is no `POST /v5/trips/search`** |
| Read trip | `GET /api/v5/trips/:id` | — |
| Create / patch trip | `POST /api/v5/trips`, `PATCH /api/v5/trips/:id` | `tenna.microservices.manage` |
| Contact assignments | `GET /api/v6/contact-assignments` | reading when the standing assignee was set |
| Threshold events | `POST /v2/threshold-events/search`, `POST /v2/threshold-events/transfer` | transfer body is `[{contactId, thresholdEventId}]` |
| Raw rosco events | `POST /api/v5/rosco-events/search` | registered **before** the microservices gate, so normal perms |
| Impersonate | `POST /api/v4/impersonate` with `{account_id}` then send the `impersonatetoken` header | — |

### Auth

Cognito `USER_SRP_AUTH`, and the **ID token** (not the access token) is sent as `Authorization: Bearer`. Per-environment `client_id` and `pool_id` are in `_tools/utility-test-driver/src/environments.json`; copy them into `src/environments.ts`. Reference implementation: `utility-test-driver/src/services/auth.ts:17-54` and `src/services/http.ts:15-32`.

Use `amazon-cognito-identity-js` (`CognitoUserPool`, `CognitoUser.authenticateUser`) rather than Amplify, so nothing browser-shaped is pulled in. Handle the `newPasswordRequired` and MFA callbacks by failing with an actionable message rather than hanging.

## Non-obvious facts that will otherwise cost a day each

1. **A TennaCAM 2.0 is not a Rosco tracker.** It is a Geometris primary tracker, type `TennaCAM 2.0`, model `TCM-ROGM-05`, whose *secondary* tracker is the Rosco camera. `secondary_tracker_data.device_id` is the Rosco `vehicle_id`. There is no tracker make `rosco` in any enum (`js-models/src/enumerations/trackerMakers.js:3-25`). Model fields: `backend-crud/app/db/models/Tracker.js:128-133`.

2. **Digestion's Redis key gates everything.** The ingestion branch resolves the device through `getTrackerMetaByMakeSerial({make:'rosco', serial:<device_id>, include:'secondary'})`, which reads the Redis key `{secondaryTracker:<device_id>}` (`hapi-plugin-digestion-api/src/helpers/index.js:49`). That key is populated asynchronously after the tracker is created. An identification injected before it exists is **silently acked and dropped** (`rawEvents.ts:83-91`). Provisioning must poll Digestion until the device resolves, with a hard timeout and a failure message that names this exact cause. This is the most likely reason for a test that passes while doing nothing.

3. **Type 6/7 carry no `event_id`.** Today's ingestion rejects any raw event missing one (`rawEvents.ts:52`, `REQUIRED_KEYS = ['vehicle_id','event_id']`). The new branch generates it as `uuidv5(FR_NAMESPACE, vehicle_id|event.name|normalizedTimestamp|driver_guid ?? '')`, where `normalizedTimestamp` is `YYYY-MM-DDTHH:mm:ss.SSSZ` in UTC. The suite must emit the **same normalised timestamp string** on a redelivery, or O16 tests nothing.

4. **`driver_guid` is the Tenna Contact UUID.** That is the join between Rosco's world and ours.

5. **`account_integrations.partner = 'rosco'`** is account-scoped, free text, no enum. Without it the webhook path rejects the account.

6. **The asset PATCH body must carry exactly one key.** The permission-schema validator picks the first matching schema and permission pair, so bundling anything alongside `contacts.assignee` falls through to a general-update branch that demands a different permission.

7. **Absent and `false` are the same** for every key in the `flags` JSONB. Assertions must normalise.

8. **Threshold-event re-assignment has no same-assignee guard**, and it stamps `transferred_by_id`. Selection must exclude events already naming the identified driver, and must filter `transferred_by_id IS NULL OR = the FR service user`.

## Module ownership

Do not create or edit a file outside your own list. If you need something from another module, import it from the path below and assume the contract in `src/types.ts` and `src/scenario/types.ts`, which are already written and **must not be edited**.

| Module | Files | Depends on |
|---|---|---|
| **A. Foundation** | `src/env.ts`, `src/environments.ts`, `src/auth/cognito.ts`, `src/auth/impersonate.ts`, `src/api/client.ts`, `src/constants.ts` | types |
| **B. Resource clients** | `src/api/{assets,trackers,contacts,trips,thresholdEvents,roscoEvents,digestion,licences}.ts` | A, types |
| **C. Emitters and readers** | `src/emit/{webhook,becrud,telemetry,index}.ts`, `src/read/driverEvents.ts`, `src/db/pool.ts`, `src/hash.ts` | A, B, types |
| **D. Runner and fixtures** | `src/scenario/{runner,waits,timeouts}.ts`, `src/fixtures/{provision,manifest,test}.ts` | A-C, scenario/types |
| **E. Scenarios and docs** | `tests/**`, `src/scenarios/*.ts`, `PLAN/*.md`, `TRACEABILITY.md`, `OUT-OF-SCOPE.md`, `README.md` | all |

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess` on. No `any` without a comment saying why.
- Immutable: build new objects, never mutate an argument.
- Files under 400 lines, functions under 50.
- Every exported function gets a one-line doc comment saying what it does, not how.
- Errors are explicit. A failed API call throws with the method, path, status and response body, truncated to 500 characters. Never swallow.
- No `waitForTimeout`. Every wait is `expect.poll` against a named constant from `src/scenario/timeouts.ts`.
- No hardcoded ids, hosts or credentials. Everything comes from `src/env.ts`.
- Anything unverifiable without a live call gets a `// VERIFY: <what to confirm>` comment.
