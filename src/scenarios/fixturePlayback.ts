/**
 * Compiles a fixture JSON file (the `Fixture` contract in `src/fixture/types.ts`) into the
 * `Step[]` array the scenario runner actually executes.
 *
 * AGENT-BRIEF revision 2, item 7: "Where a fixture file exists with the same case id, the runner
 * plays it and the scenario only carries preconditions and expectations." `scenario/types.ts`
 * still declares `Scenario.timeline` as a required `Step[]` and carries no field naming a fixture
 * directly, so a fixture-driven scenario compiles its fixture into a `timeline` at module load
 * time instead. This module does the compiling, but it is not a second implementation of the
 * fixture's two-clock playback semantics: it calls `planPlayback` (`../fixture/planner`), the same
 * function `../player.ts` and `tools/play.ts` use to play a fixture directly, and turns the
 * resulting `PlaybackPlan` into `Step[]`. `planner.ts` stays the single place that resolves
 * `atSec`/`deliverAtSec` and the `none`/`full-burst`/`partial-burst` delay modes; nothing here
 * re-derives that arithmetic.
 *
 * `scenario/runner.ts` only ever walks `Scenario.timeline` in array order, pausing
 * `step.sendAfterMs` real milliseconds before sending each one (`deliverStep`,
 * `pauseForDeliveryOrder`). So converting a `PlaybackPlan` into `Step[]` is just a shape change:
 * each `PlannedEvent`'s `deliverAtMs` gap from the previous one becomes `sendAfterMs`, and each
 * event's resolved timestamp (relative to the plan's own `t0`) becomes `atSec`.
 */

import type { Fixture, FixtureIdentification, FixtureTripEvent, PlannedEvent } from '../fixture/types';
import type { HarshEventStep, IdentStep, IgnitionOffStep, IgnitionOnStep, MoveStep, Step } from '../scenario/types';
import { planPlayback } from '../fixture/planner';

function tripEventToStep(event: FixtureTripEvent, atSec: number): Step {
  const base = { atSec, note: event.note };
  switch (event.type) {
    case 'IGN_ON':
      return { kind: 'ignitionOn', ...base } satisfies IgnitionOnStep;
    case 'IGN_OFF':
      return { kind: 'ignitionOff', ...base } satisfies IgnitionOffStep;
    case 'ON_PERIODIC':
      return { kind: 'move', ...base, lat: event.lat, lon: event.lon } satisfies MoveStep;
    case 'HARDBRAKE':
      return { kind: 'harshEvent', ...base, severity: 'hardBrake' } satisfies HarshEventStep;
    case 'HARDACCEL':
      return { kind: 'harshEvent', ...base, severity: 'hardAccel' } satisfies HarshEventStep;
    case 'HARDTURN':
      return { kind: 'harshEvent', ...base, severity: 'hardTurn' } satisfies HarshEventStep;
  }
}

function identToStep(ident: FixtureIdentification, atSec: number): Step {
  return {
    kind: 'ident',
    atSec,
    driver: ident.driver,
    type: ident.type,
    as: ident.as,
    redeliverOf: ident.redeliverOf,
    note: ident.note,
  } satisfies IdentStep;
}

/** `PlannedEvent.atSec`, recovered from its resolved timestamp relative to the plan's own `t0`. */
function plannedAtSec(item: PlannedEvent, t0: Date): number {
  return (new Date(item.timestampIso).getTime() - t0.getTime()) / 1_000;
}

function plannedItemToStep(item: PlannedEvent, t0: Date): Step {
  const atSec = plannedAtSec(item, t0);
  if (item.kind === 'trip') {
    if (!item.tripEvent) {
      throw new Error('expandFixtureToSteps: a "trip" planned item is missing its tripEvent');
    }
    return tripEventToStep(item.tripEvent, atSec);
  }
  if (!item.identification) {
    throw new Error('expandFixtureToSteps: an "ident" planned item is missing its identification');
  }
  return identToStep(item.identification, atSec);
}

/**
 * Compiles `fixture` into `Step[]` by resolving it through `planPlayback` and converting the
 * resulting `PlaybackPlan.events` (already time-ordered by `deliverAtMs`) into steps: the gap
 * between consecutive events' ABSOLUTE `deliverAtMs` (milliseconds after playback start, per
 * `fixture/types.ts`'s `PlannedEvent` doc comment) becomes `sendAfterMs`, so replaying the
 * returned `Step[]` through the scenario runner's `sendAfterMs` pauses reproduces the exact same
 * delivery schedule `planPlayback` resolved, including whichever delay mode the fixture declared.
 *
 * The FIRST step is not special-cased to a zero gap: its `sendAfterMs` is its own absolute
 * `deliverAtMs`, same as every other step's gap from its predecessor (predecessor being an
 * implicit `deliverAtMs: 0` at timeline start). This matters for O5 and O12d, whose only item is
 * an identification delivered 60 real seconds into playback (`deliverAtSec: 60`): forcing the
 * first step's gap to zero — the previous behaviour — silently dropped that lead time, so the
 * runner sent it immediately while `player.ts` (which always honoured the first item's absolute
 * offset) correctly waited the minute. Both callers now honour the same absolute schedule.
 *
 * `opts.atSecOffset` (default 0) shifts every compiled step's STAMPED `atSec` later by that many
 * seconds, so the payload's timestamp reflects the shift. It never adds to any `sendAfterMs` gap,
 * for any index including the first: gaps are derived purely from each `PlannedEvent`'s own
 * (un-shifted) `deliverAtMs`, which already cancels any uniform offset out of a gap between two
 * items and, with the first step no longer special-cased, cancels it out of the first item's own
 * gap too. This is what lets a two-part fixture's second part — each part's own `atSec` is
 * zero-based, per `fixture/types.ts` — be played as a continuation of the first part's clock
 * (the offset shifts what gets STAMPED) without also inserting a real wall-clock pause that would
 * double-count whatever wait the caller already placed between the two parts (e.g. a
 * `settle('tripEnded')` step): see O6 and O12c in `tripLookup.ts`, which compute the offset from
 * the first part's own last `atSec` plus a deliberate gap. A part played alone (`atSecOffset`
 * omitted or 0) is unaffected by any of this and behaves exactly as `planPlayback` resolved it.
 * `planner.ts`'s `atSec`/`deliverAtSec` resolution, and its own default `t0` anchor, are untouched
 * by any of the above; the offset is applied here, after `planPlayback` has already resolved the
 * fixture's own delay mode and anchor.
 */
export function expandFixtureToSteps(fixture: Fixture, opts?: { t0?: Date; atSecOffset?: number }): Step[] {
  const plan = planPlayback(fixture, { t0: opts?.t0 });
  const atSecOffset = opts?.atSecOffset ?? 0;

  let previousDeliverAtMs = 0;
  return plan.events.map((item) => {
    const step = plannedItemToStep(item, plan.t0);
    const shiftedStep = atSecOffset === 0 ? step : { ...step, atSec: step.atSec + atSecOffset };
    const gapMs = item.deliverAtMs - previousDeliverAtMs;
    previousDeliverAtMs = item.deliverAtMs;
    return gapMs > 0 ? { ...shiftedStep, sendAfterMs: gapMs } : shiftedStep;
  });
}

/** Index of the last step matching `predicate`, or -1. Used to splice runner-only wait/checkpoint
 *  steps (never part of the fixture's own data) into a fixture-derived timeline without hand
 *  counting array positions, which would silently drift the day the fixture file changes. */
export function lastIndexWhere(steps: readonly Step[], predicate: (step: Step) => boolean): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step !== undefined && predicate(step)) return i;
  }
  return -1;
}

/** Returns a new array with `toInsert` placed immediately after position `index` (0-based). */
export function insertAfterIndex(steps: readonly Step[], index: number, toInsert: Step): Step[] {
  if (index < 0) {
    throw new Error('insertAfterIndex: negative index, the caller\'s lastIndexWhere lookup did not match anything');
  }
  return [...steps.slice(0, index + 1), toInsert, ...steps.slice(index + 1)];
}
