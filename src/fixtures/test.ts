/**
 * The `fr` fixture and `defineScenarioTests`.
 *
 * `fr` is WORKER-scoped, keyed on a `fleet` TEST OPTION — Playwright's supported mechanism for a
 * value that must be fixed for a whole file but still needs to flow into a worker-scoped fixture.
 * A spec file declares its fleet by calling `defineScenarioTests(scenarios, fleet)` at module
 * scope, which sets the option via `test.use({ fleet })`. Playwright starts a fresh worker
 * whenever the resolved option value changes between files, so two files never share a worker.
 *
 * Each scenario runs on its own asset (`FleetContext.assetFor`), which is what lets a file run its
 * scenarios in parallel (`ScenarioFileOptions.parallel`): the trip-recency guard and the trip-end
 * claim are asset-scoped, so two scenarios on different assets can't see each other's trips. They
 * do share the fleet's drivers, which is why a scenario that deactivates one runs in an `inOrder`
 * group on a driver nothing else in the file uses.
 */

import { test as base, expect, request as playwrightRequest } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { ApiClient } from '../api/client';
import type { Contact, DriverKey, RunContext } from '../types';
import { suiteAccountId, suiteAssetId } from '../env';
import { createDriverEventEmitter } from '../emit/index';
import { createTelemetryEmitter } from '../emit/telemetry';
import { createDriverEventsReader } from '../read/driverEvents';
import type { ScenarioContext } from '../scenario/context';
import { anchorTimeline, ANCHOR_MARGIN_MS, deactivatedDrivers, runScenario } from '../scenario/runner';
import { describeExpectation } from '../reporting/describe';
import { designDocCaseFor } from '../reporting/designDocCases';
import { BACKFILL_BUDGET_MS } from '../scenario/timeouts';
import type { Scenario } from '../scenario/types';
import { prepareFleet, provisionAssetWithTennaCam } from './provision';
import { writeManifest } from './manifest';

/**
 * Fallback fleet for a spec file that uses `runContext`/`fr` without going through
 * `defineScenarioTests` — today, only `tests/setup/provision.spec.ts` (Module E's provisioning
 * smoke test). A real scenario suite always overrides this via `defineScenarioTests(scenarios,
 * fleet)`.
 */
const DEFAULT_FLEET = 'fr-setup';

/**
 * `fr` plus the per-scenario asset lookup. Each scenario runs on its own asset,
 * `[FRTest]-<fleet>-<case id>` (and `...-secondary` when it needs a second one), reused across
 * runs. Scenarios in a file used to share the fleet's asset, and one scenario's leftovers changed
 * the next one's outcome: an open trip (O12a) stopped the next trip being created (O12b), an
 * unlinked row (O12f, O5) was claimed by the next scenario's trip (O14), and a backdated trip
 * (O12c) overlapped the previous scenario's (O6). dv3 full run, 2026-09-29.
 */
export interface FleetContext extends Omit<ScenarioContext, 'run' | 'secondaryAsset'> {
  /** The fleet's drivers, found or created when the worker starts. */
  contacts: Record<DriverKey, Contact>;
  /**
   * The fleet's own asset, `[FRTest]-<fleet>` or the pinned `ASSET_ID_<FLEET>`. Provisioned on
   * first use only: scenarios run on their own assets, so it's only needed when one is pinned (and
   * by the setup smoke test). Every worker of a parallel file would otherwise provision it at once.
   */
  primary(): Promise<RunContext>;
  /** Provisions (or reuses) the asset and TennaCAM for `label`, once per worker. */
  assetFor(label: string): Promise<RunContext>;
}

interface WorkerFixtures {
  /** Test option (see module doc comment). Set once per file via `defineScenarioTests`. */
  fleet: string;
  /**
   * Test option. When true, this file's worker creates new assets instead of reusing the fleet's
   * (see `provisionAssetWithTennaCam`). Set via `defineScenarioTests(..., { freshAsset: true })`.
   */
  freshAsset: boolean;
  /**
   * Test option. Drivers this file's scenarios deactivate. Worker startup leaves them as they are
   * rather than re-enabling them, since in a parallel file another worker may be mid-scenario with
   * one disabled on purpose. Set by `defineScenarioTests` from the scenarios' timelines.
   */
  leaveEnabledAsIs: DriverKey[];
  fr: FleetContext;
  /**
   * `fr.run`, exposed as its own worker-scoped fixture so a plain provisioning-smoke-test (see
   * `tests/setup/provision.spec.ts`) can assert the fixture data without pulling in the emitter,
   * telemetry and reader plumbing `ScenarioContext` also carries. Depends on `fr`, so provisioning
   * still happens exactly once per worker.
   */
  runContext: RunContext;
}

// eslint-disable-next-line @typescript-eslint/ban-types -- no test-scoped fixtures of our own.
export const test = base.extend<{}, WorkerFixtures>({
  fleet: [DEFAULT_FLEET, { option: true, scope: 'worker' }],
  freshAsset: [false, { option: true, scope: 'worker' }],
  leaveEnabledAsIs: [[], { option: true, scope: 'worker' }],

  fr: [
    async ({ fleet, freshAsset, leaveEnabledAsIs }, use, workerInfo) => {
      // `playwrightRequest.newContext()` is the top-level `request` API, not the test's built-in
      // `request` fixture, because `fr` is worker-scoped and a worker-scoped fixture cannot depend
      // on a test-scoped one. That means it inherits none of `playwright.config.ts`'s `use` block —
      // reviewer finding 7. `use.actionTimeout` only ever governs Page/Locator actions and never
      // applied to API calls even through the built-in fixture, but it is the only configured
      // number that maps onto "how long one HTTP call may take", so it is read here and passed as
      // this context's default per-request timeout. `use.trace` has no equivalent: APIRequestContext
      // has no `.tracing` API at all (only BrowserContext/Page do), so there is nothing to wire it
      // into — it was dropped from `playwright.config.ts` instead of left in as false protection.
      const requestTimeoutMs = workerInfo.project.use.actionTimeout || undefined;
      const requestContext: APIRequestContext = await playwrightRequest.newContext({
        timeout: requestTimeoutMs,
      });
      const api = ApiClient.create(requestContext, { accountId: suiteAccountId(fleet) });
      const contacts = await prepareFleet(api, fleet, { leaveEnabledAsIs });
      const emitter = createDriverEventEmitter(api);
      const telemetry = createTelemetryEmitter(api);
      const reader = createDriverEventsReader(api);

      // Memoized per worker: a label is provisioned once, and every later call reuses the promise.
      // Assets are reused across runs by label (`provisionAssetWithTennaCam`).
      const assets = new Map<string, Promise<RunContext>>();
      const provisionOnce = (label: string, existingAssetId?: string): Promise<RunContext> => {
        let asset = assets.get(label);
        if (!asset) {
          asset = provisionAssetWithTennaCam(api, label, { existingAssetId, freshAsset }).then((b) => ({ ...b, contacts }));
          assets.set(label, asset);
        }
        return asset;
      };
      const sc: FleetContext = {
        contacts,
        primary: () => provisionOnce(fleet, suiteAssetId(fleet)),
        assetFor: (label) => provisionOnce(label),
        api,
        fleet,
        emitter,
        telemetry,
        reader,
        t0: new Date(),
      };

      await use(sc);

      writeManifest();
      await reader.close();
      await requestContext.dispose();
    },
    { scope: 'worker' },
  ],

  runContext: [
    async ({ fr }, use) => {
      await use(await fr.primary());
    },
    { scope: 'worker' },
  ],
});

export { expect };

/** Headroom added on top of BACKFILL_BUDGET_MS for `@slow` scenarios' test-level timeout. */
const SLOW_TEST_HEADROOM_MS = 60_000;

/**
 * Per execution, on top of the timeline's own planned pauses: preconditions, checkpoint holds
 * (up to LIVE_BUDGET_MS each), and the settle waits. A generous flat allowance, because the test
 * timeout only exists to stop a hung run, not to measure one.
 */
const EXECUTION_OVERHEAD_MS = 5 * 60_000;

/** Options for `defineScenarioTests`. */
export interface ScenarioFileOptions {
  /** Create new assets instead of reusing them (see `provisionAssetWithTennaCam`). */
  freshAsset?: boolean;
  /**
   * Run this file's scenarios in parallel across workers. Safe when each scenario has its own
   * asset and none of them changes something another one reads at the same time. Scenarios that
   * deactivate a driver are the exception inside a file: list them in `inOrder`, using a driver no
   * other scenario in the file uses.
   */
  parallel?: boolean;
  /**
   * Groups of scenario ids that run one after the other, in the order listed, while the rest of a
   * parallel file runs alongside them. Each group is a `describe` in Playwright's `default` mode.
   */
  inOrder?: ReadonlyArray<readonly string[]>;
}

/**
 * Generates one Playwright test per scenario, titled `<id> @mutating <tags> <title>`. `fleet` is
 * the fleet name this spec file owns (AGENT-BRIEF revision 2 item 1) — it both selects the
 * `ASSET_ID_<FLEET>`/`ACCOUNT_ID_<FLEET>` env overrides (`src/env.ts`) and, for a fixture-driven
 * scenario, scopes which fixtures `runner.ts` searches for an id match (see the convention
 * documented at the top of `scenario/runner.ts`). Call once per spec file, at module scope.
 */
export function defineScenarioTests(scenarios: readonly Scenario[], fleet: string, opts: ScenarioFileOptions = {}): void {
  const leaveEnabledAsIs = [...new Set(scenarios.flatMap(deactivatedDrivers))];
  test.use({ fleet, freshAsset: opts.freshAsset ?? false, leaveEnabledAsIs });
  if (opts.parallel) test.describe.configure({ mode: 'parallel' });

  const grouped = new Set((opts.inOrder ?? []).flat());
  const unknown = [...grouped].filter((id) => !scenarios.some((sc) => sc.id === id));
  if (unknown.length > 0) throw new Error(`defineScenarioTests(${fleet}): inOrder names unknown scenario(s) ${unknown.join(', ')}`);

  for (const group of opts.inOrder ?? []) {
    test.describe(`${group.join(', ')} in order`, () => {
      test.describe.configure({ mode: 'default' });
      for (const id of group) registerScenario(scenarios.find((sc) => sc.id === id) as Scenario, fleet);
    });
  }
  for (const scenario of scenarios) {
    if (!grouped.has(scenario.id)) registerScenario(scenario, fleet);
  }
}

function registerScenario(scenario: Scenario, fleet: string): void {
  const tags = (scenario.tags ?? []).join(' ');
  const title = `${scenario.id} @mutating ${tags} ${scenario.title}`.replace(/\s+/g, ' ').trim();
  // Read by `src/reporting/summaryReporter.ts` to print what each case is meant to prove.
  const docCase = designDocCaseFor(scenario.id);
  const annotation = [
    { type: 'case', description: scenario.id },
    { type: 'priority', description: scenario.priority },
    { type: 'fleet', description: fleet },
    { type: 'asserts', description: describeExpectation(scenario.expect) },
    ...(scenario.caveat ? [{ type: 'caveat', description: scenario.caveat }] : []),
    ...(docCase ? [{ type: 'doc-case', description: docCase.case }, { type: 'doc-expected', description: docCase.expected }] : []),
  ];
  // The wait `anchorTimeline` adds before a delayed trip's first step, per execution.
  const startWaitMs = anchorTimeline(scenario.timeline, 0).startAtMs - ANCHOR_MARGIN_MS;
  // Steps are sent in real time, so an execution lasts at least its planned pauses. A repeated
  // scenario (O9 runs five times) needs that budget for every execution.
  const plannedMs = scenario.timeline.reduce((sum, s) => sum + Math.max(0, s.sendAfterMs ?? 0), 0);
  // A violation check that waits on the backfill cron polls for BACKFILL_BUDGET_MS on its own.
  const expectations = [scenario.expect, ...(scenario.expectAfterStep ?? []).map((c) => c.expect)];
  const backfillWaitMs = expectations.some((e) => e.thresholdEvents?.some((t) => t.viaBackfill)) ? BACKFILL_BUDGET_MS : 0;
  const executionBudgetMs = (scenario.repeat ?? 1) * (startWaitMs + plannedMs + backfillWaitMs + EXECUTION_OVERHEAD_MS);
  if (scenario.fixme) {
    test.fixme(title, { annotation: [...annotation, { type: 'fixme', description: scenario.fixme }] }, () => {});
    return;
  }
  test(title, { annotation }, async ({ fr }, testInfo) => {
    // A pinned asset (ASSET_ID / ASSET_ID_<FLEET>) is used as-is by every scenario in the file.
    // Otherwise each scenario gets its own asset (see `FleetContext`).
    const label = `${fleet}-${scenario.id}`;
    const run = suiteAssetId(fleet) !== undefined ? await fr.primary() : await fr.assetFor(label);
    const sc: ScenarioContext = { ...fr, run, secondaryAsset: () => fr.assetFor(`${label}-secondary`) };
    testInfo.annotations.push({ type: 'asset', description: `${run.assetId} (tracker ${run.trackerId})` });
    test.setTimeout(Math.max(testInfo.timeout, executionBudgetMs));
    if (scenario.tags?.includes('@slow')) {
      // Reviewer finding 4: this must only ever WIDEN the timeout. `testInfo.timeout` is the
      // timeout already in effect (the project/config default, e.g. `playwright.config.ts`'s
      // 12 minutes) before this override runs — taking the max means a smaller computed budget
      // (BACKFILL_BUDGET_MS + headroom = 7 minutes today) can never shrink the one scenario that
      // waits out the backfill cron below what every other, faster scenario already gets.
      test.setTimeout(Math.max(testInfo.timeout, BACKFILL_BUDGET_MS + SLOW_TEST_HEADROOM_MS + startWaitMs));
    }
    await runScenario(scenario, sc);
  });
}
