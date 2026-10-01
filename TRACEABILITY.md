# Traceability

Design-doc operation case to spec file to scenario id to status. Rows follow the "Facial Recognition Operation cases" table in [Rosco Facial Recognition - Design doc](https://tenna.atlassian.net/wiki/spaces/SE/pages/3662708761/Rosco+Facial+Recognition+-+Design+doc#Facial-Recognition-Operation-cases), as of 2026-09-28. `PLAN/08-DESIGN-DOC-COVERAGE.md` says, case by case, how closely each scenario matches the doc's expected outcome.

Status values:

* `covered` — a scenario exists and asserts the case.
* `partial` — a scenario exists, but part of the doc's expectation isn't asserted or can't be forced. The note says which part.
* `manual` — not automatable.
* `opt-in` — built, and runs only with `ALLOW_FRESH_ASSETS=1`, because it creates a new asset every run.
* `repo test` — no scenario here, but unit or e2e tests in hapi-server-rosco-ingestion-rmq cover it. The note names them. Those marked TS-43928 are on `feature/ten-mfm.TS-43928.cover-cases-dv3-cannot-reach` until it merges.
* `not covered` — no scenario.

| O-case | Spec file | Scenario id(s) | Status | Note |
|---|---|---|---|---|
| O1 | `o-live.spec.ts` | `O1` | covered (simulated) | The normal happy path with both event types, from a fixture TennaCAM and emulated Rosco payloads. The real-hardware check stays manual; see `OUT-OF-SCOPE.md` |
| O2 | `o-live.spec.ts` | `O2` | covered | |
| O3.1 | `o-delayed.spec.ts` | `O3.1` | covered | |
| O3.2 | `o-delayed.spec.ts` | `O3.2` | covered | |
| O3.3 | `o-delayed.spec.ts` | `O3.3` | partial | Waits 6 minutes for the backfill cron, so only its 5-minute run is covered, not the 2-hour one |
| O3.4 | `o-delayed.spec.ts` | `O3.4` | covered | |
| O3.5 | `o-delayed.spec.ts` | `O3.5` | covered | |
| O4 | `o-live.spec.ts` | `O4`, `O4b` | covered | `O4b` (QA T16521566): 50 identifications of the same driver on one trip. 50 rows, one assignee move, the earlier violation ends on A |
| O5 | `o-trip-lookup.spec.ts` | `O5` | partial | "No assignee change" is asserted. The doc's "monitor the diff to the next trip start" is an observation; see `PLAN/06-BLOCKERS.md` |
| O6 | `o-trip-lookup-gaps.spec.ts` | `O6`, `O6.1` | covered | Asserts the agreed TS-44193 behavior, not the doc's original "No asset write": latest write wins, so the late identification writes its trip and the asset when it's the latest change. Trip 2 keeps its assignee. `O6.1` (design O6.1): trip 2's own identification, delivered after trip 1's late one. Trip 2 moves to that driver, but the asset stays on trip 1's driver because the guard compares C's event time with when A's late write landed. That's the known residual, accepted on 2026-10-01 and monitored in production, so `O6.1` asserts the asset stays on A |
| O7.1 | `o-guards.spec.ts` | `O7.1` | covered | Told apart from O7.2 by receipt order, not the event timestamp the doc's table names; see `PLAN/06-BLOCKERS.md` |
| O7.2 | `o-guards.spec.ts` | `O7.2` | covered | Same receipt-order note as O7.1 |
| O8 | `o-guards.spec.ts` | `O8`, `O8b`, `O8c`, `O8d`, `O8e` | covered | `O8`: contact deactivated after its row is written, blocked by the trip-end guard's live re-check. `O8b`: contact already disabled when the identification arrives, recorded as `flags.contact_is_active: false`. Both use driver D, which no other guards scenario uses, so the rest of the file can run in parallel with them. `O8c` (QA T16521553): a `driver_guid` that matches no contact is persisted as unidentified and writes nothing. `O8d` (QA T16521555): a Type 7 naming a soft-deleted contact is persisted as unidentified and writes nothing. The deleted contact is a fixture found again through `include_deleted`. `O8e` (design O8.1): a `driver_guid` that isn't a UUID, sent through the webhook. be-crud answers 422, the consumer logs an error and rejects the message to `ros-driver-events_error`, and no row is written |
| O9 | `o-race.spec.ts` | `O9` | covered | The identification and trip-end fire together, repeated 5 times, as the doc's row describes |
| O12 | `o-trip-lookup.spec.ts`, `o-trip-lookup-gaps.spec.ts` (O12c) | `O12a`, `O12b`, `O12c`, `O12d`, `O12e`, `O12f` | partial | One scenario per lookup outcome. `O12e` needs a heartbeat or virtual trip, which the emitter can't produce, so it's `fixme` here and covered by the repo's e2e test `an identification covered only by a heartbeat or virtual trip` (TS-43928); see `PLAN/06-BLOCKERS.md` |
| O13 | `o-guards.spec.ts` | `O13` | partial | "Already-transferred events are excluded" is asserted. The transfer half is only covered indirectly; see `PLAN/06-BLOCKERS.md` |
| O14 | `o-trip-lookup.spec.ts` | `O14` | partial | Asserts trip end recovering the row (linked, claim, asset A), per the doc's trip-end section and the consumer. The doc's O14 row says "no assignee change", which contradicts that section; see `PLAN/06-BLOCKERS.md`. "Monitor clock drift" is an observation |
| O15 | `o-live.spec.ts` | `O15`, `O15b` | covered | `O15b` (QA T16521587): the reverse order, a late Type 6 stamped before an earlier-delivered Type 7, moves nothing |
| O16 | `o-live.spec.ts` | `O16` | covered | Asserts the outcome (one row, one assignee write). The code has no S3 check for driver events: ingestion publishes every delivery and the unique index on `(account_id, event_id)` collapses a redelivery |
| O17 | `o-live.spec.ts` | `O17` | covered | Also asserts both violations, one before A's identification and one after, end on A (QA T16521568) |
| O18 | `o-licence.spec.ts` | `O18` | covered | Runs on `ACCOUNT_ID_FR_LICENCE` (FrTest on dv3) |
| O19 | `o-licence.spec.ts` | `O19` | covered | Runs on `ACCOUNT_ID_FR_LICENCE` with a placeholder `trackit` integration. Asserts the outcome converges on A, and that trackit logged its FR skip for the account (`kubectl logs`, needs hapi-server-trackit `v1.2.0-build.3` or later) |
| O20 | — | — | repo test | Repo unit tests (`driverEvent.test.ts`, `assetTripStarted.test.ts`) ack on a failed publish. The e2e test `an assignee publish that is lost` (TS-43928) shows trip end moves only violations up to the trip driver write, and leaves later ones to the backfill cron. The audit half stays manual. See `OUT-OF-SCOPE.md` |
| O21 | `o-first-trip.spec.ts` | `O21` | opt-in | Struck from the initial release in the doc, but the trip-end consumer's pre-start tolerance shipped. Needs an asset's very first trip, so it creates a new asset every run and is tagged `@fresh-asset` |
| O22 | `o-trip-start.spec.ts` | `O22` | covered | The trip-start consumer shipped in the initial release (TS-43907), though the doc still marks O22 to O24 phase 2 only |
| O23 | `o-trip-start.spec.ts` | `O23` | covered | |
| O24 | `o-trip-start.spec.ts` | `O24` | partial | Asserts the outcome only. The adjacent-publish ordering can't be forced; see `PLAN/06-BLOCKERS.md` |
| O26 | — | — | repo test | Same path as O16 now, since nothing checks S3 before publishing a driver event. Repo e2e test `a redelivered webhook` |
| O27 | — | — | repo test | Repo unit test `generateDriverEventNaturalKey` (`rawEvents.test.ts`). Isolation is by salting the hash (`driver_events_<id>`) under `ros.`, not the doc's `rosdrv.` prefix |
| O28 | — | — | repo test | Ingestion never checks S3 for driver events, so an outage can't drop one (repo unit test in `rawEvents.test.ts`, TS-43928). The event recorder keeps its existence check, and `@tenna-llc/aws-sdk-wrapper`'s `S3.check` reads an outage as "found", so during an outage the S3 archive copy is skipped with no error. Known gap until the wrapper is fixed |

The doc's test data also lists "two concurrent identifications for the same trip" (item 1), but no case row in its table uses it, and no scenario here does either.

Scenario count per group: `live` 8, `tripLookup` 7, `tripLookupGaps` 3, `delayed` 5, `guards` 8, `race` 1, `licence` 2, `tripStart` 3, `firstTrip` 1. Total 38 scenarios covering 26 of the doc's 30 rows (O12 has 6 sub-scenarios). 25 of those rows run by default, and O21 needs `ALLOW_FRESH_ASSETS=1`. O1 runs simulated only. O12e, O20, O26, O27 and O28 are covered by repo tests in hapi-server-rosco-ingestion-rmq instead (O20's audit half stays manual).
