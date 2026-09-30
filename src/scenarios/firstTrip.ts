/**
 * `o-first-trip.spec.ts` scenario: O21. Fleet `fr-first-trip`.
 *
 * O21 needs an asset's very first trip, so its file creates a new asset every run, which makes it
 * `@fresh-asset` and opt-in through `ALLOW_FRESH_ASSETS`. It exercises the trip-end window's pre-start tolerance, which the
 * consumer applies when an asset has no previous trip (`resolveWindowStart` in `assetTripEnded.ts`).
 */

import type { Fixture } from '../fixture/types';
import type { Scenario, Step } from '../scenario/types';
import o21Fixture from '../../fixtures/O21-first-trip-pre-start-tolerance.json';
import { expandFixtureToSteps, insertAfterIndex, lastIndexWhere } from './fixturePlayback';

// ---------------------------------------------------------------------------
// O21 — compiled from fixtures/O21-first-trip-pre-start-tolerance.json
// ---------------------------------------------------------------------------

const o21Base = expandFixtureToSteps(o21Fixture as Fixture);
const o21IdentIndex = lastIndexWhere(o21Base, (s) => s.kind === 'ident');
const o21WithIdentSettle = insertAfterIndex(o21Base, o21IdentIndex, {
  kind: 'settle',
  atSec: -299,
  until: 'identificationPersisted',
  budget: 'LIVE_BUDGET_MS',
});
const o21CheckpointIndex = o21IdentIndex + 1;
const o21IgnitionOffIndex = lastIndexWhere(o21WithIdentSettle, (s) => s.kind === 'ignitionOff');
const o21Timeline: Step[] = insertAfterIndex(o21WithIdentSettle, o21IgnitionOffIndex, {
  kind: 'settle',
  atSec: 151,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});

const O21: Scenario = {
  id: 'O21',
  title: "Asset's very first trip, pre-start tolerance links a pre-start identification",
  priority: 'P1',
  // B is not otherwise involved in O21, so ending at A is proof of a genuine write.
  preconditions: { assetAssignee: 'B' },
  timeline: o21Timeline,
  expectAfterStep: [
    {
      afterIndex: o21CheckpointIndex,
      expect: {
        assetAssignee: { value: 'unchanged' },
        driverEvents: [{ driver: 'A', isAssigneeSource: null, tripLink: { state: 'unlinked' } }],
      },
    },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEvents: [{ driver: 'A', isAssigneeSource: true, tripLink: { state: 'linked', tripRef: 'latest' } }],
  },
  rationale:
    "The doc's O21: 'An asset's very first trip, with no previous trip to floor the window | The pre-start tolerance is used and a pre-start identification is still linked.' With no previous trip in the lookback, the floor falls back to this trip's start minus the ten-minute pre-start tolerance rather than this trip's own start_date with no tolerance at all (contrast O14, which is not a first trip and gets no tolerance). Compiled from fixtures/O21-first-trip-pre-start-tolerance.json via fixturePlayback.ts: the identification's `deliverAtSec: 0` ties it to the trip's own `IGN_ON` (also atSec/deliverAtSec 0); as in O14, `planPlayback`'s stable sort resolves the tie by delivering the trip event first, so the checkpoint lands right after the identification itself rather than strictly before the trip's own IGN_ON.",
};


export const FIRST_TRIP_SCENARIOS: readonly Scenario[] = [O21];
