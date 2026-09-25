/**
 * Connectivity gate: every tunnel the suite needs is up and answering, before any other project
 * runs (`playwright.config.ts` makes `preflight`, `operation` and `unit` depend on this project).
 *
 * Read-only by construction. No test here writes anything, so none carries `@mutating`, and the
 * whole file runs on a default `ALLOW_MUTATIONS`-unset invocation. One test per service, so a red
 * run names the exact tunnel that is down rather than failing the first scenario 12 minutes in.
 *
 * `scripts/tunnels.sh up` opens everything this file checks.
 */

import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { ApiClient } from '../../src/api/client';
import { env } from '../../src/env';
import { assertExpectedAccount } from '../../src/fixtures/provision';
import { closePool, query } from '../../src/db/pool';

/** A tunnel that is up answers in milliseconds. Anything slower is treated as down. */
const PROBE_TIMEOUT_MS = 10_000;
const TUNNEL_HINT = 'Is the tunnel up? Run `scripts/tunnels.sh status` (or `up`).';

test.describe.configure({ timeout: 30_000 });
test.afterAll(closePool);

async function expectHealthy(request: APIRequestContext, label: string, baseUrl: string): Promise<void> {
  const url = `${baseUrl}/health`;
  let status: number;
  let body: unknown;
  try {
    const response = await request.get(url, { timeout: PROBE_TIMEOUT_MS, failOnStatusCode: false });
    status = response.status();
    body = await response.json().catch(() => undefined);
  } catch (err) {
    throw new Error(`${label}: GET ${url} failed: ${err instanceof Error ? err.message : String(err)}\n${TUNNEL_HINT}`);
  }
  expect(status, `${label}: GET ${url} status. ${TUNNEL_HINT}`).toBe(200);
  expect(body, `${label}: GET ${url} body`).toMatchObject({ ok: true });
}

test.describe('connectivity', () => {
  test('backend-crud answers on the intra-service path for the expected account', async ({ request }) => {
    const api = ApiClient.create(request);
    // Reads GET /v5/accounts/:id and compares its name with EXPECTED_ACCOUNT_NAME. This is the
    // check that catches a port-forward bound to the wrong cluster, and a 401 here means the
    // Host header fell off the intra-service allowlist (see src/api/client.ts).
    await assertExpectedAccount(api, env.accountId, 'fr-connectivity');
  });

  test('webhooks-api is reachable', async ({ request }) => {
    await expectHealthy(request, 'webhooks-api', env.webhookBaseUrl);
  });

  test('scorecard-v2-api is reachable and serves threshold-event search', async ({ request }) => {
    await expectHealthy(request, 'scorecard-v2-api', env.scorecardsBaseUrl);
    const api = ApiClient.create(request);
    // POST, but a search: it reads threshold events and writes nothing.
    const response = await api.serviceCall<{ results?: unknown[] }>(
      'post',
      env.scorecardsBaseUrl,
      '/v2/threshold-events/search',
      {},
      { query: { limit: 1 } },
    );
    expect(Array.isArray(response.results), 'threshold-events/search returns a results array').toBe(true);
  });

  test('digestion is reachable and exposes the secondary-tracker lookup', async ({ request }) => {
    await expectHealthy(request, 'digestion', env.digestionBaseUrl);
    // GET /trackers answers 404 both for "no such route" and for "no such tracker", so an empty
    // lookup cannot tell the two apart. The swagger document can.
    const response = await request.get(`${env.digestionBaseUrl}/swagger.json`, { timeout: PROBE_TIMEOUT_MS });
    expect(response.status(), 'digestion swagger.json status').toBe(200);
    const swagger = (await response.json()) as { paths?: Record<string, Record<string, unknown>> };
    expect(swagger.paths?.['/trackers']?.get, 'digestion exposes GET /trackers').toBeDefined();
  });

  test('database tunnel answers a read-only query', async () => {
    test.skip(
      env.dbUrl === undefined && env.driverEventsReader !== 'sql',
      'DB_URL is not set and DRIVER_EVENTS_READER is not "sql", so nothing in this run reads the database.',
    );
    expect(env.dbUrl, 'DRIVER_EVENTS_READER=sql needs DB_URL (see .env.example)').toBeDefined();
    const rows = await query<{ ok: number }>('select 1 as ok', []);
    expect(rows[0]?.ok).toBe(1);
  });
});
