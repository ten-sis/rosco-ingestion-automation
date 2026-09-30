# Context

## What is being built

A Playwright suite that drives the Rosco Facial Recognition operation flow end to end against a nonprod Tenna environment, covering cases O1 to O24 from the design doc's Developer Test Plan. Registration (R) and audit (A) cases are out of scope for this project entirely, not just for this module.

Nothing in the feature exists yet. A monorepo search for `rosco_driver_events`, `driver-ident` and `driver-events` returns no hits outside the design folder. This suite is an executable acceptance spec written ahead of the code. Most tests will fail until the feature ships, and that is the intended state, not a bug in the suite. The one spec expected to pass today is `tests/setup/provision.spec.ts`, because provisioning only touches endpoints that already exist.

## The feature, in one paragraph

A camera on a vehicle (a Rosco add-on riding as the secondary tracker on a Geometris TennaCAM 2.0 primary) recognises the driver at the start of a trip and tells Tenna who it saw. Tenna then sets that person as the asset's assignee, the trip's assignee, and reassigns any safety-threshold events on that trip that were attributed to the wrong person before the identification arrived. The whole point is to stop scorecards being only as accurate as whatever manual driver assignment happened to be sitting on the asset.

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

Plus a NEW trip-end consumer on `asset.#.#.trip-ended` that links rows the live path could not link, sets the assignees under the same guards, and re-assigns the trip's threshold events. A trip-start consumer on `asset.#.#.trip-started` also shipped in the initial release, and O22 to O24 exercise it.

`{h}.{h}` is the two-character md5 hash of the device serial, `md5(vehicle_id)[0]` and `md5(vehicle_id)[1]`, joined by dots. Source: `js-models/src/rmq/standardHashTemplateObject.js`.

## The four write guards

These are what most cases in this module actually test, not the happy path.

| Guard | Rule |
|---|---|
| The claim | Exactly one identification per trip becomes the assignee source, via `pg_advisory_xact_lock` plus a partial unique index as backstop |
| Trip recency | Before the asset write, if this row's own trip is already closed, look for a later normal trip on the same asset. If one exists, skip the asset write |
| Trip-driver write | Write the trip assignee only when it is null or already equals the intended contact. Anything else is a manual correction or predates the feature, and is never reverted |
| Contact status | Re-check the winning contact's live `enabled` and `deleted_at`, not the row's insert-time snapshot. Inactive or deleted skips the asset write, the trip write and the re-assignment |

The asset-assignee comparison uses `received_at` (server receipt time), not the event's device-side `timestamp`, because the device clock carries buffering delay and skew. This matters for O7.1/O7.2; see `06-BLOCKERS.md`.

## What exists and is reused

Fixture and emission endpoints (assets, trackers, contacts, trips, threshold events, the raw Rosco webhook, `automation-tracker` for live trips) already exist and are unaffected by whether the feature ships. `04-API-REFERENCE.md` lists them with citations. `AGENT-BRIEF.md` has the full non-obvious-facts list; the one that costs the most time if missed is the deterministic `event_id` generation that O16's redelivery test depends on. Digestion's asynchronous Redis propagation for a newly installed secondary tracker is not a live risk: provisioning polls it (`waitForDigestionReady`) until the device resolves, with a budget and a failure message naming the exact cause, so it is infrastructure this suite already accounts for rather than an open concern.

## There is no login

The suite reaches backend-crud over the intra-service path (a `requestor` header, no `Authorization` header, `localhost:3000` on the allowlist in `INTRA_SERVICE_REQUEST_HEADER_HOSTS`). See `README.md` and `AGENT-BRIEF.md` revision 2, item 1, for the full mechanism and why the port-forward's local port matters.

## What does not exist and is blocked

The `rosco_driver_events` table, the identification consumer, the trip-end consumer, the trip-start consumer, the widened threshold-event backfill cron, the trip-update guard in `backend-crud` that all three consumers depend on for safety, and `POST /api/v5/rosco-driver-events/search`. None of it has a seed script yet either, which the design doc calls a prerequisite rather than a detail. See `06-BLOCKERS.md` for the full list mapped to which O-cases each blocks.

## Scope of this module

Module E owns `src/scenarios/*.ts`, everything under `tests/`, and the documentation pack under `PLAN/` plus `TRACEABILITY.md`, `OUT-OF-SCOPE.md` and `README.md` at the project root. It depends on, and must not edit, `src/scenario/types.ts` and `src/types.ts`. It depends on, but does not implement, modules A through D (foundation, resource clients, emitters/readers, runner/fixtures).
