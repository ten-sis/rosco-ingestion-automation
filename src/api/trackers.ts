/**
 * Tracker resource client: TennaCAM 2.0 creation and account/asset association.
 */
import type { ApiClient } from './client';
import { firstId } from './client';
import type { Tracker, Uuid } from '../types';
import { TENNACAM_2_MODEL, TENNACAM_2_TYPE, TRACKER_MAKE_GEOMETRIS } from '../constants';

export interface CreateTennaCamInput {
  gmsSerial: string;
  vehicleId: string;
  imei?: string;
}

/**
 * Creates the TennaCAM 2.0 primary tracker (Geometris, type `TennaCAM 2.0`, model
 * `TCM-ROGM-05`), then patches in the Rosco camera as its secondary tracker. There is no
 * tracker make "rosco" in any enum (design brief item 1;
 * js-models/src/enumerations/trackerMakers.js:3-25). Confirmed shape:
 * utility-test-driver/src/services/trackers.ts:46-55 (array-body create, returns id array) and
 * :170-176 (plain-object PATCH); field names from
 * backend-crud/app/db/models/Tracker.js:128-133 (`secondary_tracker_serial_number`,
 * `secondary_tracker_data`).
 */
export async function createTennaCam2(api: ApiClient, input: CreateTennaCamInput): Promise<Uuid> {
  const createBody = [
    {
      type: TENNACAM_2_TYPE,
      make: TRACKER_MAKE_GEOMETRIS,
      model: TENNACAM_2_MODEL,
      serial_number: input.gmsSerial,
      ...(input.imei !== undefined ? { imei: input.imei } : {}),
    },
  ];
  const ids = await api.post<Uuid[]>('/v5/trackers', createBody);
  const id = firstId(ids, `createTennaCam2: POST /v5/trackers for serial ${input.gmsSerial}`);
  await api.patch<void>(`/v5/trackers/${id}`, {
    secondary_tracker_serial_number: input.vehicleId,
    secondary_tracker_data: { device_id: input.vehicleId },
  });
  return id;
}

/** Reads a tracker, including its secondary (Rosco) fields. */
export async function getTracker(api: ApiClient, id: Uuid): Promise<Tracker> {
  return api.get<Tracker>(`/v5/trackers/${id}`, {
    query: {
      fields: 'id,type,make,model,serial_number,secondary_tracker_serial_number,secondary_tracker_data',
    },
  });
}

/**
 * Associates a tracker with an account. Returns the association id.
 * Confirmed: utility-test-driver/src/services/trackers.ts:15-33 (array body, id-array response).
 */
export async function associateTrackerWithAccount(api: ApiClient, trackerId: Uuid, accountId: Uuid): Promise<Uuid> {
  const ids = await api.post<Uuid[]>('/v5/tracker_account_associations', [
    { tracker_id: trackerId, account_id: accountId },
  ]);
  return firstId(
    ids,
    `associateTrackerWithAccount: POST /v5/tracker_account_associations for tracker ${trackerId} / account ${accountId}`,
  );
}

/**
 * Installs a tracker on an asset. Returns the tracker-asset-association id.
 * Field names confirmed by utility-test-driver/src/interfaces/application.ts:110-117
 * (TrackerAssetAssociation: tracker_id, asset_id, tracker_account_association_id).
 */
export async function installTrackerOnAsset(
  api: ApiClient,
  trackerId: Uuid,
  assetId: Uuid,
  accountAssociationId: Uuid,
): Promise<Uuid> {
  const ids = await api.post<Uuid[]>('/v5/tracker-asset-associations', [
    {
      tracker_id: trackerId,
      asset_id: assetId,
      tracker_account_association_id: accountAssociationId,
    },
  ]);
  return firstId(
    ids,
    `installTrackerOnAsset: POST /v5/tracker-asset-associations for tracker ${trackerId} / asset ${assetId}`,
  );
}

/**
 * Removes a tracker-asset installation.
 * Confirmed: utility-test-driver/src/services/trackers.ts:75-83 (DELETE by association id).
 */
export async function uninstallTracker(api: ApiClient, trackerAssetAssociationId: Uuid): Promise<void> {
  await api.delete<void>(`/v5/tracker-asset-associations/${trackerAssetAssociationId}`);
}
