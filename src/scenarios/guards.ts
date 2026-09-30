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
import o8bFixture from '../../fixtures/O8b-contact-disabled-before-identification.json';
import o8cFixture from '../../fixtures/O8c-identification-for-unknown-contact.json';
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
  title: 'Manual correction newer than the identification survives, trip write is unaffected',
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
    // The identification is delivered after trip end, so only the backfill cron moves these.
    thresholdEvents: [{ tripRef: 'latest', allAssignedTo: 'A', viaBackfill: true }],
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
  driver: 'D',
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
  // The identified driver is D, not A: O8 and O8b deactivate their driver, and D is the one no
  // other scenario in this file uses, so the rest of the file can run alongside them. B keeps the
  // required 'unchanged' assertions falsifiable against a buggy award that writes D anyway.
  preconditions: { assetAssignee: 'B' },
  timeline: o8Timeline,
  expectAfterStep: [
    {
      afterIndex: o8IdentSettleIndex,
      expect: {
        assetAssignee: { value: 'unchanged' },
        driverEvents: [{ driver: 'D', isAssigneeSource: null, tripLink: { state: 'unlinked' } }],
      },
    },
  ],
  expect: {
    assetAssignee: { value: 'unchanged' },
    trips: [{ tripRef: 'latest', assignee: 'unchanged' }],
    driverEvents: [
      {
        driver: 'D',
        // No `isAssigneeSource` here. The doc's O8 row asks for no asset write, no trip write and
        // no reassignment, which the assignee expectations above cover. Whether the row itself
        // wins the claim is not part of it: on dv3 (2026-09-28) the row won the claim
        // (`is_assignee_source: true`) and the contact-status guard then blocked both writes,
        // the stale-but-allowed state design doc line 690 describes.
        tripLink: { state: 'linked', tripRef: 'latest' },
        // No `contactActive` either. The contact is active when this row is written and is
        // deactivated afterward, so the row's insert-time snapshot stays active (the table has no
        // `contact_active` column; the snapshot is `flags.contact_is_active`, written only when
        // false). What blocks the writes is the trip-end guard's live re-check of the contact
        // (`contactIsLive` in hapi-server-rosco-ingestion-rmq's `tripClaim.ts`), which the
        // assignee and violation expectations prove. O8b covers a contact already disabled at insert.
      },
    ],
    thresholdEvents: [{ tripRef: 'latest', noTransfers: true }],
  },
  rationale:
    "The doc: 'Re-check the winning contact's live enabled and deleted state, rather than the row's frozen flag. Inactive or deleted skips the asset write, the trip write and the reassignment.' The identification is sent before any trip exists, so the claim is decided at trip end. D is active when the row is written, so the row is eligible and wins the claim, and D is deactivated before the trip ends. The trip-end consumer then re-checks D's live state and skips every write. The assignee and violation expectations are the proof. Compiled from fixtures/O8-contact-deactivated-before-trip-end.json (`delay.mode: 'full-burst'`, `burstStartAtSec: 20`: identification delivered at deliverAtSec 0, before any trip exists, trip frames follow as a burst) via fixturePlayback.ts; the `deactivateContact` step is spliced in right after the identification's own settle, since the fixture format has no field for it. The fixture carries a HARDBRAKE at atSec 30, before the identification's claimed atSec 60, so `thresholdEvents: { noTransfers: true }` is a live proof the deactivated contact never picks up a violation, not a vacuous pass against an empty trip. The runner re-enables D when the scenario ends",
};

// ---------------------------------------------------------------------------
// O8b — compiled from fixtures/O8b-contact-disabled-before-identification.json
// ---------------------------------------------------------------------------

// D is deactivated before the trip starts, so the identification arrives for a contact that is
// already disabled. The runner re-enables D when the scenario ends. D, like O8, because no other
// scenario in this file uses it.
const o8bBase: Step[] = [
  { kind: 'deactivateContact', atSec: 0, driver: 'D', note: 'disabled before the identification arrives' },
  ...expandFixtureToSteps(o8bFixture as Fixture),
];
const o8bIdentIndex = lastIndexWhere(o8bBase, (s) => s.kind === 'ident');
const o8bWithIdentSettle = insertAfterIndex(o8bBase, o8bIdentIndex, {
  kind: 'settle',
  atSec: 71,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});
const o8bIdentSettleIndex = o8bIdentIndex + 1;
const o8bTimeline: Step[] = [...o8bWithIdentSettle, { kind: 'settle', atSec: 151, until: 'tripEnded', budget: 'TRIP_END_BUDGET_MS' }];

const O8b: Scenario = {
  id: 'O8b',
  title: 'Identification for a contact already disabled when it arrives',
  priority: 'P0',
  tags: [],
  // B keeps the 'unchanged' assertions falsifiable against a buggy consumer that writes D anyway.
  preconditions: { assetAssignee: 'B' },
  timeline: o8bTimeline,
  expectAfterStep: [
    {
      afterIndex: o8bIdentSettleIndex,
      expect: {
        assetAssignee: { value: 'unchanged' },
        trips: [{ tripRef: 'latest', assignee: 'unchanged' }],
        // Ineligible at insert, so the identification consumer does no trip lookup at all.
        driverEvents: [{ driver: 'D', isAssigneeSource: null, tripLink: { state: 'unlinked' }, contactActive: false }],
      },
    },
  ],
  expect: {
    assetAssignee: { value: 'unchanged' },
    trips: [{ tripRef: 'latest', assignee: 'unchanged' }],
    driverEvents: [
      {
        driver: 'D',
        // Trip end links every unlinked row to the trip and awards nothing to an ineligible one.
        // No `isAssigneeSource`: the local consumer source marks such a row false, but on dv3
        // (2026-09-28) it stayed null. The doc's O8 row only asks that nothing is written, which
        // the assignee and violation expectations cover.
        tripLink: { state: 'linked', tripRef: 'latest' },
        contactActive: false,
        flags: { contact_is_active: false },
      },
    ],
    thresholdEvents: [{ tripRef: 'latest', noTransfers: true }],
  },
  rationale:
    "The doc's O8: 'Driver identification for deactivated Contact. No asset write, no trip write, no reassignment.' This is that case with the contact disabled before the identification arrives; O8 covers it being deactivated after its row is written. The identification consumer resolves D, records the contact as inactive (flags.contact_is_active false, the design's 'row still persists with its contact and the inactive flag'), and skips the trip lookup because the row is not eligible. At trip end the row is linked to the trip and no claim is awarded, so nothing is written. The HARDBRAKE at atSec 30 makes `noTransfers` a live check rather than a pass against an empty trip. Not a separate row in the doc's table; it maps to O8.",
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

// ---------------------------------------------------------------------------
// O8c — compiled from fixtures/O8c-identification-for-unknown-contact.json
// ---------------------------------------------------------------------------

const o8cBase = expandFixtureToSteps(o8cFixture as Fixture);
const o8cIdentIndex = lastIndexWhere(o8cBase, (s) => s.kind === 'ident');
const o8cWithIdentSettle = insertAfterIndex(o8cBase, o8cIdentIndex, {
  kind: 'settle',
  atSec: 71,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});
const o8cIdentSettleIndex = o8cIdentIndex + 1;
const o8cTimeline: Step[] = [...o8cWithIdentSettle, { kind: 'settle', atSec: 151, until: 'tripEnded', budget: 'TRIP_END_BUDGET_MS' }];

const O8c: Scenario = {
  id: 'O8c',
  title: 'Identification whose driver_guid matches no contact',
  priority: 'P0',
  tags: [],
  preconditions: { assetAssignee: 'B' },
  timeline: o8cTimeline,
  expectAfterStep: [
    {
      afterIndex: o8cIdentSettleIndex,
      expect: {
        assetAssignee: { value: 'unchanged' },
        trips: [{ tripRef: 'latest', assignee: 'unchanged' }],
        // An unresolved guid is persisted as unidentified, so there's no trip lookup at insert.
        driverEvents: [{ driver: null, type: 'identDrv', isAssigneeSource: null, tripLink: { state: 'unlinked' } }],
      },
    },
  ],
  expect: {
    assetAssignee: { value: 'unchanged' },
    trips: [{ tripRef: 'latest', assignee: 'unchanged' }],
    driverEvents: [{ driver: null, type: 'identDrv', count: 1, isAssigneeSource: null }],
    thresholdEvents: [{ tripRef: 'latest', noTransfers: true }],
  },
  rationale:
    "QA T16521553: a Type 7 whose driver_guid is no Tenna contact. The identification consumer's `resolveContact` finds no contact, so the row is persisted as unidentified (contact_id null), is never eligible, and nothing is written. The HARDBRAKE at atSec 30 makes `noTransfers` a live check. Not a row in the doc's table; it sits next to O8 because it's the same eligibility rule. The guid is random per execution (`unknownDriver` on the identification).",
};

export const GUARDS_SCENARIOS: readonly Scenario[] = [O7_1, O7_2, O8, O8b, O8c, O13];
