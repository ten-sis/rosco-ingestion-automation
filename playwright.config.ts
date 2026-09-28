import { defineConfig } from '@playwright/test';
import 'dotenv/config';
import { env } from './src/env';

/**
 * TS-43579 facial-recognition operation suite.
 *
 * There is no browser. Tests drive the pipeline over HTTP and assert through backend-crud reads.
 *
 * PARALLELISM. Each spec file owns its own asset, provisioned once for that file and reused by
 * every scenario in it. Files therefore run in parallel across workers, while scenarios inside a
 * file stay serial, because the trip-recency guard is asset-scoped and two concurrent trips on one
 * asset would make the suite lie. That is `fullyParallel: false` plus `workers > 1`.
 */

// Reading these throws if a value looks like production.
void env.crudBaseUrl;
void env.webhookBaseUrl;

const allowMutations = env.allowMutations;
const allowPhase2 = env.allowPhase2;

/**
 * Tags excluded from the default run. `@mutating` covers every operation-suite test (it is baked
 * into every generated title in `src/fixtures/test.ts`'s `defineScenarioTests`) and needs
 * `ALLOW_MUTATIONS`. `@phase2` needs its OWN opt-in even once mutations are allowed: those four
 * scenarios (`src/scenarios/phase2.ts`) exercise the trip-start consumer, which the design doc
 * places explicitly outside the initial deployment, so `ALLOW_MUTATIONS` alone must not be enough
 * to reach them. `npm run test:phase2`'s `--grep @phase2` still ANDs against this `grepInvert`
 * (Playwright applies both), so reaching those tests needs `ALLOW_MUTATIONS=1 ALLOW_PHASE2=1
 * npm run test:phase2`, not the script alone.
 */
const excludedTagPatterns: string[] = [];
if (!allowMutations) excludedTagPatterns.push('@mutating');
if (!allowPhase2) excludedTagPatterns.push('@phase2');
const grepInvert = excludedTagPatterns.length > 0 ? new RegExp(excludedTagPatterns.join('|')) : undefined;

export default defineConfig({
  testDir: './tests',
  globalSetup: require.resolve('./src/globalSetup'),
  grepInvert,
  fullyParallel: false,
  // One worker per scenario file keeps each file's waits from queueing behind another's. The
  // default run has 7 scenario files (phase 2 excluded).
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 6,
  forbidOnly: !!process.env.CI,
  // A retry would replay a timeline against dirty state. Fix the test instead.
  retries: 0,
  timeout: 12 * 60 * 1000,
  expect: { timeout: 30_000 },
  // The summary reporter writes .runs/summary-<timestamp>.md: each case with the design doc's
  // expected outcome and its result (src/reporting/summaryReporter.ts).
  reporter: [['list'], ['html', { open: 'never' }], ['./src/reporting/summaryReporter.ts']],
  use: {
    // No `trace` here (reviewer finding 7). There is no browser and no Page/BrowserContext in this
    // suite, and `fr` (`src/fixtures/test.ts`) builds its own worker-scoped APIRequestContext via
    // the top-level `request` API rather than the test's built-in `request` fixture — which has no
    // `.tracing` API at all, unlike BrowserContext. Setting `trace` here would read as "failures are
    // captured" while doing nothing, which is worse than not setting it.
    //
    // `actionTimeout` genuinely only governs Page/Locator actions (click, fill, ...) and this suite
    // never creates either, but it is the one configured number that stands in for "how long a
    // single HTTP call may take" here. `src/fixtures/test.ts` reads it back via
    // `workerInfo.project.use.actionTimeout` and passes it into `request.newContext({ timeout })`,
    // so it is honored even though its name is borrowed from a concept this suite doesn't have.
    actionTimeout: 60_000,
  },
  projects: [
    {
      // Read-only gate: every tunnel answers, the account is the expected one and already has the
      // rosco integration and the FR licence. Runs first, with or without ALLOW_MUTATIONS, and
      // every other project depends on it, so a dead port-forward fails here in seconds instead of
      // as a timeout deep inside a scenario. `scripts/tunnels.sh up` opens what it checks.
      name: 'connectivity',
      testMatch: /connectivity\/.*\.spec\.ts/,
    },
    {
      // Pure, offline, in-process regression specs (e.g. the fixture-playback/planner agreement
      // check). They never touch the network, but still wait on `connectivity` so that one command
      // checks everything before any test runs. Offline: `npm run test:unit` (`--no-deps`).
      name: 'unit',
      dependencies: ['connectivity'],
      testMatch: /unit\/.*\.spec\.ts/,
    },
    {
      name: 'preflight',
      dependencies: ['connectivity'],
      testMatch: /setup\/.*\.spec\.ts/,
    },
    {
      name: 'operation',
      dependencies: ['preflight'],
      testIgnore: [/setup\/.*\.spec\.ts/, /unit\/.*\.spec\.ts/, /connectivity\/.*\.spec\.ts/],
    },
  ],
});
