/**
 * Hashing helpers: the GMS routing-key prefix and the deterministic driver-event id.
 */
import { createHash } from 'node:crypto';
import { FR_NAMESPACE } from './constants';
import type { DriverEventType } from './types';

/**
 * `{h}` twice, joined by a dot: the first two hex characters of `md5(serial)`, matching
 * `serial_number_hash_prefix_2` in `js-models/src/rmq/standardHashTemplateObject.js`
 * (`md5Hash`/`buildPrefix(2, hash, '.')`). This is the routing-key prefix `gms.<h>.<h>` a
 * telemetry frame lands on; the automation-tracker endpoint computes it server-side, so the
 * suite only needs this to predict where to look, never to build the routing key itself.
 */
export function serialHashPrefix2(serial: string): string {
  const digest = createHash('md5').update(serial).digest('hex');
  const first = digest.charAt(0);
  const second = digest.charAt(1);
  if (first.length === 0 || second.length === 0) {
    throw new Error(`serialHashPrefix2: md5 digest of "${serial}" was shorter than expected`);
  }
  return `${first}.${second}`;
}

/**
 * `YYYY-MM-DDTHH:mm:ss.SSSZ` in UTC. Load-bearing: per design brief item 3, the (not yet built)
 * ingestion branch hashes this exact string into the deterministic `event_id`, so a redelivery
 * formatted differently would hash to a different value and defeat deduplication.
 */
export function normaliseTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`normaliseTimestamp: "${iso}" is not a valid date`);
  }
  return parsed.toISOString();
}

const UUID_BYTE_LENGTH = 16;
const VERSION_BYTE_INDEX = 6;
const VARIANT_BYTE_INDEX = 8;
const VERSION_5_MASK = 0x0f;
const VERSION_5_TAG = 0x50;
const VARIANT_MASK = 0x3f;
const VARIANT_TAG = 0x80;

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== UUID_BYTE_LENGTH * 2) {
    throw new Error(`uuidToBytes: "${uuid}" is not a well-formed UUID`);
  }
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

/**
 * RFC 4122 UUIDv5, implemented over `node:crypto`'s sha1 rather than pulling in a uuid package
 * (design brief's EXACT PUBLIC API note: "no new dependency").
 */
function uuidv5(name: string, namespace: string): string {
  const namespaceBytes = uuidToBytes(namespace);
  const nameBytes = Buffer.from(name, 'utf8');
  const digest = createHash('sha1').update(Buffer.concat([namespaceBytes, nameBytes])).digest();
  const bytes = Buffer.from(digest.subarray(0, UUID_BYTE_LENGTH));

  const versionByte = bytes[VERSION_BYTE_INDEX];
  const variantByte = bytes[VARIANT_BYTE_INDEX];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error('uuidv5: sha1 digest was shorter than 16 bytes');
  }
  bytes[VERSION_BYTE_INDEX] = (versionByte & VERSION_5_MASK) | VERSION_5_TAG;
  bytes[VARIANT_BYTE_INDEX] = (variantByte & VARIANT_MASK) | VARIANT_TAG;
  return bytesToUuid(bytes);
}

/**
 * The deterministic driver-event `event_id` the (not yet built) ingestion branch is expected to
 * generate: `uuidv5(FR_NAMESPACE, vehicle_id|name|normalisedTimestamp|driver_guid ?? '')`
 * (design brief item 3; `FR_NAMESPACE`'s doc comment in `constants.ts`).
 *
 * VERIFY: `FR_NAMESPACE` is a placeholder value (see its doc comment in `constants.ts`), because
 * the real ingestion branch does not exist yet. This function only lets the suite PREDICT an id
 * for its own read-side assertions and for the O16 redelivery case's byte-identical resend; it
 * cannot be checked against a value anything else computes until the branch ships.
 */
export function driverEventId(
  vehicleId: string,
  name: DriverEventType,
  timestampIso: string,
  driverGuid?: string,
): string {
  const nameInput = `${vehicleId}|${name}|${normaliseTimestamp(timestampIso)}|${driverGuid ?? ''}`;
  return uuidv5(nameInput, FR_NAMESPACE);
}
