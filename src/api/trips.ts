/**
 * Trip resource client: search, read, assignee patch, and the covering-trip lookup.
 */
import type { ApiClient } from './client';
import type { Trip, TripType, Uuid } from '../types';

export interface TripQuery {
  assetId: Uuid;
  from?: string;
  to?: string;
  type?: TripType;
  limit?: number;
}

interface TripSearchResponse {
  results: Trip[];
}

/**
 * Every trip read in this suite must carry `assignee_id`, `asset_id` and `account_id`: those are
 * what the scenarios' assertions compare. Confirmed query params are
 * `account_id, start_date_from, start_date_to, end_date_from, end_date_to, asset_id, type,
 * assignee_id, organization_id` (backend-crud/app/modules/trip/v4/schema.js:14-27), with
 * `sort_by, order, limit, offset` in the same file's `QuerySchema` (:137-158).
 *
 * Without an explicit `fields` param, `GET /v5/trips` and `/trips/:id` default to exactly
 * `["id","type","start_date","end_date"]` (trip/v5/field_groups.js:13-16 feeding `DEFAULT_FIELDS`
 * at v5/schema.js:19,88, applied under Ajv `useDefaults` by `FIELDS()` in
 * app/schema/_types.js:27-35) -- so `assignee_id`, `asset_id` and `account_id` silently come back
 * undefined, and any `'unchanged'` assertion built on them compares undefined to undefined and
 * passes no matter what happened (finding 1). Every read in this file requests `TRIP_FIELDS`.
 *
 * `QuerySchema` sets no `additionalProperties: false`, and unknown query params are silently
 * ignored rather than rejected (app/middleware/query-validator.v5.js:296-300). A future rename of
 * one of the confirmed params above would therefore degrade to an unfiltered result set instead
 * of a 400 -- worth a defensive check, not just a comment, so `searchTrips` throws if a result
 * falls outside the filter it asked for (finding 8).
 */
const TRIP_FIELDS = 'id,type,start_date,end_date,assignee_id,asset_id,account_id';

/**
 * Throws when a trip response is missing the `assignee_id` key entirely, rather than letting a
 * missing field silently read the same as an explicit `null` (finding 1). A comma-separated
 * `fields` string is split into an array at query-validator.v5.js:294-321, so this is the correct
 * shape to send; if it is ever dropped along the way, this is what catches it.
 */
function assertHasAssigneeField(trip: Trip, source: string): Trip {
  if (!('assignee_id' in trip)) {
    throw new Error(
      `${source}: response is missing the "assignee_id" field entirely. This usually means the ` +
        '"fields" query parameter was dropped or ignored, in which case backend-crud silently ' +
        'defaults to ["id","type","start_date","end_date"] (trip/v5/field_groups.js:13-16, ' +
        'DEFAULT_FIELDS at v5/schema.js:19,88) and every trip assertion built on assignee_id, ' +
        'asset_id or account_id would compare undefined to undefined and pass regardless of what ' +
        'the feature actually did.',
    );
  }
  return trip;
}

/**
 * Throws when a "filtered" search result falls outside the filter it was asked for -- the
 * defensive half of finding 8, since a renamed or misspelled query param degrades to an
 * unfiltered result set rather than a 400 (query-validator.v5.js:296-300).
 */
function assertMatchesQuery(trips: readonly Trip[], q: TripQuery): Trip[] {
  for (const trip of trips) {
    if (trip.asset_id !== q.assetId) {
      throw new Error(
        `searchTrips: asked for asset_id=${q.assetId} but got trip ${trip.id} with ` +
          `asset_id=${trip.asset_id}. Unknown or renamed query params are silently ignored rather ` +
          'than rejected (query-validator.v5.js:296-300), so this looks like an unfiltered result ' +
          'set rather than a 400.',
      );
    }
    if (q.type !== undefined && trip.type !== q.type) {
      throw new Error(
        `searchTrips: asked for type=${q.type} but got trip ${trip.id} with type=${trip.type}.`,
      );
    }
  }
  return [...trips];
}

/**
 * GET /v5/trips with query filters. Returns newest first.
 *
 * There is no `POST /v5/trips/search`: trip/v5/index.js only registers `GET /` and `GET /:id`
 * before the `tenna.microservices.manage` gate (index.js:15-26).
 *
 * The scenario-level window maps onto `start_date_from`/`start_date_to`, i.e. filtering on when
 * the trip *started* -- confirmed against `QuerySchema` (trip/v4/schema.js:137-158), which also
 * exposes the `end_date_from`/`end_date_to` pair for the alternative reading.
 */
export async function searchTrips(api: ApiClient, q: TripQuery): Promise<Trip[]> {
  const response = await api.get<TripSearchResponse>('/v5/trips', {
    query: {
      asset_id: q.assetId,
      start_date_from: q.from,
      start_date_to: q.to,
      type: q.type,
      sort_by: 'start_date',
      order: 'desc',
      limit: q.limit ?? 25,
      fields: TRIP_FIELDS,
    },
  });
  const trips = response.results.map((trip) => assertHasAssigneeField(trip, 'searchTrips'));
  return assertMatchesQuery(trips, q);
}

/** Reads a single trip by id. */
export async function getTrip(api: ApiClient, id: Uuid): Promise<Trip> {
  const trip = await api.get<Trip>(`/v5/trips/${id}`, { query: { fields: TRIP_FIELDS } });
  return assertHasAssigneeField(trip, 'getTrip');
}

/** Sets, or clears, the trip's assignee contact. */
export async function setTripAssignee(api: ApiClient, id: Uuid, contactId: Uuid | null): Promise<void> {
  await api.patch<void>(`/v5/trips/${id}`, { assignee_id: contactId });
}

/**
 * Computes `timestampIso` minus three calendar months, in UTC. The floor used by the identification
 * consumer's own covering-trip lookup (see `findCoveringTrip` below).
 */
function threeMonthsBefore(timestampIso: string): string {
  const d = new Date(timestampIso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`threeMonthsBefore: "${timestampIso}" is not a valid ISO timestamp.`);
  }
  d.setUTCMonth(d.getUTCMonth() - 3);
  return d.toISOString();
}

/**
 * The identification consumer's own covering-trip lookup, mirrored exactly so a scenario can
 * assert what the consumer should have found (design doc, "Trip lookup" section, ~lines
 * 1121-1148: https://tenna.atlassian.net/wiki/spaces/SE/pages/3662708761):
 *
 * ```sql
 * SELECT id, start_date, end_date FROM trips
 *  WHERE account_id = :accountId AND asset_id = :assetId AND type = 'normal'
 *    AND start_date <= :timestamp AND start_date >= :timestamp - INTERVAL '3 months'
 *    AND deleted_at IS NULL
 *  ORDER BY start_date DESC LIMIT 1
 * ```
 *
 * The three-month floor caps the backward scan; ordering by `start_date` desc with `limit 1`,
 * rather than a covering-window predicate, is what reaches the open-trip case. The covering guard
 * is then applied to that one candidate, not to the query: `end_date` null, or `end_date >=
 * timestamp`, covers the identification and is returned; `end_date < timestamp` means the
 * identification happened after that trip ended and this returns null exactly as if no row had
 * come back, because linking it anyway would attach the identification to the wrong, already-
 * finished trip.
 *
 * Finding 9: this was previously dead (nothing called it) and wrong -- it had neither the
 * three-month floor nor the `end_date >= timestamp` guard, so it would have reported a link for
 * the one case the design doc is explicit must not link. Fixed and exported here, rather than
 * deleted, so a scenario that wants to assert "the consumer should have found trip X" has a
 * correct oracle to call. It is still unused by anything in `src/scenarios/` today; wiring it in
 * is scenario-module work, outside this file's ownership.
 */
export async function findCoveringTrip(api: ApiClient, assetId: Uuid, timestampIso: string): Promise<Trip | null> {
  const response = await api.get<TripSearchResponse>('/v5/trips', {
    query: {
      asset_id: assetId,
      type: 'normal',
      start_date_to: timestampIso,
      start_date_from: threeMonthsBefore(timestampIso),
      sort_by: 'start_date',
      order: 'desc',
      limit: 1,
      fields: TRIP_FIELDS,
    },
  });
  const candidate = response.results[0];
  if (candidate === undefined) return null;
  assertHasAssigneeField(candidate, 'findCoveringTrip');
  const covers = candidate.end_date === null || candidate.end_date >= timestampIso;
  return covers ? candidate : null;
}
