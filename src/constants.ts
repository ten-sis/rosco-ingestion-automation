/**
 * Fixed values the suite depends on. Anything environment-specific belongs in `env.ts`.
 */

/** Prefix on every entity this suite creates, so a human can find and clean them up. */
export const FIXTURE_PREFIX = '[FRTest]';

/**
 * The four fixture drivers' last names. Their first name is per fleet (`fixtureDriverFirstName` in
 * `fixtures/identity.ts`), so each fleet has its own four contacts, created once per account and
 * reused. The `first` values here are only a display fallback for `tools/play.ts`.
 */
export const DRIVER_NAMES = {
  A: { first: `${FIXTURE_PREFIX} Driver`, last: 'Alpha' },
  B: { first: `${FIXTURE_PREFIX} Driver`, last: 'Bravo' },
  C: { first: `${FIXTURE_PREFIX} Driver`, last: 'Charlie' },
  D: { first: `${FIXTURE_PREFIX} Driver`, last: 'Delta' },
} as const;

/**
 * A TennaCAM 2.0 is a Geometris primary tracker whose SECONDARY tracker is the Rosco camera.
 * There is no tracker make `rosco`; `secondary_tracker_data.device_id` is the Rosco vehicle_id.
 * Source: backend-crud/app/constants/trackers.js:158,167-175 and app/db/models/Tracker.js:128-133.
 */
export const TENNACAM_2_TYPE = 'TennaCAM 2.0';
export const TENNACAM_2_MODEL = 'TCM-ROGM-05';
export const TRACKER_MAKE_GEOMETRIS = 'geometris';

/** GMS frame format selected for TennaCAM 2.0 + TCM-ROGM-05. Source: utility-test-driver/src/services/events.ts:9. */
export const GMS_FRAME_FORMAT_TENNACAM2 = '845F';
/** Frame format used by ordinary Geometris trackers, and by the TS-13509 DST fixture CSVs. */
export const GMS_FRAME_FORMAT_DEFAULT = '99B2';

/** Account-level enablement for the Rosco integration. Free text in account_integrations.partner. */
export const ROSCO_PARTNER = 'rosco';

/** The licence the operation flow gates on. */
export const FR_LICENSE_NAME = 'TennaCAM Facial Recog';
/** Mutually exclusive with the above, per the design doc. */
export const TRACKIT_LICENSE_NAME = 'TrackIt';

/** Rosco driver event names as they arrive on the webhook. Type 7 and Type 6 respectively. */
export const IDENT_DRV = 'identDrv';
export const UN_DRV = 'unDrv';

/**
 * The `requestor` header value. Any non-empty string takes the intra-service branch in
 * backend-crud's session middleware; this one identifies the suite in server logs.
 */
export const REQUESTOR = 'playwright-fr';

/**
 * Namespace for the deterministic driver event_id, uuidv5 over
 * `${vehicle_id}|${name}|${normalisedTimestamp}|${driver_guid ?? ''}`.
 *
 * VERIFY: the ingestion branch does not exist yet, so this value cannot be matched against the
 * real one. The suite only uses it to PREDICT an id for its own read-side assertions. When the
 * branch ships, replace this with the constant it uses, or the O16 redelivery assertion is
 * checking a value nothing else computes.
 */
export const FR_NAMESPACE = '6f0c4a2e-4d1b-5e8a-9c3f-1b7d2a5e8c04';

/** Maximum trip length the suite will generate. Keeps a full run inside a sensible wall clock. */
export const MAX_TRIP_SECONDS = 300;
/** A tracker that goes quiet for too long ends its own trip, so pings stay under this. */
export const PING_INTERVAL_SECONDS = 58;
