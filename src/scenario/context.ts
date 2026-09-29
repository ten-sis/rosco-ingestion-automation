/**
 * The per-run execution context every scenario step and assertion is handed, plus the
 * per-scenario-execution state that resolves `TripRef`s, ident redelivery labels and `'unchanged'`
 * assignee baselines.
 *
 * `ScenarioContext` is built once per (worker, fleet) by the `fr` fixture (see `fixtures/test.ts`)
 * and reused across every scenario in that spec file. AGENT-BRIEF revision 2 item 1: each spec
 * file hardcodes one fleet, provisions that fleet's asset once, and the fleet's `fr` fixture is
 * WORKER-scoped, keyed on the `fleet` test option, so `playwright.config.ts`'s `workers: 4` lets
 * different files' fleets run concurrently while `fullyParallel: false` keeps the scenarios inside
 * one file strictly serial against the one asset that file owns. Per the coding-style immutability
 * rule, the runner never mutates that shared object in place. Instead, `runScenario` derives a
 * fresh copy per scenario execution — `{ ...baseContext, t0: ... }` — and threads that derived copy
 * into every step handler and assertion. `secondaryAsset` is a closure, so its memoized promise
 * survives being copied by the spread and stays shared across every scenario and every `repeat`
 * iteration for that fleet.
 *
 * Because each execution gets its own derived context *object* (a fresh spread), it can also serve
 * as a `WeakMap` key for execution-scoped bookkeeping: which trips (and, since the fix for defect
 * 3 below, which driver-event rows) already existed before this execution's timeline, which ident
 * payload a labelled step sent (for `redeliverOf`), whether any ident has been dispatched yet
 * (for defect 1's proof-of-liveness gate), and which assignee values were true before step 1 (for
 * `'unchanged'` expectations). That bookkeeping is inherently a mutable log for the lifetime of one
 * execution, not a value object passed around by the contract — see the doc comment on
 * `ExecutionState` for why that is a deliberate, narrow exception to the immutability rule rather
 * than an oversight.
 */

import type { ApiClient } from '../api/client';
import type { RoscoDriverWebhookPayload, RunContext, Trip, Uuid } from '../types';
import type { DriverEventEmitter } from '../emit/index';
// VERIFY: `TelemetryEmitter` and `DriverEventsReader` are named this way by Module C. The brief
// only describes their shapes inline (createTelemetryEmitter / createDriverEventsReader return
// values); confirm the exact export names and paths once ../emit/telemetry and
// ../read/driverEvents land.
import type { TelemetryEmitter } from '../emit/telemetry';
import type { DriverEventsReader } from '../read/driverEvents';
import { searchTrips } from '../api/trips';
import type { AssetRef, Step, TripRef } from './types';

export interface ScenarioContext {
  api: ApiClient;
  run: RunContext;
  /**
   * The fleet this spec file declared (see `fixtures/test.ts`'s `defineScenarioTests`). Not part
   * of the frozen `RunContext` (`src/types.ts`), which carries no notion of "which suite" — added
   * here, on the non-frozen `ScenarioContext`, for provisioning (`suiteAccountId(fleet)`) and for
   * anything that needs to know which suite it is running under.
   */
  fleet: string;
  emitter: DriverEventEmitter;
  telemetry: TelemetryEmitter;
  reader: DriverEventsReader;
  /** Provisions and caches a second asset+tracker for scenarios that need one. */
  secondaryAsset(): Promise<RunContext>;
  /** Anchor for the scenario's logical clock. Set by the runner at the start of each scenario. */
  t0: Date;
}

/** Resolves an `AssetRef` to the concrete `RunContext` it names. Undefined means the primary asset. */
export function resolveAsset(sc: ScenarioContext, ref: AssetRef | undefined): Promise<RunContext> {
  if (ref === 'secondary') return sc.secondaryAsset();
  return Promise.resolve(sc.run);
}

/**
 * Converts a scenario-logical offset (seconds from `sc.t0`) into the ISO string stamped as the
 * GMS frame or Rosco payload `timestamp`. `Date#toISOString()` produces `YYYY-MM-DDTHH:mm:ss.SSSZ`,
 * deliberately the same shape as the ingestion branch's `normalizedTimestamp` (AGENT-BRIEF item 3),
 * so a `redeliverOf` resend can collapse onto the same deterministic `event_id` when it resends the
 * identical cached payload.
 */
export function logicalTime(sc: ScenarioContext, atSec: number): string {
  return new Date(sc.t0.getTime() + atSec * 1_000).toISOString();
}

/**
 * Numeric comparator for two ISO timestamps. Two ISO strings that name the same instant do not
 * necessarily compare correctly as plain strings — a `+00:00` offset sorts before `Z` under
 * `String#localeCompare`/`<`/`>=` even when it names the same or a later instant (AGENT-BRIEF
 * "Also" item, originally waits.ts:75). Every chronological comparison in this module and in
 * `waits.ts` goes through this rather than comparing the raw strings.
 */
export function compareIsoAsc(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

/**
 * Bookkeeping scoped to one scenario execution (one `repeat` iteration). Held in a `WeakMap` keyed
 * by the derived per-execution `ScenarioContext` object, because that object's identity is unique
 * per execution (see the module doc comment) while its shape is fixed by the contract and has no
 * room for this state. The maps here are mutated in place for the lifetime of a single execution —
 * a deliberate, narrow exception to the immutability rule: this is a private cache, never handed
 * back to callers, and every value it holds is otherwise immutable.
 */
interface ExecutionState {
  /** assetId -> ids of trips that existed on it before this execution's timeline started. */
  preExistingTripIds: Map<Uuid, Set<Uuid>>;
  /**
   * assetId -> ids of `rosco_driver_events` rows that existed on it before this execution's
   * timeline started, captured over the same window `windowStart` will later query (defect 3).
   * Subtracted from every row-based read so an earlier scenario's (or an earlier `repeat`'s) rows
   * never bleed into this execution's counts or row-shape assertions.
   */
  preExistingDriverEventRowIds: Map<Uuid, Set<Uuid>>;
  /**
   * The smallest `atSec` anywhere in this execution's timeline (never above 0). Assertion windows
   * (`windowStart`) are floored here rather than at a fixed lookback constant, so a scenario whose
   * timeline reaches further into the past than any other still gets its own rows inside the
   * window instead of silently dropping them (defect 3).
   */
  timelineMinAtSec: number;
  /** The timeline's largest `atSec`, for `windowEnd`. */
  timelineMaxAtSec: number;
  /**
   * Whether an `ident` step (fresh or `redeliverOf`) has been dispatched yet in this execution.
   * Negative assertions use this to choose their strategy (defect 1): before the first ident is
   * sent, no positive "the consumer ran" marker can possibly exist yet, so the only correct check
   * is to hold the expected value for the full budget and fail on any change; once an ident has
   * been sent, the pipeline is guaranteed (by design — row persistence happens before any write
   * guard can suppress a downstream write) to eventually leave a marker, so a negative assertion
   * instead waits for that marker before taking its one decisive read.
   */
  identDispatched: boolean;
  /** ident step `as` label -> the exact payload that label actually sent. */
  identPayloads: Map<string, RoscoDriverWebhookPayload>;
  /** assetId -> contact id (or null) captured before step 1, for `assetAssignee: 'unchanged'`. */
  unchangedAssetAssignee: Map<Uuid, Uuid | null>;
  /**
   * serialized `TripRef` -> the trip's contact id (or null) for `assignee: 'unchanged'`. Captured
   * before step 1 when the trip already exists, otherwise as soon as it first appears (see
   * `pendingTripBaselines`).
   */
  unchangedTripAssignee: Map<string, Uuid | null>;
  /**
   * serialized `TripRef` -> the ref itself, for `'unchanged'` trips that did not exist yet before
   * step 1. Their baseline is the assignee the trip starts with, which dv3 copies from the asset's
   * assignee when the trip is created (observed 2026-09-28, O7.2). The runner captures it once the
   * trip appears and before any step that could write an assignee.
   */
  pendingTripBaselines: Map<string, TripRef>;
}

const executionStates = new WeakMap<ScenarioContext, ExecutionState>();

/**
 * Starts a fresh, empty execution record for this (derived, per-execution) context. `timeline` is
 * the scenario's own `Step[]` — needed up front only to derive `timelineMinAtSec` (defect 3); the
 * runner still walks its own copy of the array for delivery.
 */
export function beginExecution(sc: ScenarioContext, timeline: readonly Step[]): void {
  executionStates.set(sc, {
    preExistingTripIds: new Map(),
    preExistingDriverEventRowIds: new Map(),
    timelineMinAtSec: Math.min(0, ...timeline.map((s) => s.atSec)),
    timelineMaxAtSec: Math.max(0, ...timeline.map((s) => s.atSec)),
    identDispatched: false,
    identPayloads: new Map(),
    unchangedAssetAssignee: new Map(),
    unchangedTripAssignee: new Map(),
    pendingTripBaselines: new Map(),
  });
}

function stateFor(sc: ScenarioContext): ExecutionState {
  const state = executionStates.get(sc);
  if (!state) {
    throw new Error(
      'ScenarioContext was never initialized by runScenario (beginExecution was not called). ' +
        "TripRef resolution, ident redelivery and 'unchanged' assertions all require a " +
        'runner-managed execution — call runScenario rather than using this context directly.',
    );
  }
  return state;
}

/** The lower bound of the time window an assertion should query within, as an ISO string. Floored
 *  at this execution's own timeline minimum `atSec` (defect 3), not a fixed lookback constant. */
export function windowStart(sc: ScenarioContext): string {
  return logicalTime(sc, stateFor(sc).timelineMinAtSec);
}

/** Records which trips already exist on `assetId`, before this execution's timeline runs. */
export async function capturePreExistingTrips(sc: ScenarioContext, assetId: Uuid): Promise<void> {
  const trips = await searchTrips(sc.api, { assetId });
  stateFor(sc).preExistingTripIds.set(
    assetId,
    new Set(trips.map((t) => t.id)),
  );
}

/** The ids of trips that already existed on `assetId` before this execution's timeline started. */
export function getPreExistingTripIds(sc: ScenarioContext, assetId: Uuid): ReadonlySet<Uuid> {
  return stateFor(sc).preExistingTripIds.get(assetId) ?? new Set<Uuid>();
}

/**
 * Records which `rosco_driver_events` rows already exist on `assetId`, before this execution's
 * timeline runs (defect 3), over the same window later row-based assertions will query
 * (`windowStart`, which by now reflects this execution's own `timelineMinAtSec`). When the reader
 * is not available at all (the feature genuinely is not built), records an empty baseline rather
 * than throwing — `ensureReaderAvailable` (waits.ts) is the single place that turns "not built"
 * into a loud, greppable failure, and it runs at the point a scenario actually needs a row, not
 * during setup for scenarios that never assert on driver events at all.
 */
export async function capturePreExistingDriverEventRows(sc: ScenarioContext, assetId: Uuid): Promise<void> {
  if (!(await sc.reader.isAvailable())) {
    stateFor(sc).preExistingDriverEventRowIds.set(assetId, new Set());
    return;
  }
  const rows = await sc.reader.byAsset({ assetId, fromIso: windowStart(sc), toIso: windowEnd(sc) });
  stateFor(sc).preExistingDriverEventRowIds.set(assetId, new Set(rows.map((r) => r.id)));
}

/**
 * Filters `rows` down to the ones that appeared *during this execution* on `assetId` — i.e.
 * excluding whatever `capturePreExistingDriverEventRows` snapshotted (defect 3). Generic over any
 * row shape carrying an `id`, so `waits.ts` can use it for both the full `DriverEventRow` and any
 * narrower projection.
 */
export function filterExecutionRows<T extends { id: Uuid }>(sc: ScenarioContext, assetId: Uuid, rows: readonly T[]): T[] {
  const preIds = stateFor(sc).preExistingDriverEventRowIds.get(assetId) ?? new Set<Uuid>();
  return rows.filter((r) => !preIds.has(r.id));
}

/** Marks that an `ident` step (fresh or `redeliverOf`) has been dispatched in this execution. */
export function recordIdentDispatched(sc: ScenarioContext): void {
  stateFor(sc).identDispatched = true;
}

/** Whether an `ident` step has been dispatched yet in this execution (defect 1). */
export function hasIdentBeenDispatched(sc: ScenarioContext): boolean {
  return stateFor(sc).identDispatched;
}

/** Stores the payload an `as`-labelled ident step actually sent, for a later `redeliverOf`. */
export function recordIdentPayload(sc: ScenarioContext, label: string, payload: RoscoDriverWebhookPayload): void {
  stateFor(sc).identPayloads.set(label, payload);
}

/** Looks up the payload a labelled ident step sent. Undefined if the label was never recorded. */
export function getIdentPayload(sc: ScenarioContext, label: string): RoscoDriverWebhookPayload | undefined {
  return stateFor(sc).identPayloads.get(label);
}

export function recordUnchangedAssetAssignee(sc: ScenarioContext, assetId: Uuid, value: Uuid | null): void {
  stateFor(sc).unchangedAssetAssignee.set(assetId, value);
}

/**
 * The upper bound of the time window an assertion should query within: now, or the timeline's
 * latest logical time if that is later. It is later only for a step stamped ahead of when it is
 * sent (`timestampAheadOfDelivery`, O17's day-two identification), whose row would otherwise fall
 * outside a window that ends now.
 */
export function windowEnd(sc: ScenarioContext): string {
  const latest = sc.t0.getTime() + stateFor(sc).timelineMaxAtSec * 1_000;
  return new Date(Math.max(Date.now(), latest)).toISOString();
}

export function getUnchangedAssetAssignee(sc: ScenarioContext, assetId: Uuid): Uuid | null | undefined {
  return stateFor(sc).unchangedAssetAssignee.get(assetId);
}

/** `TripRef` has no natural string form, so callers pass the same serialization key both times. */
export function serializeTripRef(ref: TripRef): string {
  return typeof ref === 'string' ? ref : `${ref.assetRef ?? 'primary'}#${ref.index}`;
}

export function recordUnchangedTripAssignee(sc: ScenarioContext, key: string, value: Uuid | null): void {
  const state = stateFor(sc);
  state.unchangedTripAssignee.set(key, value);
  state.pendingTripBaselines.delete(key);
}

/** Defers a trip's `'unchanged'` baseline until the trip exists. See `pendingTripBaselines`. */
export function markTripBaselinePending(sc: ScenarioContext, key: string, ref: TripRef): void {
  stateFor(sc).pendingTripBaselines.set(key, ref);
}

/** The `'unchanged'` trip baselines still waiting for their trip to appear. */
export function getPendingTripBaselines(sc: ScenarioContext): ReadonlyMap<string, TripRef> {
  return stateFor(sc).pendingTripBaselines;
}

export function getUnchangedTripAssignee(sc: ScenarioContext, key: string): Uuid | null | undefined {
  return stateFor(sc).unchangedTripAssignee.get(key);
}

/**
 * Resolves a `TripRef` against the trips that appeared on the target asset *during this
 * execution* — i.e. excluding whatever `capturePreExistingTrips` snapshotted. `'latest'` and
 * `'first'` carry no `assetRef` in the contract, so they always mean the primary asset.
 * `{ index }` is 0-based.
 * // VERIFY: 0-based indexing is an assumption; confirm against Module E once scenarios using an
 * explicit index are written.
 */
export async function resolveTripRef(sc: ScenarioContext, ref: TripRef): Promise<Trip> {
  const asset = ref === 'latest' || ref === 'first' ? sc.run : await resolveAsset(sc, ref.assetRef);
  const preIds = getPreExistingTripIds(sc, asset.assetId);
  const all = await searchTrips(sc.api, { assetId: asset.assetId });
  const thisExecution = all
    .filter((t) => !preIds.has(t.id))
    .sort((a, b) => compareIsoAsc(a.start_date, b.start_date));
  const index = ref === 'first' ? 0 : ref === 'latest' ? thisExecution.length - 1 : ref.index;
  const trip = thisExecution[index];
  if (!trip) {
    throw new Error(
      `resolveTripRef: no trip at index ${index} for asset ${asset.assetId} within this scenario ` +
        `execution (found ${thisExecution.length} trip(s) so far)`,
    );
  }
  return trip;
}
