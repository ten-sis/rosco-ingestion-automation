/**
 * Asset resource client: create, read, assignee patch, and soft delete.
 */
import type { ApiClient } from './client';
import { firstId } from './client';
import type { Asset, Uuid } from '../types';

export interface CreateAssetInput {
  name: string;
  category_id?: string;
  fleet?: string;
  make?: string;
  model?: string;
  year?: number;
}

interface AssetSearchResponse {
  results: Asset[];
}

/**
 * Creates a fixture asset and returns its id.
 *
 * Finding 11: a 204 with no body comes back from `send` as `undefined`, not `[]`. The previous
 * `ids[0]` on that `undefined` threw a raw TypeError instead of the intended message; `firstId`
 * guards with `Array.isArray` first.
 */
export async function createAsset(api: ApiClient, input: CreateAssetInput): Promise<Uuid> {
  const ids = await api.post<Uuid[]>('/v5/assets', [{ ...input }]);
  return firstId(ids, `createAsset: POST /v5/assets for input ${JSON.stringify(input)}`);
}

interface AssetListResponse {
  results: Array<{ id: Uuid; category_id?: Uuid | null }>;
}

/**
 * The category a fixture asset is created in. `POST /v5/assets` rejects a body without
 * `category_id` and `fleet` (422, observed live on dv3 2026-09-24). `ASSET_CATEGORY_ID` pins it;
 * otherwise this borrows the category of an existing asset on the account, which is guaranteed to
 * be one the account can use.
 */
export async function resolveAssetCategoryId(api: ApiClient): Promise<Uuid> {
  const pinned = process.env.ASSET_CATEGORY_ID;
  if (pinned) return pinned;
  const response = await api.get<AssetListResponse>('/v5/assets', {
    query: { limit: 1, fields: 'id,category_id' },
  });
  const categoryId = response.results.find((a) => a.category_id)?.category_id;
  if (!categoryId) {
    throw new Error(
      `resolveAssetCategoryId: account ${api.accountId} has no asset with a category to borrow. ` +
        'Set ASSET_CATEGORY_ID in .env to a category this account can create assets in.',
    );
  }
  return categoryId;
}

/** Reads an asset, including its contacts (assignee) include block. */
export async function getAsset(api: ApiClient, id: Uuid): Promise<Asset> {
  return api.get<Asset>(`/v5/assets/${id}`, { query: { include: 'contacts' } });
}

/**
 * Finds the asset whose fleet number is exactly `fleet`, with its installed tracker, or null when
 * there is none. `fleetStrict` is an equality match (`assets/v4/controller.js`,
 * `where.fleet = req.filters.fleetStrict`), unlike the substring `fleet` and `name` filters.
 * Confirmed live on dv3 2026-09-28: a full fleet value returns its one asset, and a prefix of it
 * returns nothing. Fleet numbers are unique per account, so a second match means something is
 * badly wrong and this throws rather than picking one.
 */
export async function findAssetByFleet(api: ApiClient, fleet: string): Promise<Asset | null> {
  const response = await api.post<AssetSearchResponse>('/v5/assets/search', {
    fleetStrict: fleet,
    include: ['tracker'],
    limit: 2,
  });
  if (response.results.length > 1) {
    throw new Error(
      `findAssetByFleet: ${response.results.length} assets on account ${api.accountId} have fleet ` +
        `"${fleet}" (${response.results.map((a) => a.id).join(', ')}). Fleet numbers are meant to be ` +
        'unique per account. Fix the duplicates by hand before running this suite.',
    );
  }
  return response.results[0] ?? null;
}

/** Reads an asset with its installed tracker (null when nothing is installed). */
export async function getAssetWithTracker(api: ApiClient, id: Uuid): Promise<Asset> {
  return api.get<Asset>(`/v5/assets/${id}`, { query: { include: 'tracker' } });
}

/**
 * PATCH /v5/assets/:id with a body of exactly {"contacts":{"assignee":id}}. Any other key
 * bundled into the same PATCH falls through to a general-update permission branch that demands
 * a different permission (design brief item 6), so this never merges in other fields.
 */
export async function setAssetAssignee(api: ApiClient, id: Uuid, contactId: Uuid | null): Promise<void> {
  await api.patch<void>(`/v5/assets/${id}`, { contacts: { assignee: contactId } });
}

/**
 * Reads the asset's current assignee CONTACT ID, or null when unset.
 *
 * `contacts.assignee` is a contact OBJECT, not a bare uuid (see `AssetAssigneeContact` in
 * `types.ts` for the confirmed shape and its absent/no-id cases) — reading `.assignee` itself
 * here, as this function previously did, compared distinct object instances under `toBe` and
 * made every `assetAssignee` assertion in the suite a false signal (defect C1). `?.id` handles
 * all three real cases: no `assignee` key, an `assignee` object with no `id` property, and a
 * populated `assignee.id`; none of them can produce the literal `null` `normalizeContacts` never
 * writes, so `?? null` here is purely this function's own contract, not an echo of the API.
 */
export async function getAssetAssignee(api: ApiClient, id: Uuid): Promise<Uuid | null> {
  const asset = await getAsset(api, id);
  return asset.contacts?.assignee?.id ?? null;
}

/** Soft-deletes a fixture asset. The model is paranoid, so this sets deleted_at rather than a hard delete. */
export async function softDeleteAsset(api: ApiClient, id: Uuid): Promise<void> {
  await api.delete<void>(`/v5/assets/${id}`);
}
