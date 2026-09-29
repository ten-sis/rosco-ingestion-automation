/**
 * The six O12 trip-lookup fixtures, plus O5, O14 and O6, which share the same covering-trip guard.
 * Source: design doc "Trip lookup" (the covering-guard table) and "The write guards" > Trip recency.
 *
 * Split across two spec files, each with its own fleet and asset, so they run in parallel:
 * `o-trip-lookup.spec.ts` (`TRIP_LOOKUP_SCENARIOS`, fleet `fr-trip-lookup`) and
 * `o-trip-lookup-gaps.spec.ts` (`TRIP_LOOKUP_GAP_SCENARIOS`, fleet `fr-trip-lookup-gaps`). The
 * second holds O12c and O6, the two cases whose trips sit about ten minutes apart. Each waits
 * about ten minutes before its first step so its backdated trip still lands after its
 * preconditions (`anchorTimeline` in `src/scenario/runner.ts`), and in one file those waits added
 * up behind everything else.
 *
 * Every case in this file has a fixture file under `fixtures/` and is compiled through
 * `fixturePlayback.ts`'s `expandFixtureToSteps`, the same path `live.ts`'s O2 and `delayed.ts`'s
 * O3.1/O3.3 use. `O12c` and `O6` each ship as two fixture files (`-part1`/`-part2`) meant to be
 * played in order against the same asset. Each part's own `atSec` is zero-based (`fixture/types.ts`
 * gives a multi-part fixture no field to declare a continuing clock across files), so part 2 is
 * compiled with `expandFixtureToSteps`'s `atSecOffset` option, continuing part 1's clock rather
 * than restarting it at 0 — see `TWO_PART_TRIP_GAP_SEC` below.
 *
 * `isAssigneeSource` convention used throughout this file and the rest of the suite:
 *   `true`  the row won the claim and is the trip's assignee source
 *   `null`  every other row, linked or not. Only the winner is ever set (dv3, 2026-09-28), so a
 *           row that lost the claim reads null, not false.
 */

import type { Fixture } from '../fixture/types';
import type { Scenario, Step } from '../scenario/types';
import o12aFixture from '../../fixtures/O12a-open-trip-covers.json';
import o12bFixture from '../../fixtures/O12b-closed-trip-covers.json';
import o12cPart1Fixture from '../../fixtures/O12c-part1-first-trip.json';
import o12cPart2Fixture from '../../fixtures/O12c-part2-second-trip-gap-identification.json';
import o12dFixture from '../../fixtures/O12d-no-trip-at-all.json';
import o12eFixture from '../../fixtures/O12e-heartbeat-trip-skipped.json';
import o12fFixture from '../../fixtures/O12f-trip-created-after-start.json';
import o5Fixture from '../../fixtures/O5-no-covering-trip-ever.json';
import o14Fixture from '../../fixtures/O14-identification-before-trip-started.json';
import o6Part1Fixture from '../../fixtures/O6-part1-first-trip-with-violations.json';
import o6Part2Fixture from '../../fixtures/O6-part2-late-identification-superseded.json';
import { expandFixtureToSteps, insertAfterIndex, lastIndexWhere } from './fixturePlayback';

/**
 * Real seconds inserted between a two-part fixture's two trips, on top of part 1's own last
 * `atSec`, so trip 2 never starts at or before trip 1's own end. The trip-recency guard (and the
 * covering-trip lookup) key off `start_date`/`end_date` ordering; a zero-width or negative gap
 * would let trip 2's `IGN_ON` land at or before trip 1's own `IGN_OFF`, which is exactly the kind
 * of boundary tie / inversion O6 and O12c exist to rule out, not accidentally reintroduce.
 *
 * The value is not arbitrary: fixtures/O6-part2's own identification claims atSec -600 relative
 * to ITS OWN (zero-based) trip start, standing in for "atSec 180" in part1's trip window — part1's
 * own fixture file names that exact value ("both before atSec 180, the point in this trip's window
 * that part2's identification claims"). Once part2 is offset by `lastAtSec(part1) + GAP`, that
 * identification's stamped atSec becomes `lastAtSec(part1) + GAP - 600`; solving for it to land
 * back on 180 (part1's own `IGN_OFF` is at atSec 200, so 180 keeps it inside the closed trip's
 * window, both before its own violations' re-check and short of tripping row 3 of the
 * covering-guard table, "end_date < timestamp -> do not link", which is O12c's case, not O6's)
 * gives 580. That same 580 keeps O12c's own part2 identification (local atSec -40, needing only
 * to clear part1's last atSec by more than 40) comfortably inside the gap between its two trips.
 */
const TWO_PART_TRIP_GAP_SEC = 580;

/** The highest `atSec` among a compiled part's own steps, i.e. that part's trip closing. Used to
 *  continue a two-part fixture's clock into its second part rather than restarting it at 0. */
function lastAtSec(steps: readonly Step[]): number {
  return Math.max(0, ...steps.map((s) => s.atSec));
}

// ---------------------------------------------------------------------------
// O12a — compiled from fixtures/O12a-open-trip-covers.json
// ---------------------------------------------------------------------------

const o12aBase = expandFixtureToSteps(o12aFixture as Fixture);
const o12aIgnitionOnIndex = lastIndexWhere(o12aBase, (s) => s.kind === 'ignitionOn');
const o12aWithTripStarted = insertAfterIndex(o12aBase, o12aIgnitionOnIndex, {
  kind: 'settle',
  atSec: 1,
  until: 'tripStarted',
  budget: 'LIVE_BUDGET_MS',
});
const o12aTripStartedIndex = o12aIgnitionOnIndex + 1;
const o12aIdentIndex = lastIndexWhere(o12aWithTripStarted, (s) => s.kind === 'ident');
const o12aTimeline: Step[] = insertAfterIndex(o12aWithTripStarted, o12aIdentIndex, {
  kind: 'settle',
  atSec: 71,
  until: 'assigneeWritten',
  budget: 'LIVE_BUDGET_MS',
});

const O12a: Scenario = {
  id: 'O12a',
  title: 'Trip lookup: open trip covers the identification',
  priority: 'P0',
  tags: ['@live'],
  // H3: this file's nine scenarios run serially against one shared asset with nothing resetting
  // the assignee between them, and almost every case here uses driver A. D is not otherwise
  // involved in O12a, so ending at A is proof of a genuine write, not residue from a later
  // scenario running before an earlier one gets its own precondition applied (each scenario in
  // this file gets its own distinct, non-A precondition for the same reason).
  preconditions: { assetAssignee: 'D' },
  timeline: o12aTimeline,
  expectAfterStep: [
    { afterIndex: o12aTripStartedIndex, expect: { assetAssignee: { value: 'unchanged' } } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [{ driver: 'A', isAssigneeSource: true, tripLink: { state: 'linked', tripRef: 'latest' } }],
  },
  rationale:
    "Covering-guard table, row 1: '`end_date` is null -> An open trip covers the identification -> Link.' Compiled from fixtures/O12a-open-trip-covers.json (the trip is deliberately left open; no IGN_OFF is ever sent) via fixturePlayback.ts. The checkpoint right after the trip starts, before the identification lands, proves the fixture itself is not already carrying an assignee.",
};

// ---------------------------------------------------------------------------
// O12b — compiled from fixtures/O12b-closed-trip-covers.json
// ---------------------------------------------------------------------------

const o12bBase = expandFixtureToSteps(o12bFixture as Fixture);
const o12bIgnitionOffIndex = lastIndexWhere(o12bBase, (s) => s.kind === 'ignitionOff');
const o12bWithTripEndSettle = insertAfterIndex(o12bBase, o12bIgnitionOffIndex, {
  kind: 'settle',
  atSec: 201,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});
const o12bTripEndCheckpointIndex = o12bIgnitionOffIndex + 1;
const o12bIdentIndex = lastIndexWhere(o12bWithTripEndSettle, (s) => s.kind === 'ident');
const o12bTimeline: Step[] = insertAfterIndex(o12bWithTripEndSettle, o12bIdentIndex, {
  kind: 'settle',
  atSec: 253,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});

const O12b: Scenario = {
  id: 'O12b',
  title: "Trip lookup: closed trip covers the identification (end_date >= ts)",
  priority: 'P0',
  tags: [],
  // H3: C is not otherwise involved, so ending at A is a genuine write, not residue left by O12a.
  preconditions: { assetAssignee: 'C' },
  timeline: o12bTimeline,
  expectAfterStep: [
    { afterIndex: o12bTripEndCheckpointIndex, expect: { assetAssignee: { value: 'unchanged' }, trips: [{ tripRef: 'latest', assignee: 'unchanged' }] } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [
      {
        driver: 'A',
        isAssigneeSource: true,
        tripLink: { state: 'linked', tripRef: 'latest' },
        flags: { arrived_after_trip_ended: true },
      },
    ],
  },
  rationale:
    "Covering-guard table, row 2: '`end_date >= timestamp` -> A closed trip covers the identification -> Link, and set the arrived-after-trip-ended flag.' Compiled from fixtures/O12b-closed-trip-covers.json (claimed timestamp atSec 150, inside the trip, delivered at atSec 250, fifty seconds after the trip closes at atSec 200) via fixturePlayback.ts. Because this is the trip's only identification and no later trip exists, the identification consumer's own insert-time claim-and-write still applies; nothing here depends on the trip-end consumer having anything left to do.",
};

// ---------------------------------------------------------------------------
// O12c — compiled from fixtures/O12c-part1-first-trip.json and
// fixtures/O12c-part2-second-trip-gap-identification.json, played in order against the same asset.
//
// Part1's own trip runs atSec 0-150 (IGN_OFF at 150); part2's own fixture file is zero-based
// (IGN_ON at 0, identification at atSec -40 relative to ITS OWN trip start). Part2 is compiled
// with `atSecOffset` set to part1's last atSec plus `TWO_PART_TRIP_GAP_SEC`, continuing part1's
// clock instead of restarting it, so trip2's IGN_ON lands strictly after trip1's IGN_OFF and the
// identification's claimed timestamp (part2's own atSec -40, now offset the same amount) still
// falls in the gap between the two trips, per this fixture's own design.
// ---------------------------------------------------------------------------

const o12cPart1Base = expandFixtureToSteps(o12cPart1Fixture as Fixture);
const o12cPart2Base = expandFixtureToSteps(o12cPart2Fixture as Fixture, {
  atSecOffset: lastAtSec(o12cPart1Base) + TWO_PART_TRIP_GAP_SEC,
});
const o12cBase: Step[] = [...o12cPart1Base, ...o12cPart2Base];
const o12cIdentIndex = lastIndexWhere(o12cBase, (s) => s.kind === 'ident');
const o12cWithIdentSettle = insertAfterIndex(o12cBase, o12cIdentIndex, {
  kind: 'settle',
  atSec: 6,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});
const o12cIdentSettleIndex = o12cIdentIndex + 1;
const o12cTimeline: Step[] = [
  ...o12cWithIdentSettle,
  { kind: 'settle', atSec: 901, until: 'tripEnded', budget: 'TRIP_END_BUDGET_MS' },
];

const O12c: Scenario = {
  id: 'O12c',
  title: 'Trip lookup: identification between two trips, unlinked at insert, claimed by the trip that follows',
  priority: 'P0',
  tags: [],
  // B is not otherwise involved (this case uses only A), so ending at A is a real write.
  preconditions: { assetAssignee: 'B' },
  timeline: o12cTimeline,
  expectAfterStep: [
    {
      // At insert the latest trip that started before the identification is trip 1, which ended
      // before it, so the covering guard does not link it (the doc's table, row 3).
      afterIndex: o12cIdentSettleIndex,
      expect: {
        assetAssignee: { value: 'unchanged' },
        driverEvents: [
          { driver: 'A', isAssigneeSource: null, tripLink: { state: 'unlinked' }, flags: { arrived_before_trip_created: true } },
        ],
      },
    },
  ],
  expect: {
    // At trip 2's end, its search window is floored at trip 1's end, so it finds the row and
    // awards it the claim: "an identification between two trips belongs to the trip that followed
    // it" (design doc, trip-end search window).
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [{ driver: 'A', isAssigneeSource: true, tripLink: { state: 'linked', tripRef: 'latest' } }],
  },
  rationale:
    "Covering-guard table, row 3: '`end_date < timestamp` -> The identification happened after that trip ended -> Do not link. The row persists with no trip.' That is the insert-time result, asserted at the checkpoint. The doc's trip-end section then says the search window's 'lower bound is therefore the previous trip's end rather than this trip's start' and 'an identification between two trips belongs to the trip that followed it', which the consumer implements (`resolveWindowStart` in hapi-server-rosco-ingestion-rmq), so trip 2's end links the row and awards it the claim. Compiled from fixtures/O12c-part1-first-trip.json and fixtures/O12c-part2-second-trip-gap-identification.json, played in order against the same asset, via fixturePlayback.ts. Part2 is compiled with `atSecOffset: lastAtSec(o12cPart1Base) + TWO_PART_TRIP_GAP_SEC` (see that constant's own comment) so its trip continues part1's clock (150) rather than restarting at 0; its identification's local atSec -40 lands at 690, inside the gap between trip1's end (150) and trip2's start (730).",
};

// ---------------------------------------------------------------------------
// O12d — compiled from fixtures/O12d-no-trip-at-all.json
// ---------------------------------------------------------------------------

const o12dBase = expandFixtureToSteps(o12dFixture as Fixture);
const o12dIdentIndex = lastIndexWhere(o12dBase, (s) => s.kind === 'ident');
const o12dTimeline: Step[] = insertAfterIndex(o12dBase, o12dIdentIndex, {
  kind: 'settle',
  atSec: 61,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});

const O12d: Scenario = {
  id: 'O12d',
  title: 'Trip lookup: no trip at all on the asset',
  priority: 'P0',
  tags: [],
  // H3: C is not otherwise involved. This case expects 'unchanged'; a non-A precondition makes
  // that an actual proof rather than a trivial pass against residue left by an earlier scenario.
  preconditions: { assetAssignee: 'C' },
  timeline: o12dTimeline,
  expect: {
    assetAssignee: { value: 'unchanged' },
    driverEvents: [{ driver: 'A', isAssigneeSource: null, tripLink: { state: 'unlinked' } }],
  },
  rationale:
    "Covering-guard table, row 4: 'No row -> No normal trip started at or before this timestamp -> Do not link.' Compiled from fixtures/O12d-no-trip-at-all.json (`trip.events` is intentionally empty) via fixturePlayback.ts. No trip is ever run on this asset in this scenario, so there is nothing for even a later trip-end pass to find.",
};

// ---------------------------------------------------------------------------
// O12e — compiled from fixtures/O12e-heartbeat-trip-skipped.json
// ---------------------------------------------------------------------------

const o12eBase = expandFixtureToSteps(o12eFixture as Fixture);
const o12eIdentIndex = lastIndexWhere(o12eBase, (s) => s.kind === 'ident');
const o12eTimeline: Step[] = insertAfterIndex(o12eBase, o12eIdentIndex, {
  kind: 'settle',
  atSec: 61,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});

const O12e: Scenario = {
  id: 'O12e',
  title: 'Trip lookup: a heartbeat trip covers the identification, skipped by the type filter',
  priority: 'P0',
  tags: [],
  // H3: D is not otherwise involved. This case expects 'unchanged'; a non-A precondition makes
  // that an actual proof rather than a trivial pass against residue left by an earlier scenario.
  preconditions: { assetAssignee: 'D' },
  fixme:
    'The telemetry emitter can only produce normal trips, so a normal trip covers the identification and wins the claim. Needs a heartbeat or virtual trip, which no Step kind can produce yet (PLAN/06-BLOCKERS.md).',
  timeline: o12eTimeline,
  expect: {
    assetAssignee: { value: 'unchanged' },
    trips: [{ tripRef: 'latest', assignee: 'unchanged', type: 'heartbeat' }],
    driverEvents: [{ driver: 'A', isAssigneeSource: null, tripLink: { state: 'unlinked' } }],
  },
  rationale:
    "Trip lookup SQL filters on `type = 'normal'`, so a heartbeat or virtual trip is invisible to the query regardless of whether its window covers the timestamp. The doc's own O12 row: 'Skipped by the type filter, behaves as O12d.' Compiled from fixtures/O12e-heartbeat-trip-skipped.json via fixturePlayback.ts; the `type: 'heartbeat'` in the trip expectation is there to confirm the fixture itself is the right shape, not to assert anything about the write. // VERIFY (carried over from this scenario's previous hand-authored form, since the compiled Step vocabulary still has no way to express it): the `Scenario`/`Step` types have no field that forces a heartbeat or virtual trip type; the covering trip's `type` column is decided by the telemetry emitter's frame shape (module C), not by anything a fixture's `trip.type` metadata field can select on its own. This scenario assumes the emitter exposes a way to produce a heartbeat trip from this fixture's IGN_ON/ON_PERIODIC/IGN_OFF events; if it cannot, this case moves to OUT-OF-SCOPE.md as manual.",
};

// ---------------------------------------------------------------------------
// O12f — compiled from fixtures/O12f-trip-created-after-start.json
// ---------------------------------------------------------------------------

const o12fBase = expandFixtureToSteps(o12fFixture as Fixture);
const o12fIdentIndex = lastIndexWhere(o12fBase, (s) => s.kind === 'ident');
const o12fWithIdentSettle = insertAfterIndex(o12fBase, o12fIdentIndex, {
  kind: 'settle',
  atSec: 101,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});
const o12fIdentCheckpointIndex = o12fIdentIndex + 1;
const o12fIgnitionOffIndex = lastIndexWhere(o12fWithIdentSettle, (s) => s.kind === 'ignitionOff');
const o12fTimeline: Step[] = insertAfterIndex(o12fWithIdentSettle, o12fIgnitionOffIndex, {
  kind: 'settle',
  atSec: 151,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});

const O12f: Scenario = {
  id: 'O12f',
  title: "Trip lookup: the trip is created after its own start (lookup orders by start_date)",
  priority: 'P0',
  tags: [],
  // H3: B is not otherwise involved, so ending at A is a genuine write, not residue.
  // tripHistory: arrived_before_trip_created needs an earlier trip that ended before the identification.
  preconditions: { assetAssignee: 'B', tripHistory: true },
  timeline: o12fTimeline,
  expectAfterStep: [
    {
      afterIndex: o12fIdentCheckpointIndex,
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
        flags: { arrived_before_trip_created: true },
      },
    ],
  },
  rationale:
    "The doc's O12f: 'backdated trip creation covering the timestamp -> Linked; the lookup orders by start_date, not by creation.' Compiled from fixtures/O12f-trip-created-after-start.json (`delay.mode: 'full-burst'`, `burstStartAtSec: 20`: the identification is delivered live at deliverAtSec 0, before any trip exists, and the trip's own frames then arrive as a full burst starting 20 seconds into playback) via fixturePlayback.ts — the first fixture in this file whose declared burst delay mode now actually reaches the test, rather than being replaced by a hand-authored delivery order that only approximated it. At insert time no trip exists yet, so the row is unlinked (checkpoint). The trip-end pass, once the backdated trip exists and closes, finds this row inside its search window (floored at the trip's own start_date; see O14 below) and links and awards it. Same shape as O3.1; the point of this case specifically is the ordering guarantee, not the delay itself.",
};

// ---------------------------------------------------------------------------
// O5 — compiled from fixtures/O5-no-covering-trip-ever.json
// ---------------------------------------------------------------------------

const o5Base = expandFixtureToSteps(o5Fixture as Fixture);
const o5IdentIndex = lastIndexWhere(o5Base, (s) => s.kind === 'ident');
const o5Timeline: Step[] = insertAfterIndex(o5Base, o5IdentIndex, {
  kind: 'settle',
  atSec: 61,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});

const O5: Scenario = {
  id: 'O5',
  title: 'Identification with no covering trip, ever',
  priority: 'P0',
  tags: [],
  // H3: C is not otherwise involved. This case expects 'unchanged'; a non-A precondition makes
  // that an actual proof rather than a trivial pass against residue left by an earlier scenario.
  preconditions: { assetAssignee: 'C' },
  timeline: o5Timeline,
  expect: {
    assetAssignee: { value: 'unchanged' },
    driverEvents: [{ driver: 'A', isAssigneeSource: null, tripLink: { state: 'unlinked' } }],
  },
  rationale:
    "The plan's own gloss on O5: 'The row persists unlinked... Record the gap between the identification and the next trip start, which is the measurement that decides whether the phase-2 trip-start consumer is built.' Compiled from fixtures/O5-no-covering-trip-ever.json (`trip.events` intentionally empty, same shape as O12d) via fixturePlayback.ts. The gap measurement itself is a metrics concern (`facial_recognition_trip_lookup_total{outcome=no_covering_trip}`), which the Scenario/Expectation type has no field for; this scenario can only assert the row-level outcome (unlinked, no write), not the timing measurement. Distinct from O12f and O3.1: here no trip ever follows within the run, so there is nothing for a later trip-end pass to find either.",
};

// ---------------------------------------------------------------------------
// O14 — compiled from fixtures/O14-identification-before-trip-started.json
// ---------------------------------------------------------------------------

const o14Base = expandFixtureToSteps(o14Fixture as Fixture);
const o14IdentIndex = lastIndexWhere(o14Base, (s) => s.kind === 'ident');
const o14WithIdentSettle = insertAfterIndex(o14Base, o14IdentIndex, {
  kind: 'settle',
  atSec: -119,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});
const o14IdentCheckpointIndex = o14IdentIndex + 1;
const o14IgnitionOffIndex = lastIndexWhere(o14WithIdentSettle, (s) => s.kind === 'ignitionOff');
const o14Timeline: Step[] = insertAfterIndex(o14WithIdentSettle, o14IgnitionOffIndex, {
  kind: 'settle',
  atSec: 151,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});

const O14: Scenario = {
  id: 'O14',
  title: "Identification timestamped before its own trip started",
  priority: 'P0',
  tags: [],
  // D is not otherwise involved, so ending at A is a real write.
  preconditions: { assetAssignee: 'D' },
  timeline: o14Timeline,
  expectAfterStep: [
    {
      afterIndex: o14IdentCheckpointIndex,
      expect: {
        assetAssignee: { value: 'unchanged' },
        driverEvents: [{ driver: 'A', isAssigneeSource: null, tripLink: { state: 'unlinked' } }],
      },
    },
  ],
  expect: {
    // Trip end recovers it: the window is floored at the previous trip's end (or, with no previous
    // trip in the lookback, at this trip's start minus the ten-minute pre-start tolerance), so an
    // identification stamped 120 seconds before the trip is found, linked and awarded the claim.
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [{ driver: 'A', isAssigneeSource: true, tripLink: { state: 'linked', tripRef: 'latest' } }],
  },
  rationale:
    "The doc's trip-end section: an identification timestamped slightly before its trip is found at insert to belong to no trip, and 'trip end already floors its search on the previous trip's end and recovers that row'. The consumer implements that (`resolveWindowStart` in hapi-server-rosco-ingestion-rmq), so the row is unlinked at insert (checkpoint) and claimed at trip end. The doc's own O14 row ('no assignee change across the board') disagrees with that section and has been flagged to the doc owners (PLAN/06-BLOCKERS.md). The floor at the trip's own start_date belongs to the phase 2 trip-start consumer, not to trip end. Compiled from fixtures/O14-identification-before-trip-started.json via fixturePlayback.ts: the identification claims atSec -120 and is delivered at deliverAtSec 0, tied with the trip's own IGN_ON; planPlayback's stable sort delivers the trip event first.",
};

// ---------------------------------------------------------------------------
// O6 — compiled from fixtures/O6-part1-first-trip-with-violations.json and
// fixtures/O6-part2-late-identification-superseded.json, played in order against the same asset.
//
// Part1's trip runs atSec 0-200 (IGN_OFF at 200); part2's own fixture file is zero-based (IGN_ON
// at 0, identification at atSec -600 relative to ITS OWN trip start, a stand-in per the fixture's
// own description for "atSec 180" in part1's window). Part2 is compiled with `atSecOffset` set to
// part1's last atSec plus `TWO_PART_TRIP_GAP_SEC` (see that constant's own comment for why 580 is
// exactly the value that lands the identification back on atSec 180 in part1's window), so its
// trip continues part1's clock instead of restarting it.
// ---------------------------------------------------------------------------

const o6Part1Base = expandFixtureToSteps(o6Part1Fixture as Fixture);
const o6Part1IgnitionOffIndex = lastIndexWhere(o6Part1Base, (s) => s.kind === 'ignitionOff');
const o6Part1WithTripEndSettle = insertAfterIndex(o6Part1Base, o6Part1IgnitionOffIndex, {
  kind: 'settle',
  atSec: 201,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});
const o6Part2Base = expandFixtureToSteps(o6Part2Fixture as Fixture, {
  atSecOffset: lastAtSec(o6Part1Base) + TWO_PART_TRIP_GAP_SEC,
});
const o6Base: Step[] = [...o6Part1WithTripEndSettle, ...o6Part2Base];
const o6Part2IgnitionOffIndex = lastIndexWhere(o6Base, (s) => s.kind === 'ignitionOff');
const o6WithSecondTripEndSettle = insertAfterIndex(o6Base, o6Part2IgnitionOffIndex, {
  kind: 'settle',
  atSec: 151,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});
const o6IdentIndex = lastIndexWhere(o6WithSecondTripEndSettle, (s) => s.kind === 'ident');
const o6Timeline: Step[] = insertAfterIndex(o6WithSecondTripEndSettle, o6IdentIndex, {
  kind: 'settle',
  atSec: 251,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});

const O6: Scenario = {
  id: 'O6',
  title: 'Late identification for a trip already superseded by a later one',
  priority: 'P0',
  tags: ['@slow'],
  // Agreed behavior (TS-44193, team lead and Geoff, 2026-09-29): a late identification writes its
  // own trip and the asset when it's the latest change, even though a later trip has started. The
  // later trip's own identification is expected to take care of it. The write is flagged
  // (`superseded_trip_asset_write`) so it can be monitored. Starting the asset on B, which this
  // scenario doesn't otherwise use, is what makes the move to A observable.
  preconditions: { assetAssignee: 'B' },
  timeline: o6Timeline,
  expect: {
    assetAssignee: { value: 'A' },
    trips: [
      { tripRef: 'first', assignee: 'A' },
      { tripRef: 'latest', assignee: 'unchanged' },
    ],
    driverEvents: [
      {
        driver: 'A',
        isAssigneeSource: true,
        tripLink: { state: 'linked', tripRef: 'first' },
        flags: { arrived_after_trip_ended: true, resulted_in_assignee_change: true, superseded_trip_asset_write: true },
      },
    ],
    // Trip 1's trip-end pass ran before the identification, so only the backfill cron moves these.
    thresholdEvents: [{ tripRef: 'first', allAssignedTo: 'A', viaBackfill: true }],
  },
  rationale:
    "Agreed behavior for TS-44193 (hapi-server-rosco-ingestion-rmq PR #94), which replaces the design's original 'no asset write' for a superseded trip: the late identification changes its own trip and the asset, as long as it's the latest change (the asset guard's event-timestamp comparison), and the row is flagged `superseded_trip_asset_write` for monitoring. The later trip keeps its own assignee, and its own identification is expected to correct the asset. Known residual, to watch: if the later trip's identification is stamped before this write lands but delivered after it, the asset guard skips it (`.runs/O6-unidentified-later-trip-asset-write.md`). Compiled from fixtures/O6-part1-first-trip-with-violations.json and fixtures/O6-part2-late-identification-superseded.json, played in order against the same asset, via fixturePlayback.ts: part1's trip carries two violations (HARDBRAKE, HARDACCEL) and closes with a settle('tripEnded') before part2's trip starts. Part2's trip then runs and closes, and only then does the late identification (claiming a timestamp inside part1's window) arrive. The trip lookup finds trip 1, links it (closed trip covers, flagged `arrived_after_trip_ended`), the claim is won, and both writes happen. Trip 1's own trip-end pass already ran, so its violations move only on the scorecard backfill cron, hence `@slow` and `viaBackfill`. Part2 is compiled with `atSecOffset: lastAtSec(o6Part1Base) + TWO_PART_TRIP_GAP_SEC` so its trip continues part1's clock, and the identification's own local atSec -600 lands back on atSec 180 in part1's window.",
};


// These run in parallel, each on its own asset. O14 doesn't need trip history: with no earlier trip,
// trip end floors its search 10 minutes before the trip's start, which covers the identification.
export const TRIP_LOOKUP_SCENARIOS: readonly Scenario[] = [O12a, O12b, O12d, O12e, O12f, O5, O14];

/** O12c and O6: the long-gap cases, in their own spec file and fleet. See the file comment. */
export const TRIP_LOOKUP_GAP_SCENARIOS: readonly Scenario[] = [O12c, O6];
