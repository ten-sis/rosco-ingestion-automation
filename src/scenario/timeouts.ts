/**
 * Named timeout budgets for every wait in the suite. No wait ever hardcodes a number outside
 * this file — see `waits.ts` and `runner.ts`.
 */

import type { TimeoutName } from './types';

/** How often `expect.poll` re-checks state. Every poll in the suite uses this interval. */
export const POLL_INTERVAL_MS = 2_000;

/** webhook -> ingestion -> consumer -> writes, for the common case (no trip-end involved). */
export const LIVE_BUDGET_MS = 60_000;

/** trip-ended -> trip-end consumer -> writes (asset/trip assignee, threshold re-assignment). */
export const TRIP_END_BUDGET_MS = 120_000;

/** Past the scorecard backfill cron's own 5-minute run, plus headroom. */
export const BACKFILL_BUDGET_MS = 6 * 60_000;

/** How long Digestion's async Redis population may take before a device resolves. */
export const DIGESTION_READY_BUDGET_MS = 180_000;

/** How long a newly-started trip may take to become visible over the trips API. */
export const TRIP_APPEARS_BUDGET_MS = 90_000;

/**
 * How long `preflight()` (fixtures/provision.ts) waits for `/v5/licenses` to reflect a licence it
 * just enabled through the `setAccountLicenceEnabled` chain. A plain PATCH/POST is very likely
 * synchronous, so this is a short confirmation window, not a real propagation-delay budget.
 */
export const LICENCE_ENABLE_BUDGET_MS = 30_000;

/**
 * Resolves a `SettleStep.budget` name to its millisecond value. `TimeoutName` (declared in
 * `scenario/types.ts`) only carries the three budgets a scenario author can pick explicitly;
 * `DIGESTION_READY_BUDGET_MS` and `TRIP_APPEARS_BUDGET_MS` are never selectable this way; the
 * runner applies them as fixed internal defaults instead (see `runner.ts`).
 */
export function budgetFor(name: TimeoutName): number {
  switch (name) {
    case 'LIVE_BUDGET_MS':
      return LIVE_BUDGET_MS;
    case 'TRIP_END_BUDGET_MS':
      return TRIP_END_BUDGET_MS;
    case 'BACKFILL_BUDGET_MS':
      return BACKFILL_BUDGET_MS;
  }
}
