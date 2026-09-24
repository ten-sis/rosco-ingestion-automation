/**
 * Fixture loading and validation. Fixtures are hand-written JSON, so nothing about their shape
 * is guaranteed by the type system until it passes through here — this is the suite's one input
 * boundary that reads untrusted file content.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import type { DelayMode, Fixture, FixtureIdentification, FixtureTripEvent, GmsEventType } from './types';
import type { DriverKey } from '../types';

const FIXTURES_DIR = join(__dirname, '../../fixtures');
const DRIVER_KEYS: readonly DriverKey[] = ['A', 'B', 'C', 'D'];
const GMS_EVENT_TYPES: readonly GmsEventType[] = [
  'IGN_ON',
  'ON_PERIODIC',
  'IGN_OFF',
  'HARDBRAKE',
  'HARDACCEL',
  'HARDTURN',
];
const TRIP_TYPES = ['normal', 'heartbeat', 'virtual'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fail(source: string, message: string): never {
  throw new Error(`Invalid fixture at ${source}: ${message}`);
}

function validateDelay(value: unknown, source: string): asserts value is DelayMode {
  if (!isRecord(value) || typeof value.mode !== 'string') {
    fail(source, '"delay.mode" is required');
  }
  const mode = value.mode;
  if (mode === 'none') return;
  if (mode === 'full-burst' || mode === 'partial-burst') {
    if (value.burstStartAtSec !== undefined && typeof value.burstStartAtSec !== 'number') {
      fail(source, '"delay.burstStartAtSec" must be a number when present');
    }
    if (mode === 'partial-burst' && typeof value.burstThroughAtSec !== 'number') {
      fail(source, '"delay.burstThroughAtSec" is required for mode "partial-burst"');
    }
    return;
  }
  fail(source, `"delay.mode" must be "none", "full-burst" or "partial-burst", got ${JSON.stringify(mode)}`);
}

/**
 * `typeof x === 'number'` is true for `NaN` and `Infinity`. A malformed `deliverAtSec` (a string,
 * say) that survives as `NaN` through `Number()` would make the planner compute a `NaN` delivery
 * time, which every `NaN > 0` delay check downstream treats as "not delayed" — silently turning a
 * delayed case into a live one. Reject non-finite values here as firmly as the wrong type.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateTripEvent(value: unknown, source: string, index: number): asserts value is FixtureTripEvent {
  if (!isRecord(value)) fail(source, `trip.events[${index}] is not an object`);
  if (typeof value.type !== 'string' || !GMS_EVENT_TYPES.includes(value.type as GmsEventType)) {
    fail(source, `trip.events[${index}].type must be one of ${GMS_EVENT_TYPES.join(', ')}`);
  }
  if (!isFiniteNumber(value.atSec)) {
    fail(source, `trip.events[${index}].atSec must be a finite number`);
  }
  if (value.deliverAtSec !== undefined && !isFiniteNumber(value.deliverAtSec)) {
    fail(source, `trip.events[${index}].deliverAtSec must be a finite number when present`);
  }
}

function validateIdentification(
  value: unknown,
  source: string,
  index: number,
): asserts value is FixtureIdentification {
  if (!isRecord(value)) fail(source, `driver_identifications[${index}] is not an object`);
  if (!isFiniteNumber(value.atSec)) {
    fail(source, `driver_identifications[${index}].atSec must be a finite number`);
  }
  if (value.deliverAtSec !== undefined && !isFiniteNumber(value.deliverAtSec)) {
    fail(source, `driver_identifications[${index}].deliverAtSec must be a finite number when present`);
  }
  if (value.driver !== null && !DRIVER_KEYS.includes(value.driver as DriverKey)) {
    fail(source, `driver_identifications[${index}].driver must be null or one of ${DRIVER_KEYS.join(', ')}`);
  }
  if (value.type !== undefined && value.type !== 'identDrv' && value.type !== 'unDrv') {
    fail(source, `driver_identifications[${index}].type must be "identDrv" or "unDrv" when present`);
  }
  if (value.type === 'unDrv' && value.driver !== null) {
    fail(
      source,
      `driver_identifications[${index}] has type "unDrv" but driver is ${JSON.stringify(value.driver)}; ` +
        'unDrv carries no identity, so driver must be null',
    );
  }
  if (value.redeliverOf !== undefined && typeof value.redeliverOf !== 'string') {
    fail(source, `driver_identifications[${index}].redeliverOf must be a string when present`);
  }
  if (value.as !== undefined && typeof value.as !== 'string') {
    fail(source, `driver_identifications[${index}].as must be a string when present`);
  }
}

/**
 * Checks the `driver_identifications` array as a whole, which no per-item check can do: `as`
 * labels must be unique, since O16's redelivery case depends on `redeliverOf` addressing exactly
 * one earlier entry, and every `redeliverOf` must actually name one.
 */
function validateIdentificationLabels(identifications: readonly FixtureIdentification[], source: string): void {
  const seenLabels = new Set<string>();
  for (const ident of identifications) {
    if (ident.as === undefined) continue;
    if (seenLabels.has(ident.as)) {
      fail(source, `"as" label "${ident.as}" is used more than once in driver_identifications`);
    }
    seenLabels.add(ident.as);
  }
  identifications.forEach((ident, index) => {
    if (ident.redeliverOf !== undefined && !seenLabels.has(ident.redeliverOf)) {
      fail(
        source,
        `driver_identifications[${index}].redeliverOf="${ident.redeliverOf}" does not name any "as" label in this fixture`,
      );
    }
  });
}

/** Throws a descriptive error naming `source` unless `value` is a well-formed `Fixture`. */
export function validateFixture(value: unknown, source: string): asserts value is Fixture {
  if (!isRecord(value)) fail(source, 'root value is not an object');
  if (typeof value.id !== 'string' || value.id.length === 0) fail(source, '"id" must be a non-empty string');
  if (typeof value.title !== 'string' || value.title.length === 0) fail(source, '"title" must be a non-empty string');
  if (typeof value.suite !== 'string' || value.suite.length === 0) fail(source, '"suite" must be a non-empty string');
  validateDelay(value.delay, source);

  if (!isRecord(value.trip)) {
    fail(source, '"trip" must be an object');
  }
  const trip = value.trip as Record<string, unknown>;
  if (!Array.isArray(trip.events)) {
    fail(source, '"trip.events" must be an array');
  }
  const tripEvents = trip.events as unknown[];
  if (trip.type !== undefined && !TRIP_TYPES.includes(trip.type as (typeof TRIP_TYPES)[number])) {
    fail(source, `"trip.type" must be one of ${TRIP_TYPES.join(', ')} when present`);
  }
  tripEvents.forEach((event: unknown, index: number) => validateTripEvent(event, source, index));

  if (!Array.isArray(value.driver_identifications)) {
    fail(source, '"driver_identifications" must be an array');
  }
  value.driver_identifications.forEach((ident: unknown, index: number) => validateIdentification(ident, source, index));
  validateIdentificationLabels(value.driver_identifications as FixtureIdentification[], source);
}

function readFixtureFile(filePath: string): Fixture {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`loadFixture: could not read ${filePath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`loadFixture: ${filePath} is not valid JSON: ${(err as Error).message}`);
  }
  validateFixture(parsed, filePath);
  return parsed;
}

/** Every fixture under `fixtures/`, parsed and validated. */
export function listFixtures(): Fixture[] {
  const files = readdirSync(FIXTURES_DIR).filter((name) => extname(name) === '.json');
  return files.map((name) => readFixtureFile(join(FIXTURES_DIR, name)));
}

/** Fixtures whose `suite` matches, in the order `listFixtures()` returns them. */
export function fixturesForSuite(suite: string): Fixture[] {
  return listFixtures().filter((fixture) => fixture.suite === suite);
}

function isExistingFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/**
 * Loads one fixture, accepting a filesystem path (absolute or relative to the current working
 * directory), a bare filename under `fixtures/`, or the fixture's own `id` (e.g. `O3.1`).
 */
export function loadFixture(pathOrId: string): Fixture {
  const directPath = isAbsolute(pathOrId) ? pathOrId : join(process.cwd(), pathOrId);
  const byFilename = join(FIXTURES_DIR, pathOrId.endsWith('.json') ? pathOrId : `${pathOrId}.json`);

  for (const candidate of [directPath, byFilename]) {
    if (isExistingFile(candidate)) {
      return readFixtureFile(candidate);
    }
  }

  const all = listFixtures();
  const byId = all.find((fixture) => fixture.id === pathOrId);
  if (byId) return byId;

  const available = all.map((fixture) => fixture.id).join(', ');
  throw new Error(
    `loadFixture: could not resolve "${pathOrId}" as a file path, a filename under fixtures/, or a fixture id. ` +
      `Available ids: ${available}`,
  );
}
