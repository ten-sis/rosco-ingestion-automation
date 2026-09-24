/**
 * Account integration and licence checks used to gate scenarios before they run.
 */
import type { ApiClient } from './client';
import type { Uuid } from '../types';
import { ROSCO_PARTNER } from '../constants';

interface AccountIntegrationSearchResponse {
  results: Array<Record<string, unknown>>;
}

interface LicenseRow {
  id: Uuid;
  name: string;
  account_license?: { active?: boolean } | null;
}

/**
 * True when the account has an `account_integrations` row with `partner = 'rosco'`
 * (design brief item 5: this is account-scoped free text, no enum). Without it the webhook
 * path rejects the account. Confirmed at
 * account_integrations/v5/index.js (`GET /partner/:partner`, mounted at
 * `/api/v5/account-integrations` per routes/index.js:81-82), which forwards to the v4
 * controller's `search`, whose response envelope is `{ results, count, ... }`
 * (account_integrations/v4/controller.js:23-47, `applyMetadata`).
 */
export async function accountHasRoscoIntegration(api: ApiClient, accountId: Uuid): Promise<boolean> {
  const response = await api.get<AccountIntegrationSearchResponse>(
    `/v5/account-integrations/partner/${ROSCO_PARTNER}`,
    { query: { account_id: accountId } },
  );
  return response.results.length > 0;
}

/**
 * True when the named licence is active for the account.
 *
 * license/v5/licenses.controller.js scopes `GET /v5/licenses` to the CALLING session's account
 * (`getAccountId(req)`), not to an arbitrary `accountId` argument. The previous version of this
 * function silently discarded `accountId` (`void accountId;`) and answered for whatever account
 * `api` happened to be scoped to, so a caller asking about a different account got a confidently
 * wrong boolean (finding 6) -- O19's dual-licence precondition depends on comparing two different
 * accounts, so this matters. This throws instead of silently answering for the wrong account;
 * callers that need a different account should build one with `api.forAccount(accountId)` and
 * pass that client in along with the same `accountId`.
 *
 * VERIFY: the `account_license` join's exact response field name (assumed
 * `account_license.active`, from licenses.schema.js's `expandAttrs("account_license",
 * "account_license", ...)`) is unconfirmed without a live call.
 */
export async function accountHasLicence(api: ApiClient, accountId: Uuid, licenceName: string): Promise<boolean> {
  if (accountId !== api.accountId) {
    throw new Error(
      `accountHasLicence: called with accountId=${accountId} but the api client is scoped to ` +
        `account ${api.accountId}. GET /v5/licenses always answers for the calling session's own ` +
        'account, so this call would silently report on the wrong account. Build the client with ' +
        '`api.forAccount(accountId)` first.',
    );
  }
  const licences = await api.get<LicenseRow[]>('/v5/licenses', {
    query: { fields: 'id,name,account_license.active' },
  });
  const match = licences.find((l: LicenseRow) => l.name === licenceName);
  return match?.account_license?.active ?? false;
}

// `setAccountLicenceEnabled` (`../fixtures/provision.ts`) is the one implementation of "enable or
// disable a licence for an account": the three-call chain (find the licence id, find or create the
// account's `AccountLicense` row, `PATCH`/`POST` it). It lives there rather than here because it
// was written against this module's own VERIFY notes on that chain; nothing in this file
// duplicates it, and nothing here throws a stand-in for it.
