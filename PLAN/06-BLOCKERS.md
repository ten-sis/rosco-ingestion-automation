# Blockers

One row per blocker: what is blocked, which cases it blocks, what must ship, who owns it. Ordered roughly by how many cases each one touches.

| Blocked | Cases | What must ship | Owner |
|---|---|---|---|
| **`POST /v5/rosco-events/publish` schema, the one thing between this suite and CI** | Nothing is blocked outright (`EMITTER=webhook` over the port-forward is the working path meanwhile — see below), but there is no port-forward-free path today | The schema is expected to carry Types 6 and 7 but does not: it requires `event_id` and pins `name` to the enum `["events"]`. Widen it to accept `event_id` and a `name` outside that enum | Engineering (backend-crud), owns the CI story |
| The whole write path | O2, O3.1-3.5, O4, O5, O6, O7.1, O7.2, O8, O9, O12a-f, O13, O15, O16, O17, O18, O19 | `rosco_driver_events` table, the identification consumer (trip lookup, claim, both writes), IN-2 in the design doc's Work Breakdown | Engineering (backend, `hapi-server-rosco-ingestion-rmq`) |
| Trip-end reassignment | O3.1, O3.3, O3.4, O6, O7.1, O7.2, O8, O13 | The trip-end consumer: search window (floored at trip start; see O14 below), award step, contact-status re-check, threshold reassignment | Engineering, same repository |
| Trip-update guard | Every case that writes the trip assignee | The blocking prerequisite in `backend-crud`, called out in the design doc's Deployment Plan as gating steps 10 and 12; all three consumers are "unsafe without it" | Engineering, `backend-crud` |
| Backfill cron widening | O3.3, O3.4, O6, O7.1, O7.2, O13 | `hapi-server-scorecards`' cron widened to react to a trip-driver write for facial-recognition accounts | Engineering |
| Trip-start consumer | O21, O22, O23, O24 | Built at all; it is explicitly out of the initial deployment and its build decision is deferred to post-deployment metrics (no-covering-trip rate, trip-end award share, pre-start arrival distance) | Engineering, with Product on timing |
| `POST /api/v5/rosco-driver-events/search` | Nothing directly (the SQL reader covers it), but the CI-friendly path | The endpoint and its OpenAPI spec, so `DRIVER_EVENTS_READER=api` becomes viable | Engineering |
| O12e trip-type fixture | O12e | The telemetry emitter (module C) needs a way to produce a heartbeat or virtual trip on demand; no Step kind in `src/scenario/types.ts` can select trip type | Module C, or move to `OUT-OF-SCOPE.md` if it cannot |
| O24 adjacent-publish ordering | O24 | A way to force a `trip-started` republish immediately before `trip-ended` on the same trip; no Step kind expresses "emit a duplicate lifecycle event out of band" | Module C/D, or move to `OUT-OF-SCOPE.md` if it cannot |

Resolved and removed from this table since the previous revision of this pack: the licence toggle path (O18, O19) is enabled through the API by the preflight step, not a manual CS step; O20 is no longer an automated case at all (see `OUT-OF-SCOPE.md`), so there is nothing left to block.

## O14, resolved

Previously contested (see the git history of this pack for the earlier back-and-forth). AGENT-BRIEF revision 2, item 6, settles it: the trip-end search window is floored at the trip's own `start_date`, not at the previous trip's end, so an identification timestamped before its own trip started falls outside the window regardless of what preceded it — not linked, no claim, no assignee change anywhere. `src/scenarios/tripLookup.ts`'s `O14` asserts exactly that, and no longer carries the `@contested` tag.

This also resolves the apparent tension with O21 without either case needing to change: the pre-start tolerance (ten minutes, used when no previous trip exists in the lookback) is a distinct, narrower mechanism reserved for an asset's very first trip ever, which O14 deliberately is not. `o-trip-lookup.spec.ts` runs O12a through O12f before O14 in `TRIP_LOOKUP_SCENARIOS`, all serially against the one shared `fr-trip-lookup` asset, so by the time O14's own trip starts, that asset already has trip history and the pre-start tolerance does not apply to it. O21 (`@phase2`) is the only case that deliberately requires a fresh, trip-history-free asset, and its own preconditions say so explicitly. The two cases describe genuinely different mechanisms, not two readings of the same one; the earlier contradiction was between the plan's prose and a design-doc table row that did not distinguish "this trip's own floor" from "the previous trip's end" carefully enough, not between the two scenarios themselves.

## O7.1 / O7.2, a judgment call

The design doc's "Setting the asset assignee" section is explicit that the asset-write guard compares `received_at` (server receipt time) against the standing association's `created_at`, specifically because the event's own device-side `timestamp` "carries buffering delay and clock skew." The plan this module was built from describes O7.1 and O7.2's distinguishing variable as the event's timestamp relative to the manual correction's time ("ts < Tm" / "ts > Tm"), which is not the field the guard actually reads.

`src/scenarios/guards.ts` resolves this by using delivery ORDER (the identification's position in the timeline array relative to the `patchAssetAssignee` step, plus an explicit `sendAfterMs` gap) as the real differentiator, since that is what determines `received_at`, while keeping `atSec` narratively consistent with the plan's "ts before/after Tm" framing. Both scenarios carry a `// VERIFY` comment making this explicit. If module D's runner sends steps close enough together in real time that Postgres timestamps could tie, these two scenarios will not reliably distinguish their outcomes; the `sendAfterMs` values (2000ms) are a starting point, not a guarantee, and should be widened if flakiness shows up.

## O9, a naming mismatch

The design doc's Developer Test Plan labels "insert-time race on the claim" (two concurrent identifications on one trip, no trip end involved) as O9, and "trip-end award race" (an identification racing the trip-ended message) as O10. This suite's plan describes its `o-race.spec.ts` case, labeled O9, as the identification-versus-trip-ended race, matching the design doc's O10 by mechanism. `src/scenarios/race.ts` follows the plan's label and mechanism as instructed and documents the mismatch in a file-level comment. The design doc's own O9 and O10 are both therefore left uncovered by this module; see `TRACEABILITY.md`.

## O10 and O11, out of this module's scope by omission

Neither the design doc's O10 (trip-end award race, distinct from what this module's O9 covers) nor O11 (cached-state write across all three fixtures, a `hapi-server-live-events`/`processor-scorecard` concern) appears in the case-to-file mapping this module was given. This looks like a deliberate scoping decision made upstream of this module rather than an oversight in this module's own work, since every other O1-O24 case is accounted for exactly once. Recorded in `TRACEABILITY.md` as `blocked` with a note, so the gap is visible rather than silently absent.

## O20, moved to OUT-OF-SCOPE.md

Previously covered indirectly by `src/scenarios/resilience.ts` (the observable trip-end-correction outcome, since the lost publish itself cannot be forced from outside the cluster). AGENT-BRIEF revision 2, item 6, descopes the whole case, not only its direct counter proof: the audit detects a lost publish and the team reacts to it, so there is nothing left for an automated test to prove. `src/scenarios/resilience.ts` and `tests/o-resilience.spec.ts` are deleted; see `OUT-OF-SCOPE.md` for the full reasoning and the manual proof if one is ever needed for a specific incident.

## `'unchanged'` semantics, resolved

An earlier draft of this pack assumed `'unchanged'` could chain forward through `expectAfterStep` checkpoints. Once module D's runner landed (`src/scenario/context.ts`, `runner.ts`, `waits.ts`), it was confirmed to do something simpler and different: `'unchanged'` always resolves to a single snapshot taken once, right after `Precondition`s are applied and before the timeline's first step runs, for the whole scenario execution. It never compares against an intermediate checkpoint value.

Every scenario in `src/scenarios/*.ts` that used the chaining assumption (O2, O4, O16, O17, O3.5, O7.1, O13, O18, O23, O24) has been corrected: the mandatory negative control is now a `'unchanged'` checkpoint placed as early in the timeline as the first meaningful point allows (almost always right after the first telemetry step, before any identification or manual write), and later proof that a real write survived a subsequent pass (trip end, the backfill cron) uses the identical literal value (`{ value: 'A' }`) repeated at both points instead of `'unchanged'`. See `01-ARCHITECTURE.md` for the corrected explanation. No further action is needed here; this row is kept as a record of the mistake and its fix rather than as an open risk.

## Consequence of flooring the trip-end window at trip start

Decision taken: the trip-end consumer's search window is floored at the TRIP START, not at the previous trip's end. This settles O14, which was previously recorded as contested. An identification timestamped before its trip started falls outside the window, is not linked, and moves no assignee.

It also opens a coverage hole that the design did not previously have, and the owner should decide whether that is acceptable. The design's original reasoning for flooring trip end at the PREVIOUS trip's end was that it recovers a pre-start identification: "An identification timestamped slightly earlier than its trip belongs to trip end, which already floors its search on the previous trip's end and recovers exactly that case." The trip-start consumer deliberately does not reach back before the trip's start date, and widening it is explicitly deferred pending measurement. With trip end now floored at trip start as well, neither pass recovers a pre-start identification. It is written, it is never linked, and the driver is never attributed for that trip.

Whether that matters depends on how often identifications arrive stamped before their trip's start_date, which is unmeasured. The design already names the counter that would answer it: the trip lookup counter's no-covering-trip outcome, plus how far before their trip's start the unlinked identifications actually sit. Clock skew between the camera's cellular path and the tracker's telemetry path makes a sub-minute early fire plausible, and the design's own O14 note says to "Monitor clock drift, if there is considerable amount of under one minute early fires, consider artificially widening the trip overlap window with identification events".

What the suite does about it: O14 asserts the decided behaviour, that nothing is linked and nothing moves. O21, which asserts that a pre-start tolerance links the identification on an asset's very first trip, is tagged `@phase2` and excluded from the default run, because it tests a widening the design defers. The two are therefore not in conflict in the suite as it stands, but O21 will fail against any implementation that follows the decision above, and that is expected rather than a defect.

## Backend gap: a facial-recognition licence row cannot be created from here

The preflight step enables the licence by reading `GET /v5/licenses` to find it by name, then reading `GET /v4/account-licenses` and writing the matching row. The update path works: `account_license/v4/controller.js:41-53` filters on `req.params.id` alone, so the call succeeds with the `account_id` header omitted, which is what clears the `permission(["super","admin"])` gate through the intra-service bypass.

The create path does not. `account_license/v4/controller.js:31-39` takes `account_id` from `req.session.account_id`, and omitting the header to pass the permission gate leaves that undefined. The column has no `allowNull: false`, so the insert would not fail loudly; it would write a row with a null account and report success. The suite therefore refuses to create a row and throws with an actionable message instead.

What this means in practice: an account used by this suite must already carry an `account_licenses` row for the facial recognition licence, in any state. The suite will enable a disabled row, but it cannot bring the first one into existence. Someone with Tenna-account credentials seeds it once per test account. The alternative is a backend change to accept an explicit `account_id` on that create, which is worth doing if these accounts are provisioned often.

## Known limitation: O17's day-two identification is stamped ahead of its delivery

O17 stands in for a multi-day trip with a second driver identified on day two. The trip itself is compressed to minutes so a test can run, but the second identification keeps `atSec: 93600` to remain recognisably a day later. One `PlaybackPlan` carries one anchor, and the anchor is derived from the trip events' span so the trip stays close to now, so that one identification is stamped roughly twenty-six hours ahead of the moment it is actually sent. Every other payload in every other fixture is stamped at or behind its delivery time.

Keeping the trip near now matters more than keeping that one timestamp in the past, because a trip backdated by a day sits behind the trips other scenarios have already placed on the shared asset and would trip the trip-recency guard for a reason unrelated to the case. Fixing both at once needs per-item anchoring, which is a fixture schema change. O17 is P1 and the mechanism it proves, that a later identification in the same trip does not move the assignee, is also covered by O4 at P0.

## To confirm on the first real run: what `contact_active` holds for O8

O8 deactivates the driver after the identification row is written and before the trip-end backstop runs, then asserts `contact_active` is false on that row. The design says `contact_active` is captured at insert, and at insert the contact was still live, so a literal reading would leave the stored value true and treat it as a stale-but-consistent state the design explicitly tolerates. The suite asserts false because that is what makes the contact-status guard's input observable. If the implementation captures at insert and never refreshes, this assertion needs to move to the guard's effect, which is the absence of the asset write, the trip write and the re-assignment, rather than to the column.
