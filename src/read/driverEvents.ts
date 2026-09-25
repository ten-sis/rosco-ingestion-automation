/**
 * Driver-event reader: normalises the API-backed and SQL-backed row sources onto the same
 * `DriverEventRow` shape (`src/types.ts`), so scenarios never branch on which one answered them.
 *
 * `env.driverEventsReader` defaults to `api`. Neither the table nor the API endpoint exists yet
 * (design brief item: "Nothing in the feature is implemented yet"); both readers are written
 * against the documented contracts so they work unchanged once the feature ships.
 */
import type { ApiClient } from '../api/client';
import { ApiError } from '../api/client';
import type { DriverEventRow, Uuid } from '../types';
import { env } from '../env';
import { query, closePool } from '../db/pool';

export interface DriverEventWindow {
  assetId: Uuid;
  fromIso: string;
  toIso: string;
}

export interface DriverEventsReader {
  readonly kind: 'api' | 'sql';
  byAsset(w: DriverEventWindow): Promise<DriverEventRow[]>;
  isAvailable(): Promise<boolean>;
  close(): Promise<void>;
}

interface SearchFilter {
  field: string;
  filterType: 'text' | 'set' | 'date';
  type: 'equals' | 'inRange';
  value?: string;
  values?: string[];
}

interface SearchResponse {
  results: Array<Record<string, unknown>>;
}

/**
 * Absent and `false` mean the same thing for every `flags` key (design brief item 7). There is
 * deliberately no `contact_inactive` key here: the design's `flags` column has exactly three keys
 * (`arrived_before_trip_created`, `arrived_after_trip_ended`, `resulted_in_assignee_change`), and
 * contact status is asserted through the row's own `contact_active` column, never through a flag
 * (`src/types.ts`'s `DriverEventFlags` doc comment; design doc :675, :688).
 */
function normaliseFlags(flags: unknown): DriverEventRow['flags'] {
  if (typeof flags !== 'object' || flags === null) return null;
  const f = flags as Record<string, unknown>;
  return {
    arrived_before_trip_created: Boolean(f.arrived_before_trip_created),
    arrived_after_trip_ended: Boolean(f.arrived_after_trip_ended),
    resulted_in_assignee_change: Boolean(f.resulted_in_assignee_change),
  };
}

/**
 * Postgres returns a `timestamptz` column as a JS `Date`; the API path returns the same concept
 * as a JSON string. Coercing both onto one ISO string here is what lets the rest of the suite
 * treat `DriverEventRow.timestamp`/`.received_at` as a single shape regardless of source.
 */
function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Maps one raw row (API projection or SQL row) onto `DriverEventRow`.
 *
 * The OpenAPI spec
 * (`claude-tasks/TS-43579-facial-recognition-hld/openapi/backend-crud-rosco-driver-events.openapi.yaml`,
 * `RoscoDriverEventCore.driver_id`) and the design doc (`ROSCO_FACIAL_RECOGNITION_DESIGN.md:668`)
 * both name the vendor-claimed identity field `driver_id`; `src/types.ts`'s `DriverEventRow`
 * (written by another module, not editable here) calls the same concept `driver_guid`. Both
 * spellings are accepted below so a naming drift between the spec and the eventual implementation
 * does not silently drop the field — the SQL reader's own query aliases its `driver_id` column
 * onto the `driver_guid` output key (see `DRIVER_EVENTS_TABLE_QUERY`), so only that branch of the
 * fallback ever fires today, but the API branch is kept for whichever spelling the live endpoint
 * actually returns once it ships.
 */
function toDriverEventRow(raw: Record<string, unknown>): DriverEventRow {
  const driverGuid = (raw.driver_guid ?? raw.driver_id) as string | null | undefined;
  return {
    id: raw.id as Uuid,
    account_id: raw.account_id as Uuid,
    asset_id: raw.asset_id as Uuid,
    tracker_id: raw.tracker_id as Uuid,
    event_id: raw.event_id as string,
    type: raw.type as DriverEventRow['type'],
    contact_id: (raw.contact_id ?? null) as Uuid | null,
    driver_guid: driverGuid ?? null,
    trip_id: (raw.trip_id ?? null) as Uuid | null,
    is_assignee_source: (raw.is_assignee_source ?? null) as boolean | null,
    contact_active: (raw.contact_active ?? null) as boolean | null,
    trip_driver_set_at: (raw.trip_driver_set_at ?? null) as string | null,
    timestamp: toIsoString(raw.timestamp),
    received_at: toIsoString(raw.received_at),
    data: (raw.data ?? null) as Record<string, unknown> | null,
    flags: normaliseFlags(raw.flags),
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

const SEARCH_PATH = '/v5/rosco-driver-events/search';

/**
 * Explicit field list for the search request, rather than relying on the endpoint's documented
 * default set (openapi `RoscoDriverEventSearchRequest.fields`): naming `contact_active` here is
 * what actually fixes it being surfaced (design brief defect: "neither reader surfaces it"),
 * and it keeps this reader correct even if the endpoint's own default field set ever narrows.
 */
const DRIVER_EVENT_FIELDS = [
  'id',
  'account_id',
  'asset_id',
  'tracker_id',
  'event_id',
  'type',
  'contact_id',
  'contact_active',
  'driver_id',
  'trip_id',
  'is_assignee_source',
  'trip_driver_set_at',
  'timestamp',
  'received_at',
  'data',
  'flags',
] as const;

/**
 * The `fields` the deployed endpoint accepts, read out of its own 422. dv3 (2026-09-24) rejects
 * `contact_active` and `driver_id` with `keyword: "enum"` on `/fields/<n>` and lists the accepted
 * set in `params.allowedValues`. Returns undefined for any other error, so only this exact shape
 * triggers the retry.
 */
function allowedFieldsFrom(err: unknown): string[] | undefined {
  if (!(err instanceof ApiError) || err.status !== 422) return undefined;
  try {
    const body = JSON.parse(err.body) as {
      errors?: Array<{ field?: string; keyword?: string; params?: { allowedValues?: unknown } }>;
    };
    const enumError = body.errors?.find((e) => e.keyword === 'enum' && e.field?.startsWith('/fields/'));
    const allowed = enumError?.params?.allowedValues;
    return Array.isArray(allowed) && allowed.every((v) => typeof v === 'string') ? (allowed as string[]) : undefined;
  } catch {
    return undefined;
  }
}

class ApiDriverEventsReader implements DriverEventsReader {
  readonly kind = 'api' as const;

  /**
   * Starts as the design's full field list. Narrowed once, if the deployed endpoint rejects some
   * of them: a missing column then reads as null in `toDriverEventRow`, so any expectation on it
   * (O8's `contactActive: false`) fails as a real product gap instead of the 422 aborting the
   * scenario before a single event reaches the webhook.
   */
  private fields: readonly string[] = DRIVER_EVENT_FIELDS;

  constructor(private readonly api: ApiClient) {}

  async byAsset(w: DriverEventWindow): Promise<DriverEventRow[]> {
    const filterModel: SearchFilter[] = [
      { field: 'asset_id', filterType: 'text', type: 'equals', value: w.assetId },
      { field: 'timestamp', filterType: 'date', type: 'inRange', values: [w.fromIso, w.toIso] },
    ];
    const search = (fields: readonly string[]): Promise<SearchResponse> =>
      this.api.post<SearchResponse>(SEARCH_PATH, {
        fields: [...fields],
        filterModel,
        sortModel: [{ colId: 'received_at', sort: 'asc' }],
        limit: 500,
      });
    try {
      const response = await search(this.fields).catch(async (err: unknown) => {
        const allowed = allowedFieldsFrom(err);
        if (!allowed) throw err;
        const narrowed = this.fields.filter((f) => allowed.includes(f));
        if (narrowed.length === this.fields.length) throw err;
        // eslint-disable-next-line no-console
        console.warn(
          `[driver-events] ${SEARCH_PATH} does not accept fields ` +
            `${this.fields.filter((f) => !allowed.includes(f)).join(', ')}; they read as null from now on.`,
        );
        this.fields = narrowed;
        return search(narrowed);
      });
      return response.results.map(toDriverEventRow);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  /** The endpoint does not exist yet (PLAN/06-BLOCKERS.md); a 404 means "not shipped". */
  async isAvailable(): Promise<boolean> {
    try {
      await this.api.post<SearchResponse>(SEARCH_PATH, { filterModel: [], limit: 1 });
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async close(): Promise<void> {
    // No connection to release: this reader shares the caller's ApiClient / APIRequestContext.
  }
}

/**
 * The design (`ROSCO_FACIAL_RECOGNITION_DESIGN.md:668`) and the OpenAPI spec
 * (`openapi/backend-crud-rosco-driver-events.openapi.yaml:415`) both name this column `driver_id`,
 * not `driver_guid`. Selected here and aliased to `driver_guid` — the output key
 * `toDriverEventRow` reads first — rather than referencing both spellings, since only one of them
 * actually exists as a column; a query naming a column the table doesn't have fails outright, so
 * there is no way to tolerate an unknown spelling without a second, schema-probing round trip.
 * `contact_active` is selected alongside it: the design makes it a first-class column precisely
 * because the award step's eligibility predicate reads it (`:667`, `:688`).
 */
const DRIVER_EVENTS_TABLE_QUERY = `
  select id, account_id, asset_id, tracker_id, event_id, type, contact_id,
         driver_id as driver_guid, trip_id, is_assignee_source, contact_active,
         trip_driver_set_at, timestamp, received_at, data, flags
    from rosco_driver_events
   where asset_id = $1 and timestamp >= $2 and timestamp <= $3
   order by received_at asc
   limit 500
`;

class SqlDriverEventsReader implements DriverEventsReader {
  readonly kind = 'sql' as const;

  async byAsset(w: DriverEventWindow): Promise<DriverEventRow[]> {
    const rows = await query<Record<string, unknown>>(DRIVER_EVENTS_TABLE_QUERY, [w.assetId, w.fromIso, w.toIso]);
    return rows.map(toDriverEventRow);
  }

  /** Probes for the table's existence rather than querying it, so a missing table never throws mid-scenario. */
  async isAvailable(): Promise<boolean> {
    const rows = await query<{ to_regclass: string | null }>(
      "select to_regclass('public.rosco_driver_events') as to_regclass",
      [],
    );
    const first = rows[0];
    return first !== undefined && first.to_regclass !== null;
  }

  async close(): Promise<void> {
    await closePool();
  }
}

/** Picks the reader named by `env.driverEventsReader` (`api`, the default, or `sql`). */
export function createDriverEventsReader(api: ApiClient): DriverEventsReader {
  return env.driverEventsReader === 'sql' ? new SqlDriverEventsReader() : new ApiDriverEventsReader(api);
}
