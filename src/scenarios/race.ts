/**
 * `o-race.spec.ts` scenario: O9. Fleet `fr-race`.
 *
 * NAMING NOTE: the design doc's own Developer Test Plan labels 'insert-time race on the claim'
 * (two concurrent identifications on one trip) as O9, and 'trip-end award race' (an identification
 * racing the trip-ended message) as O10. This suite's plan (i-would-like-to-quiet-codd.md,
 * o-race.spec.ts) describes O9 as the identification-vs-trip-ended race instead, and that is the
 * shape the agent brief and per-case tables ask this file to build. Encoded here as instructed;
 * the design doc's own O9 (two concurrent identifications) and O10 (trip-end award race) are
 * therefore both left uncovered by this module and are called out in TRACEABILITY.md.
 */

import type { Fixture } from '../fixture/types';
import type { Scenario, Step } from '../scenario/types';
import o9Fixture from '../../fixtures/O9-identification-races-trip-ended.json';
import { expandFixtureToSteps, lastIndexWhere } from './fixturePlayback';

// ---------------------------------------------------------------------------
// O9 — compiled from fixtures/O9-identification-races-trip-ended.json
// ---------------------------------------------------------------------------

const o9Base = expandFixtureToSteps(o9Fixture as Fixture);
const o9IgnitionOnIndex = lastIndexWhere(o9Base, (s) => s.kind === 'ignitionOn');
const o9LastIndex = o9Base.length - 1;
const o9Timeline: Step[] = [...o9Base, { kind: 'settle', atSec: (o9Base[o9LastIndex]?.atSec ?? 0) + 1, until: 'tripEnded', budget: 'TRIP_END_BUDGET_MS' }];

const O9: Scenario = {
  id: 'O9',
  title: 'Identification races the trip-ended message on the same trip',
  priority: 'P0',
  tags: ['@race'],
  repeat: 5,
  // H3: this scenario `repeat`s 5 times against the same asset with nothing resetting the
  // assignee between runs, and every run identifies driver A. Without this, run 2 onward would
  // start already at A (run 1's own write), so a buggy write of A on a later run would be
  // indistinguishable from a correct one. D is not otherwise involved in this scenario, so ending
  // each run at A is proof of a genuine write, every time.
  preconditions: { assetAssignee: 'D' },
  timeline: o9Timeline,
  expectAfterStep: [
    { afterIndex: o9IgnitionOnIndex, expect: { assetAssignee: { value: 'unchanged' } } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [{ driver: 'A', isAssigneeSource: true, count: 1 }],
    driverEventRowCount: 1,
    thresholdEvents: [{ tripRef: 'latest', allAssignedTo: 'A' }],
  },
  rationale:
    "The plan's o-race.spec.ts: 'fire the identification and the trip-ended message concurrently on the same trip. Assert exactly one row carries is_assignee_source (a SQL assertion, this is what proves the partial unique index), and that asset assignee, trip assignee and violation attribution all converge on A regardless of which arrived first.' `repeat: 5` exists because a race is not proven by one lucky interleaving. `driverEventRowCount: 1` plus `isAssigneeSource` count 1 is the SQL-backed proof the partial unique index, not just application logic, is what prevents a duplicate claim. Compiled from fixtures/O9-identification-races-trip-ended.json via fixturePlayback.ts: the identification and the trip's own IGN_OFF share the identical `deliverAtSec` (150), so `planPlayback` resolves them to the same `deliverAtMs` and `expandFixtureToSteps` computes a zero gap between them (no `sendAfterMs`), which is functionally the same signal to the runner as this scenario's previous hand-authored `sendAfterMs: 0` on both steps (a falsy value either way; `deliverStep` only pauses when `step.sendAfterMs` is truthy). // VERIFY (unchanged from this scenario's previous hand-authored form): `scenario/runner.ts`'s `runTimelineExecution` loop `await`s each step's delivery before starting the next, so even a zero gap does not make the two requests land at the network layer at the same instant; if the runner needs a genuine race rather than a fast sequential send, that is a `scenario/runner.ts` change, not something either the fixture or this scenario file can express.",
};

export const RACE_SCENARIOS: readonly Scenario[] = [O9];
