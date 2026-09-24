/**
 * GMS telemetry emitter: `POST /v5/automation-tracker`, the trip/telemetry endpoint.
 *
 * Body shape and CSV field layout are confirmed against a WORKING replayer against this exact
 * endpoint: `claude-tasks/TS-13509-timezone-inventory/overnight-dst-trips/play_trip.sh:190-260`
 * (the request body) and `generate_trips.py` (the 99B2 column layout and its two functional
 * constraints: LOCATION_AGE must stay 0 or the trip start is suppressed, and battery voltage
 * must stay above 5000mV or events are ignored). Field ordering and defaults additionally match
 * `_tools/utility-test-driver/src/services/events.ts` (`buildMappedTrip`) and its column-index
 * enums in `_tools/utility-test-driver/src/interfaces/gms.ts` (`GMSMessageHeader`,
 * `GMSMessage_99B2`, `GMSMessage_845F`, `GMSMessageTypes`).
 */
import { randomUUID } from 'node:crypto';
import type { ApiClient } from '../api/client';
import type { GmsEventType } from '../fixture/types';
import { env } from '../env';
import { GMS_FRAME_FORMAT_DEFAULT, GMS_FRAME_FORMAT_TENNACAM2 } from '../constants';

export interface TelemetryFrame {
  gmsSerial: string;
  event: GmsEventType;
  atIso: string;
  lat?: number;
  lon?: number;
  sequence?: number;
  frameFormat?: string;
}

export interface TelemetryEmitter {
  send(frame: TelemetryFrame): Promise<void>;
  readonly sentCount: number;
}

const HARSH_EVENTS: ReadonlySet<GmsEventType> = new Set(['HARDBRAKE', 'HARDACCEL', 'HARDTURN']);
/** Source: events.ts:29-35 — 350 for hard acceleration, 500 for hard braking/turn. */
const HARD_ACCEL_MILLI_G = 350;
const HARD_BRAKE_OR_TURN_MILLI_G = 500;

function accelMilliGFor(event: GmsEventType): number {
  if (event === 'HARDACCEL') return HARD_ACCEL_MILLI_G;
  if (event === 'HARDBRAKE' || event === 'HARDTURN') return HARD_BRAKE_OR_TURN_MILLI_G;
  return 0;
}

/** Field indices for the confirmed 99B2 layout (generate_trips.py, GMSMessage_99B2). */
const IDX_99B2 = {
  LATITUDE: 5,
  LONGITUDE: 6,
  ALTITUDE: 7,
  HDOP: 8,
  HEADING: 9,
  SPEED: 10,
  GPS_SPEED: 11,
  RSSI: 12,
  SATELLITES_IN_VIEW: 13,
  TRUE_ODOMETER: 14,
  ODOMETER: 15,
  IGNITION: 16,
  LOCATION_AGE: 17,
  TRIP_FUEL_USED: 18,
  FUEL_LEVEL: 19,
  BATTERY_VOLTAGE: 20,
  DEF_LEVEL: 21,
  INTERNAL_BATTERY_VOLTAGE: 22,
  DTC: 23,
  PTO_STATE: 24,
  PTO_HOURS: 25,
  ACCEL: 26,
} as const;

/**
 * Field indices for the 845F layout (GMSMessage_845F), narrowed to what a TennaCAM 2 fixture
 * needs. The source enum's F620-only fields (CELL_INFO/FIRMWARE_VERSION/CONFIG_VERSION/
 * DISCOVERY/VIN, which share column 59 with ACCEL for a different tracker family) are omitted:
 * this fixture never selects that tracker.
 *
 * VERIFY: unlike 99B2, there is no confirmed WORKING 845F CSV line to check this layout and its
 * defaults against (`play_trip.sh`'s `csv/` directory is 99B2 only). Defaults below are taken
 * from `events.ts`'s `|| <default>` fallbacks for the 845F branch of `buildMappedTrip`. Confirm
 * against a real captured 845F frame on the first live run.
 */
const IDX_845F = {
  LATITUDE: 5,
  LONGITUDE: 6,
  ALTITUDE: 7,
  HEADING: 8,
  GPS_SPEED: 9,
  HIGHEST_GPS_SPEED_MPH: 10,
  LOCATION_AGE: 11,
  HDOP: 12,
  SATELLITES_IN_VIEW: 13,
  SATELLITES: 14,
  RSSI: 15,
  IGNITION: 16,
  ODOMETER: 17,
  IGNITION_DURATION: 18,
  BATTERY_VOLTAGE: 19,
  ENGINE_RPM: 20,
  COOLANT_TEMP: 21,
  SPEED: 22,
  ACTIVE_DTC: 23,
  THROTTLE: 24,
  RPM_BANDS: 25,
  ALL_DTC: 26,
  DPF_REGEN_INHIBIT: 27,
  HOURS: 28,
  OIL_TEMP: 29,
  OIL_LEVEL: 30,
  COOLANT_LEVEL: 31,
  TRANSMISSION_OIL_LEVEL: 32,
  TRANSMISSION_OIL_TEMP: 33,
  TRANSMISSION_CURRENT_GEAR: 34,
  SEATBELT: 35,
  TRUE_ODOMETER: 36,
  OIL_LIFE: 37,
  SESSION_IDLE_DUR: 38,
  TOTAL_IDLE_DUR: 39,
  FUEL_LEVEL: 40,
  CUMULATIVE_FUEL_ECONOMY: 41,
  TRIP_FUEL_ECONOMY: 42,
  TOTAL_FUEL_USED: 43,
  TOTAL_GAS_USED: 44,
  TOTAL_IDLE_HOURS: 45,
  DEF_LEVEL: 46,
  DEF_TEMP: 47,
  DPF_SOOT_LOAD: 48,
  DPF_TIME_SINCE_LAST_ACTIVE_REGEN: 49,
  DPF_SOOT_LOAD_REGEN_THRESHOLD: 50,
  DPF_STATUS: 51,
  DPF_ACTIVE_REGEN_STATUS: 52,
  IDLE_FUEL_USED: 53,
  TRIP_FUEL_USED: 54,
  TRIP_GAS_USED: 55,
  PTO_HOURS: 56,
  PTO_STATE: 57,
  INTERNAL_BATTERY_VOLTAGE: 58,
  ACCEL: 59,
} as const;

/** Functional constraints (generate_trips.py): must stay 0, or above 5000, respectively. */
const LOCATION_AGE = 0;
const BATTERY_VOLTAGE_MV = 14000;
const INTERNAL_BATTERY_VOLTAGE_MV = 4000;

/**
 * Fallback position when a fixture omits lat/lon. Matches the WORKING reference CSVs' own first
 * frame (`claude-tasks/TS-13509-timezone-inventory/overnight-dst-trips/csv/DST01_...csv`'s
 * `IGN_ON` row: `40.70297,-74.43029`), rather than null-island `0,0`. A trip built entirely from
 * `0,0` frames has zero distance and can be classified as a heartbeat, which the covering-trip
 * lookup skips by design (`ROSCO_FACIAL_RECOGNITION_DESIGN.md` trip-type note) — defaulting to a
 * real-looking position keeps a fixture that forgets to set lat/lon from silently becoming a
 * different kind of test.
 */
const DEFAULT_LAT = 40.70297;
const DEFAULT_LON = -74.43029;

function assembleLine(length: number, fields: Record<number, string | number>): string {
  const arr = new Array<string | number>(length).fill(0);
  for (const [indexText, value] of Object.entries(fields)) {
    arr[Number(indexText)] = value;
  }
  return arr.join(',');
}

function build99B2Line(
  header: Record<number, string | number>,
  lat: number,
  lon: number,
  isHarsh: boolean,
  event: GmsEventType,
): string {
  const odometer = 1.3;
  const fields: Record<number, string | number> = {
    ...header,
    [IDX_99B2.LATITUDE]: lat,
    [IDX_99B2.LONGITUDE]: lon,
    [IDX_99B2.ALTITUDE]: 17,
    [IDX_99B2.HDOP]: 0.8,
    [IDX_99B2.HEADING]: 101,
    [IDX_99B2.SPEED]: 64.3738,
    [IDX_99B2.GPS_SPEED]: 40,
    [IDX_99B2.RSSI]: -45,
    [IDX_99B2.SATELLITES_IN_VIEW]: 12,
    [IDX_99B2.TRUE_ODOMETER]: `${odometer.toFixed(1)}T`,
    [IDX_99B2.ODOMETER]: odometer.toFixed(1),
    [IDX_99B2.IGNITION]: 1,
    [IDX_99B2.LOCATION_AGE]: LOCATION_AGE,
    [IDX_99B2.TRIP_FUEL_USED]: 0,
    [IDX_99B2.FUEL_LEVEL]: 55,
    [IDX_99B2.BATTERY_VOLTAGE]: BATTERY_VOLTAGE_MV,
    [IDX_99B2.DEF_LEVEL]: 0,
    [IDX_99B2.INTERNAL_BATTERY_VOLTAGE]: INTERNAL_BATTERY_VOLTAGE_MV,
    [IDX_99B2.DTC]: '0:0',
    [IDX_99B2.PTO_STATE]: 0,
    [IDX_99B2.PTO_HOURS]: 0,
  };
  if (isHarsh) {
    return assembleLine(IDX_99B2.ACCEL + 1, { ...fields, [IDX_99B2.ACCEL]: accelMilliGFor(event) });
  }
  return assembleLine(IDX_99B2.PTO_HOURS + 1, fields);
}

function build845FLine(
  header: Record<number, string | number>,
  lat: number,
  lon: number,
  isHarsh: boolean,
  event: GmsEventType,
): string {
  const fields: Record<number, string | number> = {
    ...header,
    [IDX_845F.LATITUDE]: lat,
    [IDX_845F.LONGITUDE]: lon,
    [IDX_845F.ALTITUDE]: 17,
    [IDX_845F.HEADING]: 0,
    [IDX_845F.GPS_SPEED]: 0,
    [IDX_845F.HIGHEST_GPS_SPEED_MPH]: 0,
    [IDX_845F.LOCATION_AGE]: LOCATION_AGE,
    [IDX_845F.HDOP]: 0.8,
    [IDX_845F.SATELLITES_IN_VIEW]: 12,
    [IDX_845F.SATELLITES]: 10,
    [IDX_845F.RSSI]: -45,
    [IDX_845F.IGNITION]: 1,
    [IDX_845F.ODOMETER]: '0.0',
    [IDX_845F.IGNITION_DURATION]: 0,
    [IDX_845F.BATTERY_VOLTAGE]: BATTERY_VOLTAGE_MV,
    [IDX_845F.ENGINE_RPM]: 5500,
    [IDX_845F.COOLANT_TEMP]: 100.25,
    [IDX_845F.SPEED]: 0,
    [IDX_845F.ACTIVE_DTC]: 0,
    [IDX_845F.THROTTLE]: 0,
    [IDX_845F.RPM_BANDS]: 0,
    [IDX_845F.ALL_DTC]: 0,
    [IDX_845F.DPF_REGEN_INHIBIT]: 0,
    [IDX_845F.HOURS]: 0,
    [IDX_845F.OIL_TEMP]: 100.5,
    [IDX_845F.OIL_LEVEL]: 89.9,
    [IDX_845F.COOLANT_LEVEL]: 99.9,
    [IDX_845F.TRANSMISSION_OIL_LEVEL]: 0,
    [IDX_845F.TRANSMISSION_OIL_TEMP]: 0,
    [IDX_845F.TRANSMISSION_CURRENT_GEAR]: 0,
    [IDX_845F.SEATBELT]: 1,
    [IDX_845F.TRUE_ODOMETER]: '0.0T',
    [IDX_845F.OIL_LIFE]: 75.0,
    [IDX_845F.SESSION_IDLE_DUR]: 0,
    [IDX_845F.TOTAL_IDLE_DUR]: 0,
    [IDX_845F.FUEL_LEVEL]: 56.99,
    [IDX_845F.CUMULATIVE_FUEL_ECONOMY]: 0,
    [IDX_845F.TRIP_FUEL_ECONOMY]: 0,
    [IDX_845F.TOTAL_FUEL_USED]: 0,
    [IDX_845F.TOTAL_GAS_USED]: 0,
    [IDX_845F.TOTAL_IDLE_HOURS]: 0,
    [IDX_845F.DEF_LEVEL]: 80.75,
    [IDX_845F.DEF_TEMP]: 105.25,
    [IDX_845F.DPF_SOOT_LOAD]: 0,
    [IDX_845F.DPF_TIME_SINCE_LAST_ACTIVE_REGEN]: 0,
    [IDX_845F.DPF_SOOT_LOAD_REGEN_THRESHOLD]: 0,
    [IDX_845F.DPF_STATUS]: 0,
    [IDX_845F.DPF_ACTIVE_REGEN_STATUS]: 0,
    [IDX_845F.IDLE_FUEL_USED]: 0,
    [IDX_845F.TRIP_FUEL_USED]: 0,
    [IDX_845F.TRIP_GAS_USED]: 0,
    [IDX_845F.PTO_HOURS]: 0,
    [IDX_845F.PTO_STATE]: 0,
    [IDX_845F.INTERNAL_BATTERY_VOLTAGE]: INTERNAL_BATTERY_VOLTAGE_MV,
  };
  if (isHarsh) {
    return assembleLine(IDX_845F.ACCEL + 1, { ...fields, [IDX_845F.ACCEL]: accelMilliGFor(event) });
  }
  return assembleLine(IDX_845F.INTERNAL_BATTERY_VOLTAGE + 1, fields);
}

/**
 * Builds the GMS `data` CSV line for one frame: `format,serial,event,epochSeconds,sequence,
 * lat,lon,<tail>` (confirmed real example in AGENT-BRIEF.md's CONFIRMED FACTS). Exported so
 * tests can assert the shape directly, independent of the network call.
 */
export function buildGmsCsvLine(frame: TelemetryFrame): string {
  const frameFormat = frame.frameFormat ?? GMS_FRAME_FORMAT_TENNACAM2;
  const atMs = new Date(frame.atIso).getTime();
  if (Number.isNaN(atMs)) {
    throw new Error(`buildGmsCsvLine: frame.atIso is not a valid date: "${frame.atIso}"`);
  }
  const epochSeconds = Math.floor(atMs / 1000);
  const sequence = frame.sequence ?? epochSeconds;
  const lat = frame.lat ?? DEFAULT_LAT;
  const lon = frame.lon ?? DEFAULT_LON;
  const isHarsh = HARSH_EVENTS.has(frame.event);

  const header: Record<number, string | number> = {
    0: frameFormat,
    1: frame.gmsSerial,
    2: frame.event,
    3: epochSeconds,
    4: sequence,
  };

  return frameFormat === GMS_FRAME_FORMAT_DEFAULT
    ? build99B2Line(header, lat, lon, isHarsh, frame.event)
    : build845FLine(header, lat, lon, isHarsh, frame.event);
}

const AUTOMATION_TRACKER_PATH = '/v5/automation-tracker';
const HOST = 'test-driver';
const APP = 'too-ti';
const APP_VERSION = '4.0.0-build.0';

/**
 * Creates a telemetry emitter. Body shape confirmed against `play_trip.sh:190-260` and
 * `events.ts`'s `addMQMessageHeader`: `data` is the CSV line wrapped in a literal pair of
 * double quotes, which JSON-serialises as an escaped quoted string.
 */
export function createTelemetryEmitter(api: ApiClient, opts?: { dryRun?: boolean }): TelemetryEmitter {
  const isDryRun = opts?.dryRun ?? env.dryRun;
  // Closure counter: `sentCount` is a running total exposed to a long-lived caller (the player),
  // not an object handed to us that we mutate in place — see coding-style.md's immutability note
  // on `hash.ts`-adjacent modules for the same narrow exception.
  let sentCount = 0;

  return {
    async send(frame: TelemetryFrame): Promise<void> {
      const csvLine = buildGmsCsvLine(frame);
      if (isDryRun) {
        sentCount += 1;
        return;
      }
      const body = {
        version: 1,
        host: HOST,
        id: randomUUID(),
        app: APP,
        appVersion: APP_VERSION,
        type: 'gms',
        created: new Date().toISOString(),
        options: { esn: frame.gmsSerial },
        data: `"${csvLine}"`,
        sequenceID: frame.sequence ?? Math.floor(Date.now() / 1000),
      };
      // `omitAccountId` is load-bearing, not a tidy-up. This route is permission(["super","admin"])
      // (backend-crud/app/modules/automation-tracker/v1/index.js:10), and the intra-service bypass
      // at app/middleware/permission-validator.js:36 fires only when user_id or account_id is
      // falsy. user_id is never falsy because session.js:32 substitutes TENNA_MICROSERVICE_USER_ID,
      // so dropping the account_id header is the only way this call is not a 403 for a normal test
      // account. The write is scoped by options.esn in the payload rather than by the session.
      await api.post<void>(AUTOMATION_TRACKER_PATH, body, { omitAccountId: true });
      sentCount += 1;
    },
    get sentCount(): number {
      return sentCount;
    },
  };
}
