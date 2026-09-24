# API reference

All public calls go to `https://services.api.<env>.cloud.tenna.com/be-crud/<path>`. The gateway maps `/be-crud/v5` to the app's `/api/v5`. Citations point at `hapi-plugin-webhooks`, `backend-crud`, `js-models` and `hapi-plugin-digestion-api` as checked out locally under `_tmp/tenna-llc/` at the time this pack was written.

Verification note: this repo's own memory carries a standing caveat that vendored/local copies of these services can lag deployed HEAD (`reference_tenna_stale_vendored_copies`). Line numbers below were spot-checked against the local checkout and are close to, but in a couple of cases not byte-identical to, the numbers `AGENT-BRIEF.md` originally cited (for example, `roscoHandler.js`'s `bunnyBusClient.publish` calls land at lines 76 and 163 locally, not line 64). Treat every citation here as "this function, in this file" rather than as a promise the line number will match whatever is deployed; re-grep before relying on an exact line in a live debugging session.

## Emission

| What | Call | Notes |
|---|---|---|
| Primary emitter | `POST http://localhost:8081/rosco` over `kubectl port-forward -n integration svc/webhooks-api 8081:80` | `auth: false`. Body needs only `vehicle_id`. Published verbatim to `ros.{h}.{h}.raw-events` on exchange `too_ti`. `RoscoHandler.path` getter and route `configure()`: `hapi-plugin-webhooks/src/handlers/roscoHandler.js:173` onward; the handler's own publish calls are at `:76` and `:163` in this checkout |
| Public webhook URL | `https://<host>/integration/v1/webhooks/rosco` | Unreachable from a laptop. Istio allowlists 13 Rosco egress IPs: `fluxcd-deployment/integration/webhooks.yaml:63-78`. Do not build against it |
| Secondary emitter | `POST /api/v5/rosco-events/publish` | Proxies to `/rosco` in-cluster: `backend-crud/app/modules/rosco_events/v5/index.js:77`, service `:514-534`. Needs super/admin and `tenna.microservices.manage`. Blocked today: schema requires `event_id` and pins `name` to `["events"]` (`backend-crud/app/swagger-ui/be-crud.json`). Write the client behind `EMITTER=becrud`; it is inert until the schema widens |
| Trips and telemetry | `POST /api/v5/automation-tracker` | `permission(["super","admin"])` at `backend-crud/app/modules/automation-tracker/v1/index.js:10`. Publishes the body to exchange `too_ti` with routeKey `<type>.<md5(esn)[0]>.<md5(esn)[1]>` (`controller.js`, the `AutomationTrackerController.createMessage` method, `buildPrefix`/`md5Hash` helpers at the top of the same file). Schema requires only `options.esn` (`schema.js`, `trackingEvent`) |

Read `claude-tasks/TS-13509-timezone-inventory/overnight-dst-trips/play_trip.sh` and its `csv/` directory before writing the telemetry emitter; it is a working GMS frame replayer against this exact endpoint. Also read `utility-test-driver/src/components/trip-builder-new/trip-builder.tsx` and `src/services/events.ts` for how frames are built per tracker model (`TennaCAM 2.0` + model `TCM-ROGM-05` selects the `845F` frame format).

`{h}.{h}` is the two-character md5 hash of the device serial, `md5(vehicle_id)[0]` and `md5(vehicle_id)[1]`, joined by dots. Verified locally at `js-models/src/rmq/standardHashTemplateObject.js`: `md5Hash`/`buildPrefix` helpers near the top of the file, `serial_number_hash`, `serial_number_hash_prefix_1` and `serial_number_hash_prefix_2` getters further down the same class.

## Fixtures

| What | Call | Permission |
|---|---|---|
| Create asset | `POST /api/v5/assets` | `assets.asset.create` |
| Search assets | `POST /api/v5/assets/search` | scoped |
| Read asset | `GET /api/v5/assets/:id?include=contacts` | — |
| Patch asset assignee | `PATCH /api/v5/assets/:id` | body must be **exactly** `{"contacts":{"assignee":"<id>"}}`. Bundling any other key falls through to a general-update branch requiring a different permission |
| Create tracker | `POST /api/v5/trackers` (array body, returns id array) | `tenna.tracker.manage` |
| Patch tracker | `PATCH /api/v5/trackers/:id` | sets `secondary_tracker_serial_number`, `secondary_tracker_data.device_id` |
| Tracker to account | `POST /api/v5/tracker_account_associations` (array body) | `tenna.warehouse.manage` |
| Install on asset | `POST /api/v5/tracker-asset-associations` (array body) | `assets.trackers.create` |
| Create contact | `POST /api/v5/contacts` | MANAGE_SETTINGS |
| Search contacts | `POST /api/v5/contacts/search` | before the licence gate |
| Patch contacts | `PATCH /api/v5/contacts` | no id segment, array body, id inside each element |
| Search trips | `GET /api/v5/trips` with query filters | there is no `POST /v5/trips/search` |
| Read trip | `GET /api/v5/trips/:id` | — |
| Create / patch trip | `POST /api/v5/trips`, `PATCH /api/v5/trips/:id` | `tenna.microservices.manage` |
| Contact assignments | `GET /api/v6/contact-assignments` | reading when the standing assignee was set; the identification consumer's timestamp guard reads this same search with an asset filter added (`BC-5` in the design doc's Work Breakdown) |
| Threshold events | `POST /v2/threshold-events/search`, `POST /v2/threshold-events/transfer` | Despite the `/v2/` path, these are **not** backend-crud: both live on `hapi-server-scorecards` (`src/manifest.ts:24,28`; search handler `src/plugins/scorecard-api/handlers/thresholdEvent/thresholdEventList/index.ts:142`, transfer `src/plugins/recorder-api/handlers/threshold-events/thresholdEventsTransfer/index.ts:55`), reached over its own port-forward (`kubectl port-forward -n snc svc/scorecard-v2-api 3001:80`, `SCORECARDS_BASE_URL`, default `http://localhost:3001`). Both declare `auth: 'jwt'` in source, but the proven service-to-service path — the one `hapi-server-trackit` itself uses (`src/services/scorecardApiClient.ts:36-52`) — carries no token, only the `requestor`/`account_id` headers, same as backend-crud's intra-service path. `src/api/client.ts`'s `serviceCall` reuses those headers against this base URL. Transfer body is `[{contactId, thresholdEventId}]` |
| Raw rosco events | `POST /api/v5/rosco-events/search` | registered before the microservices gate, normal perms |
| Digestion readiness | in-process helper `getTrackerMetaByMakeSerial({make:'rosco', serial:<device_id>, include:'secondary'})`, not an HTTP endpoint | reads Redis key `{secondaryTracker:<device_id>}`, written by `secondaryTrackerMakeSerialKey`/`getTrackerSecondaryValue` in `hapi-plugin-digestion-api/src/helpers/index.js`. Populated asynchronously after tracker install; provisioning polls it (`waitForDigestionReady`), which is accounted for, not an open risk |
| Licence toggle | enabled through the API by the preflight step | resolved — no longer an open question (AGENT-BRIEF revision 2, item 8) |

## Not yet existing (this feature)

| What | Call | Status |
|---|---|---|
| Driver-event search | `POST /api/v5/rosco-driver-events/search` | Does not exist. `05-VERIFICATION.md` covers the SQL-based alternative used until it ships, and the OpenAPI spec this suite is written against once it does: `claude-tasks/TS-43579-facial-recognition-hld/openapi/backend-crud-rosco-driver-events.openapi.yaml` |
| `rosco_driver_events` table | — | Does not exist |

## There is no login

No Cognito, no token, no impersonation call anywhere in this suite. Every request carries a `requestor` header and an `account_id`, and no `Authorization` header at all, which is what puts it on backend-crud's intra-service path (`app/middleware/session.js:21-35,60-65`); `localhost:3000` is in `INTRA_SERVICE_REQUEST_HEADER_HOSTS` (`fluxcd-deployment/be-crud/be-crud-v5.yaml:177-178`). `user_id` falls back to `TENNA_MICROSERVICE_USER_ID`, the identity the ingestion pipeline itself writes as. `src/api/client.ts` implements this; there is no `src/auth/` and no `src/environments.ts`. The same story covers `hapi-server-scorecards` (see the threshold-events row above): its routes declare `auth: 'jwt'`, but the proven service-to-service path carries only the same two headers, and `client.ts`'s `serviceCall` reuses them.
