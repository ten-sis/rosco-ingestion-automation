/**
 * Executes a `Scenario` against a `ScenarioContext`, then asserts its `expect`. See the doc
 * comment at the top of `scenario/types.ts` for the two-clock model (logical `atSec` vs. delivery
 * order) that the timeline path below follows.
 *
 * ===========================================================================
 * EVERY SCENARIO IS TIMELINE-DRIVEN
 * ===========================================================================
 * `Scenario.timeline` is a required `Step[]`, and `runOneExecution` always runs it through
 * `runTimelineExecution` — there is no separate fixture-driven execution path, and no notion of a
 * `Fixture` anywhere in this module. A scenario whose case has a JSON fixture file under
 * `fixtures/*.json` still gets its `timeline` from that fixture, but the compiling happens once,
 * at module load time, in `src/scenarios/fixturePlayback.ts`'s `expandFixtureToSteps` (see O2,
 * O3.1 and O3.3 in `src/scenarios/live.ts` and `src/scenarios/delayed.ts`). That module resolves
 * the fixture through `planPlayback` (`../fixture/planner`) — the same function `../player.ts` and
 * `tools/play.ts` use to play a fixture directly from the command line — so a fixture-backed
 * scenario's `timeline` and a `tools/play.ts` run of the same fixture share one source of delay-
 * mode arithmetic. By the time a `Scenario` reaches this runner it is indistinguishable from a
 * hand-authored one: `timeline` is populated, `expectAfterStep` checkpoints reference real indices
 * into it, and this file only ever walks that array in order.
 *
 * COORDINATION NOTE (t0 anchor): AGENT-BRIEF asks for `computeT0` below to be deleted in favour of
 * reading an anchor a second agent is moving onto `planPlayback`'s returned `PlaybackPlan`. That
 * plan is resolved once per module, at fixture-compile time (inside `expandFixtureToSteps`, which
 * every `src/scenarios/*.ts` file calls at the top level) — well before any given scenario
 * *executes*, and, for `repeat` (`race.ts`'s O9), the same compiled `Step[]` is executed several
 * times from several independent `t0` anchors. Nothing in the current `Scenario` contract
 * (`scenario/types.ts`, not owned by this task and not to be edited) carries a `PlaybackPlan` or a
 * `t0` through to the runner, and neither `fixturePlayback.ts` nor `fixture/planner.ts` (both
 * off-limits to this task) currently attach one to the `Step[]` they return. Deleting `computeT0`
 * without a real replacement would silently break every scenario execution in a way `tsc
 * --noEmit`/`playwright test --list` cannot catch (neither type-checks nor lists execute a
 * timeline). `computeT0` is therefore kept, unchanged in behaviour, until that dependency actually
 * lands; see the final report for this file's task.
 */

import { getAssetAssignee, setAssetAssignee } from '../api/assets';
import { setTripAssignee } from '../api/trips';
import { searchThresholdEvents, transferThresholdEvents } from '../api/thresholdEvents';
import { setContactEnabled } from '../api/contacts';
import { setAccountLicenceEnabled } from '../fixtures/provision';
import { buildDriverEventPayload } from '../emit/index';
import type { GmsEventType } from '../fixture/types';
import type { DriverEventType, DriverKey, Uuid } from '../types';
import { FR_LICENSE_NAME } from '../constants';
import {
  beginExecution,
  capturePreExistingDriverEventRows,
  capturePreExistingTrips,
  getIdentPayload,
  getUnchangedAssetAssignee,
  logicalTime,
  recordIdentDispatched,
  recordIdentPayload,
  recordUnchangedAssetAssignee,
  recordUnchangedTripAssignee,
  resolveAsset,
  resolveTripRef,
  serializeTripRef,
  windowStart,
  type ScenarioContext,
} from './context';
import {
  assertAssetAssignee,
  assertDriverEvents,
  assertDriverEventRowCount,
  assertThresholdEvent,
  assertTrip,
  selectByWhich,
  settle as pauseForDeliveryOrder,
  waitForDriverEventRows,
  waitForTrip,
  waitForTripEnded,
} from './waits';
import { budgetFor, LIVE_BUDGET_MS, POLL_INTERVAL_MS, TRIP_APPEARS_BUDGET_MS, TRIP_END_BUDGET_MS } from './timeouts';
import { expect } from '@playwright/test';
import type {
  Expectation,
  HarshEventStep,
  IdentStep,
  IgnitionOffStep,
  IgnitionOnStep,
  MoveStep,
  PatchAssetAssigneeStep,
  PatchTripAssigneeStep,
  Scenario,
  SettleStep,
  Step,
  TransferViolationsStep,
} from './types';

// ---------------------------------------------------------------------------
// Local defaults not pinned by the contract
// ---------------------------------------------------------------------------

/** Arbitrary fixed coordinates (Atlanta) used whenever a step omits `lat`/`lon`. */
const DEFAULT_LAT = 33.749;
const DEFAULT_LON = -84.388;
const DEFAULT_HARSH_SEVERITY: NonNullable<HarshEventStep['severity']> = 'hardBrake';

/** Headroom so the timeline's largest `atSec` still lands safely in the past, never in the future. */
const CLOCK_SAFETY_MARGIN_SEC = 30;

/** See the "COORDINATION NOTE (t0 anchor)" module doc comment above for why this stays. */
function computeT0(timeline: readonly Step[]): Date {
  const maxAtSec = Math.max(0, ...timeline.map((s) => s.atSec));
  return new Date(Date.now() - (maxAtSec + CLOCK_SAFETY_MARGIN_SEC) * 1_000);
}

function contactIdFor(sc: ScenarioContext, driver: DriverKey | null): Uuid | null {
  return driver === null ? null : sc.run.contacts[driver].id;
}

function licenceNameFor(licence: 'facialRecognition' | 'trackIt'): string {
  if (licence === 'facialRecognition') return FR_LICENSE_NAME;
  // VERIFY: ../constants exports no TrackIt licence name. Confirm the exact licence key string
  // against the account_licenses enum before relying on this against a live account.
  return 'TrackIt';
}

/** The kinds `deliverStep` actually sends over the wire (telemetry or an ident webhook), as
 *  opposed to test-harness/control-plane steps (`settle`, patches, contact/licence toggles,
 *  manual transfers). Defect 6's same-instant concurrency only ever applies to a pair of these. */
function isNetworkDispatchStep(step: Step): boolean {
  return step.kind === 'ignitionOn' || step.kind === 'move' || step.kind === 'harshEvent' || step.kind === 'ignitionOff' || step.kind === 'ident';
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Runs `scenario` against `baseSc`, once per `scenario.repeat` (default 1). */
export async function runScenario(scenario: Scenario, baseSc: ScenarioContext): Promise<void> {
  const repeatCount = scenario.repeat ?? 1;
  for (let rep = 0; rep < repeatCount; rep++) {
    await runOneExecution(scenario, baseSc, rep);
  }
}

/** Every `Scenario` carries a `timeline` — see the module doc comment above. */
async function runOneExecution(scenario: Scenario, baseSc: ScenarioContext, rep: number): Promise<void> {
  await runTimelineExecution(scenario, baseSc, rep);
}

function referencesSecondaryAsset(scenario: Scenario): boolean {
  if (scenario.preconditions?.secondaryAsset) return true;
  return scenario.timeline.some((step) => 'assetRef' in step && step.assetRef === 'secondary');
}

/**
 * Defect 6: `O9` (`@race`) fires an identification and the trip's own `ignitionOff` at the same
 * logical delivery instant (`fixturePlayback.ts` gives the second of the pair a zero `sendAfterMs`
 * gap), but the old loop `await`ed each step's delivery before starting the next, so the two
 * "concurrent" sends were actually strictly sequential and every one of the five `repeat`s
 * exercised the identical interleaving. `Array.prototype.sort` being STABLE is what made that
 * deterministic in the first place: `planner.ts`'s `events.sort((a, b) => a.deliverAtMs -
 * b.deliverAtMs)` never reorders two events whose `deliverAtMs` tie, so the trip event (always
 * concatenated before the ident events, `[...tripEvents, ...identEvents]`) reliably won every tie
 * — including this one — and stayed first every time. Restricted to `@race` scenarios only: a
 * same-instant tie elsewhere in the suite (e.g. O14/O21, where the ident and the trip's own
 * `IGN_ON` tie at `atSec 0`) is relied on by other scenarios to resolve in that same stable order,
 * and dispatching those concurrently would change behaviour those scenarios were not written to
 * exercise.
 */
function isRaceScenario(scenario: Scenario): boolean {
  return scenario.tags?.includes('@race') ?? false;
}

/** Whether `timeline[index + 1]` was compiled to the exact same delivery instant as `timeline[index]`
 *  (a zero/absent `sendAfterMs` on the *next* step, for two real network-dispatch steps — see
 *  `isNetworkDispatchStep`). Only meaningful for `index + 1 < timeline.length`. */
function tiesWithNext(timeline: readonly Step[], index: number): boolean {
  const step = timeline[index];
  const next = timeline[index + 1];
  if (!step || !next) return false;
  return !next.sendAfterMs && isNetworkDispatchStep(step) && isNetworkDispatchStep(next);
}

async function runTimelineExecution(scenario: Scenario, baseSc: ScenarioContext, rep: number): Promise<void> {
  // Fresh derived context per execution: new t0, new WeakMap-keyed bookkeeping. `baseSc` (the
  // worker-scoped fixture context) is never mutated — see the module doc comment in context.ts.
  const sc: ScenarioContext = { ...baseSc, t0: computeT0(scenario.timeline) };
  beginExecution(sc, scenario.timeline);

  await capturePreExistingTrips(sc, sc.run.assetId);
  await capturePreExistingDriverEventRows(sc, sc.run.assetId);
  if (referencesSecondaryAsset(scenario)) {
    const secondary = await sc.secondaryAsset();
    await capturePreExistingTrips(sc, secondary.assetId);
    await capturePreExistingDriverEventRows(sc, secondary.assetId);
  }

  await applyPreconditions(scenario, sc);
  await captureUnchangedSnapshots(scenario, sc);

  const raceMode = isRaceScenario(scenario);
  const { timeline } = scenario;
  for (let i = 0; i < timeline.length; i++) {
    const step = timeline[i];
    if (!step) continue; // unreachable given the loop bound; satisfies noUncheckedIndexedAccess

    if (raceMode && tiesWithNext(timeline, i)) {
      const next = timeline[i + 1];
      if (!next) continue; // unreachable: tiesWithNext already confirmed timeline[i + 1] exists
      // Alternate which side of the pair is listed (and therefore dispatched) first across
      // repeats, so both interleavings actually get exercised rather than always resolving the
      // same way (see the doc comment above `isRaceScenario`).
      const [firstStep, secondStep] = rep % 2 === 0 ? [step, next] : [next, step];
      await Promise.all([deliverStep(sc, firstStep), deliverStep(sc, secondStep)]);
      for (const entry of scenario.expectAfterStep ?? []) {
        if (entry.afterIndex === i || entry.afterIndex === i + 1) await assertExpectation(entry.expect, sc);
      }
      i += 1; // both steps consumed
      continue;
    }

    await deliverStep(sc, step);
    for (const entry of scenario.expectAfterStep ?? []) {
      if (entry.afterIndex === i) await assertExpectation(entry.expect, sc);
    }
  }

  await assertExpectation(scenario.expect, sc);
}

async function applyPreconditions(scenario: Scenario, sc: ScenarioContext): Promise<void> {
  const pre = scenario.preconditions;
  if (!pre) return;
  if (pre.assetAssignee !== undefined) {
    await setAssetAssignee(sc.api, sc.run.assetId, contactIdFor(sc, pre.assetAssignee));
  }
  if (pre.licences) {
    for (const [key, enabled] of Object.entries(pre.licences)) {
      await setAccountLicenceEnabled(sc.api, sc.run.accountId, licenceNameFor(key as 'facialRecognition' | 'trackIt'), enabled ?? false);
    }
  }
  if (pre.secondaryAsset) {
    await sc.secondaryAsset();
  }
}

/**
 * Snapshots the assignee baselines a scenario execution needs before step 1 runs.
 *
 * Unconditionally captures the primary asset's (and, when referenced, the secondary asset's)
 * assignee — not only when an `'unchanged'` expectation names it — because `deliverSettleStep`'s
 * `assigneeWritten` case (defect 2) needs "the value at execution start" regardless of whether any
 * expectation ever asserts `'unchanged'` against it. `recordUnchangedAssetAssignee` is idempotent
 * (last write wins with the same freshly-read value), so the loop below capturing it again for an
 * explicit `'unchanged'` expectation is a harmless, if slightly redundant, extra read.
 *
 * A trip referenced as `'unchanged'` that does not exist yet is recorded with a `null` baseline (a
 * trip with no history has no assignee) — a reasonable but unverified reading of the design doc's
 * intent for that edge case.
 */
async function captureUnchangedSnapshots(scenario: Scenario, sc: ScenarioContext): Promise<void> {
  const primary = await resolveAsset(sc, undefined);
  recordUnchangedAssetAssignee(sc, primary.assetId, await getAssetAssignee(sc.api, primary.assetId));
  if (referencesSecondaryAsset(scenario)) {
    const secondary = await sc.secondaryAsset();
    recordUnchangedAssetAssignee(sc, secondary.assetId, await getAssetAssignee(sc.api, secondary.assetId));
  }

  const expectations: Expectation[] = [scenario.expect, ...(scenario.expectAfterStep ?? []).map((e) => e.expect)];
  for (const expectation of expectations) {
    if (expectation.assetAssignee?.value === 'unchanged') {
      const asset = await resolveAsset(sc, expectation.assetAssignee.assetRef);
      const current = await getAssetAssignee(sc.api, asset.assetId);
      recordUnchangedAssetAssignee(sc, asset.assetId, current);
    }
    for (const tripExpectation of expectation.trips ?? []) {
      if (tripExpectation.assignee === 'unchanged') {
        const key = serializeTripRef(tripExpectation.tripRef);
        const baseline = await resolveTripRef(sc, tripExpectation.tripRef)
          .then((t) => t.assignee_id)
          .catch(() => null);
        recordUnchangedTripAssignee(sc, key, baseline);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step dispatch (timeline path only)
// ---------------------------------------------------------------------------

async function deliverStep(sc: ScenarioContext, step: Step): Promise<void> {
  if (step.sendAfterMs) await pauseForDeliveryOrder(step.sendAfterMs);
  switch (step.kind) {
    case 'ignitionOn':
    case 'move':
    case 'harshEvent':
    case 'ignitionOff':
      await deliverTelemetryStep(sc, step);
      return;
    case 'ident':
      await deliverIdentStep(sc, step);
      return;
    case 'patchAssetAssignee':
      await deliverPatchAssetAssignee(sc, step);
      return;
    case 'patchTripAssignee':
      await deliverPatchTripAssignee(sc, step);
      return;
    case 'deactivateContact':
    case 'reactivateContact':
      await setContactEnabled(sc.api, sc.run.contacts[step.driver].id, step.kind === 'reactivateContact');
      return;
    case 'setLicence':
      await setAccountLicenceEnabled(sc.api, sc.run.accountId, licenceNameFor(step.licence), step.enabled);
      return;
    case 'transferViolations':
      await deliverTransferViolations(sc, step);
      return;
    case 'settle':
      await deliverSettleStep(sc, step);
      return;
  }
}

/** Maps a `harshEvent` step's severity onto the GMS event name that carries it. */
function harshSeverityToGmsEvent(severity: NonNullable<HarshEventStep['severity']>): GmsEventType {
  switch (severity) {
    case 'hardBrake':
      return 'HARDBRAKE';
    case 'hardAccel':
      return 'HARDACCEL';
    case 'hardTurn':
      return 'HARDTURN';
  }
}

function gmsEventTypeFor(step: IgnitionOnStep | MoveStep | HarshEventStep | IgnitionOffStep): GmsEventType {
  switch (step.kind) {
    case 'ignitionOn':
      return 'IGN_ON';
    case 'move':
      return 'ON_PERIODIC';
    case 'harshEvent':
      return harshSeverityToGmsEvent(step.severity ?? DEFAULT_HARSH_SEVERITY);
    case 'ignitionOff':
      return 'IGN_OFF';
  }
}

/**
 * `TelemetryEmitter` (`../emit/telemetry`, Module C's file) exposes a single `send(frame)`, not
 * one method per GMS event kind — this maps every telemetry `Step` kind onto one `TelemetryFrame`.
 */
async function deliverTelemetryStep(
  sc: ScenarioContext,
  step: IgnitionOnStep | MoveStep | HarshEventStep | IgnitionOffStep,
): Promise<void> {
  const asset = await resolveAsset(sc, step.assetRef);
  const atIso = logicalTime(sc, step.atSec);
  const lat = step.kind === 'move' ? step.lat ?? DEFAULT_LAT : DEFAULT_LAT;
  const lon = step.kind === 'move' ? step.lon ?? DEFAULT_LON : DEFAULT_LON;
  await sc.telemetry.send({ gmsSerial: asset.gmsSerial, event: gmsEventTypeFor(step), atIso, lat, lon });
}

/**
 * `buildDriverEventPayload` (per AGENT-BRIEF) takes no explicit event-type argument, so it likely
 * derives `name` from whether `driverGuid` is present. `IdentStep.type` is a first-class override
 * (needed for deliberately-malformed cases), so the built payload's `name` is always overwritten
 * afterward to whatever this step actually asks for.
 * // VERIFY: confirm buildDriverEventPayload's exact param/return shape against Module C; the
 * post-hoc `name` override assumes the field is called `name` and is freely overwritable, which
 * matches `RoscoDriverWebhookPayload` but not any internal invariant the real implementation might
 * enforce. `buildDriverEventPayload` is also not among the exact `../emit/index` signatures this
 * revision's brief pins down (only `createDriverEventEmitter` is) — confirm it still exists there.
 */
async function deliverIdentStep(sc: ScenarioContext, step: IdentStep): Promise<void> {
  // Marks this execution as having dispatched an ident regardless of which branch below actually
  // sends it (defect 1: negative assertions use this to decide whether a proof-of-liveness marker
  // can possibly exist yet).
  recordIdentDispatched(sc);

  if (step.redeliverOf) {
    const cached = getIdentPayload(sc, step.redeliverOf);
    if (!cached) {
      throw new Error(
        `ident step references redeliverOf="${step.redeliverOf}" but no earlier step in this ` +
          `execution was labelled as: '${step.redeliverOf}'`,
      );
    }
    await sc.emitter.reemit(cached);
    if (step.as) recordIdentPayload(sc, step.as, cached);
    return;
  }

  const asset = await resolveAsset(sc, step.assetRef);
  const type: DriverEventType = step.type ?? (step.driver === null ? 'unDrv' : 'identDrv');
  const contact = step.driver === null ? undefined : sc.run.contacts[step.driver];
  const payload = {
    ...buildDriverEventPayload({
      vehicleId: asset.vehicleId,
      timestampIso: logicalTime(sc, step.atSec),
      driverGuid: contact?.id ?? null,
      driverFirst: contact?.first_name,
      driverLast: contact?.last_name,
      lat: DEFAULT_LAT,
      lon: DEFAULT_LON,
    }),
    name: type,
  };
  await sc.emitter.emit(payload);
  if (step.as) recordIdentPayload(sc, step.as, payload);
}

async function deliverPatchAssetAssignee(sc: ScenarioContext, step: PatchAssetAssigneeStep): Promise<void> {
  const asset = await resolveAsset(sc, step.assetRef);
  await setAssetAssignee(sc.api, asset.assetId, contactIdFor(sc, step.driver));
}

async function deliverPatchTripAssignee(sc: ScenarioContext, step: PatchTripAssigneeStep): Promise<void> {
  const trip = await resolveTripRef(sc, step.tripRef ?? 'latest');
  await setTripAssignee(sc.api, trip.id, contactIdFor(sc, step.driver));
}

async function deliverTransferViolations(sc: ScenarioContext, step: TransferViolationsStep): Promise<void> {
  const trip = await resolveTripRef(sc, step.tripRef ?? 'latest');
  const events = await searchThresholdEvents(sc.api, trip.id);
  const subset = selectByWhich(events, step.which ?? 'all');
  const contactId = sc.run.contacts[step.driver].id;
  await transferThresholdEvents(sc.api, subset.map((e) => ({ contactId, thresholdEventId: e.id })));
}

/**
 * `SettleStep` carries no `assetRef`/`tripRef` of its own, so every `until` kind resolves against
 * the run's primary asset (and, for `tripEnded`, its latest trip). This is a structural limit of
 * `scenario/types.ts` as given, not a choice made here — flagged in the final report.
 */
async function deliverSettleStep(sc: ScenarioContext, step: SettleStep): Promise<void> {
  const budgetMs = step.budget ? budgetFor(step.budget) : defaultBudgetFor(step.until);
  switch (step.until) {
    case 'identificationPersisted':
      await waitForDriverEventRows(sc, {
        assetId: sc.run.assetId,
        fromIso: windowStart(sc),
        toIso: new Date().toISOString(),
        minCount: 1,
        budgetMs,
      });
      return;
    case 'tripStarted':
      // Defect 2: no longer filters by `start_date >= sc.t0` (a backdated `sc.t0` could match a
      // trip left over from an earlier scenario in the same file); `waitForTrip` now excludes
      // pre-existing trip ids instead, agreeing with `resolveTripRef`.
      await waitForTrip(sc, { assetId: sc.run.assetId, budgetMs });
      return;
    case 'tripEnded': {
      const trip = await resolveTripRef(sc, 'latest');
      await waitForTripEnded(sc, { tripId: trip.id, budgetMs });
      return;
    }
    case 'assigneeWritten': {
      // Defect 2: polls for a CHANGE from the value captured at execution start
      // (`captureUnchangedSnapshots`'s unconditional baseline), not merely "is non-null" — nothing
      // resets the asset assignee between scenarios in a file, and several scenarios set one in
      // `preconditions`, so `!== null` could already be true before this step ever runs. Asserting
      // against a *specific* expected contact (the other half of AGENT-BRIEF's instruction) is not
      // expressible here: `SettleStep` carries no driver/contact field of its own — another
      // structural limit of `scenario/types.ts` as given, flagged in the final report.
      const baseline = getUnchangedAssetAssignee(sc, sc.run.assetId);
      if (baseline === undefined) {
        throw new Error(
          "deliverSettleStep('assigneeWritten'): no execution-start baseline was captured for " +
            'this asset. captureUnchangedSnapshots always captures the primary asset ' +
            'unconditionally now — this only happens if this SettleStep ever fires before that.',
        );
      }
      await expect
        .poll(async () => (await getAssetAssignee(sc.api, sc.run.assetId)) !== baseline, {
          message:
            `asset ${sc.run.assetId} assignee was still ${baseline ?? 'unset'} ${budgetMs}ms after the ` +
            'identification was accepted by the webhook: the facial-recognition pipeline did not write it',
          timeout: budgetMs,
          intervals: [POLL_INTERVAL_MS],
        })
        .toBe(true);
      return;
    }
  }
}

function defaultBudgetFor(until: SettleStep['until']): number {
  switch (until) {
    case 'identificationPersisted':
      return LIVE_BUDGET_MS;
    case 'tripStarted':
      return TRIP_APPEARS_BUDGET_MS;
    case 'tripEnded':
      return TRIP_END_BUDGET_MS;
    case 'assigneeWritten':
      return LIVE_BUDGET_MS;
  }
}

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

/**
 * Asserts one `Expectation`. Exported so tests can assert independently of a timeline, but
 * `'unchanged'` values still require a snapshot captured by `runScenario` (see `waits.ts`'s
 * internal `resolveAssigneeValue`), and every poll inside the delegated `waits.ts` functions
 * defaults to `LIVE_BUDGET_MS` (or the budget-appropriate constant for trip/trip-end waits)
 * because this function has no scenario tags to consult. A `@slow` scenario that needs the
 * `BACKFILL_BUDGET_MS` scorecard-cron window MUST place an explicit `SettleStep` with
 * `budget: 'BACKFILL_BUDGET_MS'` in its timeline before relying on this — otherwise the polls
 * below will simply time out too early.
 */
export async function assertExpectation(expectation: Expectation, sc: ScenarioContext): Promise<void> {
  if (expectation.assetAssignee) await assertAssetAssignee(expectation.assetAssignee, sc);
  if (expectation.trips) for (const t of expectation.trips) await assertTrip(t, sc);
  if (expectation.driverEvents) await assertDriverEvents(expectation.driverEvents, sc);
  if (expectation.thresholdEvents) for (const t of expectation.thresholdEvents) await assertThresholdEvent(t, sc);
  if (expectation.driverEventRowCount !== undefined) await assertDriverEventRowCount(expectation.driverEventRowCount, sc);
}
