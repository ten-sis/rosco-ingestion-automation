/**
 * `o-guards.spec.ts` scenarios: O7.1, O7.2, O8, O13. Fleet `fr-guards`.
 *
 * Every case in this file has a fixture under `fixtures/` and is compiled from it via
 * `fixturePlayback.ts`'s `expandFixtureToSteps`. The fixture format has no field for a manual
 * asset-only correction, a contact deactivation, or a manual violation transfer, so each of those
 * steps is spliced in around the compiled fixture steps with `insertAfterIndex`/`lastIndexWhere`,
 * exactly as `fixturePlayback.ts`'s doc comment describes.
 *
 * `patchAssetAssignee` only ever touches the asset. It never touches a trip's own assignee, which
 * is the mechanism behind O7.1's "trip assignee becomes A regardless": nothing in this suite's
 * manual-correction step is capable of writing the trip driver, so once the trip's own assignee is
 * set by a guard-passing identification it stays put no matter what happens to the asset
 * afterward.
 */

import type { Fixture } from '../fixture/types';
import type { Scenario, Step } from '../scenario/types';
import o71Fixture from '../../fixtures/O7.1-manual-correction-receipt-order.json';
import o72Fixture from '../../fixtures/O7.2-identification-after-manual-change.json';
import o8Fixture from '../../fixtures/O8-contact-deactivated-before-trip-end.json';
import o13Fixture from '../../fixtures/O13-exclude-transferred-violations.json';
import { expandFixtureToSteps, insertAfterIndex, lastIndexWhere } from './fixturePlayback';

// ---------------------------------------------------------------------------
// O7.1 — compiled from fixtures/O7.1-manual-correction-receipt-order.json
// ---------------------------------------------------------------------------

const o71Base = expandFixtureToSteps(o71Fixture as Fixture);
const o71IgnitionOnIndex = lastIndexWhere(o71Base, (s) => s.kind === 'ignitionOn');
const o71IdentIndex = lastIndexWhere(o71Base, (s) => s.kind === 'ident');
const o71WithAssigneeSettle = insertAfterIndex(o71Base, o71IdentIndex, {
  kind: 'settle',
  atSec: 181,
  until: 'assigneeWritten',
  budget: 'LIVE_BUDGET_MS',
});
const o71AssigneeSettleIndex = o71IdentIndex + 1;
const o71WithPatch = insertAfterIndex(o71WithAssigneeSettle, o71AssigneeSettleIndex, {
  kind: 'patchAssetAssignee',
  atSec: 190,
  driver: 'C',
  sendAfterMs: 2000,
  note: 'manual, asset-only correction; this is Tm, the association timestamp the asset write guard will later be compared against',
});
const o71IgnitionOffIndex = lastIndexWhere(o71WithPatch, (s) => s.kind === 'ignitionOff');
const o71Timeline: Step[] = insertAfterIndex(o71WithPatch, o71IgnitionOffIndex, {
  kind: 'settle',
  atSec: 201,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});

const O7_1: Scenario = {
  id: 'O7.1',
  title: 'Manual correction wins on receipt order, trip write is unaffected',
  priority: 'P0',
  tags: ['@slow'],
  // B is not otherwise involved in this scenario (it uses A and C): every scenario in this file
  // runs serially against one shared asset with nothing resetting the assignee in between, and
  // every scenario names driver A, so an unset precondition would inherit whatever the previous
  // scenario left behind -- often already A -- and a buggy write that sets A would then look
  // identical to the guard correctly leaving the assignee untouched. Starting from B every time
  // gives the 'unchanged' checkpoints somewhere real to move from.
  preconditions: { assetAssignee: 'B' },
  timeline: o71Timeline,
  expectAfterStep: [
    { afterIndex: o71IgnitionOnIndex, expect: { assetAssignee: { value: 'unchanged' } } },
    { afterIndex: o71AssigneeSettleIndex, expect: { assetAssignee: { value: 'A' }, trips: [{ tripRef: 'latest', assignee: 'A' }] } },
  ],
  expect: {
    assetAssignee: { value: 'C' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    thresholdEvents: [{ tripRef: 'latest', allAssignedTo: 'A' }],
  },
  rationale:
    "The plan's O7.1: 'Asset assignee stays C. Trip assignee becomes A regardless. Violations re-assigned by the backfill cron.' // VERIFY: the design's asset-write guard compares `received_at` (server receipt time) against the standing association's `created_at`, per 'Setting the asset assignee' — not the event's device-side timestamp, which is what the plan's own prose ('ts < Tm' / 'ts > Tm') describes. This scenario encodes the O7.1/O7.2 distinction as delivery ORDER (identification received before vs after the manual patch), because that is what actually drives `received_at`. Compiled from fixtures/O7.1-manual-correction-receipt-order.json (two violations, HARDBRAKE at 90 and HARDACCEL at 150, both before the identification's claimed atSec 180, delivered live while the trip is still open) via fixturePlayback.ts; the manual `patchAssetAssignee(C)` step is spliced in right after the identification's own `assigneeWritten` settle, since the fixture format has no field for a manual correction. The `sendAfterMs` gap on that patch exists so the two writes land far enough apart in wall-clock time that Postgres timestamps cannot tie; module D's runner must honor it. The manual patch never touches the trip, so the trip's own null-or-equal guard, having already been satisfied by A, is never revisited. The checkpoint right after ignition-on, before the identification, is this scenario's required negative control (`'unchanged'` resolves against the pre-timeline snapshot, per PLAN/01-ARCHITECTURE.md) — moved here from 'right after the first move' since the compiled fixture's first telemetry frame is not at the same position as the previous hand-authored timeline's.",
};

// ---------------------------------------------------------------------------
// O7.2 — compiled from fixtures/O7.2-identification-after-manual-change.json
// ---------------------------------------------------------------------------

const o72Base = expandFixtureToSteps(o72Fixture as Fixture);
const o72LastMoveIndex = lastIndexWhere(o72Base, (s) => s.kind === 'move');
const o72WithPatch = insertAfterIndex(o72Base, o72LastMoveIndex, {
  kind: 'patchAssetAssignee',
  atSec: 190,
  driver: 'C',
  note: 'manual correction applied before any identification exists for this trip; this is Tm',
});
const o72IgnitionOffIndex = lastIndexWhere(o72WithPatch, (s) => s.kind === 'ignitionOff');
const o72WithTripEndSettle = insertAfterIndex(o72WithPatch, o72IgnitionOffIndex, {
  kind: 'settle',
  atSec: 201,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});
const o72TripEndCheckpointIndex = o72IgnitionOffIndex + 1;
const o72IdentIndex = lastIndexWhere(o72WithTripEndSettle, (s) => s.kind === 'ident');
const o72Timeline: Step[] = insertAfterIndex(o72WithTripEndSettle, o72IdentIndex, {
  kind: 'settle',
  atSec: 401,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});

const O7_2: Scenario = {
  id: 'O7.2',
  title: 'Identification received after the manual change, asset write applies',
  priority: 'P0',
  tags: ['@slow'],
  // Same reasoning as O7.1: B is not otherwise involved (this scenario uses A and C), and the
  // manual `patchAssetAssignee(C)` step already spliced into the timeline is the intended second
  // asset write, not a substitute for this precondition.
  preconditions: { assetAssignee: 'B' },
  timeline: o72Timeline,
  expectAfterStep: [
    { afterIndex: o72TripEndCheckpointIndex, expect: { assetAssignee: { value: 'C' }, trips: [{ tripRef: 'latest', assignee: 'unchanged' }] } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    thresholdEvents: [{ tripRef: 'latest', allAssignedTo: 'A' }],
  },
  rationale:
    "The plan's O7.2: 'Asset assignee becomes A. Trip assignee becomes A. Violations by the backfill cron.' Same // VERIFY note as O7.1: the differentiator here is receipt order relative to the manual patch, not the event's own device timestamp. Compiled from fixtures/O7.2-identification-after-manual-change.json (same two-violation trip shape as O7.1) via fixturePlayback.ts: the identification claims atSec 180 but is not delivered until atSec 400, well after the trip closes (200); the manual `patchAssetAssignee(C)` step is spliced in right before the trip's own `IGN_OFF`, since the fixture format has no field for it, so it lands well before the delayed identification arrives. The checkpoint right after the trip-end settle (asset C, trip still unset) is the required negative control proving the manual correction alone did not touch the trip.",
};

// ---------------------------------------------------------------------------
// O8 — compiled from fixtures/O8-contact-deactivated-before-trip-end.json
// ---------------------------------------------------------------------------

const o8Base = expandFixtureToSteps(o8Fixture as Fixture);
const o8IdentIndex = lastIndexWhere(o8Base, (s) => s.kind === 'ident');
const o8WithIdentSettle = insertAfterIndex(o8Base, o8IdentIndex, {
  kind: 'settle',
  atSec: 61,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});
const o8IdentSettleIndex = o8IdentIndex + 1;
const o8WithDeactivate = insertAfterIndex(o8WithIdentSettle, o8IdentSettleIndex, {
  kind: 'deactivateContact',
  atSec: 62,
  driver: 'A',
  note: 'deactivated after the row exists but before any consumer ever awards the claim',
});
const o8IgnitionOffIndex = lastIndexWhere(o8WithDeactivate, (s) => s.kind === 'ignitionOff');
const o8Timeline: Step[] = insertAfterIndex(o8WithDeactivate, o8IgnitionOffIndex, {
  kind: 'settle',
  atSec: 151,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});

const O8: Scenario = {
  id: 'O8',
  title: 'Contact deactivated after winning the claim, before the trip-end backstop runs',
  priority: 'P0',
  tags: [],
  // A is not involved as a baseline here (only as the identified driver): B keeps the required
  // 'unchanged' assertions falsifiable against a buggy award that writes A anyway, the same
  // reasoning as O7.1/O7.2.
  preconditions: { assetAssignee: 'B' },
  timeline: o8Timeline,
  expectAfterStep: [
    {
      afterIndex: o8IdentSettleIndex,
      expect: {
        assetAssignee: { value: 'unchanged' },
        driverEvents: [{ driver: 'A', isAssigneeSource: null, tripLink: { state: 'unlinked' } }],
      },
    },
  ],
  expect: {
    assetAssignee: { value: 'unchanged' },
    trips: [{ tripRef: 'latest', assignee: 'unchanged' }],
    driverEvents: [
      {
        driver: 'A',
        isAssigneeSource: null,
        tripLink: { state: 'linked', tripRef: 'latest' },
        // The guard's real input (design doc :667, :688: `contact_active` is a column, read by
        // the award step's eligibility predicate, precisely because "nothing in flags decides
        // anything"). Asserted directly rather than through a flag, replacing the previous
        // `flags: { contact_inactive: false }`, which invented a key `DriverEventFlags` does not
        // define and which "absent equals false" made unfalsifiable against any store, including
        // no store at all.
        // VERIFY: design doc :667 says `contact_active` is captured "at insert", and this row is
        // inserted (unlinked) while the contact is still active -- deactivation happens
        // afterward, per this fixture's own description. A literal reading of that line would
        // have the stored value stay `true` (a stale-but-consistent state design line :690
        // explicitly allows: a stale `contact_active` can let a row win the claim's own
        // eligibility check and then still write nothing, once the live contact-status guard
        // re-checks and blocks it). Asserted `false` here per this defect's fix instruction --
        // confirm which one the first real implementation actually reports.
        contactActive: false,
      },
    ],
    thresholdEvents: [{ tripRef: 'latest', noTransfers: true }],
  },
  rationale:
    "The doc: 'Re-check the winning contact's live enabled and deleted state, rather than the row's contact_active snapshot, which records what was true at insert.' To exercise the live re-check rather than the insert-time snapshot, the identification is sent unlinked (no trip exists yet), so the claim decision is genuinely deferred to the trip-end consumer's award step, which finds A ineligible ('a resolved contact with contact_active true, and not soft-deleted') and stops. The row's own `contact_active` column -- asserted directly now, never through a flag -- is what actually proves this: it is a real column the design makes load-bearing for exactly this guard, so a store that has it wrong, or has no such column at all, now fails the assertion instead of trivially satisfying it the way an invented `flags.contact_inactive` key did. Compiled from fixtures/O8-contact-deactivated-before-trip-end.json (`delay.mode: 'full-burst'`, `burstStartAtSec: 20`: identification delivered live at deliverAtSec 0, before any trip exists, trip frames follow as a burst) via fixturePlayback.ts — another case whose declared burst delay mode now actually reaches the test; the `deactivateContact` step is spliced in right after the identification's own settle, since the fixture format has no field for it. The fixture carries a HARDBRAKE at atSec 30, before the identification's claimed atSec 60, so `thresholdEvents: { noTransfers: true }` is a live proof the deactivated contact never picks up a violation, not a vacuous pass against an empty trip.",
};

// ---------------------------------------------------------------------------
// O13 — compiled from fixtures/O13-exclude-transferred-violations.json
// ---------------------------------------------------------------------------

const o13Base = expandFixtureToSteps(o13Fixture as Fixture);
const o13IgnitionOnIndex = lastIndexWhere(o13Base, (s) => s.kind === 'ignitionOn');
const o13IgnitionOffIndex = lastIndexWhere(o13Base, (s) => s.kind === 'ignitionOff');
const o13WithTripEndSettle = insertAfterIndex(o13Base, o13IgnitionOffIndex, {
  kind: 'settle',
  atSec: 221,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});
const o13TripEndSettleIndex = o13IgnitionOffIndex + 1;
const o13WithTransfer = insertAfterIndex(o13WithTripEndSettle, o13TripEndSettleIndex, {
  kind: 'transferViolations',
  atSec: 222,
  driver: 'C',
  which: 'first',
  note: 'manual transfer of the earliest violation to C, before the winning identification is even sent',
});
const o13IdentIndex = lastIndexWhere(o13WithTransfer, (s) => s.kind === 'ident');
const o13Timeline: Step[] = insertAfterIndex(o13WithTransfer, o13IdentIndex, {
  kind: 'settle',
  atSec: 301,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});

const O13: Scenario = {
  id: 'O13',
  title: 'Threshold reassignment excludes already-transferred violations',
  priority: 'P0',
  tags: ['@slow'],
  // Same reasoning as the other scenarios in this file: B is not otherwise involved (this
  // scenario uses A and C), so the 'unchanged' checkpoint right after ignition-on has somewhere
  // real to move from.
  preconditions: { assetAssignee: 'B' },
  timeline: o13Timeline,
  expectAfterStep: [
    { afterIndex: o13IgnitionOnIndex, expect: { assetAssignee: { value: 'unchanged' } } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    thresholdEvents: [{ tripRef: 'latest', stillAssignedTo: { driver: 'C', which: 'first' } }],
  },
  rationale:
    "The doc: 'Events before the winner's receipt time with a different assignee are transferred. Already-transferred events are excluded' because `transferred_by_id IS NULL OR = the FR service user` is part of the selection, and a human's manual transfer sets `transferred_by_id` to the human, taking that event out of scope permanently. Compiled from fixtures/O13-exclude-transferred-violations.json (three violations, HARDBRAKE at 60, HARDACCEL at 120, HARDTURN at 180; the identification claims atSec 190 but is not delivered until atSec 300, after both the trip closes at 220 and the manual transfer) via fixturePlayback.ts; the `transferViolations` step is spliced in right after the trip-end settle, before the delayed identification, since the fixture format has no field for a manual transfer. `stillAssignedTo` is the doc-mandated proof of the exclusion half of this case; the required `'unchanged'` negative control (resolved against the pre-timeline snapshot) is the checkpoint right after ignition-on, before anything in this scenario runs. // GAP: `ThresholdEventExpectation` has no way to assert that a specific non-'all' subset (here, the two events that are NOT the manually-transferred one) were reassigned to the winner while a named subset stays untouched; `allAssignedTo` only asserts that every event in the trip names the same driver, which is false in this scenario by design. This scenario can therefore only assert the exclusion half of O13 directly; the reassignment half is covered indirectly by the asset/trip assignee assertions above. Reported in the final summary rather than by editing scenario/types.ts.",
};

export const GUARDS_SCENARIOS: readonly Scenario[] = [O7_1, O7_2, O8, O13];
