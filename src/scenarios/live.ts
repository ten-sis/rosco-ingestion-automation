/**
 * `o-live.spec.ts` scenarios: O1 (simulated), O2, O4, O15, O16, O17. Fleet `fr-live`.
 *
 * Every case here lands its identification while the trip is genuinely open (`@live`). Trips are
 * short and live throughout this module (AGENT-BRIEF revision 2, item 4): two to five minutes,
 * never past `MAX_TRIP_SECONDS`, with a telemetry frame at least every `PING_INTERVAL_SECONDS`
 * (58s) so the tracker is never seen as gone quiet. Every case in this file has a fixture under
 * `fixtures/` and is compiled from it via `fixturePlayback.ts`'s `expandFixtureToSteps`.
 *
 * See PLAN/03-TEST-CASES.md for the full preconditions/timeline/assert breakdown and
 * PLAN/06-BLOCKERS.md for what has to ship before each one can go green.
 */

import type { Fixture } from '../fixture/types';
import type { Scenario, Step } from '../scenario/types';
import o1Fixture from '../../fixtures/O1-happy-path-both-event-types.json';
import o2Fixture from '../../fixtures/O2-live-open-trip.json';
import o4Fixture from '../../fixtures/O4-second-identification-same-trip.json';
import o15Fixture from '../../fixtures/O15-type6-then-type7.json';
import o16Fixture from '../../fixtures/O16-redelivered-webhook.json';
import o17Fixture from '../../fixtures/O17-multi-day-trip-compressed.json';
import o15bFixture from '../../fixtures/O15b-late-type6-after-type7.json';
import o4bFixture from '../../fixtures/O4b-burst-of-identifications-same-trip.json';
import { expandFixtureToSteps, insertAfterIndex, lastIndexWhere } from './fixturePlayback';

// ---------------------------------------------------------------------------
// O1 (simulated) — compiled from fixtures/O1-happy-path-both-event-types.json
// ---------------------------------------------------------------------------

const o1Base = expandFixtureToSteps(o1Fixture as Fixture);
const o1UnDrvIndex = lastIndexWhere(o1Base, (s) => s.kind === 'ident' && s.driver === null);
const o1WithUnDrvSettle = insertAfterIndex(o1Base, o1UnDrvIndex, {
  kind: 'settle',
  atSec: 76,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});
const o1UnDrvSettleIndex = o1UnDrvIndex + 1;
const o1IdentAIndex = lastIndexWhere(o1WithUnDrvSettle, (s) => s.kind === 'ident' && s.driver === 'A');
const o1WithAssigneeSettle = insertAfterIndex(o1WithUnDrvSettle, o1IdentAIndex, {
  kind: 'settle',
  atSec: 106,
  until: 'assigneeWritten',
  budget: 'LIVE_BUDGET_MS',
});
const o1AssigneeSettleIndex = o1IdentAIndex + 1;
const o1Timeline: Step[] = [...o1WithAssigneeSettle, { kind: 'settle', atSec: 201, until: 'tripEnded', budget: 'TRIP_END_BUDGET_MS' }];

const O1: Scenario = {
  id: 'O1',
  title: 'Happy path, both event types end to end (simulated)',
  priority: 'P0',
  tags: ['@live'],
  // B is not otherwise involved, so ending at A is a real write, not residue from an earlier
  // scenario on this asset.
  preconditions: { assetAssignee: 'B' },
  timeline: o1Timeline,
  expectAfterStep: [
    {
      afterIndex: o1UnDrvSettleIndex,
      expect: {
        assetAssignee: { value: 'unchanged' },
        driverEvents: [{ driver: null, type: 'unDrv', count: 1, tripLink: { state: 'unlinked' } }],
      },
    },
    {
      afterIndex: o1AssigneeSettleIndex,
      expect: { assetAssignee: { value: 'A' }, trips: [{ tripRef: 'latest', assignee: 'A' }] },
    },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [
      // Unlinked while the trip is open (checkpoint above). Trip end links every unlinked row on
      // the trip, Type 6 included, so its link is not asserted here.
      { driver: null, type: 'unDrv', count: 1 },
      { driver: 'A', type: 'identDrv', count: 1, isAssigneeSource: true, tripLink: { state: 'linked', tripRef: 'latest' } },
    ],
    thresholdEvents: [{ tripRef: 'latest', allAssignedTo: 'A' }],
  },
  rationale:
    "The doc's O1: 'Real hardware, both event types, end to end. Both resolve, persist and behave as designed.' This is the same happy path, simulated. Both event types arrive while the trip is open: a Type 6 that must persist and change nothing, then a Type 7 for A that must win the claim. Both assignees become A while the trip is still open, and at trip end both violations, including the one from before the identification, are on A. Compiled from fixtures/O1-happy-path-both-event-types.json via fixturePlayback.ts. The checkpoint after the Type 6 settles is the negative control.",
  caveat:
    'Simulated, not a real tracker: GMS frames come from a fixture TennaCAM and the Rosco events are emulated payloads. A pass proves the pipeline end to end, not the real camera, the Rosco recognition, or the webhook Rosco itself sends. The real-hardware check stays manual (OUT-OF-SCOPE.md).',
};

// ---------------------------------------------------------------------------
// O2 — compiled from fixtures/O2-live-open-trip.json
// ---------------------------------------------------------------------------

const o2Base = expandFixtureToSteps(o2Fixture as Fixture);
const o2IgnitionOnIndex = lastIndexWhere(o2Base, (s) => s.kind === 'ignitionOn');
const o2IdentIndex = lastIndexWhere(o2Base, (s) => s.kind === 'ident');
const o2WithAssigneeSettle = insertAfterIndex(o2Base, o2IdentIndex, {
  kind: 'settle',
  atSec: 71,
  until: 'assigneeWritten',
  budget: 'LIVE_BUDGET_MS',
});
const o2Timeline: Step[] = [...o2WithAssigneeSettle, { kind: 'settle', atSec: 181, until: 'tripEnded', budget: 'TRIP_END_BUDGET_MS' }];
const o2AssigneeSettleIndex = o2IdentIndex + 1; // the settle step just inserted

const O2: Scenario = {
  id: 'O2',
  title: 'Live identification during an open trip',
  priority: 'P0',
  tags: ['@live'],
  // H3: this file's scenarios run serially against one shared asset with nothing resetting the
  // assignee between them, and every case here uses driver A. D is not otherwise involved in O2,
  // so ending at A is proof of a genuine write rather than residue left by a later scenario.
  preconditions: { assetAssignee: 'D' },
  timeline: o2Timeline,
  expectAfterStep: [
    { afterIndex: o2IgnitionOnIndex, expect: { assetAssignee: { value: 'unchanged' } } },
    {
      afterIndex: o2AssigneeSettleIndex,
      expect: {
        assetAssignee: { value: 'A' },
        trips: [{ tripRef: 'latest', assignee: 'A' }],
        driverEvents: [
          {
            driver: 'A',
            isAssigneeSource: true,
            tripLink: { state: 'linked', tripRef: 'latest' },
            flags: { resulted_in_assignee_change: true },
          },
        ],
      },
    },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    thresholdEvents: [{ tripRef: 'latest', allAssignedTo: 'A', noTransfers: true }],
  },
  rationale:
    "The doc's own words for O2: 'Both writes fire immediately. At trip end the consumer finds both already set and has nothing to reassign.' The timeline is compiled from fixtures/O2-live-open-trip.json (a three-minute trip played in real time, ON_PERIODIC every 58 seconds, one identification 70 seconds in) via fixturePlayback.ts; this scenario adds only the two `settle` waits the fixture format has no field for and the checkpoints against them. The checkpoint right after ignition-on, before the identification, proves the fixture starts clean; the checkpoint right after the identification, and the identical literal 'A' repeated in the final assertion, are what show trip end changed nothing and transferred nothing. The fixture carries a HARDBRAKE at atSec 130, after the identification, so it is scored live on A and the final `thresholdEvents` (all on A, none transferred) proves 'nothing left to reassign'. A violation before the identification is moved to A at trip end by a transfer (the trip-end consumer's `transferThresholdEvents`), which is O1's case, so it can't be the proof here.",
};

// ---------------------------------------------------------------------------
// O4 — compiled from fixtures/O4-second-identification-same-trip.json
// ---------------------------------------------------------------------------

const o4Base = expandFixtureToSteps(o4Fixture as Fixture);
const o4IgnitionOnIndex = lastIndexWhere(o4Base, (s) => s.kind === 'ignitionOn');
const o4IdentAIndex = lastIndexWhere(o4Base, (s) => s.kind === 'ident' && s.driver === 'A');
const o4WithAssigneeSettle = insertAfterIndex(o4Base, o4IdentAIndex, {
  kind: 'settle',
  atSec: 71,
  until: 'assigneeWritten',
  budget: 'LIVE_BUDGET_MS',
});
const o4AssigneeSettleIndex = o4IdentAIndex + 1;
const o4IdentBIndex = lastIndexWhere(o4WithAssigneeSettle, (s) => s.kind === 'ident' && s.driver === 'B');
const o4WithIdentBSettle = insertAfterIndex(o4WithAssigneeSettle, o4IdentBIndex, {
  kind: 'settle',
  atSec: 201,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});
const o4IdentBSettleIndex = o4IdentBIndex + 1;
const o4IgnitionOffIndex = lastIndexWhere(o4WithIdentBSettle, (s) => s.kind === 'ignitionOff');
const o4Timeline: Step[] = insertAfterIndex(o4WithIdentBSettle, o4IgnitionOffIndex, {
  kind: 'settle',
  atSec: 251,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});

const O4: Scenario = {
  id: 'O4',
  title: 'Second identification on an already-claimed trip',
  priority: 'P0',
  tags: ['@live'],
  // H3: C is not otherwise involved (this case uses A and B), so ending at A is a genuine write,
  // not residue from O2 (which runs earlier in this same file, against the same shared asset).
  preconditions: { assetAssignee: 'C' },
  timeline: o4Timeline,
  expectAfterStep: [
    { afterIndex: o4IgnitionOnIndex, expect: { assetAssignee: { value: 'unchanged' } } },
    { afterIndex: o4AssigneeSettleIndex, expect: { assetAssignee: { value: 'A' }, trips: [{ tripRef: 'latest', assignee: 'A' }] } },
    { afterIndex: o4IdentBSettleIndex, expect: { assetAssignee: { value: 'A' }, trips: [{ tripRef: 'latest', assignee: 'A' }] } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [
      { driver: 'A', count: 1, isAssigneeSource: true, tripLink: { state: 'linked', tripRef: 'latest' } },
      // A non-winning row keeps is_assignee_source null: only the winner is ever set, to true.
      { driver: 'B', count: 1, isAssigneeSource: null, tripLink: { state: 'linked', tripRef: 'latest' } },
    ],
  },
  rationale:
    "The doc: 'Only the claim winner writes the assignee. The second persists audit-only.' The advisory lock plus the partial unique index decide the claim once, at insert, for the whole trip. B's row is the proof the pipeline still records the second identification without ever acting on it. Compiled from fixtures/O4-second-identification-same-trip.json (B arrives 130 seconds after A, both while the trip is open) via fixturePlayback.ts. The checkpoint right after ignition-on, before either identification, is this scenario's required negative control (`'unchanged'` resolves against the pre-timeline snapshot, per PLAN/01-ARCHITECTURE.md); the two later checkpoints repeat the literal value 'A' to show B's identification did not move it.",
};

// ---------------------------------------------------------------------------
// O15 — compiled from fixtures/O15-type6-then-type7.json
// ---------------------------------------------------------------------------

const o15Base = expandFixtureToSteps(o15Fixture as Fixture);
const o15UnDrvIndex = lastIndexWhere(o15Base, (s) => s.kind === 'ident' && s.driver === null);
const o15WithUnDrvSettle = insertAfterIndex(o15Base, o15UnDrvIndex, {
  kind: 'settle',
  atSec: 61,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});
const o15UnDrvSettleIndex = o15UnDrvIndex + 1;
const o15IdentAIndex = lastIndexWhere(o15WithUnDrvSettle, (s) => s.kind === 'ident' && s.driver === 'A');
const o15Timeline: Step[] = insertAfterIndex(o15WithUnDrvSettle, o15IdentAIndex, {
  kind: 'settle',
  atSec: 121,
  until: 'assigneeWritten',
  budget: 'LIVE_BUDGET_MS',
});

const O15: Scenario = {
  id: 'O15',
  title: 'Type 6 (unDrv) followed by Type 7 (identDrv) in one trip',
  priority: 'P0',
  tags: ['@live'],
  // H3: D is not otherwise involved (this case uses null/unDrv and A), so ending at A is a
  // genuine write, not residue from an earlier scenario in this file.
  preconditions: { assetAssignee: 'D' },
  timeline: o15Timeline,
  expectAfterStep: [
    {
      afterIndex: o15UnDrvSettleIndex,
      expect: {
        assetAssignee: { value: 'unchanged' },
        trips: [{ tripRef: 'latest', assignee: 'unchanged' }],
        driverEvents: [{ driver: null, type: 'unDrv', count: 1, isAssigneeSource: null, tripLink: { state: 'unlinked' } }],
      },
    },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [
      // Unlinked while the trip is open (checkpoint above). Trip end links every unlinked row on
      // the trip, Type 6 included, so its link is not asserted here. It never wins the claim.
      { driver: null, type: 'unDrv', count: 1, isAssigneeSource: null },
      { driver: 'A', type: 'identDrv', count: 1, isAssigneeSource: true, tripLink: { state: 'linked', tripRef: 'latest' } },
    ],
  },
  rationale:
    "The doc: 'The identified event wins and becomes the assignee source. The unidentified row persists and is ignored.' An unDrv carries no driver id, and the identification consumer's own branch is explicit that any unDrv 'is persisted only, with no trip lookup and no claim attempt' — so the unDrv row is not linked while the trip is open. Trip end then links every unlinked row on the trip, Type 6 included, without ever making it the assignee source. Compiled from fixtures/O15-type6-then-type7.json via fixturePlayback.ts. The checkpoint right after the unDrv event's settle is the proof it changed nothing before A ever arrives.",
};

// ---------------------------------------------------------------------------
// O16 — compiled from fixtures/O16-redelivered-webhook.json
// ---------------------------------------------------------------------------

const o16Base = expandFixtureToSteps(o16Fixture as Fixture);
const o16IgnitionOnIndex = lastIndexWhere(o16Base, (s) => s.kind === 'ignitionOn');
const o16FirstIdentIndex = lastIndexWhere(o16Base, (s) => s.kind === 'ident' && s.as === 'first');
const o16WithAssigneeSettle = insertAfterIndex(o16Base, o16FirstIdentIndex, {
  kind: 'settle',
  atSec: 71,
  until: 'assigneeWritten',
  budget: 'LIVE_BUDGET_MS',
});
const o16RedeliverIndex = lastIndexWhere(o16WithAssigneeSettle, (s) => s.kind === 'ident' && s.redeliverOf === 'first');
const o16Timeline: Step[] = insertAfterIndex(o16WithAssigneeSettle, o16RedeliverIndex, {
  kind: 'settle',
  atSec: 251,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});

const O16: Scenario = {
  id: 'O16',
  title: 'Redelivered webhook, byte-identical payload',
  priority: 'P0',
  tags: ['@live'],
  // H3: C is not otherwise involved (this case uses only A), so ending at A is a genuine write,
  // not residue from an earlier scenario in this file.
  preconditions: { assetAssignee: 'C' },
  timeline: o16Timeline,
  expectAfterStep: [
    { afterIndex: o16IgnitionOnIndex, expect: { assetAssignee: { value: 'unchanged' } } },
    { afterIndex: o16RedeliverIndex, expect: { assetAssignee: { value: 'A' }, driverEventRowCount: 1 } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    driverEventRowCount: 1,
    driverEvents: [{ driver: 'A', count: 1, isAssigneeSource: true }],
  },
  rationale:
    "The doc: 'Exactly one row, collapsed by the unique (account_id, event_id). One asset assignee audit entry, not two.' event_id is uuidv5(FR_NAMESPACE, vehicle_id|event.name|normalizedTimestamp|driver_guid); the redelivery step's `redeliverOf` is what module C's emitter uses to guarantee the identical payload rather than rebuilding one that only looks the same. Compiled from fixtures/O16-redelivered-webhook.json via fixturePlayback.ts: unlike this scenario's previous hand-authored form, the fixture sends the redelivery at deliverAtSec 250, after the trip has already closed at atSec 200, so the checkpoint right after the redelivery is now also proof the redelivery collapses correctly even once the trip is no longer open. The checkpoint right after ignition-on is this scenario's required negative control; `driverEventRowCount: 1`, asserted both before and after the redelivery, is the real point of the case.",
};

// ---------------------------------------------------------------------------
// O17 — compiled from fixtures/O17-multi-day-trip-compressed.json
// ---------------------------------------------------------------------------

// Driver B's day-two identification claims atSec 93600 (26 hours) but is sent at 160, while the
// compressed trip is still open. Its timestamp is deliberately in the future when sent, so it is
// flagged, or the runner would hold it back 26 hours.
const o17Base = expandFixtureToSteps(o17Fixture as Fixture).map((s) =>
  s.kind === 'ident' && s.driver === 'B' ? { ...s, timestampAheadOfDelivery: true } : s,
);
const o17IgnitionOnIndex = lastIndexWhere(o17Base, (s) => s.kind === 'ignitionOn');
const o17IdentAIndex = lastIndexWhere(o17Base, (s) => s.kind === 'ident' && s.driver === 'A');
const o17WithAssigneeSettle = insertAfterIndex(o17Base, o17IdentAIndex, {
  kind: 'settle',
  atSec: 71,
  until: 'assigneeWritten',
  budget: 'LIVE_BUDGET_MS',
});
const o17AssigneeSettleIndex = o17IdentAIndex + 1;
const o17IdentBIndex = lastIndexWhere(o17WithAssigneeSettle, (s) => s.kind === 'ident' && s.driver === 'B');
const o17Timeline: Step[] = [
  ...insertAfterIndex(o17WithAssigneeSettle, o17IdentBIndex, {
    kind: 'settle',
    atSec: 93601,
    until: 'identificationPersisted',
    budget: 'LIVE_BUDGET_MS',
  }),
  { kind: 'settle', atSec: 171, until: 'tripEnded', budget: 'TRIP_END_BUDGET_MS' },
];

const O17: Scenario = {
  id: 'O17',
  title: 'Second driver identified later in the same still-open trip',
  priority: 'P1',
  tags: ['@live'],
  // H3: D is not otherwise involved (this case uses A and B), so ending at A is a genuine write,
  // not residue from an earlier scenario in this file.
  preconditions: { assetAssignee: 'D' },
  timeline: o17Timeline,
  expectAfterStep: [
    { afterIndex: o17IgnitionOnIndex, expect: { assetAssignee: { value: 'unchanged' } } },
    { afterIndex: o17AssigneeSettleIndex, expect: { assetAssignee: { value: 'A' }, trips: [{ tripRef: 'latest', assignee: 'A' }] } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [
      { driver: 'A', count: 1, isAssigneeSource: true },
      // A non-winning row keeps is_assignee_source null: only the winner is ever set, to true.
      { driver: 'B', count: 1, isAssigneeSource: null },
    ],
    // The HARDBRAKE before A's identification moves to A at trip end. The HARDACCEL after it is
    // scored to A live. Neither goes to B.
    thresholdEvents: [{ tripRef: 'latest', allAssignedTo: 'A' }],
  },
  rationale:
    "PM's own rule, quoted in the doc: 'Multi-day trips are not split. The assignee moves once per trip, and a second driver identified later in the same trip is discarded, because assigning them would attribute the first leg's events to the second driver.' The design doc's own O17 tests this over a multi-day trip; `MAX_TRIP_SECONDS` (`src/constants.ts`) caps every trip this suite generates at 300 seconds, so the day-boundary framing itself is not reproducible by live emission. Compiled from fixtures/O17-multi-day-trip-compressed.json via fixturePlayback.ts: the fixture keeps the trip itself compressed (IGN_OFF at atSec 170) and stretches only B's claimed timestamp (atSec 93600, standing in for the real ~26-hour-later moment) while delivering it at deliverAtSec 160, before the compressed trip's own IGN_OFF, so the trip is genuinely still open when B's identification arrives — matching the real multi-day case, where the trip has not ended either. This proves the discard happens for a second identification arriving while the trip is still open, via the plain trip-driver write guard (null-or-equal; the trip's assignee is already A, non-null and not B), not via the closed-trip discard path O3.4/O3.5 and O6/O12b exercise for a late arrival after trip end. See PLAN/06-BLOCKERS.md for why the true multi-day claim (a trip literally open for ~30 hours) is out of this suite's reach either way. The checkpoint right after ignition-on, before A's identification, asserts `'unchanged'` (the pre-timeline `null` baseline); the checkpoint right after A's win, and the identical literal 'A' repeated in the final assertion, show B's later identification did not move it.",
};

// ---------------------------------------------------------------------------
// O15b — compiled from fixtures/O15b-late-type6-after-type7.json
// ---------------------------------------------------------------------------

const o15bBase = expandFixtureToSteps(o15bFixture as Fixture);
const o15bIdentAIndex = lastIndexWhere(o15bBase, (s) => s.kind === 'ident' && s.driver === 'A');
const o15bWithAssigneeSettle = insertAfterIndex(o15bBase, o15bIdentAIndex, {
  kind: 'settle',
  atSec: 61,
  until: 'assigneeWritten',
  budget: 'LIVE_BUDGET_MS',
});
const o15bAssigneeSettleIndex = o15bIdentAIndex + 1;
const o15bTimeline: Step[] = [...o15bWithAssigneeSettle, { kind: 'settle', atSec: 151, until: 'tripEnded', budget: 'TRIP_END_BUDGET_MS' }];

const O15b: Scenario = {
  id: 'O15b',
  title: 'A late Type 6 stamped before an earlier-delivered Type 7',
  priority: 'P0',
  tags: ['@live'],
  preconditions: { assetAssignee: 'D' },
  timeline: o15bTimeline,
  expectAfterStep: [
    { afterIndex: o15bAssigneeSettleIndex, expect: { assetAssignee: { value: 'A' }, trips: [{ tripRef: 'latest', assignee: 'A' }] } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [
      { driver: 'A', type: 'identDrv', count: 1, isAssigneeSource: true, tripLink: { state: 'linked', tripRef: 'latest' } },
      { driver: null, type: 'unDrv', count: 1, isAssigneeSource: null },
    ],
  },
  rationale:
    "QA T16521587, the reverse order of O15. A's Type 7 is delivered first and wins the trip. A Type 6 stamped ten seconds before it arrives forty seconds later. An unDrv carries no contact, so it's never eligible for the claim and can't take the trip back, whatever its timestamp. The checkpoint after A's win and the identical final 'A' show the late Type 6 moved nothing.",
};

// ---------------------------------------------------------------------------
// O4b — compiled from fixtures/O4b-burst-of-identifications-same-trip.json
// ---------------------------------------------------------------------------

// No settle inside the burst: it would hold back the rest of the identifications.
const o4bBase = expandFixtureToSteps(o4bFixture as Fixture);
const o4bIgnitionOnIndex = lastIndexWhere(o4bBase, (s) => s.kind === 'ignitionOn');
const o4bTimeline: Step[] = [...o4bBase, { kind: 'settle', atSec: 151, until: 'tripEnded', budget: 'TRIP_END_BUDGET_MS' }];

const O4b: Scenario = {
  id: 'O4b',
  title: 'A burst of identifications of the same driver on one trip',
  priority: 'P1',
  tags: ['@live'],
  preconditions: { assetAssignee: 'D' },
  timeline: o4bTimeline,
  expectAfterStep: [{ afterIndex: o4bIgnitionOnIndex, expect: { assetAssignee: { value: 'unchanged' } } }],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    // Each identification has its own timestamp, so its own event_id and its own row.
    driverEvents: [{ driver: 'A', type: 'identDrv', count: 50 }],
    thresholdEvents: [{ tripRef: 'latest', allAssignedTo: 'A' }],
  },
  rationale:
    "QA T16521566: 50 Type 7s for the same driver on one open trip, two seconds apart. Every one is persisted (50 rows), only the first can win the trip, and the asset and trip move to A once. The HARDBRAKE at atSec 5, before the first identification, moves to A at trip end. The QA case also asks about database load and lock contention, which is a metrics check outside this suite.",
};

export const LIVE_SCENARIOS: readonly Scenario[] = [O1, O2, O4, O4b, O15, O15b, O16, O17];
