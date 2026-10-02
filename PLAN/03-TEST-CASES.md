# Test cases

One section per O-case. `A`, `B`, `C`, `D` are the four provisioned driver contacts. `T0` is the anchor of logical time (`atSec: 0`); negative `atSec` values are before it. "Delivered" means the step's position in the timeline array, independent of its `atSec` (see `01-ARCHITECTURE.md`, the two-clock model).

## O1 — Real hardware, both event types, end to end

Priority P0. Runs simulated in `o-live.spec.ts`, compiled from `fixtures/O1-happy-path-both-event-types.json`: one open trip, HARDBRAKE at 45 before any identification, a Type 6 (unDrv) at 75, a Type 7 (identDrv) for A at 105, HARDACCEL at 150, trip end at 200.
Preconditions: asset assignee B.
Checkpoints: after the Type 6 settles, the asset assignee is unchanged and one unlinked unDrv row exists. After A's identification, the asset and trip assignees are A.
Expected end state: asset A, trip A, the unDrv row still unlinked, A's identDrv row linked and the assignee source, and both violations on A.
Caveat: simulated, not a real tracker. The real-hardware check needs a TennaCAM 2.0 on a drivable vehicle producing real Type 6 and Type 7 events, and stays manual (`OUT-OF-SCOPE.md`).

## O2 — Live identification during an open trip (`o-live.spec.ts`)

Compiled from `fixtures/O2-live-open-trip.json` via `src/scenarios/fixturePlayback.ts`; the scenario itself adds only the `settle` waits and the assertions below.
Preconditions: none.
Timeline: ignition on; move; identify A while the trip is open; wait for the assignee write; move; ignition off; wait for trip end.
Expected end state: asset assignee A, trip assignee A, one `rosco_driver_events` row for A with `is_assignee_source` true, linked to the trip, `flags.resulted_in_assignee_change` true.
Negative control: a checkpoint right after ignition-on, before the identification, asserts `'unchanged'` (the pre-timeline `null` baseline, per `01-ARCHITECTURE.md`). A second checkpoint right after the identification pins asset/trip assignee at the literal value A; the final assertion repeats that same literal value and asserts nothing was transferred, which is what shows trip end left it alone.
What must ship first: the identification consumer (trip lookup, claim, both writes), the trip-end consumer (to prove it does nothing here).

## O3.1 — Delayed trip, different driver (`o-delayed.spec.ts`)

Compiled from `fixtures/O3.1-delayed-trip-different-driver.json` via `src/scenarios/fixturePlayback.ts`.
Preconditions: none.
Timeline: identify A first, before any trip exists; then run and close a trip whose frames are backdated to cover A's timestamp.
Expected end state: row unlinked at insert (checkpoint), then at trip end: linked, claim awarded, asset and trip assignee A, `flags.arrived_before_trip_created` true, violations reassigned by the trip-end consumer's own pass.
Negative control: the mid-timeline checkpoint (unlinked, no assignee) before the trip exists.
What must ship first: the identification consumer's insert-time lookup (to correctly leave it unlinked), the trip-end consumer's search window and award/reassignment steps.

## O3.2 — Delayed trip, same driver (`o-delayed.spec.ts`)

Preconditions: asset assignee A.
Timeline: same shape as O3.1, with A both before and after.
Expected end state: trip assignee becomes A (a genuine first write, trip assignee starts null regardless of the asset's standing value), asset assignee is unaffected because it was already A, no threshold transfer.
Negative control: asset assignee `'unchanged'` throughout.
What must ship first: same as O3.1.

## O3.3 — Delayed identification, different driver (`o-delayed.spec.ts`, `@slow`)

Compiled from `fixtures/O3.3-partially-delayed-trip.json` via `src/scenarios/fixturePlayback.ts`.
Preconditions: asset assignee B (a pre-existing manual/standing assignee, not itself a facial-recognition claim).
Timeline: run and close a trip with one violation; then, after trip end has already run, identify A with a timestamp inside the closed trip.
Expected end state: asset and trip assignee become A; the violation moves to A only once the scorecard backfill cron's next five-minute pass examines the trip (the trip-driver write is what puts it in the cron's scope).
Negative control: the checkpoint right after trip end (asset still B, trip still unset) before the late identification lands.
What must ship first: the identification consumer's own asset/trip write guards (since this trip already has no open claim), the widened backfill cron in `hapi-server-scorecards`.

## O3.4 — Delayed identification, same driver (`o-delayed.spec.ts`, `@slow`)

Preconditions: asset assignee A.
Timeline: same shape as O3.3, with A both times.
Expected end state: trip assignee becomes A (first write), asset assignee unaffected, no threshold transfer, confirmed only after the backfill cron has had a chance to run and correctly do nothing.
Negative control: asset assignee `'unchanged'`, and `thresholdEvents.noTransfers: true` confirmed post-cron rather than immediately.
What must ship first: same as O3.3.

## O3.5 — Second delayed identification, different driver, after O3.3-shaped state (`o-delayed.spec.ts`, `@slow`)

Preconditions: asset assignee B.
Timeline: O3.3's shape, then a second, later identification for B on the same trip after A has already won the claim.
Expected end state: unchanged from A's win; B's row persists linked, `is_assignee_source` false.
Negative control: the checkpoint pinning A's win before B's identification lands.
What must ship first: same as O3.3, plus the claim mechanism correctly rejecting a second late claimant.

## O4 — Second identification, same trip (`o-live.spec.ts`)

Preconditions: none.
Timeline: identify A; wait for the write; identify B on the same still-open trip.
Expected end state: asset and trip assignee stay A; B's row persists linked, `is_assignee_source` false.
Negative control: two checkpoints, one pinning A's win, one confirming B's identification changed nothing.
What must ship first: the identification consumer's claim mechanism (advisory lock plus partial unique index).

## O5 — Identification with no covering trip, ever (`o-trip-lookup.spec.ts`)

Preconditions: none.
Timeline: identify A; no trip is ever run on this asset within the scenario.
Expected end state: row persists unlinked, `is_assignee_source` null, no asset write.
Negative control: asset assignee `'unchanged'`.
What must ship first: the identification consumer's trip lookup returning no row correctly. The doc's own framing of O5 also calls for measuring the gap to the next trip start, which decides whether the phase-2 trip-start consumer gets built; that measurement is a metrics concern (`facial_recognition_trip_lookup_total`) this scenario cannot assert, see `06-BLOCKERS.md`.

## O6 — Late identification for a superseded trip (`o-trip-lookup.spec.ts`, `@slow`)

Preconditions: none.
Timeline: run and close trip 1 with one violation; run and close trip 2 (a later, separate trip on the same asset); then deliver a late identification for A timestamped inside trip 1.
Expected end state: no asset write (trip recency guard, since trip 2 already exists), trip 1's own assignee still becomes A, trip 1's violation still reassigned via the backfill cron because trip 1's own trip-end pass already ran before this late identification arrived.
Negative control: asset assignee `'unchanged'`; trip 2's assignee also asserted `'unchanged'`.
What must ship first: the trip recency guard specifically (this is the case that most directly exercises it), the backfill cron.

## O7.1 — Manual correction wins on receipt order (`o-guards.spec.ts`, `@slow`)

Preconditions: none.
Timeline: identify A while the trip is open (asset and trip both become A); then a manual, asset-only correction to C is applied; then the trip ends.
Expected end state: asset assignee ends at C (the manual correction was received after A's write and simply overwrote it; nothing about the asset-write guard specifically "protects" C here). Trip assignee stays A regardless, because the manual correction step never touches the trip and the trip-driver guard, once satisfied, never revisits a non-null value.
Negative control: the checkpoint right after A's identification (asset and trip both A) before the manual correction runs.
What must ship first: the trip-driver write guard (null-or-equal), the backfill cron for the violation reassignment.
See `06-BLOCKERS.md` for the judgment call this scenario required: the design doc's asset-write guard compares `received_at`, not the event's device timestamp, which the plan's own prose for O7.1/O7.2 described loosely as "ts".

## O7.2 — Identification received after the manual change (`o-guards.spec.ts`, `@slow`)

Preconditions: none.
Timeline: a manual, asset-only correction to C is applied first, before any identification exists; the trip runs and ends; then a delayed identification for A is delivered, received well after the correction.
Expected end state: asset assignee becomes A (the identification's `received_at` is newer than C's association `created_at`, so the asset-write guard passes); trip assignee becomes A (first write, guard passes).
Negative control: the checkpoint right after the manual correction (asset C, trip still unset) before the identification lands.
What must ship first: the asset-write timestamp guard specifically, since this is the case where it has to let the write through rather than block it.

## O8 — Contact deactivated after winning the claim (`o-guards.spec.ts`)

Preconditions: none.
Timeline: identify A while unlinked (no trip exists yet, so no claim is decided at insert); deactivate A; then run and close a trip that covers A's timestamp.
Expected end state: A's row is eligible (A was active when it was written), so trip end awards it the claim, then the contact-status guard re-checks A's live state, finds A deactivated, and skips every write. No asset write, no trip write, no reassignment. The row carries no inactive flag, because the consumer records contact status only at insert (`flags.contact_is_active`, written only when false). The runner re-enables A when the scenario ends.
Negative control: the checkpoint right after the identification (unlinked, `is_assignee_source` null) before deactivation and the trip even exist.
What must ship first: the trip-end consumer's contact-status guard, specifically the live re-check rather than the row's own snapshot.

## O9 — Identification races the trip-ended message (`o-race.spec.ts`, `@race`, `repeat: 5`)

Preconditions: none.
Timeline: identify A and end the trip at effectively the same real-world instant, five times over.
Expected end state: exactly one `rosco_driver_events` row carries `is_assignee_source` true regardless of arrival order; asset assignee, trip assignee and threshold attribution all converge on A.
Negative control: a checkpoint right after ignition-on, before the race, confirming nothing was assigned yet.
What must ship first: the advisory lock and its partial-unique-index backstop. This matches the design doc's current O9 row (identification and trip end fired at the same time, run several times). See `06-BLOCKERS.md` for the older numbering this replaced.

## O12a — Trip lookup: open trip covers (`o-trip-lookup.spec.ts`)

See the covering-guard table in `AGENT-BRIEF.md` / the design doc's "Trip lookup" section. Identify A while the trip is open. Linked, assignee written, same shape as O2's core assertion in miniature.

## O12b — Trip lookup: closed trip covers, `end_date >= ts` (`o-trip-lookup.spec.ts`)

Run and close a trip; deliver a late identification timestamped inside it. Linked, `flags.arrived_after_trip_ended` true, assignee written by the identification consumer's own insert-time path (no later trip exists to supersede it).

## O12c — Trip lookup: identification between two trips (`o-trip-lookup-gaps.spec.ts`)

Run and close a trip, start a second one, and deliver an identification timestamped in the gap between them. At insert the covering guard finds trip 1, which ended before the identification, so the row is not linked and carries `arrived_before_trip_created` (checkpoint). When trip 2 ends, its search window is floored at trip 1's end, so it links the row and awards it the claim: asset A, trip 2 A. The design doc's trip-end section: "an identification between two trips belongs to the trip that followed it".

## O12d — Trip lookup: no trip at all (`o-trip-lookup.spec.ts`)

Identical construction and outcome to O5, filed separately because it is one of the doc's six named trip-lookup fixtures rather than its own distinct write-guard story.

## O12e — Trip lookup: heartbeat/virtual trip, skipped by the type filter (`o-trip-lookup.spec.ts`)

A trip whose `type` is not `normal` covering the identification's timestamp. Behaves as O12d: the lookup's `type = 'normal'` filter makes the trip invisible to the query. See `06-BLOCKERS.md`: the Step vocabulary has no way to force a heartbeat or virtual trip type, so this case depends on the telemetry emitter (module C) exposing one.

## O12f — Trip lookup: trip created after its own start (`o-trip-lookup.spec.ts`)

Deliver an identification before any trip exists; then create a trip, backdated, whose `start_date` precedes the identification. Linked at trip end, because the lookup orders by `start_date`, not by row-creation time. Same shape as O3.1; this case's distinguishing point is the ordering guarantee specifically.

## O8b — Identification for a contact already disabled when it arrives (`o-guards.spec.ts`)

Compiled from `fixtures/O8b-contact-disabled-before-identification.json`. Maps to the doc's O8 row; not a separate row in its table.
Preconditions: asset assignee B.
Timeline: deactivate A; start a trip (HARDBRAKE at 30); identify A at 70 while the trip is open; end the trip at 150.
Checkpoint: after the identification settles, the row exists, is unlinked (the consumer skips the trip lookup for an ineligible row), has `is_assignee_source` null, and reads `contact_active` false. The asset and trip assignees are unchanged.
Expected end state: the row is linked to the trip with `flags.contact_is_active` false, no claim is awarded, the asset and trip assignees are unchanged, and no violation is transferred. The runner re-enables A when the scenario ends.

## O13 — Threshold reassignment excludes already-transferred violations (`o-guards.spec.ts`, `@slow`)

Preconditions: none.
Timeline: run and close a trip with three violations; manually transfer the first to C; then deliver a late identification for A timestamped at the first violation.
Expected end state: the manually-transferred violation stays with C (`transferred_by_id` is the human, which the selection excludes: `transferred_by_id IS NULL OR = the FR service user`); asset and trip assignee become A.
Negative control: `thresholdEvents.stillAssignedTo: { driver: 'C', which: 'first' }`, the doc's own named negative control for this case.
What must ship first: the trip-end consumer's threshold-event selection (the three bounds: before the winner's receipt time, a different assignee, not already transferred).
Known gap: see `06-BLOCKERS.md`. `ThresholdEventExpectation` has no field for "this specific non-`'all'` subset is now assigned to the winner", so the reassignment half of this case is only covered indirectly, through the asset/trip assignee assertions.

## O14 — Identification timestamped before its own trip started (`o-trip-lookup.spec.ts`)

Preconditions: asset assignee D. An identification for A stamped 120 seconds before its trip starts. At insert it belongs to no trip, so it is unlinked (checkpoint). At trip end the search window is floored at the previous trip's end (or at the trip's start minus the ten-minute pre-start tolerance when there is no previous trip), so the row is found, linked and awarded the claim: asset A, trip A. This follows the design doc's trip-end section and the consumer. The doc's O14 row ("no assignee change across the board") disagrees; see `06-BLOCKERS.md`.

## O15 — Type 6 then Type 7 in one trip (`o-live.spec.ts`)

Preconditions: none.
Timeline: an unidentified event (`unDrv`), then identify A, both inside one open trip.
Expected end state: the unDrv row persists with `contact_id` null and is never linked to any trip at any point, because an unDrv "is persisted only, with no trip lookup and no claim attempt" per the design doc. A wins the claim normally.
Negative control: the checkpoint right after the unDrv event, confirming it changed nothing.
What must ship first: the identification consumer's branch for an unDrv or a contact-less identDrv (persist-only, no lookup).

## O16 — Redelivered webhook, byte-identical payload (`o-live.spec.ts`)

Preconditions: none.
Timeline: identify A; then redeliver the identical payload (same normalised timestamp string, so the deterministic `event_id` collides).
Expected end state: exactly one row, one asset-assignee audit entry.
Negative control: `driverEventRowCount: 1` both mid-timeline and at the end.
What must ship first: the deterministic `event_id` generation (`uuidv5(FR_NAMESPACE, vehicle_id|event.name|normalizedTimestamp|driver_guid)`) and the unique index on it.

## O17 — Second driver identified later in the same still-open trip (`o-live.spec.ts`)

Preconditions: none.
Timeline: identify A; later (compressed to well within the trip's real duration), identify B on the same still-open trip; end the trip.
Expected end state: assignee stays A throughout; B's row persists, `is_assignee_source` false.
Negative control: a checkpoint right after ignition-on, before A's identification, asserts `'unchanged'` (the pre-timeline `null` baseline). A second checkpoint pins the literal value A right after A's identification, and the final assertion repeats it, which is what shows B's later identification did not move it.
What must ship first: same claim mechanism as O4.
Note: the design doc's own O17 is a multi-day trip, and `MAX_TRIP_SECONDS` (`src/constants.ts`, 300s) now caps every trip this suite generates, so the day-boundary claim itself cannot be reproduced by live emission. This scenario proves only the mechanism (a second identification on a still-open trip is discarded), which is otherwise identical to O4 at a shorter interval. See `06-BLOCKERS.md`.

## O18 — Licence revoked mid-flight (`o-licence.spec.ts`)

Preconditions: facial recognition licence enabled.
Timeline: identify A while the trip is open; revoke the licence; identify B; end the trip.
Expected end state: asset and trip stay A. B's webhook is accepted (200) but produces no `rosco_driver_events` row at all, because the identification consumer's own license check runs and stops before any persistence.
Negative control: `driverEventRowCount: 1`, asserting B genuinely left no trace rather than an inert one.
What must ship first: the per-message license check in all three consumers.

## O19 — TrackIt exclusivity (`o-licence.spec.ts`)

Preconditions: facial recognition licence enabled, and a `trackit` account integration. TrackIt is an integration, not a licence. The runner adds a placeholder integration (its `api_key` is not a real TrackIt key) and deletes it when the scenario ends.
Timeline: run a trip with one violation, identify A while it is open, end the trip.
Expected end state: a clean, uncontested convergence on A, and trackit's pod logs `Skipping TrackIt assignee override: facial_recognition license enabled for account: <account>`. The early exit writes nothing to any table, so the log line is the direct proof. Without it, a TrackIt that ran and failed on the placeholder key would pass the outcome checks too.
Negative control: the checkpoint right after ignition-on, before the identification, confirming a null baseline.
What must ship first: the mirror licence check in `TripEventService.getAssigneeOverrides()`'s early exit. It shipped in hapi-server-trackit `v1.2.0-build.3` (TS-43906), which checks the `fcr` module and treats an account with no module row as not enabled.

## O20 — The live assignee publish is lost

Not automated. Priority P1 in the design doc, but the audit detects a lost publish and the team reacts to it, so there is nothing for an automated test to prove; see `OUT-OF-SCOPE.md` for the full reasoning and `06-BLOCKERS.md` for the decision record. `src/scenarios/resilience.ts` and `tests/o-resilience.spec.ts` are deleted.

## O21 — Asset's very first trip, pre-start tolerance (`o-first-trip.spec.ts`)

Preconditions: none, and this must be the asset's first trip ever (a fresh fixture, not reused).
Timeline: identify A five minutes before the asset's first trip starts; run and close the trip.
Expected end state: linked and awarded, via the ten-minute pre-start tolerance used when no previous trip exists to floor the window.
What must ship first: the trip-end consumer's pre-start-tolerance fallback (`resolveWindowStart`), which has shipped. Opt-in with `ALLOW_FRESH_ASSETS=1`, since it creates a new asset every run.

## O22 — Trip start arrives after an identification for that trip (`o-trip-start.spec.ts`)

Preconditions: none.
Timeline: identify A before the trip appears in Tenna; then the trip-started message arrives, backdated. A hard brake follows 30 seconds after the award, with the trip still open.
Expected end state: linked, awarded, both assignees written, and the assignee publish fires so threshold events raised for the rest of the trip already carry A. The hard brake's violation is on A with nothing transferred.
What must ship first: the trip-start consumer, which shipped in the initial release (TS-43907).

## O23 — Trip-start and trip-end both run against the same linked row (`o-trip-start.spec.ts`)

Preconditions: none.
Timeline: a normal live identification inside an open trip, ending normally.
Expected end state: trip-end finds the claim already decided and both writes already in place, and does nothing a second time.
What must ship first: the trip-start consumer, plus both consumers' check-before-write idempotency.

## O24 — Trip-started published inside the trip-end path (`o-trip-start.spec.ts`)

Preconditions: none.
Timeline: a normal live identification, then ignition-off.
Expected end state: degrades to O23's outcome, because both consumers keep the trip-recency and trip-driver guards regardless of whether the trip is nominally still open.
What must ship first: same as O23. See `06-BLOCKERS.md`: forcing the actual adjacent-publish ordering this case describes is not expressible through any Step kind; this scenario asserts the outcome as a best-effort proxy.
