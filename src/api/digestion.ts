/**
 * Digestion secondary-tracker resolver: the Redis-backed gate the whole ingestion branch reads.
 */
import type { ApiClient } from './client';
import { env } from '../env';
import type { Uuid } from '../types';

interface DigestionSecondaryTracker {
  id?: Uuid;
  assetId?: Uuid;
  accountId?: Uuid;
}

interface DigestionTrackerResponse {
  secondaryTracker?: DigestionSecondaryTracker | null;
}

/**
 * Resolves the Rosco camera through Digestion's secondary-tracker index. Returns null while
 * the Redis key is not yet populated (design brief item 2: this gates the whole suite, and an
 * identification injected before it exists is silently acked and dropped).
 *
 * hapi-plugin-digestion-api's tracker handler (src/handlers/trackerHandler.js:305-341, query
 * schema at :99-105) exposes `GET /trackers?make=<make>&serial=<serial>&include=secondary` on ITS
 * OWN service host, not be-crud's (finding 5). The previous version of this call used `api.get`,
 * which resolves against `api.baseUrl` (backend-crud) and so 404s on every run, which
 * `isNotFoundError` below reads as "not ready yet" -- provisioning then dies on the readiness
 * budget every single time. `ApiClient` now has both `getAbsolute` and `serviceCall`; this uses
 * `serviceCall` so the intra-service headers still go out. This needs its own port-forward,
 * bound to `DIGESTION_BASE_URL` (defaults to `http://localhost:3002`, see `src/env.ts`), e.g.:
 *   kubectl port-forward -n <digestion-namespace> svc/hapi-plugin-digestion-api 3002:80
 */
export async function resolveRoscoDevice(
  api: ApiClient,
  vehicleId: string,
): Promise<{ tracker_id: Uuid; asset_id: Uuid; account_id: Uuid } | null> {
  try {
    const response = await api.serviceCall<DigestionTrackerResponse>(
      'get',
      env.digestionBaseUrl,
      '/trackers',
      undefined,
      { query: { make: 'rosco', serial: vehicleId, include: 'secondary' } },
    );
    const secondary = response.secondaryTracker;
    if (secondary?.id === undefined || secondary.assetId === undefined || secondary.accountId === undefined) {
      return null;
    }
    return { tracker_id: secondary.id, asset_id: secondary.assetId, account_id: secondary.accountId };
  } catch (err) {
    if (isNotFoundError(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * Narrows an unknown thrown value to "the call failed with an HTTP 404". Confirmed: `ApiClient`
 * throws `ApiError`, which declares `readonly status: number` (`src/api/client.ts`).
 */
function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && (err as { status?: unknown }).status === 404;
}
