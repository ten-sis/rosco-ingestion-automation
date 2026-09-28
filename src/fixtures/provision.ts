/**
 * Per-fleet fixture provisioning: contacts, the fleet's asset with its TennaCAM 2.0 (fully
 * associated and verified), and the preflight checks that must pass before any of it means
 * anything.
 *
 * AGENT-BRIEF revision 2 item 1: one asset per spec file. Each spec file declares a fleet name
 * (see `fixtures/test.ts`), and `provisionFleetRun` provisions that fleet's asset once per worker.
 *
 * Assets and trackers are reused across runs (PLAN/07-ASSET-REUSE.md). Each fleet's asset is found
 * again by its fixed fleet value (`fixtures/identity.ts`), and the fixture TennaCAM already
 * installed on it is reused, so a new run, a worker restart after a failed test, or a new day all
 * land on the same asset and tracker. A fleet that needs an asset with no history (`fr-phase2`,
 * for O21) opts out with `freshAsset`. `env.ts`'s `suiteAssetId(fleet)` / `suiteAccountId(fleet)`
 * still let an operator pin either per fleet, and a pinned asset's fixture TennaCAM is reused too.
 */

import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { ApiClient } from '../api/client';
import type { Asset, AssetTracker, Contact, DriverKey, RunContext, Uuid } from '../types';
import { ApiError } from '../api/client';
import { env, suiteAssetId } from '../env';
import { DRIVER_NAMES, FIXTURE_PREFIX, FR_LICENSE_NAME, TENNACAM_2_TYPE } from '../constants';
import {
  createAsset,
  findAssetByFleet,
  getAssetWithTracker,
  resolveAssetCategoryId,
  setAssetAssignee,
} from '../api/assets';
import {
  associateTrackerWithAccount,
  createTennaCam2,
  getTrackerAssetAssociation,
  installTrackerOnAsset,
} from '../api/trackers';
import { getTrip, searchTrips } from '../api/trips';
import { createContact, getContact, searchContactsByName, setContactEnabled } from '../api/contacts';
import { accountHasLicence, accountHasRoscoIntegration, licenceNameMatches } from '../api/licences';
import { createTelemetryEmitter } from '../emit/telemetry';
import { waitForDigestionReady } from '../scenario/waits';
import {
  DIGESTION_READY_BUDGET_MS,
  LICENCE_ENABLE_BUDGET_MS,
  POLL_INTERVAL_MS,
  TRIP_END_BUDGET_MS,
} from '../scenario/timeouts';
import { FIXTURE_GMS_PREFIX, FIXTURE_VEHICLE_PREFIX, fixtureAssetKey, isFixtureTennaCam } from './identity';
import { currentRunId, recordCreated, recordReused } from './manifest';

const DRIVER_KEYS: readonly DriverKey[] = ['A', 'B', 'C', 'D'];

// ---------------------------------------------------------------------------
// Environment identity (reviewer finding 1, CRITICAL)
// ---------------------------------------------------------------------------

/**
 * `ENV` is a display label (`env.ts`) and `CRUD_BASE_URL` is always `http://localhost:3000/api`
 * regardless of what a `kubectl port-forward` on that local port actually answers for. Neither
 * tells this suite which cluster it is really talking to. A stale or wrong kube-context makes
 * `localhost:3000` answer for whatever cluster it is bound to that day — if that is prod, every
 * write this suite makes (assets, trackers, trips, driver reassignments) lands on a real account.
 *
 * This proves the environment from the server's own answer instead of trusting the label: it
 * reads `ACCOUNT_ID`'s name back from backend-crud and requires it to equal
 * `EXPECTED_ACCOUNT_NAME`, an operator-supplied value naming the known nonprod fixture account. A
 * wrong kube-context then either 404s (no such account on that cluster) or returns a real
 * customer's name, and either way this throws before `preflight`'s licence write, before
 * `ensureContacts`, and before `provisionAssetWithTennaCam` issue a single request.
 *
 * This cannot shell out to `kubectl config current-context` to name the active cluster (that
 * would call a process this suite has no business calling from a test, and the finding that
 * prompted this asked for the hint in the message, not in code) — so the abort message tells the
 * operator to check it themselves.
 *
 * VERIFY: `GET /v5/accounts/:id` and its `name` field follow the same `fields=` convention
 * `/v5/licenses` uses elsewhere in this file (see `setAccountLicenceEnabled`), but nothing this
 * suite has read from source confirms the endpoint path or response shape. Confirm on the first
 * live run before trusting this gate.
 *
 * M3: a single global `EXPECTED_ACCOUNT_NAME` can never pass this gate for `fr-licence`, which
 * (per `assertLicenceFleetIsolated` below) always runs on a DIFFERENT account from the shared
 * `ACCOUNT_ID`, and therefore has a different real name. This resolves the expected name per
 * fleet the same way `env.ts`'s `suiteAccountId`/`suiteAssetId` resolve an id: an
 * `EXPECTED_ACCOUNT_NAME_<FLEET>` override, falling back to the global `EXPECTED_ACCOUNT_NAME`.
 * `env.ts` is outside this module's file ownership, so the key is built here rather than by
 * adding an `env.ts` export — `expectedAccountNameEnvKey` intentionally mirrors the normalisation
 * `env.ts` already uses for `ASSET_ID_<FLEET>`/`ACCOUNT_ID_<FLEET>`, not a new convention.
 */
function expectedAccountNameEnvKey(fleet: string): string {
  return `EXPECTED_ACCOUNT_NAME_${fleet.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export async function assertExpectedAccount(api: ApiClient, accountId: Uuid, fleet: string): Promise<void> {
  const perFleetKey = expectedAccountNameEnvKey(fleet);
  const expectedName = process.env[perFleetKey] || process.env.EXPECTED_ACCOUNT_NAME;
  if (!expectedName) {
    throw new Error(
      `Neither ${perFleetKey} nor EXPECTED_ACCOUNT_NAME is set. This suite refuses to provision ` +
        "anything without proving, from the server's own answer, which account and cluster ACCOUNT_ID " +
        'actually resolves to on the other side of your kubectl port-forward — the local port and the ' +
        'ENV label alone cannot tell it apart from production. Copy .env.example, set ' +
        'EXPECTED_ACCOUNT_NAME (or, for a fleet pinned to its own account such as fr-licence, ' +
        `${perFleetKey}) to the exact name of the known nonprod fixture account, then re-run.`,
    );
  }

  interface AccountRow {
    id: Uuid;
    name?: string;
  }
  const account = await api.get<AccountRow>(`/v5/accounts/${accountId}`, { query: { fields: 'id,name' } });
  if (account.name !== expectedName) {
    throw new Error(
      `Refusing to run: backend-crud returned account "${account.name ?? '(no name field)'}" for ` +
        `ACCOUNT_ID=${accountId} (fleet "${fleet}"), but the expected name (from ${perFleetKey} or ` +
        `EXPECTED_ACCOUNT_NAME) is "${expectedName}". This almost always means the kubectl context ` +
        'behind your localhost:3000 port-forward is not the cluster you think it is (run `kubectl ' +
        'config current-context` to check) — fix that, or correct the expected-name variable if the ' +
        'fixture account was legitimately renamed, then re-run. Nothing has been written yet.',
    );
  }
}

// ---------------------------------------------------------------------------
// fr-licence account isolation (reviewer finding 2, CRITICAL)
// ---------------------------------------------------------------------------

/** The fleet whose scenarios toggle an account-scoped licence (O18/O19). Must never share an account. */
const LICENCE_FLEET = 'fr-licence';

/**
 * `playwright.config.ts` runs 4 workers, one asset per spec file, but a licence is scoped to the
 * ACCOUNT, not the asset. `fr-licence`'s O18 revokes the facial-recognition licence and O19 turns
 * on TrackIt for the whole account; while either toggle is applied, every other suite mutating
 * that same account has its negative assertions pass for the wrong reason and its positive
 * assertions fail at random, depending on how the workers happen to interleave.
 *
 * Fails before any write when `fr-licence` has not been pointed at a dedicated account via
 * `ACCOUNT_ID_FR_LICENCE` (`env.ts`'s `suiteAccountId` already prefers that override when set; this
 * only checks that it WAS set, and that it differs from the shared `ACCOUNT_ID`).
 *
 * C5: this must compare the override against `env.accountId`, the run-wide default — NOT against
 * `api.accountId`. `fixtures/test.ts` builds the `fr-licence` fleet's `ApiClient` with
 * `suiteAccountId('fr-licence')`, which already resolves to `ACCOUNT_ID_FR_LICENCE` when it is
 * set (`env.ts`). So the previous call site, `assertLicenceFleetIsolated(fleet, api.accountId)`,
 * was comparing the override to itself: always equal, so this fleet could never pass the isolation
 * check even when configured correctly. `env.accountId` is the one value in scope that is NOT
 * already resolved through the per-fleet override, so it is the only value this check can compare
 * against and still test anything.
 */
function assertLicenceFleetIsolated(fleet: string): void {
  if (fleet !== LICENCE_FLEET) return;

  const override = process.env.ACCOUNT_ID_FR_LICENCE;
  if (!override) {
    throw new Error(
      `ACCOUNT_ID_FR_LICENCE is not set. The "${LICENCE_FLEET}" fleet revokes and re-grants an ` +
        'account-scoped licence while other suites may be mutating the same account concurrently ' +
        '(4 workers, playwright.config.ts) — running it against the shared ACCOUNT_ID would turn the ' +
        'facial-recognition licence off for everyone mid-run. Set ACCOUNT_ID_FR_LICENCE in .env to an ' +
        'account dedicated to this fleet before running it.',
    );
  }
  if (override === env.accountId) {
    throw new Error(
      `ACCOUNT_ID_FR_LICENCE equals ACCOUNT_ID ("${env.accountId}"). The "${LICENCE_FLEET}" fleet needs ` +
        'an account no other suite touches, or its licence toggles corrupt every concurrent run — point ' +
        'ACCOUNT_ID_FR_LICENCE at a different account.',
    );
  }
}

// ---------------------------------------------------------------------------
// Licence enablement (AGENT-BRIEF revision 2 item 3)
// ---------------------------------------------------------------------------

interface LicenceCatalogEntry {
  id: Uuid;
  name: string;
}

/**
 * Confirmed against `backend-crud/app/modules/account_license/v4/controller.js:9-14`'s
 * `attributes: ["id", "license_id", "active"]` on the `search` action (the handler behind `GET
 * /v4/account-licenses`). `license_id` is required here (defect C4 fix, below) — the previous
 * version of this type omitted it, which is what let `rows[0]` stand in for "the matching row"
 * unchallenged.
 */
interface AccountLicenseRow {
  id: Uuid;
  license_id: Uuid;
  active?: boolean;
}

/**
 * Ensures `licenceName` is set to `enabled` for `accountId`, by calling the API directly. This is
 * the one implementation of "enable or disable a licence for an account" — `../api/licences.ts`
 * documents the confirmed-missing chain in a `VERIFY` comment but implements none of it, since
 * that file is outside this module's file ownership.
 *
 * Three calls, confirmed against `account_license/v4/{index,controller,schema}.js`:
 *   1. `GET /v5/licenses` — find the licence id by name (mirrors `accountHasLicence`'s own call).
 *   2. `GET /v4/account-licenses` — list the account's existing `AccountLicense` rows.
 *   3. `PATCH` the matching row if found, otherwise throw (see the C3 note below — there is no
 *      safe `POST` from this client for a brand-new row on a non-Tenna account).
 *
 * CONFIRMED (`controller.js:4-17`, `schema.js`): `search` reads `req.query.account_id` (falling
 * back to `req.session.account_id`) and filters `where: { account_id }` ONLY — `license_id` is
 * accepted as a query param by nothing in this route; the controller never reads it. So the
 * response is every `AccountLicense` row for the account, not just the one for `licenceName`
 * (defect C4): the previous version took `rows[0]` unconditionally, which on any account holding
 * more than one licence would patch or read an ARBITRARY row, not necessarily the intended one.
 * Fixed by filtering client-side on `row.license_id === licence.id` and throwing when nothing
 * matches, rather than silently falling back to the first row. The response itself is a bare
 * array (`res.json(result)` off `findAll`), never a `{ results: [...] }` envelope; both shapes are
 * still handled below since nothing about the array-vs-envelope question is specific to this bug.
 *
 * CONFIRMED (defect C3): `router.use("*", permission())` gates every verb on this router, and
 * `POST`/`PATCH /:id` additionally require `permission(["super","admin"])`
 * (`index.js:10,17,21-26`). `super`/`admin` are only ever 1 when the header account equals
 * `TENNA_ACCOUNT_ID` (`app/utils/permissions.js`, `isTennaAccount` gate on both), so this client's
 * intra-service bypass (`{ omitAccountId: true }`, fires only when `account_id` is absent from the
 * session) is the only way either write can ever pass permission for a real fixture account.
 *
 * That bypass is SAFE for `PATCH /:id`: `controller.js:41-53`'s `update` looks the row up by
 * `req.params.id` alone and never reads `account_id` at all, so omitting the header changes
 * nothing about which row gets updated (case C4's own client-side row match already guarantees
 * `row.id` is correct before this ever runs).
 *
 * That bypass is UNSAFE for `POST /`: `controller.js:31-39`'s `create` does
 * `db.AccountLicense.create({ license_id: req.body.license_id, account_id:
 * req.session.account_id, active: req.body.active })` — it takes the account id from the SESSION,
 * never from the request body, and the `AccountLicense` model's `account_id` column
 * (`app/db/models/account_license.js`) has no `allowNull: false`, so omitting the header does not
 * 500; it silently inserts a row with `account_id: null`, scoped to no account at all, while
 * `permission-validator.js`'s bypass condition (`!(user_id && account_id)`) is exactly what let it
 * through. There is no way, over this intra-service path, to both satisfy the ["super","admin"]
 * gate and have `create()` see this account's real id — sending the header keeps `account_id`
 * truthy and gets a normal 403 (a non-Tenna account never has `super`/`admin`), and omitting it to
 * pass the gate throws away the very value the write needs. So this never calls `POST /` at all;
 * when no existing row is found, it throws a message telling the operator to seed one out of
 * band (an initial, inactive `account_license` row for this licence and account, created with real
 * admin credentials or a direct insert) rather than either 500ing or silently writing a
 * null-account_id row. This is the "propose the alternative rather than shipping a call that
 * 500s" case the brief asks for; it belongs in `PLAN/06-BLOCKERS.md` as a backend gap (this
 * endpoint has no accessible creation path for a non-Tenna account), which is outside this
 * module's file ownership to add.
 *
 * VERIFY: the row's exact `active` semantics and the `PATCH` body shape (`{ active }`) are
 * confirmed directly from `schema.js`'s `patch` schema; nothing else about this chain remains
 * unconfirmed against source.
 */
export async function setAccountLicenceEnabled(
  api: ApiClient,
  accountId: Uuid,
  licenceName: string,
  enabled: boolean,
): Promise<void> {
  const catalog = await api.get<LicenceCatalogEntry[]>('/v5/licenses', { query: { fields: 'id,name' } });
  const licence = catalog.find((l) => licenceNameMatches(l.name, licenceName));
  if (!licence) {
    throw new Error(`setAccountLicenceEnabled: no licence named "${licenceName}" exists in /v5/licenses`);
  }

  const existing = await api.get<AccountLicenseRow[] | { results?: AccountLicenseRow[] }>(
    '/v4/account-licenses',
    { query: { account_id: accountId } },
  );
  const rows = Array.isArray(existing) ? existing : existing.results ?? [];
  const row = rows.find((r) => r.license_id === licence.id);

  if (!row) {
    throw new Error(
      `setAccountLicenceEnabled: account ${accountId} has no existing AccountLicense row for licence ` +
        `"${licenceName}" (id ${licence.id}), and POST /v4/account-licenses cannot safely create one from ` +
        'this client — account_license/v4/controller.js\'s create() takes the account id from the ' +
        'session, not the request body, and the only way to satisfy its ["super","admin"] gate over the ' +
        'intra-service path is to omit the account_id header, which would insert the new row with ' +
        'account_id: null instead. A human must seed an initial AccountLicense row for this account and ' +
        'licence (inactive is fine; this function will then flip it) before this suite can run.',
    );
  }

  // Safe per the doc comment above: update() (account_license/v4/controller.js:41-53) looks the
  // row up by :id alone and never reads account_id, so omitting the header changes nothing about
  // which row is patched, and is what lets this pass the ["super","admin"] gate for a real account.
  await api.patch<void>(`/v4/account-licenses/${row.id}`, { active: enabled }, { omitAccountId: true });
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Preflight: account exists, rosco integration present, facial-recognition licence ENABLED.
 * "Account exists" is treated as already proven by the caller having a working `ApiClient` for
 * `api.accountId` — no dedicated "get account" endpoint is in this module's contract, so
 * re-checking it here would be redundant. Returns human-readable problems; empty means OK.
 *
 * AGENT-BRIEF revision 2 item 3: the licence check no longer just reports a gap, it calls
 * `setAccountLicenceEnabled` to close it. The rosco-integration check has no equivalent
 * remediation endpoint given anywhere this suite has read from, so it stays report-only.
 */
export async function preflight(api: ApiClient): Promise<string[]> {
  const problems: string[] = [];
  if (!(await accountHasRoscoIntegration(api, api.accountId))) {
    problems.push(
      `Account ${api.accountId} has no account_integrations row with partner='rosco'. Insert one ` +
        'before running this suite (AGENT-BRIEF item 5).',
    );
  }
  try {
    await setAccountLicenceEnabled(api, api.accountId, FR_LICENSE_NAME, true);
    await expect
      .poll(() => accountHasLicence(api, api.accountId, FR_LICENSE_NAME), {
        timeout: LICENCE_ENABLE_BUDGET_MS,
        intervals: [POLL_INTERVAL_MS],
      })
      .toBe(true);
  } catch (err) {
    problems.push(
      `Could not enable the facial-recognition licence (${FR_LICENSE_NAME}) for account ${api.accountId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/**
 * Ensures the four `[FRTest]` driver contacts exist. Searches once for every contact whose first
 * or last name starts with `FIXTURE_PREFIX` (matching `searchContactsByName`'s client-side
 * startsWith filter), then matches each `DriverKey` by its exact fixture-tagged first name,
 * creating only the ones not found.
 */
export async function ensureContacts(api: ApiClient): Promise<Record<DriverKey, Contact>> {
  const existing = await searchContactsByName(api, FIXTURE_PREFIX);
  const result = {} as Record<DriverKey, Contact>;
  for (const key of DRIVER_KEYS) {
    const name = DRIVER_NAMES[key];
    const taggedFirst = `${FIXTURE_PREFIX} ${name.first}`;
    let contact = existing.find((c) => c.first_name === taggedFirst && c.last_name === name.last);
    const found = contact !== undefined;
    if (!contact) {
      const id = await createContact(api, taggedFirst, name.last);
      contact = await getContact(api, id);
      recordCreated('contact', contact.id, key);
    } else if (!contact.enabled) {
      // A disabled contact left over from a stale prior run would silently corrupt every scenario
      // that assumes a clean baseline; scenarios that need a disabled contact do so explicitly via
      // a `deactivateContact` step, so provisioning always resets to enabled.
      await setContactEnabled(api, contact.id, true);
      contact = { ...contact, enabled: true };
    }
    if (found) recordReused('contact', contact.id, key);
    result[key] = contact;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Asset + tracker
// ---------------------------------------------------------------------------

/**
 * PATCH /v5/tracker-asset-associations/:id/verify — completes the install (AGENT-BRIEF revision 2
 * item 2, the new required step). Not part of `../api/trackers.ts`'s contract (that file belongs
 * to Module B and is outside this module's file ownership), so this calls the client directly.
 *
 * The body is required: `{ certification_passed: boolean }` (backend-crud
 * tracker_asset_association/v4/schema.js `VerifyTrackerAssociation`, reused by v5). An empty body
 * is rejected with 422 (observed live on dv3 2026-09-24).
 */
async function verifyTrackerAssetAssociation(api: ApiClient, installationId: Uuid): Promise<void> {
  await api.patch<void>(`/v5/tracker-asset-associations/${installationId}/verify`, { certification_passed: true });
}

/** How `provisionAssetWithTennaCam` picks its asset. */
export interface AssetProvisionOptions {
  /** A pinned asset id (`ASSET_ID` / `ASSET_ID_<FLEET>`). Used as-is instead of the fleet lookup. */
  existingAssetId?: Uuid;
  /**
   * Always create a new asset for this worker instead of reusing the fleet's asset. For a fleet
   * whose scenarios need an asset with no trip history (O21, "an asset's very first trip").
   */
  freshAsset?: boolean;
}

/**
 * Creates the fixture asset for `fleetKey`. A 409 here means the fleet number is taken even
 * though `findAssetByFleet` found no live asset with it, which is what a soft-deleted fixture
 * asset holding its fleet number would look like.
 */
async function createFixtureAsset(api: ApiClient, fleetKey: string): Promise<Uuid> {
  try {
    return await createAsset(api, {
      name: fleetKey,
      fleet: fleetKey,
      category_id: await resolveAssetCategoryId(api),
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      throw new Error(
        `createFixtureAsset: account ${api.accountId} rejected fleet "${fleetKey}" as already used, but ` +
          'no live asset has it. A deleted asset probably still holds the fleet number. Restore that ' +
          'asset, or set FIXTURE_NAMESPACE in .env to give this suite a fresh set of fleet numbers.',
      );
    }
    throw err;
  }
}

/** The installed fixture TennaCAM's identifiers, or a throw when a real device is installed. */
function reusableTracker(asset: Asset, installed: AssetTracker): {
  trackerId: Uuid;
  gmsSerial: string;
  vehicleId: string;
  installationId: Uuid;
} {
  if (!isFixtureTennaCam(installed)) {
    throw new Error(
      `provisionAssetWithTennaCam: asset ${asset.id} ("${asset.name}") has tracker ${installed.id} ` +
        `installed (type "${installed.type}", serial "${installed.serial_number}"), which this suite did ` +
        `not create. A fixture TennaCAM is a "${TENNACAM_2_TYPE}" whose serial starts with ` +
        `"${FIXTURE_GMS_PREFIX}" and whose Rosco vehicle_id starts with "${FIXTURE_VEHICLE_PREFIX}". ` +
        'Refusing to drive telemetry through a real device. Uninstall it from the asset, or pin a different asset.',
    );
  }
  return {
    trackerId: installed.id,
    gmsSerial: installed.serial_number,
    // isFixtureTennaCam has checked this is a non-empty fixture vehicle id.
    vehicleId: installed.secondary_tracker_serial_number as string,
    installationId: installed.tracker_asset_association_id,
  };
}

/**
 * Closes a trip a previous run left open on a reused asset, by sending the tracker an `IGN_OFF`
 * now. Without it, this run's first `IGN_ON` would land inside a trip that never ended. Only the
 * newest trip is checked, since only the newest can still be open. If the trip has not closed
 * within TRIP_END_BUDGET_MS this warns and carries on: the runner already ignores trips that
 * existed before each execution (`capturePreExistingTrips`), so a stuck trip is noise, not a
 * broken baseline.
 */
async function closeLeftoverTrip(api: ApiClient, assetId: Uuid, gmsSerial: string): Promise<void> {
  const [newest] = await searchTrips(api, { assetId, limit: 1 });
  if (!newest || newest.end_date !== null) return;

  await createTelemetryEmitter(api).send({ gmsSerial, event: 'IGN_OFF', atIso: new Date().toISOString() });
  try {
    await expect
      .poll(async () => (await getTrip(api, newest.id)).end_date !== null, {
        timeout: TRIP_END_BUDGET_MS,
        intervals: [POLL_INTERVAL_MS],
      })
      .toBe(true);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      `[provision] trip ${newest.id} on asset ${assetId} was left open by an earlier run and did not ` +
        `close within ${TRIP_END_BUDGET_MS}ms of an IGN_OFF. Carrying on, since scenarios ignore trips ` +
        'that existed before they started.',
    );
  }
}

/**
 * A fully installed and verified TennaCAM 2.0 on the asset for `label`, with Digestion resolving
 * it and the asset reset to a clean baseline.
 *
 * The asset is, in order: the pinned `opts.existingAssetId`, otherwise the account's asset whose
 * fleet is `fixtureAssetKey(label)`, otherwise a new one with that fleet. With `opts.freshAsset` it
 * is always new, under a fleet value that carries this worker's run id.
 *
 * The tracker is the fixture TennaCAM already installed on the asset when there is one, otherwise
 * a new one created, associated with the account and installed. Either way the install ends up
 * verified. `label` is the fleet name, or `<fleet>-secondary` for a scenario's second asset, and
 * tags every fixture in the run manifest (see `manifest.ts`).
 */
export async function provisionAssetWithTennaCam(
  api: ApiClient,
  label: string,
  opts: AssetProvisionOptions = {},
): Promise<Omit<RunContext, 'contacts'>> {
  const stableKey = fixtureAssetKey(label, env.fixtureNamespace);
  const fleetKey = opts.freshAsset ? `${stableKey}-${currentRunId().slice(FIXTURE_PREFIX.length + 1)}` : stableKey;

  let asset: Asset | null = null;
  if (opts.existingAssetId) {
    asset = await getAssetWithTracker(api, opts.existingAssetId);
  } else if (!opts.freshAsset) {
    asset = await findAssetByFleet(api, fleetKey);
  }

  let assetId: Uuid;
  if (asset) {
    assetId = asset.id;
    recordReused('asset', assetId, label);
  } else {
    assetId = await createFixtureAsset(api, fleetKey);
    recordCreated('asset', assetId, label);
  }

  let trackerId: Uuid;
  let gmsSerial: string;
  let vehicleId: string;
  let installationId: Uuid;
  const installed = asset?.tracker ?? null;
  if (asset && installed) {
    ({ trackerId, gmsSerial, vehicleId, installationId } = reusableTracker(asset, installed));
    recordReused('tracker', trackerId, label);
    recordReused('tracker-asset-association', installationId, label);
  } else {
    // createTennaCam2 does not generate its own identifiers. It takes the GMS serial and Rosco
    // vehicle_id as input, and there is no real device pool for this suite, so both are
    // fixture-minted here, with the prefixes `isFixtureTennaCam` later recognizes.
    gmsSerial = `${FIXTURE_GMS_PREFIX}${randomUUID().slice(0, 12)}`;
    vehicleId = `${FIXTURE_VEHICLE_PREFIX}${randomUUID().slice(0, 12)}`;
    trackerId = await createTennaCam2(api, { gmsSerial, vehicleId });
    recordCreated('tracker', trackerId, label);

    const accountAssociationId = await associateTrackerWithAccount(api, trackerId, api.accountId);
    recordCreated('tracker-account-association', accountAssociationId, label);

    installationId = await installTrackerOnAsset(api, trackerId, assetId, accountAssociationId);
    recordCreated('tracker-asset-association', installationId, label);
  }

  // A run that died between install and verify leaves the install unverified, so check rather
  // than assume, even on a reused tracker.
  const installation = await getTrackerAssetAssociation(api, installationId);
  if (installation.certification_passed !== true) {
    await verifyTrackerAssetAssociation(api, installationId);
  }

  await waitForDigestionReady(api, vehicleId, DIGESTION_READY_BUDGET_MS);

  if (asset) {
    await closeLeftoverTrip(api, assetId, gmsSerial);
  }
  await setAssetAssignee(api, assetId, null);

  return {
    runId: currentRunId(),
    accountId: api.accountId,
    assetId,
    trackerId,
    gmsSerial,
    vehicleId,
  };
}

// ---------------------------------------------------------------------------
// Whole-fleet provisioning
// ---------------------------------------------------------------------------

/**
 * The whole run for one fleet: preflight checks, the shared driver contacts, and the fleet's
 * primary asset (pinned via `suiteAssetId(fleet)` when set, otherwise the fleet's reused asset, or a
 * new one with `freshAsset`). `api` must already be scoped to the fleet's account
 * (`suiteAccountId(fleet)`), see `fixtures/test.ts`.
 */
export async function provisionFleetRun(
  api: ApiClient,
  fleet: string,
  opts: { freshAsset?: boolean } = {},
): Promise<RunContext> {
  assertLicenceFleetIsolated(fleet);
  await assertExpectedAccount(api, api.accountId, fleet);

  const problems = await preflight(api);
  if (problems.length > 0) {
    throw new Error(
      `provisionFleetRun(${fleet}): preflight failed — a human must fix this before the suite can ` +
        `run:\n${problems.map((p) => `- ${p}`).join('\n')}`,
    );
  }

  const contacts = await ensureContacts(api);
  const base = await provisionAssetWithTennaCam(api, fleet, {
    existingAssetId: suiteAssetId(fleet),
    freshAsset: opts.freshAsset,
  });
  return { ...base, contacts };
}
