/**
 * The one spec expected to pass today. It provisions the run's fixtures (asset, tracker,
 * contacts, licences) and asserts the resulting `RunContext` is complete, before any scenario
 * spec depends on it. It uses the reused `[FRTest]-fr-setup` asset, so after the first run it
 * creates nothing and checks the reuse path instead. If this fails, the harness is broken, not the feature (PLAN/02-BUILD-STEPS.md).
 *
 * // VERIFY: assumes `../../src/fixtures/test` exposes a `runContext` fixture populated by the
 * `setup` Playwright project, per the project layout's `projects: setup -> api`. Module D owns
 * the exact fixture name and shape; adjust this file to match once `src/fixtures/test.ts` lands
 * if it differs.
 */

import { test, expect } from '../../src/fixtures/test';

test.describe('provisioning', () => {
  // Reviewer finding 3 (HIGH): the `runContext` fixture provisions through `fr` (see
  // `src/fixtures/test.ts`), which creates an asset, a tracker, four contacts and enables the
  // facial-recognition licence on the account — real writes, not a pure read. Without this tag,
  // `ALLOW_MUTATIONS` unset still lists and runs this spec (`playwright.config.ts`'s `grepInvert`
  // only excludes `@mutating` titles), so the opt-in did nothing for the one file that always
  // provisions before anything else touches the account.
  test('@mutating the run context is complete before any scenario depends on it', async ({ runContext }) => {
    expect(runContext.runId, 'runId').toBeTruthy();
    expect(runContext.accountId, 'accountId').toBeTruthy();
    expect(runContext.assetId, 'assetId').toBeTruthy();
    expect(runContext.trackerId, 'trackerId').toBeTruthy();
    expect(runContext.gmsSerial, 'gmsSerial').toBeTruthy();
    expect(runContext.vehicleId, 'vehicleId').toBeTruthy();

    for (const key of ['A', 'B', 'C', 'D'] as const) {
      expect(runContext.contacts[key]?.id, `contacts.${key}.id`).toBeTruthy();
      expect(runContext.contacts[key]?.enabled, `contacts.${key}.enabled`).toBe(true);
      expect(runContext.contacts[key]?.deleted_at, `contacts.${key}.deleted_at`).toBeNull();
    }
  });
});
