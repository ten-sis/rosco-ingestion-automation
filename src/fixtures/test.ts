/**
 * The `fr` fixture and `defineScenarioTests`.
 *
 * AGENT-BRIEF revision 2 item 1: one asset per spec file, and files run in parallel. `fr` is
 * WORKER-scoped, keyed on a `fleet` TEST OPTION — Playwright's supported mechanism for a value
 * that must be fixed for a whole file but still needs to flow into a worker-scoped fixture (the
 * same mechanism Playwright's own `browserName` project option uses to feed the worker-scoped
 * `browser` fixture). A spec file declares its fleet by calling `defineScenarioTests(scenarios,
 * fleet)` at module scope, which sets the option via `test.use({ fleet })` before generating that
 * file's tests. Playwright starts a fresh worker whenever the resolved option value changes
 * between files, so two spec files never share one fleet's provisioned asset. `playwright.config.
 * ts`'s `fullyParallel: false` then keeps the scenarios inside one file strictly serial, because
 * the trip-recency guard is asset-scoped and two concurrent timelines on one asset would lie to
 * each other.
 */

import { test as base, expect, request as playwrightRequest } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { ApiClient } from '../api/client';
import type { RunContext } from '../types';
import { suiteAccountId } from '../env';
import { createDriverEventEmitter } from '../emit/index';
import { createTelemetryEmitter } from '../emit/telemetry';
import { createDriverEventsReader } from '../read/driverEvents';
import type { ScenarioContext } from '../scenario/context';
import { anchorTimeline, ANCHOR_MARGIN_MS, runScenario } from '../scenario/runner';
import { BACKFILL_BUDGET_MS } from '../scenario/timeouts';
import type { Scenario } from '../scenario/types';
import { provisionAssetWithTennaCam, provisionFleetRun } from './provision';
import { writeManifest } from './manifest';

/**
 * Fallback fleet for a spec file that uses `runContext`/`fr` without going through
 * `defineScenarioTests` — today, only `tests/setup/provision.spec.ts` (Module E's provisioning
 * smoke test). A real scenario suite always overrides this via `defineScenarioTests(scenarios,
 * fleet)`.
 */
const DEFAULT_FLEET = 'fr-setup';

interface WorkerFixtures {
  /** Test option (see module doc comment). Set once per file via `defineScenarioTests`. */
  fleet: string;
  /**
   * Test option. When true, this file's worker creates new assets instead of reusing the fleet's
   * (see `provisionAssetWithTennaCam`). Set via `defineScenarioTests(..., { freshAsset: true })`.
   */
  freshAsset: boolean;
  fr: ScenarioContext;
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

  fr: [
    async ({ fleet, freshAsset }, use, workerInfo) => {
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
      const run = await provisionFleetRun(api, fleet, { freshAsset });
      const emitter = createDriverEventEmitter(api);
      const telemetry = createTelemetryEmitter(api);
      const reader = createDriverEventsReader(api);

      // Memoized lazily: the first scenario that needs a secondary asset provisions it; every
      // later call (this scenario or a future one, or a `repeat` iteration) reuses the same
      // promise. Secondary assets are never pinned — AGENT-BRIEF revision 2's per-fleet pinning
      // (`suiteAssetId`) only names the fleet's PRIMARY asset. Like the primary, it is reused
      // across runs under its own fleet key, `<fleet>-secondary`.
      let secondaryPromise: Promise<RunContext> | undefined;
      const sc: ScenarioContext = {
        api,
        run,
        fleet,
        emitter,
        telemetry,
        reader,
        t0: new Date(),
        secondaryAsset: () => {
          secondaryPromise ??= provisionAssetWithTennaCam(api, `${fleet}-secondary`, { freshAsset }).then((b) => ({
            ...b,
            contacts: run.contacts,
          }));
          return secondaryPromise;
        },
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
      await use(fr.run);
    },
    { scope: 'worker' },
  ],
});

export { expect };

/** Headroom added on top of BACKFILL_BUDGET_MS for `@slow` scenarios' test-level timeout. */
const SLOW_TEST_HEADROOM_MS = 60_000;

/**
 * Generates one Playwright test per scenario, titled `<id> @mutating <tags> <title>`. `fleet` is
 * the fleet name this spec file owns (AGENT-BRIEF revision 2 item 1) — it both selects the
 * `ASSET_ID_<FLEET>`/`ACCOUNT_ID_<FLEET>` env overrides (`src/env.ts`) and, for a fixture-driven
 * scenario, scopes which fixtures `runner.ts` searches for an id match (see the convention
 * documented at the top of `scenario/runner.ts`). `opts.freshAsset` makes this file's worker create
 * new assets instead of reusing the fleet's. Call once per spec file, at module scope, before any
 * test needs the `fr`/`runContext` fixtures.
 */
export function defineScenarioTests(
  scenarios: readonly Scenario[],
  fleet: string,
  opts: { freshAsset?: boolean } = {},
): void {
  test.use({ fleet, freshAsset: opts.freshAsset ?? false });
  for (const scenario of scenarios) {
    const tags = (scenario.tags ?? []).join(' ');
    const title = `${scenario.id} @mutating ${tags} ${scenario.title}`.replace(/\s+/g, ' ').trim();
    // The wait `anchorTimeline` adds before a delayed trip's first step, per execution.
    const startWaitMs = anchorTimeline(scenario.timeline, 0).startAtMs - ANCHOR_MARGIN_MS;
    test(title, async ({ fr }, testInfo) => {
      if (startWaitMs > 0) {
        test.setTimeout(testInfo.timeout + startWaitMs * (scenario.repeat ?? 1));
      }
      if (scenario.tags?.includes('@slow')) {
        // Reviewer finding 4: this must only ever WIDEN the timeout. `testInfo.timeout` is the
        // timeout already in effect (the project/config default, e.g. `playwright.config.ts`'s
        // 12 minutes) before this override runs — taking the max means a smaller computed budget
        // (BACKFILL_BUDGET_MS + headroom = 7 minutes today) can never shrink the one scenario that
        // waits out the backfill cron below what every other, faster scenario already gets.
        test.setTimeout(Math.max(testInfo.timeout, BACKFILL_BUDGET_MS + SLOW_TEST_HEADROOM_MS + startWaitMs));
      }
      await runScenario(scenario, fr);
    });
  }
}
