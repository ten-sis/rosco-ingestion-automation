/**
 * `o-delayed.spec.ts` scenarios: O3.1 through O3.5. Fleet `fr-delayed`.
 *
 * Every case in this file has a fixture under `fixtures/` and is compiled from it via
 * `fixturePlayback.ts`'s `expandFixtureToSteps`.
 *
 * Reading these five as rows of one table is the point of the two-clock model: a delayed TRIP is
 * `ignitionOn`/`ignitionOff` with small `atSec` values delivered *after* the `ident` that belongs
 * to them (the identification is delivered first, the trip's frames follow, backdated). A delayed
 * IDENTIFICATION is the reverse: the trip runs and closes first, and a small-`atSec` `ident` is
 * delivered late.
 *
 * A trip's own `assignee_id` is never inherited from the asset's standing assignee at creation; it
 * starts null and is set only by whichever guard-passing write reaches it first. That is what
 * makes O3.2 and O3.4 ("same driver") still produce a real trip-level write even though nothing
 * about the account's standing assignment changes.
 */

import type { Fixture } from '../fixture/types';
import type { Scenario, Step } from '../scenario/types';
import o31Fixture from '../../fixtures/O3.1-delayed-trip-different-driver.json';
import o32Fixture from '../../fixtures/O3.2-delayed-trip-same-driver.json';
import o33Fixture from '../../fixtures/O3.3-partially-delayed-trip.json';
import o34Fixture from '../../fixtures/O3.4-delayed-identification-same-driver.json';
import o35Fixture from '../../fixtures/O3.5-second-delayed-identification.json';
import { expandFixtureToSteps, insertAfterIndex, lastIndexWhere } from './fixturePlayback';

// ---------------------------------------------------------------------------
// O3.1 — compiled from fixtures/O3.1-delayed-trip-different-driver.json
// ---------------------------------------------------------------------------

const o31Base = expandFixtureToSteps(o31Fixture as Fixture);
const o31IdentIndex = lastIndexWhere(o31Base, (s) => s.kind === 'ident');
const o31WithChecked = insertAfterIndex(o31Base, o31IdentIndex, {
  kind: 'settle',
  atSec: 101,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});
const o31Timeline: Step[] = [...o31WithChecked, { kind: 'settle', atSec: 151, until: 'tripEnded', budget: 'TRIP_END_BUDGET_MS' }];
const o31CheckpointIndex = o31IdentIndex + 1;

const O3_1: Scenario = {
  id: 'O3.1',
  title: 'Delayed trip, different driver',
  priority: 'P0',
  tags: [],
  // H3: this is the first scenario in this file, so today's baseline happens to be null already,
  // but that is incidental to file order, not something this scenario should depend on. D is not
  // otherwise involved (this case uses only A), and this case's own `resulted_in_assignee_change:
  // true` assertion needs a real prior value to change FROM, so a non-null, non-A precondition
  // makes the proof explicit rather than borrowed from a fresh asset's default.
  preconditions: { assetAssignee: 'D' },
  timeline: o31Timeline,
  expectAfterStep: [
    {
      afterIndex: o31CheckpointIndex,
      expect: {
        assetAssignee: { value: 'unchanged' },
        driverEvents: [{ driver: 'A', isAssigneeSource: null, tripLink: { state: 'unlinked' } }],
      },
    },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [
      {
        driver: 'A',
        isAssigneeSource: true,
        tripLink: { state: 'linked', tripRef: 'latest' },
        flags: { arrived_before_trip_created: true, resulted_in_assignee_change: true },
      },
    ],
    thresholdEvents: [{ tripRef: 'latest', allAssignedTo: 'A' }],
  },
  rationale:
    "The plan's own O3.1: 'Row unlinked at insert. At trip end: trip_id stamped, asset assignee A, trip assignee A, violations re-assigned by the trip-end call.' Compiled from fixtures/O3.1-delayed-trip-different-driver.json (identification on the wire 20 seconds before the trip that contains it, delivered as a full burst once it arrives) via fixturePlayback.ts. Because this is the trip's own first (and only) trip-end pass, the reassignment happens directly in that pass, not on a later backfill-cron cycle, so this case needs no `@slow` tag.",
};

// ---------------------------------------------------------------------------
// O3.3 — compiled from fixtures/O3.3-partially-delayed-trip.json
// ---------------------------------------------------------------------------

const o33Base = expandFixtureToSteps(o33Fixture as Fixture);
const o33IgnitionOffIndex = lastIndexWhere(o33Base, (s) => s.kind === 'ignitionOff');
const o33WithTripEndSettle = insertAfterIndex(o33Base, o33IgnitionOffIndex, {
  kind: 'settle',
  atSec: 113,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});
const o33Timeline: Step[] = [...o33WithTripEndSettle, { kind: 'settle', atSec: 202, until: 'identificationPersisted', budget: 'LIVE_BUDGET_MS' }];
const o33TripEndCheckpointIndex = o33IgnitionOffIndex + 1;

const O3_3: Scenario = {
  id: 'O3.3',
  title: 'Delayed identification, different driver',
  priority: 'P0',
  tags: ['@slow'],
  preconditions: { assetAssignee: 'B' },
  timeline: o33Timeline,
  expectAfterStep: [
    {
      afterIndex: o33TripEndCheckpointIndex,
      expect: { assetAssignee: { value: 'unchanged' }, trips: [{ tripRef: 'latest', assignee: 'unchanged' }] },
    },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [
      {
        driver: 'A',
        isAssigneeSource: true,
        tripLink: { state: 'linked', tripRef: 'latest' },
        flags: { arrived_after_trip_ended: true, resulted_in_assignee_change: true },
      },
    ],
    thresholdEvents: [{ tripRef: 'latest', allAssignedTo: 'A' }],
  },
  rationale:
    "The plan's own O3.3: 'Asset and trip assignee become A. Violations are re-assigned by the scorecard backfill cron on its next 5-minute run, so this test polls past that boundary.' Compiled from fixtures/O3.3-partially-delayed-trip.json (the first part of the trip bursts in already-buffered, the rest plays live, and the identification arrives 30 seconds after the trip closes) via fixturePlayback.ts. `B` is a pre-existing manual/standing assignee, never itself a facial-recognition claim on this trip, so A is free to win the claim outright. Because this trip's own trip-end pass has already completed by the time A's identification lands, the trip-driver write is what puts the trip back in the widened backfill cron's scope.",
};

// ---------------------------------------------------------------------------
// O3.2 — compiled from fixtures/O3.2-delayed-trip-same-driver.json
// ---------------------------------------------------------------------------

const o32Base = expandFixtureToSteps(o32Fixture as Fixture);
const o32IdentIndex = lastIndexWhere(o32Base, (s) => s.kind === 'ident');
const o32WithIdentSettle = insertAfterIndex(o32Base, o32IdentIndex, {
  kind: 'settle',
  atSec: 81,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});
const o32CheckpointIndex = o32IdentIndex + 1;
const o32IgnitionOffIndex = lastIndexWhere(o32WithIdentSettle, (s) => s.kind === 'ignitionOff');
const o32Timeline: Step[] = insertAfterIndex(o32WithIdentSettle, o32IgnitionOffIndex, {
  kind: 'settle',
  atSec: 151,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});

const O3_2: Scenario = {
  id: 'O3.2',
  title: 'Delayed trip, same driver',
  priority: 'P0',
  tags: [],
  preconditions: { assetAssignee: 'A' },
  timeline: o32Timeline,
  expectAfterStep: [
    { afterIndex: o32CheckpointIndex, expect: { assetAssignee: { value: 'unchanged' } } },
  ],
  expect: {
    assetAssignee: { value: 'unchanged' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [{ driver: 'A', isAssigneeSource: true, flags: { resulted_in_assignee_change: false } }],
    thresholdEvents: [{ tripRef: 'latest', noTransfers: true }],
  },
  rationale:
    "The plan's own O3.2: 'Row linked and flagged. No assignee change, no threshold transfer.' 'No assignee change' is about the asset's standing assignment (already A, so `resulted_in_assignee_change` is false and nothing is re-notified); the trip's own assignee is still genuinely written for the first time, from null to A, because the trip-driver guard is a null-or-equal check with no memory of the asset's value. Compiled from fixtures/O3.2-delayed-trip-same-driver.json (`delay.mode: 'full-burst'`, `burstStartAtSec: 20`, same shape as O3.1) via fixturePlayback.ts — the burst delay mode this case is named for now actually reaches the test, rather than the hand-authored version's single fixed-order delivery. The fixture carries a HARDBRAKE at atSec 30, before the identification's claimed atSec 70, so `thresholdEvents: { noTransfers: true }` is a live proof that a real violation raised while the driver was still unknown was correctly left untransferred, not a vacuous pass against an empty trip.",
};

// ---------------------------------------------------------------------------
// O3.4 — compiled from fixtures/O3.4-delayed-identification-same-driver.json
// ---------------------------------------------------------------------------

const o34Base = expandFixtureToSteps(o34Fixture as Fixture);
const o34IgnitionOffIndex = lastIndexWhere(o34Base, (s) => s.kind === 'ignitionOff');
const o34WithTripEndSettle = insertAfterIndex(o34Base, o34IgnitionOffIndex, {
  kind: 'settle',
  atSec: 151,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});
const o34CheckpointIndex = o34IgnitionOffIndex + 1;
const o34IdentIndex = lastIndexWhere(o34WithTripEndSettle, (s) => s.kind === 'ident');
const o34Timeline: Step[] = insertAfterIndex(o34WithTripEndSettle, o34IdentIndex, {
  kind: 'settle',
  atSec: 251,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});

const O3_4: Scenario = {
  id: 'O3.4',
  title: 'Delayed identification, same driver',
  priority: 'P0',
  tags: ['@slow'],
  preconditions: { assetAssignee: 'A' },
  timeline: o34Timeline,
  expectAfterStep: [
    {
      afterIndex: o34CheckpointIndex,
      expect: { assetAssignee: { value: 'unchanged' }, trips: [{ tripRef: 'latest', assignee: 'unchanged' }] },
    },
  ],
  expect: {
    assetAssignee: { value: 'unchanged' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [
      {
        driver: 'A',
        isAssigneeSource: true,
        flags: { arrived_after_trip_ended: true, resulted_in_assignee_change: false },
      },
    ],
    thresholdEvents: [{ tripRef: 'latest', noTransfers: true }],
  },
  rationale:
    "The plan's own O3.4: 'Nothing changes.' As in O3.2, that is true of the asset's standing assignment and of the threshold events (nothing was ever attributed to anyone else, so there is nothing to transfer); the trip's own assignee is still genuinely set from null to A by this identification. `@slow` because confirming 'no transfer' honestly requires waiting past the backfill cron's boundary and observing it examine this trip and correctly do nothing, not merely asserting immediately after the identification lands. Compiled from fixtures/O3.4-delayed-identification-same-driver.json (trip closes live at atSec 150; identification claims atSec 80 but is not delivered until atSec 250) via fixturePlayback.ts. The fixture carries a HARDBRAKE at atSec 30, before the identification's claimed atSec 80, same as O3.2, so `noTransfers` is exercised against a real threshold event rather than an empty trip.",
};

// ---------------------------------------------------------------------------
// O3.5 — compiled from fixtures/O3.5-second-delayed-identification.json
// ---------------------------------------------------------------------------

const o35Base = expandFixtureToSteps(o35Fixture as Fixture);
const o35IgnitionOnIndex = lastIndexWhere(o35Base, (s) => s.kind === 'ignitionOn');
const o35IgnitionOffIndex = lastIndexWhere(o35Base, (s) => s.kind === 'ignitionOff');
const o35WithTripEndSettle = insertAfterIndex(o35Base, o35IgnitionOffIndex, {
  kind: 'settle',
  atSec: 171,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});
const o35IdentAIndex = lastIndexWhere(o35WithTripEndSettle, (s) => s.kind === 'ident' && s.driver === 'A');
const o35WithAssigneeSettle = insertAfterIndex(o35WithTripEndSettle, o35IdentAIndex, {
  kind: 'settle',
  atSec: 231,
  until: 'assigneeWritten',
  budget: 'BACKFILL_BUDGET_MS',
});
const o35AssigneeSettleIndex = o35IdentAIndex + 1;
const o35IdentBIndex = lastIndexWhere(o35WithAssigneeSettle, (s) => s.kind === 'ident' && s.driver === 'B');
const o35Timeline: Step[] = insertAfterIndex(o35WithAssigneeSettle, o35IdentBIndex, {
  kind: 'settle',
  atSec: 281,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});

const O3_5: Scenario = {
  id: 'O3.5',
  title: 'Second delayed identification, different driver, after O3.3-shaped state',
  priority: 'P0',
  tags: ['@slow'],
  preconditions: { assetAssignee: 'B' },
  timeline: o35Timeline,
  expectAfterStep: [
    { afterIndex: o35IgnitionOnIndex, expect: { assetAssignee: { value: 'unchanged' } } },
    { afterIndex: o35AssigneeSettleIndex, expect: { assetAssignee: { value: 'A' }, trips: [{ tripRef: 'latest', assignee: 'A' }] } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [
      { driver: 'A', isAssigneeSource: true, tripLink: { state: 'linked', tripRef: 'latest' } },
      // A non-winning row keeps is_assignee_source null: only the winner is ever set, to true.
      { driver: 'B', isAssigneeSource: null, tripLink: { state: 'linked', tripRef: 'latest' } },
    ],
  },
  rationale:
    "The plan's own O3.5: built on O3.3's shape, then 'ident(B, later ts, same trip). Assignee unchanged. Row persists, no claim.' B here is a second, later facial-recognition identification for the same contact that supplied the original standing assignee, arriving after A has already taken the trip's one claim; it is recorded and ignored exactly like O4's second identification. Compiled from fixtures/O3.5-second-delayed-identification.json (trip closes at atSec 170; A's identification arrives at deliverAtSec 230 and wins; B's arrives at deliverAtSec 280, after A already won) via fixturePlayback.ts. The checkpoint right after ignition-on, before either identification, is this scenario's required negative control (`'unchanged'` resolves against the precondition-B baseline captured before step 1); the identical literal 'A' repeated afterward is what shows B's second identification did not move it.",
};

export const DELAYED_SCENARIOS: readonly Scenario[] = [O3_1, O3_2, O3_3, O3_4, O3_5];
