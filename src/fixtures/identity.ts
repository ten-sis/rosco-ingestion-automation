/**
 * Stable identity for the suite's fixture assets and trackers.
 *
 * Every fleet owns one asset per account, found again on every run by its `fleet` value, so runs,
 * worker restarts and retries all land on the same asset instead of minting a new one
 * (PLAN/07-ASSET-REUSE.md). `fleet` is the key rather than `name` because fleet numbers are unique
 * per account and `POST /v5/assets/search` matches them exactly through `fleetStrict`, while its
 * `name` filter is a substring match.
 *
 * Pure functions only, so `tests/unit/fixture-identity.spec.ts` can pin them without a network.
 */
import type { Tracker } from '../types';
import { FIXTURE_PREFIX, TENNACAM_2_TYPE } from '../constants';

/** Prefix on every fixture-minted GMS serial. */
export const FIXTURE_GMS_PREFIX = `${FIXTURE_PREFIX}-gms-`;
/** Prefix on every fixture-minted Rosco vehicle_id. */
export const FIXTURE_VEHICLE_PREFIX = `${FIXTURE_PREFIX}-veh-`;

/**
 * The fleet value (and name) of the fixture asset for `label`: `[FRTest]-<label>`, or
 * `[FRTest]-<namespace>-<label>` when a namespace is given. `label` is a fleet name such as
 * `fr-live`, or `fr-live-secondary` for that fleet's second asset.
 */
export function fixtureAssetKey(label: string, namespace?: string): string {
  return namespace ? `${FIXTURE_PREFIX}-${namespace}-${label}` : `${FIXTURE_PREFIX}-${label}`;
}

/**
 * Domain for fixture contact emails. `example.com` is reserved (RFC 2606), so nothing is ever
 * delivered to these addresses.
 */
export const FIXTURE_EMAIL_DOMAIN = 'example.com';

/**
 * First name of the fleet's fixture drivers: `[FRTest]-<fleet> Driver` (with the namespace when
 * one is set), last name Alpha/Bravo/Charlie/Delta. Every fleet has its own four drivers, because
 * files run in parallel and a scenario that deactivates a driver (O8, O8b) would otherwise
 * disable that driver for every other file mid-run (dv3 full run, 2026-09-29).
 */
export function fixtureDriverFirstName(fleet: string, namespace?: string): string {
  return `${fixtureAssetKey(fleet, namespace)} Driver`;
}

/**
 * The email of fixture driver `key` for `fleet` on `accountId`. backend-crud rejects every update
 * to a contact with no email and no mobile phone ("Must have email or phone", `Contact.js`'s
 * `beforeUpdate` hook), so without one a fixture driver can never be deactivated or re-enabled.
 * Contact emails are unique across all accounts, so the address carries the account (its first
 * 8 characters, to keep the local part under the 64-character limit), the fleet and the driver.
 */
export function fixtureContactEmail(accountId: string, fleet: string, key: string, namespace?: string): string {
  const fleetPart = namespace ? `${namespace}-${fleet}` : fleet;
  return `frtest+${accountId.slice(0, 8)}-${fleetPart}-${key}`.toLowerCase().replace(/[^a-z0-9+.-]/g, '-') +
    `@${FIXTURE_EMAIL_DOMAIN}`;
}

/**
 * True when `tracker` is a TennaCAM 2.0 this suite minted, and therefore safe to drive telemetry
 * and driver events through. Anything else installed on a fixture asset is a real device someone
 * put there, and provisioning refuses to touch it.
 */
export function isFixtureTennaCam(
  tracker: Pick<Tracker, 'type' | 'serial_number' | 'secondary_tracker_serial_number'>,
): boolean {
  return (
    tracker.type === TENNACAM_2_TYPE &&
    tracker.serial_number.startsWith(FIXTURE_GMS_PREFIX) &&
    (tracker.secondary_tracker_serial_number ?? '').startsWith(FIXTURE_VEHICLE_PREFIX)
  );
}
