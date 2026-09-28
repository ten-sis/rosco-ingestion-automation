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
