# Verification

## Asserting without `POST /api/v5/rosco-driver-events/search`

That endpoint, and the `rosco_driver_events` table behind it, do not exist yet. The assertion layer is an interface, `DriverEventsReader` (module C, `src/read/driverEvents.ts`), with two implementations, selected by an environment variable so no scenario file has to know which one is active:

- `SqlDriverEventsReader` (default): read-only `pg` over the SSH tunnel on `localhost:54200`. Reads `is_assignee_source`, `trip_id`, `flags`, `trip_driver_set_at`, `received_at`. This is also the only way to prove O9's partial unique index actually fired, since the application-level claim logic alone would look identical whether or not the constraint exists.
- `ApiDriverEventsReader`: `POST /api/v5/rosco-driver-events/search`, written against `claude-tasks/TS-43579-facial-recognition-hld/openapi/backend-crud-rosco-driver-events.openapi.yaml`, switched on by `DRIVER_EVENTS_READER=api` once the endpoint ships. Every scenario in this module asserts through the `DriverEventExpectation` shape in `src/scenario/types.ts`, not through either reader directly, so this switch should require no changes to any file under `src/scenarios/`.

## Everything else

Asserted through endpoints that exist today:

- `GET /v5/assets/:id?include=contacts` — asset assignee.
- `GET /v5/trips` and `GET /v5/trips/:id` — trip assignee. There is no `POST /v5/trips/search`.
- `GET /api/v6/contact-assignments` — when the standing assignee was set, which is what the asset-write timestamp guard itself reads.
- `POST /v2/threshold-events/search` — violation attribution and `transferred_by_id`.
- `POST /v5/rosco-events/search` — that the raw event landed at all, which is what separates an ingestion failure from a consumer failure (`02-BUILD-STEPS.md`, "how to tell a red suite apart from a broken suite").

## SQL probes

Read-only, account- and asset-scoped, IDs inlined per this repo's own standing SQL convention (never `\COPY`, never a row-count placeholder, because these get pasted into a remote console):

```sql
-- every driver-event row for this run's asset, in receipt order
SELECT id, type, contact_id, trip_id, is_assignee_source, trip_driver_set_at,
       timestamp, received_at, flags
  FROM rosco_driver_events
 WHERE asset_id = '<assetId>'
 ORDER BY received_at;

-- prove the partial unique index, not just application logic, decided the claim (O9)
SELECT trip_id, count(*) FILTER (WHERE is_assignee_source) AS claim_count
  FROM rosco_driver_events
 WHERE trip_id = '<tripId>'
 GROUP BY trip_id;
-- claim_count must be exactly 1

-- the trips this run created, for TripRef resolution ('first' / 'latest' / index)
SELECT id, type, start_date, end_date, assignee_id
  FROM trips
 WHERE asset_id = '<assetId>'
 ORDER BY start_date;

-- threshold events for a trip, with their current assignee and transfer provenance
SELECT id, contact_id, transferred_by_id, received_at
  FROM threshold_events
 WHERE trip_id = '<tripId>'
 ORDER BY received_at;
```

## Tunnel and port-forward setup

Three tunnels, all required before any scenario spec runs against a real environment, plus a fourth, optional one for the SQL reader:

```bash
# backend-crud, intra-service path (no auth). MUST bind local port 3000 exactly — see README.md
kubectl port-forward -n be-crud svc/be-crud-v5 3000:3000

# webhook injection, in-cluster route, no auth, no schema gate
kubectl port-forward -n integration svc/webhooks-api 8081:80

# hapi-server-scorecards: threshold-event search/transfer live here, not on backend-crud,
# despite the /v2/ path. Declares auth: 'jwt' but the proven service-to-service path (the one
# TrackIt itself uses) carries only the requestor/account_id headers, same as everything else.
kubectl port-forward -n snc svc/scorecard-v2-api 3001:80

# optional: read-only Postgres, for the SQL driver-events reader and the probes above
_tools/engineering-tools/scripts/db-tunnel.sh --environment dv3
```

`tests/setup/provision.spec.ts` should fail with an actionable message naming which tunnel is missing, rather than a generic connection-refused error, since a missing tunnel and a missing feature both present as "nothing happened" otherwise (`02-BUILD-STEPS.md`).

## What this module could not make directly verifiable

- O20 could not be made directly verifiable at all: `facial_recognition_trip_assignee_write_total{result="no_state"}` has no HTTP or SQL surface this suite reaches, only Grafana does, and the audit is the team's own control. It has moved out of automated coverage entirely rather than staying as a partial proxy; see `06-BLOCKERS.md` and `OUT-OF-SCOPE.md`.
- O13's full reassignment story (a named non-`'all'` subset of threshold events moved to the winner while a different named subset stays put) is only partially expressible through `ThresholdEventExpectation`; see `06-BLOCKERS.md`.
