/**
 * Playwright `globalSetup`: runs once, before any project's tests are collected or executed, so
 * this is where a whole-run failure belongs rather than inside a per-worker fixture.
 *
 * Two responsibilities:
 *
 * 1. Refuses to start when `FR_DRY_RUN` and `ALLOW_MUTATIONS` are both set. `src/fixtures/test.ts`
 *    builds both emitters with no explicit `dryRun` option, so each falls back to `env.dryRun`;
 *    with both flags set the suite would run every `@mutating` test, emit nothing, and pass every
 *    negative expectation trivially, producing a partly-green report whose green tests are exactly
 *    the ones that prove nothing. Throwing here fails the whole run with one clear message instead
 *    of letting every worker's fixture setup fail separately and noisily.
 * 2. Prints a banner naming how many operation-suite scenarios are skipped by default, and why, so
 *    a green default run (connectivity and unit tests, nothing else) is never mistaken for a real one.
 */
import { env } from './env';
import { ALL_SCENARIOS } from './scenarios/index';

function refuseDryRunMutations(): void {
  if (env.dryRun && env.allowMutations) {
    throw new Error(
      'FR_DRY_RUN=1 and ALLOW_MUTATIONS=1 are both set. A dry run sends nothing over the wire, ' +
        'so every negative expectation ("the asset assignee did not change", "nothing was ' +
        'transferred", ...) trivially passes and the report would be green while validating ' +
        'nothing at all. Unset one: drop FR_DRY_RUN to actually run the mutating suite, or drop ' +
        'ALLOW_MUTATIONS to keep this a genuine, harmless dry run.',
    );
  }
}

function printSkipBanner(): void {
  const total = ALL_SCENARIOS.length;
  const rule = '='.repeat(78);

  if (!env.allowMutations) {
    console.log(
      `\n${rule}\n` +
        `FR SUITE: DEFAULT INVOCATION. ALLOW_MUTATIONS is not set, so all ${total} operation ` +
        `scenarios are SKIPPED via playwright.config.ts's ` +
        `grepInvert. Only the read-only "connectivity" and offline "unit" projects run. This ` +
        `is a green run that has exercised NONE of the facial-recognition pipeline.\n` +
        `Set ALLOW_MUTATIONS=1 to run the operation suite against a real, non-production target.\n` +
        `${rule}\n`,
    );
    return;
  }

  if (!env.allowFreshAssets) {
    console.log(
      `\n${rule}\n` +
        `FR SUITE: ALLOW_FRESH_ASSETS is not set, so the @fresh-asset scenarios (O21), which ` +
        `create a new asset every run, are SKIPPED. Set ALLOW_FRESH_ASSETS=1 to include them.\n` +
        `${rule}\n`,
    );
  }
}

export default function globalSetup(): void {
  refuseDryRunMutations();
  printSkipBanner();
}
