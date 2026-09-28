/**
 * Threshold-event (scorecard violation) client: search and manual transfer.
 *
 * THIS IS NOT BACKEND-CRUD. `/v2/threshold-events/*` is served by hapi-server-scorecards, which
 * registers both the plugin that owns `search` and the one that owns `transfer` on the same
 * process (hapi-server-scorecards/src/manifest.ts:24,28):
 *   search   src/plugins/scorecard-api/handlers/thresholdEvent/thresholdEventList/index.ts:142
 *   transfer src/plugins/recorder-api/handlers/threshold-events/thresholdEventsTransfer/index.ts:55
 *
 * Both declare `auth: 'jwt'`, but the proven service-to-service path carries no token. TrackIt,
 * which the design doc says this feature copies, sends only the `requestor` and `account_id`
 * headers (hapi-server-trackit/src/services/scorecardApiClient.ts:36-52). `serviceCall` sends the
 * same pair, so one more port-forward is all this needs:
 *   kubectl port-forward -n snc svc/scorecard-v2-api 3001:80
 *
 * FIELD NAMES ARE CAMELCASE ON THE WIRE, SNAKE_CASE IN OUR TYPE (finding 4)
 *
 * hapi-server-scorecards is camelCase throughout, but `src/types.ts`'s `ThresholdEvent` (frozen)
 * declares `contact_id`, `transferred_by_id` and `received_at`. The previous version of this file
 * cast the raw camelCase response straight to `ThresholdEvent[]`, so every row had `contact_id`
 * undefined and every threshold assertion that does have events failed silently, while O13's
 * already-transferred exclusion could not be evaluated at all. `normalizeThresholdEvent` below
 * does the mapping explicitly, since the frozen type cannot change to match the wire shape.
 */
import type { ApiClient } from './client';
import { env } from '../env';
import type { ThresholdEvent, Uuid } from '../types';

/** The raw, camelCase shape hapi-server-scorecards actually returns for `FIELDS` below. */
interface RawThresholdEvent {
  id: Uuid;
  eventTimestamp: string;
  assigneeId: Uuid | null;
  scorecardId?: Uuid;
  templateId?: Uuid;
  tripEventId?: Uuid;
  transferredById: Uuid | null;
}

interface ThresholdEventSearchResponse {
  results: RawThresholdEvent[];
  /**
   * `thresholdEventList/index.ts:74-101` silently routes to a legacy V1 service with a different
   * field vocabulary when the trip's date predates `SCORECARD_V2_ENABLED_DATE`. The mapping below
   * is only valid for V2, so `searchThresholdEvents` throws unless this is `'V2'` (any case).
   */
  metadata?: { dataVersion?: string };
}

/**
 * Maps hapi-server-scorecards' camelCase response fields onto the frozen, snake_case
 * `ThresholdEvent` shape. `trip_id` is not itself a requested field: every row returned here was
 * already filtered to one trip (`filterModel: [{ field: 'tripId', ... }]`), so the caller's own
 * `tripId` is the correct value rather than a second round-trip field.
 */
function normalizeThresholdEvent(raw: RawThresholdEvent, tripId: Uuid): ThresholdEvent {
  return {
    id: raw.id,
    trip_id: tripId,
    contact_id: raw.assigneeId,
    transferred_by_id: raw.transferredById,
    received_at: raw.eventTimestamp,
  };
}

/** The fields TrackIt asks for, which is the set this suite needs too. */
const FIELDS = [
  'id',
  'eventTimestamp',
  'assigneeId',
  'scorecardId',
  'templateId',
  'tripEventId',
  'transferredById',
] as const;

/** POST /v2/threshold-events/search, scoped to one trip. Returns an empty array on no match. */
export async function searchThresholdEvents(
  api: ApiClient,
  tripId: Uuid,
): Promise<ThresholdEvent[]> {
  const response = await api.serviceCall<ThresholdEventSearchResponse>(
    'post',
    env.scorecardsBaseUrl,
    '/v2/threshold-events/search',
    {
      // The filter field is camelCase here, unlike backend-crud's snake_case.
      // Source: hapi-server-trackit/src/services/scorecardApiClient.ts:43-48.
      filterModel: [{ field: 'tripId', type: 'equals', value: tripId }],
      fields: [...FIELDS],
    },
  );
  // dv3 returns "v2" (2026-09-28), so the check ignores case.
  if (response.metadata?.dataVersion?.toUpperCase() !== 'V2') {
    throw new Error(
      `searchThresholdEvents(tripId=${tripId}): expected metadata.dataVersion "V2" but got ` +
        `${JSON.stringify(response.metadata?.dataVersion)}. thresholdEventList/index.ts:74-101 ` +
        'routes to a legacy V1 service with a different field vocabulary when the trip date ' +
        'predates SCORECARD_V2_ENABLED_DATE, and the camelCase field mapping this client uses ' +
        '(assigneeId/transferredById/eventTimestamp) is only valid for V2.',
    );
  }
  return (response.results ?? []).map((raw) => normalizeThresholdEvent(raw, tripId));
}

/**
 * POST /v2/threshold-events/transfer. The body is an explicit list of pairs, so the caller
 * decides which events move. Score recalculation happens inside the same call.
 */
export async function transferThresholdEvents(
  api: ApiClient,
  pairs: ReadonlyArray<{ contactId: Uuid; thresholdEventId: Uuid }>,
): Promise<void> {
  if (pairs.length === 0) return;
  await api.serviceCall<void>(
    'post',
    env.scorecardsBaseUrl,
    '/v2/threshold-events/transfer',
    [...pairs],
  );
}
