/**
 * Pins `anchorTimeline`'s two rules against every real scenario timeline:
 *
 * 1. No event goes out before the time it claims (except a step flagged
 *    `timestampAheadOfDelivery`, O17's day-two identification).
 * 2. Every identification is stamped after the execution's preconditions, so the consumer's
 *    "standing assignment is newer" guard never skips an asset write because of the harness.
 *
 * Rule 2 is the bug this guards against: T0 used to be set before the preconditions, so every
 * identification was older than the assignment the preconditions had just written.
 *
 * Pure: no `ApiClient`, no HTTP. Not tagged `@mutating`.
 */
import { test, expect } from '@playwright/test';
import { ALL_SCENARIOS } from '../../src/scenarios/index';
import { anchorTimeline, ANCHOR_MARGIN_MS } from '../../src/scenario/runner';

const NOW_MS = Date.parse('2026-09-28T12:00:00Z');
const NETWORK_KINDS = new Set(['ignitionOn', 'move', 'harshEvent', 'ignitionOff', 'ident']);

for (const scenario of ALL_SCENARIOS) {
  test(`${scenario.id}: every event is sent at or after its timestamp, and identifications follow the preconditions`, () => {
    const { t0, startAtMs } = anchorTimeline(scenario.timeline, NOW_MS);
    expect(startAtMs).toBeGreaterThanOrEqual(NOW_MS + ANCHOR_MARGIN_MS);

    let earliestSendMs = startAtMs;
    for (const step of scenario.timeline) {
      earliestSendMs += Math.max(0, step.sendAfterMs ?? 0);
      if (!NETWORK_KINDS.has(step.kind) || step.timestampAheadOfDelivery) continue;
      const stampMs = t0.getTime() + step.atSec * 1_000;
      expect(stampMs, `${step.kind} at atSec ${step.atSec}`).toBeLessThanOrEqual(earliestSendMs);
      if (step.kind === 'ident') {
        expect(stampMs, `ident at atSec ${step.atSec}`).toBeGreaterThanOrEqual(NOW_MS + ANCHOR_MARGIN_MS);
      }
    }
  });
}

test('a timeline that is sent as it happens starts right after the margin', () => {
  const { t0, startAtMs } = anchorTimeline(
    [
      { kind: 'ignitionOn', atSec: 0 },
      { kind: 'ident', atSec: 30, sendAfterMs: 30_000, driver: 'A' },
    ],
    NOW_MS,
  );
  expect(startAtMs).toBe(NOW_MS + ANCHOR_MARGIN_MS);
  expect(t0.getTime()).toBe(startAtMs);
});

test('a burst-delivered delayed trip waits until its backdated stamps follow the preconditions', () => {
  // Stamped over 0..120s, all sent within the first second: the trip is 120s "old" on arrival.
  const { t0, startAtMs } = anchorTimeline(
    [
      { kind: 'ident', atSec: 60, driver: 'A' },
      { kind: 'ignitionOn', atSec: 0, sendAfterMs: 500 },
      { kind: 'ignitionOff', atSec: 120, sendAfterMs: 500 },
    ],
    NOW_MS,
  );
  expect(t0.getTime() + 120_000).toBeLessThanOrEqual(startAtMs + 1_000);
  expect(t0.getTime() + 60_000).toBeGreaterThanOrEqual(NOW_MS + ANCHOR_MARGIN_MS);
});
