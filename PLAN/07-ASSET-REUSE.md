# Reusing fixture assets across runs

## Why

Right now every run adds new `[FRTest]` assets and TennaCAM trackers to the account, and nothing removes them. One evening of iterating on dv3 (2026-09-24, 20:34 to 21:52) left 48 of them:

| Fleet | Assets |
|---|---|
| fr-guards | 15 |
| fr-setup | 11 |
| fr-live | 8 |
| fr-trip-lookup | 7 |
| fr-phase2 | 5 |
| fr-delayed | 1 |
| fr-race | 1 |

Three things drive the count:

1. **Every provisioning call makes a new asset.** `provisionAssetWithTennaCam` (`src/fixtures/provision.ts`) names the asset `[FRTest]-<fleet>-<runId>` and creates it fresh unless `ASSET_ID` is pinned. It never looks for an existing one.
2. **A failed test makes another asset.** The run id is kept in memory per worker (`src/fixtures/manifest.ts`, `currentRunId`), and the `fr` fixture is set up once per worker (`src/fixtures/test.ts`). When a test fails, Playwright throws that worker away and starts a new one. The new worker gets a new run id and provisions a new asset partway through the file. Almost every scenario fails today, so this multiplies the count. For example, `fr-guards` `…2727555`, `…2729912` and `…2731906` were created within 4 seconds of each other.
3. **Preflight makes its own asset.** `tests/setup/provision.spec.ts` uses the fixture without naming a fleet, so it falls back to `DEFAULT_FLEET = 'fr-setup'` and provisions a full asset and tracker every run.

There are two smaller problems:

* The names carry the prefix twice (`[FRTest]-fr-live-[FRTest]-1790300381973`), because `currentRunId()` already starts with `FIXTURE_PREFIX`.
* Pinning an asset with `ASSET_ID` that already has a tracker fails with a 409, because provisioning always installs a new TennaCAM (README, "Harness fixes").

## Goal

Each fleet on each account has exactly one primary asset, plus one secondary asset where scenarios need it, and every run reuses them. A worker restart, a new run, or a new day all find the same asset and the same tracker. dv3 should settle at about 9 fixture assets in total (7 fleets, `fr-setup`, and a secondary or two), no matter how often the suite runs.

Cleaning up the 48 existing assets is out of scope here.

## What makes reuse safe

The runner already expects an asset to have history.

* **Trips.** `runTimelineExecution` (`src/scenario/runner.ts`) calls `capturePreExistingTrips` before each execution, and `resolveTripRef` (`src/scenario/context.ts`) leaves those trips out. Scenarios only ever see trips from their own execution.
* **Driver events.** `capturePreExistingDriverEventRows` does the same for `rosco_driver_events`, and the reader filters by asset and a time window (`src/read/driverEvents.ts`). O16's `driverEventRowCount: 1` stays correct on a reused asset.
* **Assignee.** Every scenario that asserts on the assignee sets its own starting value through `preconditions.assetAssignee` and snapshots the baseline in `captureUnchangedSnapshots`.
* **Contacts.** `ensureContacts` already finds the four `[FRTest]` contacts by name and re-enables any disabled one.

Scenarios in one file already share one asset (`fullyParallel: false`), so reusing it across runs is the same pattern stretched over time.

## Design

### 1. A fixed identity per fleet

The asset's `fleet` field becomes the lookup key. Its value is `[FRTest]-<fleet>`, for example `[FRTest]-fr-live` or `[FRTest]-fr-live-secondary`. The name is the same string.

Why `fleet` and not `name`:

* Fleet numbers are unique per account. `POST /v5/assets` returns 409 "fleet number has been already used", so two fixture assets can never share a key.
* `POST /v5/assets/search` has an exact match on fleet, `fleetStrict` (`backend-crud/app/modules/assets/v4/controller.js`, `where.fleet = req.filters.fleetStrict`). The `name` filter is a substring `ILIKE '%…%'` match that takes an array, so `[FRTest]-fr-live` would also match every old `[FRTest]-fr-live-[FRTest]-<ts>` asset.

Add an optional `FIXTURE_NAMESPACE` setting. When it's set, the key becomes `[FRTest]-<namespace>-<fleet>`. Two people running the same fleet on the same account at the same time would otherwise share one asset and step on each other. The default is unset, which gives one shared set per account.

### 2. Find or create the asset

In `src/api/assets.ts`, replace `findAssetByName` with `findAssetByFleet(api, fleet)`:

* `POST /v5/assets/search` with `{ fleetStrict: fleet, include: ['tracker'], limit: 2 }`.
* Zero results returns null. One result returns it. Two results throws, because fleet is supposed to be unique and something is wrong.

`findAssetByName` has no callers today (checked with grep). Its search body sends `name` as a string, but the schema wants an array. Delete it rather than fix it.

In `provisionAssetWithTennaCam`:

1. If `ASSET_ID` / `ASSET_ID_<FLEET>` is pinned, use that id, as today.
2. Otherwise call `findAssetByFleet`. If it finds nothing, create the asset with `name` and `fleet` both set to the key. Record it in the manifest as `created`, and as `reused` when it was found.

### 3. Reuse the tracker already on the asset

Also in `provisionAssetWithTennaCam`, once the asset id is known:

1. Read the installed tracker from the asset (`include: ['tracker']`, from the search above or from `GET /v5/assets/:id?include=tracker` for a pinned asset).
2. If there is one, accept it only when all of these hold (the `include=tracker` block already carries every field needed):
   * `type` is `TennaCAM 2.0`
   * `serial_number` starts with `[FRTest]-gms-`
   * `secondary_tracker_serial_number` starts with `[FRTest]-veh-`

   Then use its `serial_number` as `gmsSerial` and its `secondary_tracker_serial_number` as `vehicleId`, and skip creating, associating and installing.
3. If the installed tracker is not a fixture tracker, throw and touch nothing. It means someone put a real device on the asset, and the suite must not drive telemetry through it.
4. If there is no tracker, create, associate, install and verify one, as today.
5. Make sure the install is verified. Read the association with `GET /v5/tracker-asset-associations/:id` (its id is `tracker.tracker_asset_association_id`), and call `verifyTrackerAssetAssociation` only if `certification_passed` isn't `true`. A run that died between install and verify would otherwise leave an unverified install behind forever.
6. Always call `waitForDigestionReady`. On a warm asset it returns on the first poll.

### 4. Reset state at setup

Reuse means the asset carries whatever the last run left. At the end of `provisionFleetRun`, and in the secondary-asset path:

* **Assignee.** `setAssetAssignee(api, assetId, null)`. Scenarios set their own preconditions, but a clean start makes a failing run easier to read.
* **An open trip.** `searchTrips` for the asset with `limit: 1`. If the newest trip has no `end_date`, send one `IGN_OFF` frame for the tracker at the current time and wait with `waitForTripEnded`. A run that died mid-trip would otherwise leave the next run's first `IGN_ON` landing inside a trip that's still open. This needs the telemetry emitter at provisioning time, so pass it into `provisionFleetRun`, or create one there.
* **Contacts.** `ensureContacts` already covers this. No change.

### 5. Stop the worker restart from mattering

After steps 1 to 3, a restarted worker provisions by looking up the fleet key, so it finds the same asset and tracker. Nothing else is needed for the restart case.

`currentRunId()` stays as it is. It still names the manifest file for each worker. It no longer goes into asset or fleet names.

### 6. Preflight

`tests/setup/provision.spec.ts` keeps provisioning through the fixture, on the fixed `[FRTest]-fr-setup` asset. That costs one asset in total instead of one per run, and it still smoke-tests the reuse path end to end, which is worth having. The one change is the spec's doc comment, which should say it reuses the asset.

### 7. Fleets that need a fresh asset

O21 (`src/scenarios/phase2.ts`) needs "an asset's very first trip". It only passes today because it runs first on a new per-run asset. With reuse, that asset always has trip history.

Add a per-file option: `defineScenarioTests(scenarios, fleet, { freshAsset: true })`. It sets a `freshAsset` worker option that `provisionFleetRun` reads, and when it's true provisioning keeps today's behavior (a new asset named with the run id). Use it only for `tests/o-phase2.spec.ts`. Phase 2 is opt-in through `ALLOW_PHASE2`, so this keeps adding assets only when someone asks for phase 2.

Done since: O21 is alone in `tests/o-first-trip.spec.ts`, and O22 to O24 moved to `tests/o-trip-start.spec.ts`, which reuses its assets.

### 8. Clean out the dead pins

`TRACKER_ID` and `VEHICLE_ID` are read by `env.ts` but no code uses them. Remove them from `src/env.ts` (the `trackerId` and `vehicleId` getters and the `SuiteEnv` fields) and from `.env.example`. With step 3, `ASSET_ID` on its own is enough to pin an asset and its tracker.

## Changes by file

| File | Change |
|---|---|
| `src/api/assets.ts` | Add `findAssetByFleet` using `fleetStrict` and `include: ['tracker']`. Delete `findAssetByName`. |
| `src/types.ts` | Add optional `fleet` and `tracker` (`{ id, type, serial_number }`) fields to `Asset`. |
| `src/api/trackers.ts` | Add `getTrackerAssetAssociation(api, trackerId)` (`GET /v5/tracker-asset-associations?tracker_id=…`), returning the id and verified state. |
| `src/fixtures/provision.ts` | Build the fleet key. Find or create the asset. Reuse or create the tracker, with the fixture-tracker check. Verify when needed. Reset the assignee and close an open trip. Honor `freshAsset`. |
| `src/fixtures/test.ts` | Add the `freshAsset` worker option. Build the secondary key as `<fleet>-secondary`. Pass the telemetry emitter into provisioning. |
| `src/fixtures/manifest.ts` | Record `created` or `reused` per fixture, so the manifest shows which assets a run actually added. |
| `src/constants.ts` | A `fixtureKey(fleet)` helper that applies `FIXTURE_PREFIX` and the optional `FIXTURE_NAMESPACE`. |
| `src/env.ts` | Add `FIXTURE_NAMESPACE`. Remove `trackerId` and `vehicleId`. |
| `tests/o-phase2.spec.ts` | Pass `{ freshAsset: true }`. |
| `tests/setup/provision.spec.ts` | Update the doc comment only. |
| `.env.example`, `README.md` | Document reuse and `FIXTURE_NAMESPACE`. Drop `TRACKER_ID`/`VEHICLE_ID`. Replace the "pinned asset with a tracker fails with a 409" note. |
| `tests/unit/` | Unit tests for `fixtureKey`, and for the tracker check (accept a fixture TennaCAM, reject a real device, reject the wrong type). |

## Checked on dv3 (2026-09-28)

Read-only calls against dv3 settled these:

1. `POST /v5/assets/search` with `fleetStrict` is an exact match through the v5 route. The full fleet value of an existing asset returns that one asset, and the prefix `[FRTest]-fr-live` returns nothing.
2. `include: ['tracker']` returns the installed tracker on both asset search and `GET /v5/assets/:id`, with `id`, `type`, `serial_number`, `secondary_tracker_serial_number` and `tracker_asset_association_id`. So no second lookup is needed to find the install.
3. A verified install has `certification_passed: true` and a `certification_decision_at`. `install_completed_at` stays null even on a verified install, so it isn't the field to check.
4. One asset from an earlier version of the code already has fleet `[FRTest]-fr-setup`, the new key (`2e315563-…`, named `[FRTest]-fr-setup-[FRTest]-1790300079816`). It has a fixture TennaCAM that was installed but never verified (`certification_passed: null`). The first reuse run adopts it and verifies it. No other fleet key exists yet, so each of those gets created once.

Still open: whether a soft-deleted asset keeps its fleet number. Testing it needs a real delete. The code turns a 409 on create into an error that says to restore the asset or set `FIXTURE_NAMESPACE`.

## How to verify the change

1. `npm run typecheck` and `npm run test:unit`.
2. Run the setup spec twice with `FR_DEBUG=1`. The second run makes no asset or tracker writes, and its manifest lists the asset and tracker as `reused`.
3. Run one scenario file that fails today (`o-guards.spec.ts`) to the end. Count `[FRTest]-fr-guards*` assets on the account before and after. The count goes up by one on the very first run and by zero after that, even though tests fail and workers restart.
4. Run the same file again the next day. Still zero new assets.
5. Run `o-phase2.spec.ts` with `ALLOW_PHASE2=1` and check that it still creates its own fresh asset.

## Risks

* **Two people on one account at once.** Without `FIXTURE_NAMESPACE`, simultaneous runs of the same fleet share one asset and can break each other's assertions. Today they get separate assets. The namespace setting covers it, and the README should say so.
* **An asset left in a strange state.** A run can die after changing something the reset in step 4 doesn't cover (for example a trip with an assignee that a later "unchanged" check reads). The runner's pre-existing-trip snapshot excludes old trips, so this should stay contained. If it shows up, the reset list grows.
* **Trip search limit.** `searchTrips` reads the newest 25 trips. Pre-existing capture and later lookups both sort newest first, so the exclusion logic holds. But a scenario that backdates its trip behind 25 newer trips would miss it. That's already true within one file today, and reuse makes it a little more likely. If it bites, pass the execution window (`from: windowStart`) to `searchTrips` in `resolveTripRef`.
* **Anything tied to asset age.** A reused asset is older and has more history than a fresh one. That only matters for O21, which step 7 handles, and possibly the trip-recency guard called out in the README's O17 note. Watch O17 on the first reused runs.

## Out of scope

* Deleting or soft-deleting the 48 assets already on dv3, and their trackers and associations.
* A cleanup tool.
* Reusing assets across different accounts. `fr-licence` has its own account and gets its own asset there through the same code.
