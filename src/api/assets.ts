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

/** Reads an asset, including its contacts (assignee) include block. */
export async function getAsset(api: ApiClient, id: Uuid): Promise<Asset> {
  return api.get<Asset>(`/v5/assets/${id}`, { query: { include: 'contacts' } });
}

/** Finds a fixture asset by exact name, or null when nothing matches. */
export async function findAssetByName(api: ApiClient, name: string): Promise<Asset | null> {
  // VERIFY: confirm the POST /v5/assets/search filter key for an exact name match (assumed
  // `name`, a plain top-level key, mirroring how assetFactory.js:17 and other v5 array-body
  // endpoints take flat fields). Response envelope `{ results: [...] }` is confirmed by
  // utility-test-driver/src/services/assets.ts:16-19 (ApiSearchAssetsResponse).
  const response = await api.post<AssetSearchResponse>('/v5/assets/search', { name, limit: 1 });
  return response.results[0] ?? null;
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
