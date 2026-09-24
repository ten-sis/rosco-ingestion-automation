/**
 * Raw Rosco event reader: proves an event reached storage independent of the consumer.
 */
import type { ApiClient } from './client';
import type { Uuid } from '../types';

interface RoscoEventFilter {
  field: string;
  filterType: 'text' | 'number' | 'date' | 'set';
  type: string;
  value: unknown;
}

interface RoscoEventSearchResponse {
  results: Array<Record<string, unknown>>;
}

/**
 * POST /v5/rosco-events/search — proves a raw event reached storage, which separates an
 * ingestion failure from a consumer failure. Registered before the microservices gate, so
 * normal permissions apply (rosco_events/v5/index.js:44-49, gate at line ~51).
 *
 * The body is an ag-grid-style `filterModel` array, not a flat key/value object — confirmed by
 * backend-crud/app/swagger-ui/be-crud.json, path "/api/v5/rosco-events/search", whose `field`
 * enum includes `asset_id` and `timestamp`.
 *
 * VERIFY: confirm the `inRange` date value shape — assumed a two-element `[from, to]` array,
 * matching ag-grid's own filterModel convention. The OpenAPI schema types `value` as `anyOf`
 * without pinning the inRange element count or ordering.
 */
export async function searchRoscoEvents(
  api: ApiClient,
  assetId: Uuid,
  fromIso: string,
  toIso: string,
): Promise<Array<Record<string, unknown>>> {
  const filterModel: RoscoEventFilter[] = [
    { field: 'asset_id', filterType: 'text', type: 'equals', value: assetId },
    { field: 'timestamp', filterType: 'date', type: 'inRange', value: [fromIso, toIso] },
  ];
  const response = await api.post<RoscoEventSearchResponse>('/v5/rosco-events/search', { filterModel });
  return response.results;
}
