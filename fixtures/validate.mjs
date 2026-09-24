#!/usr/bin/env node
/**
 * Validates every fixture JSON file in this directory against the contract in
 * `src/fixture/types.ts`: required keys are present and well-typed, trip duration stays under
 * `MAX_TRIP_SECONDS` (300), and the gap between consecutive trip events never exceeds
 * `PING_INTERVAL_SECONDS` (58) for the span of the trip the fixture actually plays.
 *
 * Run: node fixtures/validate.mjs   (or: npm run fixtures:check)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

const MAX_TRIP_SECONDS = 300;
const PING_INTERVAL_SECONDS = 58;

const VALID_GMS_EVENT_TYPES = new Set(['IGN_ON', 'ON_PERIODIC', 'IGN_OFF', 'HARDBRAKE', 'HARDACCEL', 'HARDTURN']);
const VALID_TRIP_TYPES = new Set(['normal', 'heartbeat', 'virtual']);
const VALID_IDENT_TYPES = new Set(['identDrv', 'unDrv']);
const VALID_DELAY_MODES = new Set(['none', 'full-burst', 'partial-burst']);
const VALID_SUITES = new Set([
  'fr-live',
  'fr-trip-lookup',
  'fr-delayed',
  'fr-guards',
  'fr-race',
  'fr-licence',
  'fr-phase2',
]);
const VALID_DRIVER_KEYS = new Set(['A', 'B', 'C', 'D']);

function fail(errors, msg) {
  errors.push(msg);
}

/** Validates one FixtureTripEvent. */
function checkTripEvent(ev, i, errors) {
  const where = `trip.events[${i}]`;
  if (typeof ev.type !== 'string' || !VALID_GMS_EVENT_TYPES.has(ev.type)) {
    fail(errors, `${where}: invalid or missing "type" (${JSON.stringify(ev.type)})`);
  }
  if (typeof ev.atSec !== 'number' || !Number.isFinite(ev.atSec)) {
    fail(errors, `${where}: "atSec" must be a finite number`);
  }
  if (ev.deliverAtSec !== undefined && typeof ev.deliverAtSec !== 'number') {
    fail(errors, `${where}: "deliverAtSec" must be a number when present`);
  }
  if (ev.lat !== undefined && typeof ev.lat !== 'number') fail(errors, `${where}: "lat" must be a number when present`);
  if (ev.lon !== undefined && typeof ev.lon !== 'number') fail(errors, `${where}: "lon" must be a number when present`);
  if (ev.note !== undefined && typeof ev.note !== 'string') fail(errors, `${where}: "note" must be a string when present`);
}

/** Validates one FixtureIdentification. */
function checkIdentification(id, i, errors) {
  const where = `driver_identifications[${i}]`;
  if (typeof id.atSec !== 'number' || !Number.isFinite(id.atSec)) {
    fail(errors, `${where}: "atSec" must be a finite number`);
  }
  if (id.deliverAtSec !== undefined && typeof id.deliverAtSec !== 'number') {
    fail(errors, `${where}: "deliverAtSec" must be a number when present`);
  }
  if (id.driver !== null && !VALID_DRIVER_KEYS.has(id.driver)) {
    fail(errors, `${where}: "driver" must be null or one of A/B/C/D (got ${JSON.stringify(id.driver)})`);
  }
  if (id.type !== undefined && !VALID_IDENT_TYPES.has(id.type)) {
    fail(errors, `${where}: "type" must be identDrv or unDrv when present (got ${JSON.stringify(id.type)})`);
  }
  if (id.driver === null && id.type !== undefined && id.type !== 'unDrv') {
    fail(errors, `${where}: driver is null but type is "${id.type}", expected "unDrv"`);
  }
  if (id.as !== undefined && typeof id.as !== 'string') fail(errors, `${where}: "as" must be a string when present`);
  if (id.redeliverOf !== undefined && typeof id.redeliverOf !== 'string') {
    fail(errors, `${where}: "redeliverOf" must be a string when present`);
  }
}

/** Validates the DelayMode discriminated union. */
function checkDelay(delay, errors) {
  if (!delay || typeof delay !== 'object' || !VALID_DELAY_MODES.has(delay.mode)) {
    fail(errors, `"delay.mode" must be one of none/full-burst/partial-burst (got ${JSON.stringify(delay && delay.mode)})`);
    return;
  }
  if (delay.mode === 'partial-burst' && typeof delay.burstThroughAtSec !== 'number') {
    fail(errors, `delay.mode is partial-burst but "burstThroughAtSec" is missing`);
  }
  if (delay.burstStartAtSec !== undefined && typeof delay.burstStartAtSec !== 'number') {
    fail(errors, `"delay.burstStartAtSec" must be a number when present`);
  }
}

function checkFixture(fixture, errors) {
  if (typeof fixture.id !== 'string' || !fixture.id) fail(errors, '"id" is required and must be a non-empty string');
  if (typeof fixture.title !== 'string' || !fixture.title) fail(errors, '"title" is required and must be a non-empty string');
  if (fixture.description !== undefined && typeof fixture.description !== 'string') {
    fail(errors, '"description" must be a string when present');
  }
  if (typeof fixture.suite !== 'string' || !VALID_SUITES.has(fixture.suite)) {
    fail(errors, `"suite" must be one of ${[...VALID_SUITES].join(', ')} (got ${JSON.stringify(fixture.suite)})`);
  }
  checkDelay(fixture.delay, errors);

  if (!fixture.trip || typeof fixture.trip !== 'object') {
    fail(errors, '"trip" is required');
  } else {
    if (!Array.isArray(fixture.trip.events)) {
      fail(errors, '"trip.events" is required and must be an array');
    } else {
      fixture.trip.events.forEach((ev, i) => checkTripEvent(ev, i, errors));
    }
    if (fixture.trip.type !== undefined && !VALID_TRIP_TYPES.has(fixture.trip.type)) {
      fail(errors, `"trip.type" must be one of normal/heartbeat/virtual when present (got ${JSON.stringify(fixture.trip.type)})`);
    }
  }

  if (!Array.isArray(fixture.driver_identifications)) {
    fail(errors, '"driver_identifications" is required and must be an array');
  } else {
    fixture.driver_identifications.forEach((id, i) => checkIdentification(id, i, errors));
  }
}

/** Trip duration: span between the earliest and latest trip-event atSec. Null when there are 0-1 events. */
function tripDurationSeconds(events) {
  if (!events || events.length < 2) return events && events.length === 1 ? 0 : null;
  const atSecs = events.map((e) => e.atSec).filter((n) => typeof n === 'number');
  if (atSecs.length < 2) return null;
  return Math.max(...atSecs) - Math.min(...atSecs);
}

/** Largest gap between consecutive trip events by atSec. Null when there are 0-1 events. */
function largestPingGap(events) {
  if (!events || events.length < 2) return null;
  const sorted = [...events].map((e) => e.atSec).filter((n) => typeof n === 'number').sort((a, b) => a - b);
  if (sorted.length < 2) return null;
  let max = 0;
  for (let i = 1; i < sorted.length; i++) {
    max = Math.max(max, sorted[i] - sorted[i - 1]);
  }
  return max;
}

function main() {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const rows = [];
  let hadErrors = false;

  for (const file of files) {
    const full = path.join(DIR, file);
    let fixture;
    try {
      fixture = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      console.error(`FAIL ${file}: invalid JSON (${e.message})`);
      hadErrors = true;
      continue;
    }

    const errors = [];
    checkFixture(fixture, errors);

    const events = fixture.trip && Array.isArray(fixture.trip.events) ? fixture.trip.events : [];
    const duration = tripDurationSeconds(events);
    const gap = largestPingGap(events);

    if (duration !== null && duration > MAX_TRIP_SECONDS) {
      fail(errors, `trip duration ${duration}s exceeds MAX_TRIP_SECONDS (${MAX_TRIP_SECONDS})`);
    }
    if (gap !== null && gap > PING_INTERVAL_SECONDS) {
      fail(errors, `largest ping gap ${gap}s exceeds PING_INTERVAL_SECONDS (${PING_INTERVAL_SECONDS})`);
    }

    if (errors.length > 0) {
      hadErrors = true;
      console.error(`FAIL ${file}:`);
      for (const e of errors) console.error(`  - ${e}`);
    }

    rows.push({
      file,
      id: fixture.id ?? '?',
      suite: fixture.suite ?? '?',
      delayMode: fixture.delay && fixture.delay.mode ? fixture.delay.mode : '?',
      durationSec: duration === null ? 'n/a' : duration,
      eventCount: events.length,
      identCount: Array.isArray(fixture.driver_identifications) ? fixture.driver_identifications.length : 0,
      maxGapSec: gap === null ? 'n/a' : gap,
      ok: errors.length === 0,
    });
  }

  const header = ['id', 'suite', 'delay', 'durationSec', 'events', 'idents', 'maxGapSec', 'status'];
  const widths = header.map((h) => h.length);
  const tableRows = rows.map((r) => [
    r.id,
    r.suite,
    r.delayMode,
    String(r.durationSec),
    String(r.eventCount),
    String(r.identCount),
    String(r.maxGapSec),
    r.ok ? 'OK' : 'FAIL',
  ]);
  for (const row of tableRows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i], cell.length)));

  const pad = (s, w) => s + ' '.repeat(w - s.length);
  console.log('');
  console.log(header.map((h, i) => pad(h, widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of tableRows) console.log(row.map((c, i) => pad(c, widths[i])).join('  '));
  console.log('');
  console.log(`${rows.length} fixture(s) checked, ${rows.filter((r) => r.ok).length} OK, ${rows.filter((r) => !r.ok).length} FAILED.`);

  if (hadErrors) process.exit(1);
}

main();
