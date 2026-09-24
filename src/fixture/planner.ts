/**
 * Resolves a `Fixture` into a concrete `PlaybackPlan`: absolute stamped timestamps and relative
 * delivery offsets for every trip event and every identification, merged and time-ordered.
 *
 * Two clocks, per `types.ts`'s doc comment: `atSec` always drives the timestamp STAMPED into the
 * payload (`isoAt(t0, atSec)`), unconditionally. `deliverAtSec` (default `atSec`) drives WHEN it
 * is sent, and that is what the trip's `delay` mode rewrites — identifications are never
 * rewritten by it, which is what lets a fixture combine a delayed trip with a live
 * identification or the other way round.
 *
 * THE ANCHOR (`t0`), SINGLE SOURCE
 *
 * `t0` used to be computed twice, disagreeing: `scenario/runner.ts` anchored off the largest
 * `atSec` across the WHOLE compiled timeline (trip events and identifications together), and
 * `player.ts` (and so `tools/play.ts`) simply defaulted `t0` to `new Date()` and offered no way to
 * backdate it at all — which is how the CLI ended up stamping frames dated in the future (see
 * `defaultAnchor` below). `planPlayback` is now the one place that resolves `t0` when a caller
 * supplies none, and every caller — `player.ts`, `tools/play.ts`, and whatever compiles a
 * `Scenario.timeline` from a fixture (`../scenarios/fixturePlayback.ts`) — reads the resolved value
 * off the returned `PlaybackPlan.t0` rather than computing its own.
 */
import type { Fixture, FixtureTripEvent, PlannedEvent, PlaybackPlan } from './types';

/**
 * Ascending gap between two events sent in the same burst, so a "back to back" delivery still
 * preserves the events' relative order without waiting the real gap between their `atSec`
 * values. Arbitrary but must stay well under a second: nothing about ordering depends on its
 * exact size.
 */
const BURST_STEP_MS = 250;

/**
 * Headroom so the trip's own last `atSec` still lands safely in the past, never in the future,
 * once stamped from `defaultAnchor`'s anchor. Moved here from `scenario/runner.ts`'s own (now
 * deleted) `computeT0` — this is the only copy now.
 */
const CLOCK_SAFETY_MARGIN_SEC = 30;

function isoAt(t0: Date, atSec: number): string {
  return new Date(t0.getTime() + atSec * 1000).toISOString();
}

/**
 * The default `t0` when a caller supplies none: `now`, backdated far enough that the TRIP's own
 * events land safely in the past. Deliberately anchored off `fixture.trip.events` alone, never off
 * `fixture.driver_identifications`.
 *
 * That distinction is what fixes the CRITICAL defect: O17 stretches one identification to
 * `atSec: 93600` (26 hours) purely to stand in for a multi-day trip, while its own compressed
 * trip only runs a few minutes. Anchoring off the largest `atSec` across EVERYTHING (the old,
 * now-deleted `runner.ts` behaviour) would drag that whole compressed trip 26 hours into the past
 * — behind every other scenario's trips already sitting on the same shared asset, tripping the
 * design's trip-recency guard for no reason O17 actually intends. Anchoring off the trip's own
 * span keeps the trip itself modestly and correctly backdated (safely past, but not absurdly so)
 * regardless of what any identification in the same fixture claims.
 *
 * An identification's claimed `atSec` is allowed to float arbitrarily outside the trip's span —
 * that is the point of the two clocks (`types.ts`) — so it is never used to compute this anchor.
 * One consequence is inherent to the fixture, not fixed by this function: O17's identification B
 * still stamps roughly "tomorrow" relative to real now, because its `atSec` (a stand-in for a
 * real day-two timestamp) is simply larger than any anchor computed from a multi-*minute*
 * compressed trip can absorb without reintroducing the trip-recency problem above. See this
 * module's build report for the full accounting.
 */
function defaultAnchor(fixture: Fixture): Date {
  const maxTripAtSec = Math.max(0, ...fixture.trip.events.map((event) => event.atSec));
  return new Date(Date.now() - (maxTripAtSec + CLOCK_SAFETY_MARGIN_SEC) * 1000);
}

/** `deliverAtMs` (offset from playback start) for every trip event, honouring the delay mode. */
function tripDeliverAtMsList(fixture: Fixture): number[] {
  const { events } = fixture.trip;
  const { delay } = fixture;

  if (delay.mode === 'none') {
    return events.map((event) => (event.deliverAtSec ?? event.atSec) * 1000);
  }

  if (delay.mode === 'full-burst') {
    const burstStartMs = (delay.burstStartAtSec ?? 0) * 1000;
    return events.map((_, index) => burstStartMs + index * BURST_STEP_MS);
  }

  // partial-burst: events at or before burstThroughAtSec burst from burstStartAtSec; the rest
  // play in real time — meaning each stays at its own original, absolute atSec/deliverAtSec
  // offset FROM PLAYBACK START, exactly as it would have without any burst at all, not offset
  // from when the burst segment itself happened to finish.
  //
  // This resolves an ambiguity in `types.ts`'s `DelayMode` doc comment ("played in real time from
  // that point on"), which can be misread as "resume counting from the end of the burst" — that
  // reading would compress out the real gap between the burst and the live tail (e.g. O3.3's
  // HARDBRAKE at atSec 95 would arrive ~37s after the burst ends instead of at absolute +95s).
  // The choice here — the live tail keeps its own absolute offset — is deliberate: partial-burst
  // models a tracker that buffered telemetry while offline, dumped the backlog on reconnecting
  // (the burst), and then resumed reporting AT THE REAL ELAPSED TIME, the same as it always would
  // have. A real device's clock does not skip forward to make up for a backlog dump, so neither
  // does this. `types.ts` is outside this module's ownership and cannot be reworded here; this
  // comment is the authoritative resolution for anyone reading the implementation.
  const burstStartMs = (delay.burstStartAtSec ?? 0) * 1000;
  let burstIndex = 0;
  return events.map((event: FixtureTripEvent) => {
    if (event.atSec <= delay.burstThroughAtSec) {
      const ms = burstStartMs + burstIndex * BURST_STEP_MS;
      burstIndex += 1;
      return ms;
    }
    return (event.deliverAtSec ?? event.atSec) * 1000;
  });
}

/** Resolves a fixture into a time-ordered playback plan, anchored at `opts.t0` (default: see `defaultAnchor`). */
export function planPlayback(fixture: Fixture, opts?: { t0?: Date }): PlaybackPlan {
  const t0 = opts?.t0 ?? defaultAnchor(fixture);
  const deliverAtMsList = tripDeliverAtMsList(fixture);

  const tripEvents: PlannedEvent[] = fixture.trip.events.map((tripEvent, index) => ({
    kind: 'trip',
    deliverAtMs: deliverAtMsList[index] ?? tripEvent.atSec * 1000,
    timestampIso: isoAt(t0, tripEvent.atSec),
    tripEvent,
  }));

  const identEvents: PlannedEvent[] = fixture.driver_identifications.map((identification) => ({
    kind: 'ident',
    deliverAtMs: (identification.deliverAtSec ?? identification.atSec) * 1000,
    timestampIso: isoAt(t0, identification.atSec),
    identification,
  }));

  // Tie-break at equal deliverAtMs: trip events sort before identifications, and within each of
  // those two groups declaration order is the array's own index. `declaredOrder` is computed
  // explicitly, right here, from that concatenation — [...tripEvents, ...identEvents] — rather
  // than left to fall out of Array.prototype.sort's stability (spec-guaranteed since ES2019, but
  // not something a reader should have to know in order to predict which of two simultaneous
  // events wins). This is what O14 depends on: its identification and the trip's own IGN_ON both
  // deliver at offset 0, and the rule below is what makes the trip event win deterministically,
  // as a documented policy rather than an accident of concatenation order.
  //
  // No current fixture can express the reverse (an identification declared to arrive before a
  // tied trip event): `driver_identifications` and `trip.events` are separate arrays with no
  // field linking their relative declaration order, and adding one would mean changing
  // `fixture/types.ts`, which is outside this module's ownership. This comment documents the
  // policy that is actually enforced; it does not claim the format can express its opposite.
  const events = [...tripEvents, ...identEvents]
    .map((event, declaredOrder) => ({ event, declaredOrder }))
    .sort((a, b) => a.event.deliverAtMs - b.event.deliverAtMs || a.declaredOrder - b.declaredOrder)
    .map(({ event }) => event);

  const durationMs = events.reduce((max, item) => Math.max(max, item.deliverAtMs), 0);

  return { fixture, t0, events, durationMs };
}
