/**
 * Every wait in the suite. No `waitForTimeout`, no bare sleep used as a proxy for pipeline state —
 * each function here is `expect.poll` against a named budget from `timeouts.ts`. The exceptions
 * are `settle` (a real wall-clock pause reserved for delivery-order sensitivity, never for "has the
 * pipeline finished", see its own doc comment) and `holdUnchanged` (defect 1's "no marker exists
 * yet" fallback, which must keep sampling for the whole budget rather than stop at the first match
 * — the opposite of what `expect.poll` is for; see its own doc comment).
 */

import { expect, test } from '@playwright/test';
import type { ApiClient } from '../api/client';
import type { DriverEventFlags, DriverEventRow, ThresholdEvent, Trip, Uuid } from '../types';
import { env } from '../env';
import { getAssetAssignee } from '../api/assets';
import { getTrip, searchTrips } from '../api/trips';
import { resolveRoscoDevice } from '../api/digestion';
import { searchRoscoEvents } from '../api/roscoEvents';
import { searchThresholdEvents } from '../api/thresholdEvents';
import {
  compareIsoAsc,
  filterExecutionRows,
  getPreExistingTripIds,
  getUnchangedAssetAssignee,
  getUnchangedTripAssignee,
  hasIdentBeenDispatched,
  resolveAsset,
  resolveTripRef,
  serializeTripRef,
  windowEnd,
  windowStart,
  type ScenarioContext,
} from './context';
import { BACKFILL_BUDGET_MS, LIVE_BUDGET_MS, POLL_INTERVAL_MS, TRIP_APPEARS_BUDGET_MS, TRIP_END_BUDGET_MS } from './timeouts';
import type { AssigneeExpectation, DriverEventExpectation, Expectation, ServiceLogExpectation, ThresholdEventExpectation, TripExpectation } from './types';
import { podsStartedAfter, readDeploymentLogs } from '../read/serviceLogs';

/**
 * Shared, greppable failure text for every expectation that names `driverEvents` or
 * `driverEventRowCount` while the backing store does not exist yet. Exported so `runner.ts`
 * (`assertExpectation`) can throw the identical string without duplicating it.
 */
export const READER_UNAVAILABLE_MESSAGE = 'NOT IMPLEMENTED: rosco_driver_events is not available';

/**
 * Distinct, greppable failure text for defect 1's other "not built" case: the reader/table itself
 * exists (so `ensureReaderAvailable` did not throw `READER_UNAVAILABLE_MESSAGE`), but the
 * identification/trip-end consumer never wrote anything for an ident this execution genuinely
 * dispatched. Shaped like `READER_UNAVAILABLE_MESSAGE` on purpose, so this also reads as "not
 * built" rather than "a write guard was violated".
 */
export const PIPELINE_NEVER_ACTED_MESSAGE = 'NOT IMPLEMENTED: the identification/trip-end consumer never acted on this execution';

/**
 * Gate before any read that needs `sc.reader`. Distinguishes two different reasons the reader can
 * be unavailable (AGENT-BRIEF revision 2 item 5):
 *
 *   - `DRIVER_EVENTS_READER=sql` was chosen but `DB_URL` is unset: this is an operator/environment
 *     setup gap, not a finding about the feature under test, so the scenario SKIPS with a clear
 *     message rather than failing.
 *   - Anything else (the default `api` reader, whose backing endpoint genuinely does not exist
 *     yet): keep failing loudly with `READER_UNAVAILABLE_MESSAGE`, unchanged from before this
 *     revision — this is the negative control that a red suite is honestly red.
 */
async function ensureReaderAvailable(sc: ScenarioContext): Promise<void> {
  if (env.driverEventsReader === 'sql' && !env.dbUrl) {
    test.skip(
      true,
      'DB_URL is not set. This scenario needs the SQL driver-events reader ' +
        '(DRIVER_EVENTS_READER=sql). Set DB_URL in .env, or unset DRIVER_EVENTS_READER to fall ' +
        'back to the api reader.',
    );
  }
  // `DriverEventsReader.isAvailable()` (../read/driverEvents.ts) is async (it probes the table or
  // the endpoint), so this must be awaited — a bare `if (!sc.reader.isAvailable())` would negate a
  // Promise object, which is always truthy, and silently never throw.
  if (!(await sc.reader.isAvailable())) {
    throw new Error(READER_UNAVAILABLE_MESSAGE);
  }
}

/** Waits for a trip to appear on `assetId`, other than one that already existed on it before this
 *  execution's timeline started (defect 2 — this used to filter by `start_date >= afterIso`
 *  instead, which disagreed with `resolveTripRef`'s pre-existing-id exclusion and could match a
 *  trip left over from an earlier scenario in the same file). Returns the latest such trip. */
export async function waitForTrip(
  sc: ScenarioContext,
  o: { assetId: string; budgetMs: number },
): Promise<Trip> {
  let found: Trip | undefined;
  await expect
    .poll(
      async () => {
        const trips = await searchTrips(sc.api, { assetId: o.assetId });
        const preIds = getPreExistingTripIds(sc, o.assetId);
        const candidates = trips
          .filter((t) => !preIds.has(t.id))
          .sort((a, b) => compareIsoAsc(a.start_date, b.start_date));
        found = candidates.at(-1);
        return found !== undefined;
      },
      { timeout: o.budgetMs, intervals: [POLL_INTERVAL_MS] },
    )
    .toBe(true);
  if (!found) {
    throw new Error(
      `waitForTrip: no new trip appeared on asset ${o.assetId} within ${o.budgetMs}ms`,
    );
  }
  return found;
}

/** Waits for the given trip to close (`end_date` set). Returns the closed trip. */
export async function waitForTripEnded(
  sc: ScenarioContext,
  o: { tripId: string; budgetMs: number },
): Promise<Trip> {
  let trip: Trip | undefined;
  await expect
    .poll(
      async () => {
        trip = await getTrip(sc.api, o.tripId);
        return trip.end_date !== null;
      },
      { timeout: o.budgetMs, intervals: [POLL_INTERVAL_MS] },
    )
    .toBe(true);
  if (!trip) {
    throw new Error(`waitForTripEnded: trip ${o.tripId} never resolved within ${o.budgetMs}ms`);
  }
  return trip;
}

/**
 * Waits for at least `minCount` driver-event rows on `assetId` within `[fromIso, toIso]`. Throws
 * immediately, before polling, when `sc.reader.isAvailable()` is false — the feature is not built
 * yet, so this must fail loudly rather than time out silently.
 */
export async function waitForDriverEventRows(
  sc: ScenarioContext,
  o: { assetId: string; fromIso: string; toIso: string; minCount: number; budgetMs: number },
): Promise<DriverEventRow[]> {
  await ensureReaderAvailable(sc);
  let rows: DriverEventRow[] = [];
  await expect
    .poll(
      async () => {
        rows = await sc.reader.byAsset({ assetId: o.assetId, fromIso: o.fromIso, toIso: o.toIso });
        return rows.length;
      },
      { timeout: o.budgetMs, intervals: [POLL_INTERVAL_MS] },
    )
    .toBeGreaterThanOrEqual(o.minCount);
  return rows;
}

/**
 * Waits for Digestion to resolve `vehicleId` through `getTrackerMetaByMakeSerial`. Accepts either
 * a full `ScenarioContext` or a raw `ApiClient` because `provisionAssetWithTennaCam` calls this
 * during worker-fixture setup, before any `ScenarioContext` exists; scenario code later calls it
 * through `sc`. On timeout, names the Redis key Digestion populates, since that is the first place
 * to look if this recurs (AGENT-BRIEF revision 2 item 6 keeps this poll but drops the dire tone the
 * original draft used here).
 */
export async function waitForDigestionReady(
  scOrApi: ScenarioContext | ApiClient,
  vehicleId: string,
  budgetMs: number,
): Promise<void> {
  const api: ApiClient = 'api' in scOrApi ? scOrApi.api : scOrApi;
  try {
    await expect
      .poll(
        async () => (await resolveRoscoDevice(api, vehicleId)) !== null,
        { timeout: budgetMs, intervals: [POLL_INTERVAL_MS] },
      )
      .toBe(true);
  } catch (cause) {
    throw new Error(
      `waitForDigestionReady: Digestion did not resolve vehicle_id ${vehicleId} within ${budgetMs}ms. ` +
        `It resolves the Rosco camera through the Redis key {secondaryTracker:${vehicleId}}, populated ` +
        'asynchronously after the tracker is installed; check that key if this recurs.',
    );
  }
}

/** Waits for a raw rosco event to land on `assetId` within `[fromIso, toIso]`. */
export async function waitForRawRoscoEvent(
  sc: ScenarioContext,
  o: { assetId: string; fromIso: string; toIso: string; budgetMs: number },
): Promise<void> {
  await expect
    .poll(
      async () => (await searchRoscoEvents(sc.api, o.assetId, o.fromIso, o.toIso)).length,
      { timeout: o.budgetMs, intervals: [POLL_INTERVAL_MS] },
    )
    .toBeGreaterThan(0);
}

/**
 * A real wall-clock pause. This is the one wait in the suite that is not `expect.poll` for "has
 * the pipeline reacted" purposes, and it exists only for delivery-order sensitivity — e.g. proving
 * a late-arriving POST still lands after an earlier one already in flight. Never use it to wait for
 * the pipeline to finish anything; use the named waits above, or a `SettleStep`, for that.
 */
export async function settle(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Defect 1 — proof-of-liveness for negative ('unchanged'-shaped) assertions
// ---------------------------------------------------------------------------

/**
 * Positive proof that the identification/trip-end consumer processed at least one event during
 * this execution, required before a negative assertion is allowed to take its one decisive read
 * (AGENT-BRIEF defect 1). Marker, in the brief's own preference order: a new `rosco_driver_events`
 * row for this execution on `assetId`. Row persistence (pipeline step 5) happens before any write
 * guard (step 6) can suppress a downstream write, so a bare row already proves the consumer ran —
 * the more specific markers (`is_assignee_source` decided, `trip_driver_set_at` set) are strictly
 * stronger evidence of the same fact, not a different condition, so a row's mere existence already
 * satisfies this check.
 *
 * Only called once `hasIdentBeenDispatched(sc)` is true (see `assertNegative`/`assertThresholdEvent`
 * below), so *some* marker existing at all within `budgetMs` is a reasonable expectation. If none
 * ever appears, the consumer never acted on an ident this execution genuinely sent — fails with
 * `PIPELINE_NEVER_ACTED_MESSAGE`, a distinct, greppable "not built" message, rather than letting
 * the caller's follow-up read produce a confusing "guard violated" failure instead.
 */
async function waitForProofOfLiveness(sc: ScenarioContext, o: { assetId: string; fromIso: string; budgetMs: number }): Promise<void> {
  if (sc.livenessLog) {
    await assertServiceLog(sc.livenessLog, sc);
    return;
  }
  await ensureReaderAvailable(sc);
  try {
    await expect
      .poll(
        async () => {
          const rows = await sc.reader.byAsset({ assetId: o.assetId, fromIso: o.fromIso, toIso: windowEnd(sc) });
          return filterExecutionRows(sc, o.assetId, rows).length > 0;
        },
        { timeout: o.budgetMs, intervals: [POLL_INTERVAL_MS] },
      )
      .toBe(true);
  } catch (cause) {
    throw new Error(
      `${PIPELINE_NEVER_ACTED_MESSAGE}: no rosco_driver_events row appeared for asset ${o.assetId} ` +
        `within ${o.budgetMs}ms, although this execution dispatched an ident`,
      { cause },
    );
  }
}

/**
 * Repeatedly samples `readValue` across the *entire* `budgetMs` window and fails the instant it
 * departs from `expected`, instead of `expect.poll`'s stop-on-first-match behaviour — the point
 * here is the opposite: prove nothing changes for the whole window, not that something became true
 * once. Used when no positive marker can possibly exist yet (defect 1's documented fallback), e.g.
 * the standard "checkpoint right after ignition-on, before any ident has been sent" negative
 * control that opens nearly every scenario in this suite: at that point in the execution nothing
 * could have written a marker even in a fully-built system, so waiting for one would time out and
 * misreport a correct pass as `PIPELINE_NEVER_ACTED_MESSAGE`.
 */
async function holdUnchanged<T>(readValue: () => Promise<T>, expected: T, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    // Cast to `unknown`: Playwright's `expect()` generic-overload resolution does not carry a
    // bare, unconstrained type parameter through to `Matchers` (it otherwise resolves to a
    // matcher stub missing `toEqual`); a concrete `unknown` picks up the full matcher set.
    const actual: unknown = await readValue();
    expect(actual).toEqual(expected as unknown);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await settle(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

/**
 * Resolves any negative, scalar-valued ('unchanged'-shaped) assertion (defect 1): picks
 * `holdUnchanged` or the marker-then-read strategy depending on whether an ident has been
 * dispatched yet in this execution, per the doc comments on both helpers above.
 */
async function assertNegative<T>(
  sc: ScenarioContext,
  o: { assetId: string; expected: T; readValue: () => Promise<T>; budgetMs: number },
): Promise<void> {
  if (!hasIdentBeenDispatched(sc)) {
    await holdUnchanged(o.readValue, o.expected, o.budgetMs);
    return;
  }
  await waitForProofOfLiveness(sc, { assetId: o.assetId, fromIso: windowStart(sc), budgetMs: o.budgetMs });
  const actual: unknown = await o.readValue();
  expect(actual).toEqual(o.expected as unknown);
}

// ---------------------------------------------------------------------------
// Expectation assertions
//
// Moved here from runner.ts (which stayed over 400 lines) per AGENT-BRIEF's guidance to split the
// runner across runner.ts (step dispatch) and waits.ts/context.ts as it grows. `runner.ts` keeps
// the single exported `assertExpectation` entry point and delegates each `Expectation` field to
// one function below.
// ---------------------------------------------------------------------------

/** Picks the `'all' | 'first' | 'last'` subset of a list, shared by the `transferViolations` step
 *  handler (runner.ts) and `assertThresholdEvent`'s `stillAssignedTo` check below. */
export function selectByWhich<T>(items: readonly T[], which: 'all' | 'first' | 'last'): T[] {
  if (which === 'all') return [...items];
  if (items.length === 0) return [];
  const item = which === 'first' ? items[0] : items[items.length - 1];
  return item === undefined ? [] : [item];
}

/**
 * Resolves an `AssigneeExpectation` to the concrete `Uuid | null` it asserts. `'unchanged'`
 * requires `unchangedBaseline` to have been captured by `runScenario` before step 1 (see
 * `context.ts#recordUnchangedAssetAssignee` / `recordUnchangedTripAssignee`); if it was not — i.e.
 * `assertExpectation` was called directly, independently of a timeline — this throws rather than
 * silently treating the assertion as satisfied.
 */
function resolveAssigneeValue(value: AssigneeExpectation, sc: ScenarioContext, unchangedBaseline: Uuid | null | undefined): Uuid | null {
  if (value === 'unchanged') {
    if (unchangedBaseline === undefined) {
      throw new Error(
        "assertExpectation: 'unchanged' was asserted but no pre-timeline snapshot exists for this " +
          'reference. Snapshots are captured by runScenario before step 1 — this only happens when ' +
          'assertExpectation is called directly, independently of a timeline.',
      );
    }
    return unchangedBaseline;
  }
  return value === null ? null : sc.run.contacts[value].id;
}

/**
 * Asserts `expectation.assetAssignee`. `'unchanged'` (defect 1) no longer resolves against a plain
 * `expect.poll` — a poll whose predicate already holds on the first probe returns instantly, which
 * is exactly what let every negative asset-assignee assertion in this suite pass without the
 * pipeline having had any chance to run. `assertNegative` requires proof of liveness (or, before
 * any ident has been sent, holds the baseline for the full budget) before trusting a single read.
 */
export async function assertAssetAssignee(exp: NonNullable<Expectation['assetAssignee']>, sc: ScenarioContext): Promise<void> {
  const asset = await resolveAsset(sc, exp.assetRef);
  const baseline = getUnchangedAssetAssignee(sc, asset.assetId);
  const expected = resolveAssigneeValue(exp.value, sc, baseline);
  const readValue = () => getAssetAssignee(sc.api, asset.assetId);

  if (exp.value === 'unchanged') {
    await assertNegative(sc, { assetId: asset.assetId, expected, readValue, budgetMs: LIVE_BUDGET_MS });
    return;
  }
  await expect.poll(readValue, { timeout: LIVE_BUDGET_MS, intervals: [POLL_INTERVAL_MS] }).toBe(expected);
}

function tripRefAssetId(sc: ScenarioContext, ref: TripExpectation['tripRef']): Promise<{ assetId: Uuid }> {
  const assetRef = typeof ref === 'object' ? ref.assetRef : undefined;
  return resolveAsset(sc, assetRef);
}

/**
 * Asserts one entry of `expectation.trips`. Same defect-1 fix as `assertAssetAssignee`: a
 * `'unchanged'` trip-assignee expectation now goes through `assertNegative` rather than a plain
 * `expect.poll`, so it cannot pass before the pipeline has proven it ran.
 */
export async function assertTrip(exp: TripExpectation, sc: ScenarioContext): Promise<void> {
  const key = serializeTripRef(exp.tripRef);

  let trip: Trip | undefined;
  await expect
    .poll(
      async () => {
        trip = await resolveTripRef(sc, exp.tripRef).catch(() => undefined);
        return trip !== undefined;
      },
      { timeout: TRIP_APPEARS_BUDGET_MS, intervals: [POLL_INTERVAL_MS] },
    )
    .toBe(true);
  if (!trip) throw new Error(`assertTrip: trip ${key} never appeared within ${TRIP_APPEARS_BUDGET_MS}ms`);

  // Read after the trip exists: an 'unchanged' baseline for a trip created during the timeline is
  // only captured once the trip appears (runner.ts, capturePendingTripBaselines).
  const expectedAssignee = resolveAssigneeValue(exp.assignee, sc, getUnchangedTripAssignee(sc, key));

  const readAssignee = async () => (await resolveTripRef(sc, exp.tripRef)).assignee_id;
  if (exp.assignee === 'unchanged') {
    const asset = await tripRefAssetId(sc, exp.tripRef);
    await assertNegative(sc, { assetId: asset.assetId, expected: expectedAssignee, readValue: readAssignee, budgetMs: LIVE_BUDGET_MS });
  } else {
    await expect.poll(readAssignee, { timeout: LIVE_BUDGET_MS, intervals: [POLL_INTERVAL_MS] }).toBe(expectedAssignee);
  }

  trip = await resolveTripRef(sc, exp.tripRef);
  if (exp.type) expect(trip.type).toBe(exp.type);
}

function filterMatchingRows(rows: readonly DriverEventRow[], exp: DriverEventExpectation, sc: ScenarioContext): DriverEventRow[] {
  const expectedContactId = exp.driver === null ? null : sc.run.contacts[exp.driver].id;
  return rows.filter((r) => r.contact_id === expectedContactId && (exp.type === undefined || r.type === exp.type));
}

/**
 * Only keys present in `expected` are checked. An absent flag means its default: `false` for every
 * flag except `contact_is_active`, which the consumer only writes when it is `false`, so absent
 * means the contact was active.
 */
function assertFlags(actual: DriverEventFlags | null, expected: DriverEventFlags): void {
  for (const key of Object.keys(expected) as Array<keyof DriverEventFlags>) {
    const absent = key === 'contact_is_active';
    const expectedValue = expected[key] ?? absent;
    const actualValue = actual?.[key] ?? absent;
    expect(actualValue, `flags.${key}`).toBe(expectedValue);
  }
}

async function assertTripLink(row: DriverEventRow, link: NonNullable<DriverEventExpectation['tripLink']>, sc: ScenarioContext): Promise<void> {
  if (link.state === 'unlinked') {
    expect(row.trip_id).toBeNull();
    return;
  }
  const trip = await resolveTripRef(sc, link.tripRef);
  expect(row.trip_id).toBe(trip.id);
}

/** Whether `exp` carries any per-row detail field beyond `driver`/`type`/`count`. */
function hasDetailFields(exp: DriverEventExpectation): boolean {
  return (
    exp.isAssigneeSource !== undefined ||
    exp.tripLink !== undefined ||
    exp.flags !== undefined ||
    exp.contactActive !== undefined ||
    exp.tripDriverSetAt !== undefined
  );
}

async function assertDriverEventDetails(rows: readonly DriverEventRow[], exp: DriverEventExpectation, sc: ScenarioContext): Promise<void> {
  const matched = filterMatchingRows(rows, exp, sc);
  for (const row of matched) {
    if (exp.isAssigneeSource !== undefined) expect(row.is_assignee_source).toBe(exp.isAssigneeSource);
    if (exp.tripLink) await assertTripLink(row, exp.tripLink, sc);
    if (exp.flags) assertFlags(row.flags, exp.flags);
    if (exp.contactActive !== undefined) expect(row.contact_active).toBe(exp.contactActive);
    if (exp.tripDriverSetAt) expect(row.trip_driver_set_at !== null).toBe(exp.tripDriverSetAt === 'set');
  }
}

/**
 * Asserts `expectation.driverEvents`. `DriverEventExpectation` carries no `assetRef`, so this
 * always targets the run's primary asset — a structural limit of `scenario/types.ts` as given, not
 * a choice made here.
 *
 * Defect 5: an expectation with `count: 0` matches no row by definition, so any detail field on it
 * (`isAssigneeSource`, `tripLink`, `flags`, `contactActive`, `tripDriverSetAt`) would silently
 * assert nothing. Throw eagerly, before any polling, rather than let it pass vacuously.
 *
 * Defect 1 / 3: entries default to `count: 1` (a positive expectation — wait for the row(s) to
 * appear, scoped to this execution via `filterExecutionRows`) but `count: 0` is a negative
 * expectation and goes through `assertNegative` instead, so it cannot pass merely because nothing
 * has happened yet.
 */
export async function assertDriverEvents(expectations: readonly DriverEventExpectation[], sc: ScenarioContext): Promise<void> {
  for (const e of expectations) {
    if ((e.count ?? 1) === 0 && hasDetailFields(e)) {
      throw new Error(
        `assertDriverEvents: the expectation for driver ${JSON.stringify(e.driver)} carries count: 0 together ` +
          'with a detail field (isAssigneeSource/tripLink/flags/contactActive/tripDriverSetAt). count: 0 means ' +
          'no row ever matches, so those fields would assert nothing (defect 5) — drop count: 0 or drop the ' +
          'detail fields.',
      );
    }
  }

  await ensureReaderAvailable(sc);
  const fromIso = windowStart(sc);
  const readRows = async (): Promise<DriverEventRow[]> =>
    filterExecutionRows(sc, sc.run.assetId, await sc.reader.byAsset({ assetId: sc.run.assetId, fromIso, toIso: windowEnd(sc) }));

  const positive = expectations.filter((e) => (e.count ?? 1) > 0);
  const zero = expectations.filter((e) => (e.count ?? 1) === 0);

  let rows: DriverEventRow[] = [];
  if (positive.length > 0) {
    await expect
      .poll(
        async () => {
          rows = await readRows();
          return positive.every((e) => filterMatchingRows(rows, e, sc).length === (e.count ?? 1));
        },
        { timeout: LIVE_BUDGET_MS, intervals: [POLL_INTERVAL_MS] },
      )
      .toBe(true);
  } else {
    rows = await readRows();
  }

  for (const e of zero) {
    await assertNegative(sc, {
      assetId: sc.run.assetId,
      expected: 0,
      readValue: async () => filterMatchingRows(await readRows(), e, sc).length,
      budgetMs: LIVE_BUDGET_MS,
    });
  }

  for (const e of positive) await assertDriverEventDetails(rows, e, sc);
}

/**
 * Asserts `expectation.driverEventRowCount`. `count: 0` is a negative expectation (defect 1) and
 * goes through `assertNegative`; any other count keeps the original poll, now scoped to this
 * execution's own rows (defect 3, via `filterExecutionRows`) so an earlier scenario's — or an
 * earlier `repeat`'s — leftover rows can no longer make the target look already satisfied.
 */
export async function assertDriverEventRowCount(count: number, sc: ScenarioContext): Promise<void> {
  await ensureReaderAvailable(sc);
  const fromIso = windowStart(sc);
  const readCount = async (): Promise<number> =>
    filterExecutionRows(sc, sc.run.assetId, await sc.reader.byAsset({ assetId: sc.run.assetId, fromIso, toIso: windowEnd(sc) })).length;

  if (count === 0) {
    await assertNegative(sc, { assetId: sc.run.assetId, expected: 0, readValue: readCount, budgetMs: LIVE_BUDGET_MS });
    return;
  }
  await expect.poll(readCount, { timeout: LIVE_BUDGET_MS, intervals: [POLL_INTERVAL_MS] }).toBe(count);
}

/**
 * Asserts one entry of `expectation.serviceLogs`: some pod of the deployment logged the line since
 * `t0`. Polls, since the service may still be working through the message when the timeline ends.
 * When it never shows up and a pod was replaced during the window, the failure says so, because a
 * deleted pod takes its log with it and the line may have been written there.
 */
/** The non-UUID `driver_guid` an execution sends, so a service-log expectation can name it. */
export function malformedDriverGuid(sc: ScenarioContext): string {
  return `frtest-not-a-uuid-${sc.t0.getTime()}`;
}

export async function assertServiceLog(exp: ServiceLogExpectation, sc: ScenarioContext): Promise<void> {
  const needles = (typeof exp.contains === 'string' ? [exp.contains] : exp.contains).map((text) =>
    text.replace('{accountId}', sc.run.accountId).replace('{malformedGuid}', malformedDriverGuid(sc)),
  );
  const needle = needles.join('" and "');
  const ref = { namespace: exp.namespace, deployment: exp.deployment };
  const deadline = Date.now() + LIVE_BUDGET_MS;
  for (;;) {
    const lines = await readDeploymentLogs(ref, sc.t0);
    if (lines.some((line) => needles.every((text) => line.includes(text)))) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const replaced = await podsStartedAfter(ref, sc.t0);
  throw new Error(
    `${exp.namespace}/${exp.deployment} never logged "${needle}" since ${sc.t0.toISOString()}` +
      (replaced.length > 0
        ? `. Pod(s) ${replaced.join(', ')} started during the window, so the line may have been on a pod that was replaced.`
        : '.'),
  );
}

/**
 * `'all assigned'` when there is at least one violation and every one is on `contactId`. An
 * empty list is its own answer: `[].every(...)` is true, which let every violation check pass on
 * trips scorecards never scored.
 */
function describeAssignment(events: readonly ThresholdEvent[], contactId: Uuid): string {
  if (events.length === 0) return 'no violations on the trip';
  const off = events.filter((te) => te.contact_id !== contactId).length;
  return off === 0 ? 'all assigned' : `${off} of ${events.length} on someone else`;
}

/**
 * Asserts one entry of `expectation.thresholdEvents`. Defect 4: `allAssignedTo` and
 * `stillAssignedTo` now poll under `TRIP_END_BUDGET_MS` (the trip-end consumer's re-assignment is
 * asynchronous and may still be in flight right after the timeline finishes) instead of reading
 * once; `noTransfers` is a negative expectation and goes through the same proof-of-liveness /
 * hold-unchanged split as defect 1, rather than a single immediate read.
 */
export async function assertThresholdEvent(exp: ThresholdEventExpectation, sc: ScenarioContext): Promise<void> {
  const trip = await resolveTripRef(sc, exp.tripRef ?? 'latest');
  let events: ThresholdEvent[] = [];
  const reassignBudgetMs = exp.viaBackfill ? BACKFILL_BUDGET_MS : TRIP_END_BUDGET_MS;

  if (exp.allAssignedTo !== undefined) {
    const contactId = sc.run.contacts[exp.allAssignedTo].id;
    await expect
      .poll(
        async () => {
          events = await searchThresholdEvents(sc.api, trip.id);
          return describeAssignment(events, contactId);
        },
        { timeout: reassignBudgetMs, intervals: [POLL_INTERVAL_MS], message: `violations on trip ${trip.id}` },
      )
      .toBe('all assigned');
  }

  if (exp.stillAssignedTo) {
    const { driver, which } = exp.stillAssignedTo;
    const contactId = sc.run.contacts[driver].id;
    await expect
      .poll(
        async () => {
          events = await searchThresholdEvents(sc.api, trip.id);
          return describeAssignment(selectByWhich(events, which), contactId);
        },
        { timeout: reassignBudgetMs, intervals: [POLL_INTERVAL_MS], message: `violations (${which}) on trip ${trip.id}` },
      )
      .toBe('all assigned');
  }

  if (exp.noTransfers) {
    const readAllUntransferred = async (): Promise<boolean> => {
      events = await searchThresholdEvents(sc.api, trip.id);
      return events.every((te) => te.transferred_by_id === null);
    };
    if (!hasIdentBeenDispatched(sc)) {
      await holdUnchanged(readAllUntransferred, true, TRIP_END_BUDGET_MS);
    } else {
      await waitForProofOfLiveness(sc, { assetId: sc.run.assetId, fromIso: windowStart(sc), budgetMs: TRIP_END_BUDGET_MS });
      expect(await readAllUntransferred()).toBe(true);
    }
  }
}
