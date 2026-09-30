/**
 * `o-trip-start.spec.ts` scenarios: O22, O23, O24. Fleet `fr-trip-start`.
 *
 * The trip-start consumer (`AssetTripStartedConsumer` in hapi-server-rosco-ingestion-rmq) shipped
 * with the initial release, so these run by default.
 * Every case has a fixture under `fixtures/` and is compiled from it via `fixturePlayback.ts`'s
 * `expandFixtureToSteps`.
 */

import type { Fixture } from '../fixture/types';
import type { Scenario, Step } from '../scenario/types';
import o22Fixture from '../../fixtures/O22-trip-start-after-identification.json';
import o23Fixture from '../../fixtures/O23-trip-start-and-trip-end-same-row.json';
import o24Fixture from '../../fixtures/O24-duplicate-trip-started-republish.json';
import { expandFixtureToSteps, insertAfterIndex, lastIndexWhere } from './fixturePlayback';

// ---------------------------------------------------------------------------
// O22 — compiled from fixtures/O22-trip-start-after-identification.json
// ---------------------------------------------------------------------------

const o22Base = expandFixtureToSteps(o22Fixture as Fixture);
const o22IdentIndex = lastIndexWhere(o22Base, (s) => s.kind === 'ident');
const o22WithIdentSettle = insertAfterIndex(o22Base, o22IdentIndex, {
  kind: 'settle',
  atSec: 11,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});
const o22CheckpointIndex = o22IdentIndex + 1;
const o22IgnitionOnIndex = lastIndexWhere(o22WithIdentSettle, (s) => s.kind === 'ignitionOn');
const o22Timeline: Step[] = insertAfterIndex(o22WithIdentSettle, o22IgnitionOnIndex, {
  kind: 'settle',
  atSec: 12,
  until: 'tripStarted',
  budget: 'LIVE_BUDGET_MS',
});

const O22: Scenario = {
  id: 'O22',
  title: 'A trip start arrives after an identification for that trip was already written',
  priority: 'P0',
  // tripHistory covers the first run of a new asset, since the flag needs an earlier trip.
  preconditions: { assetAssignee: 'C', tripHistory: true },
  timeline: o22Timeline,
  expectAfterStep: [
    {
      afterIndex: o22CheckpointIndex,
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
  },
  rationale:
    "The doc's O22: 'The trip-start consumer links it, awards the claim, writes both assignees and publishes the assignee change, so threshold events raised after that point already carry the identified driver.' Without the trip-start consumer, the row would be linked and correct in the database while the live scorecard state stayed wrong for the rest of the trip. Compiled from fixtures/O22-trip-start-after-identification.json (`delay.mode: 'full-burst'`, `burstStartAtSec: 5`: the identification is delivered live at deliverAtSec 0, and the trip-started message, though its own start_date is earlier, is not delivered until 5 seconds later; the trip is deliberately left open, no IGN_OFF) via fixturePlayback.ts — the burst delay mode this case is named for now actually reaches the test, rather than the hand-authored version's fixed array-order delivery.",
};

// ---------------------------------------------------------------------------
// O23 — compiled from fixtures/O23-trip-start-and-trip-end-same-row.json
// ---------------------------------------------------------------------------

const o23Base = expandFixtureToSteps(o23Fixture as Fixture);
const o23IgnitionOnIndex = lastIndexWhere(o23Base, (s) => s.kind === 'ignitionOn');
const o23WithTripStarted = insertAfterIndex(o23Base, o23IgnitionOnIndex, {
  kind: 'settle',
  atSec: 1,
  until: 'tripStarted',
  budget: 'LIVE_BUDGET_MS',
});
const o23TripStartedIndex = o23IgnitionOnIndex + 1;
const o23IdentIndex = lastIndexWhere(o23WithTripStarted, (s) => s.kind === 'ident');
const o23WithAssigneeSettle = insertAfterIndex(o23WithTripStarted, o23IdentIndex, {
  kind: 'settle',
  atSec: 61,
  until: 'assigneeWritten',
  budget: 'LIVE_BUDGET_MS',
});
const o23AssigneeSettleIndex = o23IdentIndex + 1;
const o23IgnitionOffIndex = lastIndexWhere(o23WithAssigneeSettle, (s) => s.kind === 'ignitionOff');
const o23Timeline: Step[] = insertAfterIndex(o23WithAssigneeSettle, o23IgnitionOffIndex, {
  kind: 'settle',
  atSec: 151,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});

const O23: Scenario = {
  id: 'O23',
  title: 'Trip-start and trip-end both run against the same already-linked row',
  priority: 'P0',
  preconditions: { assetAssignee: 'D' },
  timeline: o23Timeline,
  expectAfterStep: [
    { afterIndex: o23TripStartedIndex, expect: { assetAssignee: { value: 'unchanged' } } },
    { afterIndex: o23AssigneeSettleIndex, expect: { assetAssignee: { value: 'A' }, trips: [{ tripRef: 'latest', assignee: 'A' }] } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [{ driver: 'A', isAssigneeSource: true, count: 1 }],
  },
  rationale:
    "The doc's O23: 'Trip end finds the claim already decided and both writes already in place, and performs neither again.' Every step the trip-end consumer runs is the same check-before-write step the trip-start consumer already ran. Compiled from fixtures/O23-trip-start-and-trip-end-same-row.json (an ordinary live trip; A is identified at atSec 60, well before the trip closes at atSec 150) via fixturePlayback.ts. The checkpoint right after trip start, before the identification, is this scenario's required negative control (`'unchanged'` resolves against the pre-timeline snapshot); the identical literal 'A' repeated after trip end is what shows nothing moved a second time.",
};

// ---------------------------------------------------------------------------
// O24 — compiled from fixtures/O24-duplicate-trip-started-republish.json
// ---------------------------------------------------------------------------

const o24Base = expandFixtureToSteps(o24Fixture as Fixture);
const o24IgnitionOnIndex = lastIndexWhere(o24Base, (s) => s.kind === 'ignitionOn');
const o24IdentIndex = lastIndexWhere(o24Base, (s) => s.kind === 'ident');
const o24WithAssigneeSettle = insertAfterIndex(o24Base, o24IdentIndex, {
  kind: 'settle',
  atSec: 61,
  until: 'assigneeWritten',
  budget: 'LIVE_BUDGET_MS',
});
const o24AssigneeSettleIndex = o24IdentIndex + 1;
const o24IgnitionOffIndex = lastIndexWhere(o24WithAssigneeSettle, (s) => s.kind === 'ignitionOff');
const o24Timeline: Step[] = insertAfterIndex(o24WithAssigneeSettle, o24IgnitionOffIndex, {
  kind: 'settle',
  atSec: 151,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});

const O24: Scenario = {
  id: 'O24',
  title: 'A trip-started message published inside the trip-end path, immediately before trip-ended',
  priority: 'P1',
  preconditions: { assetAssignee: 'B' },
  timeline: o24Timeline,
  expectAfterStep: [
    { afterIndex: o24IgnitionOnIndex, expect: { assetAssignee: { value: 'unchanged' } } },
    { afterIndex: o24AssigneeSettleIndex, expect: { assetAssignee: { value: 'A' }, trips: [{ tripRef: 'latest', assignee: 'A' }] } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
  },
  rationale:
    "The doc's O24: 'The trip-start consumer must not assume the trip is open. The recency and trip-driver guards produce the same outcome as a trip-end-only run.' Both consumers keep the trip-recency and trip-driver guards regardless of whether the trip is nominally still open, which is exactly what degrades this case to O23's outcome. Compiled from fixtures/O24-duplicate-trip-started-republish.json (same shape as O23: A identified live at atSec 60, trip closes at atSec 150) via fixturePlayback.ts. // VERIFY (carried over from this scenario's previous hand-authored form): O24 needs a trip-started message re-published immediately before trip-ended on the same trip; no Step kind, and no fixture field, can force an out-of-band domain-event republish, so this fixture is a best-effort proxy that asserts the outcome (no double-write) rather than forcing the actual adjacent-publish ordering — forcing that, if it is needed, is left to module D/C's emitter, or this case moves to OUT-OF-SCOPE.md as manual. The checkpoint right after ignition-on, before the identification, is this scenario's required negative control (`'unchanged'` resolves against the pre-timeline snapshot); the identical literal 'A' repeated after trip end is what shows the (attempted) duplicate trip-started publish did not move anything a second time.",
};


export const TRIP_START_SCENARIOS: readonly Scenario[] = [O22, O23, O24];
