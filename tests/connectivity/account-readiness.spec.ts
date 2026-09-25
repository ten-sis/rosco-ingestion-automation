/**
 * Read-only smoke test: the account under test already satisfies the preconditions every
 * operation scenario depends on. Nothing here writes. `preflight` (tests/setup) is the mutating
 * counterpart that ENABLES the licence; this file only reports whether it is already on, so it
 * can pass on a default `ALLOW_MUTATIONS`-unset run and proves the suite's own read helpers
 * (`src/api/licences.ts`) work against the live target.
 */

import { test, expect } from '@playwright/test';
import { ApiClient } from '../../src/api/client';
import { accountHasLicence, accountHasRoscoIntegration } from '../../src/api/licences';
import { FR_LICENSE_NAME } from '../../src/constants';
import { env } from '../../src/env';

test.describe.configure({ timeout: 30_000 });

test.describe('account readiness (read-only)', () => {
  test('the account has the rosco integration', async ({ request }) => {
    const api = ApiClient.create(request);
    expect(
      await accountHasRoscoIntegration(api, env.accountId),
      `account ${env.accountId} needs an account_integrations row with partner='rosco'`,
    ).toBe(true);
  });

  test('the facial-recognition licence is active on the account', async ({ request }) => {
    const api = ApiClient.create(request);
    expect(
      await accountHasLicence(api, env.accountId, FR_LICENSE_NAME),
      `"${FR_LICENSE_NAME}" is not active for account ${env.accountId}. The mutating preflight ` +
        'enables it; this read-only check only reports it.',
    ).toBe(true);
  });
});
