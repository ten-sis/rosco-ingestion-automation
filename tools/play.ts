#!/usr/bin/env -S npx tsx
/**
 * Standalone fixture player. This calls the exact `playFixture` engine the scenario runner
 * uses (`src/player.ts`) — running a fixture by hand exercises the same code path a test does.
 *
 * Usage:
 *   npx tsx tools/play.ts --fixture <id|path> --account <uuid> --asset <uuid> --serial <gms> \
 *     --vehicle <rosco-device-id> [--driver-a <contact-uuid> ...] [--dry-run] [--list]
 *
 * `--list` prints every fixture under fixtures/ with its id, suite, delay mode and duration.
 *
 * `--dry-run` prints the resolved plan for one fixture (offset, kind and stamped timestamp per
 * item) with no network calls at all — it calls `planPlayback` directly rather than
 * `playFixture`, so it does not wait out a live trip's real playback time just to list it.
 * (`playFixture`'s own `dryRun` option is a different thing: it still respects real playback
 * timing but no-ops the emitters' network calls, for exercising the runner itself offline.)
 */
import { request } from '@playwright/test';
import { ApiClient } from '../src/api/client';
import { getAsset } from '../src/api/assets';
import { env } from '../src/env';
import { listFixtures, loadFixture } from '../src/fixture/loader';
import { planPlayback } from '../src/fixture/planner';
import type { Fixture } from '../src/fixture/types';
import { playFixture } from '../src/player';
import type { PlayTarget, PlayedItem } from '../src/player';
import { DRIVER_NAMES } from '../src/constants';
import type { DriverKey } from '../src/types';

const DRIVER_KEYS: readonly DriverKey[] = ['A', 'B', 'C', 'D'];

interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next);
      i += 1;
    } else {
      flags.add(name);
    }
  }
  return { flags, values };
}

function requireValue(args: ParsedArgs, name: string): string {
  const value = args.values.get(name);
  if (value === undefined) {
    console.error(`Missing required flag --${name}`);
    return process.exit(1);
  }
  return value;
}

function printFixtureList(): void {
  const fixtures = listFixtures();
  if (fixtures.length === 0) {
    console.log('No fixtures found under fixtures/.');
    return;
  }
  console.log('id             suite          delay               duration');
  for (const fixture of fixtures) {
    const plan = planPlayback(fixture);
    const durationSec = `${(plan.durationMs / 1000).toFixed(1)}s`;
    console.log(
      `${fixture.id.padEnd(15)}${fixture.suite.padEnd(15)}${fixture.delay.mode.padEnd(20)}${durationSec}`,
    );
  }
}

function printDryRun(fixture: Fixture): void {
  const plan = planPlayback(fixture);
  console.log(`Dry run: ${fixture.id} — ${fixture.title} (${plan.events.length} item(s))`);
  for (const item of plan.events) {
    const offsetSec = (item.deliverAtMs / 1000).toFixed(2);
    const label =
      item.kind === 'trip'
        ? `trip  ${item.tripEvent?.type ?? '?'}`
        : `ident ${item.identification?.driver ?? 'unDrv'}${item.identification?.redeliverOf ? ` (redeliverOf ${item.identification.redeliverOf})` : ''}`;
    console.log(`  +${offsetSec}s  ${label}  at=${item.timestampIso}`);
  }
}

type ContactRef = { id: string; first: string; last: string };

function buildContacts(args: ParsedArgs): Partial<Record<DriverKey, ContactRef>> {
  const contacts: Partial<Record<DriverKey, ContactRef>> = {};
  for (const key of DRIVER_KEYS) {
    const id = args.values.get(`driver-${key.toLowerCase()}`);
    if (id !== undefined) {
      contacts[key] = { id, first: DRIVER_NAMES[key].first, last: DRIVER_NAMES[key].last };
    }
  }
  return contacts;
}

/** Every driver key `fixture` references in a non-null identification, deduplicated. */
function referencedDriverKeys(fixture: Fixture): DriverKey[] {
  const keys = new Set<DriverKey>();
  for (const identification of fixture.driver_identifications) {
    if (identification.driver !== null) keys.add(identification.driver);
  }
  return [...keys];
}

/**
 * Fails before the first send when `fixture` references a driver whose contact id was not
 * supplied on the command line. Without this, `player.ts`'s `resolveContact` throws mid-playback
 * — potentially some 200 seconds in, with a half-played trip already written to the environment
 * and no way to undo it from here.
 */
function assertContactsCoverFixture(fixture: Fixture, contacts: Partial<Record<DriverKey, ContactRef>>): void {
  const missing = referencedDriverKeys(fixture).filter((key) => contacts[key] === undefined);
  if (missing.length === 0) return;
  console.error(
    `Refusing to play ${fixture.id}: it references driver(s) ${missing.join(', ')}, but ` +
      `${missing.map((key) => `--driver-${key.toLowerCase()}`).join(', ')} was not supplied. Provide a ` +
      'contact id for every driver the fixture uses before any frame is sent.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Safety gates — same two the Playwright suite itself refuses to run without
// (`src/fixtures/provision.ts`'s `provisionFleetRun`), reimplemented here because this is a plain
// Node entry point (`npx tsx`), not a Playwright test: importing straight from `provision.ts`
// would pull the `@playwright/test` fixture lifecycle into a script that must also run with
// `--dry-run` and no test runner at all, and that file is owned by another module (currently being
// edited for the licence chain). The duplication between this and `assertExpectedAccount` in
// `provision.ts` is real and worth collapsing into one shared helper once both are stable; until
// then this is the second, independent copy of the same check, against the same `ApiClient`.
// ---------------------------------------------------------------------------

/**
 * Refuses to send anything until the operator opts in explicitly. A real playback creates trips
 * and driver identifications on whatever cluster the operator's `kubectl port-forward` happens to
 * be bound to — this is the same `ALLOW_MUTATIONS` flag `src/env.ts` already exposes, reused here
 * rather than adding a second name for the same guard.
 */
function assertMutationsAllowed(): void {
  if (env.allowMutations) return;
  console.error(
    'Refusing to play this fixture: ALLOW_MUTATIONS is not set. A real playback writes trips and ' +
      'driver identifications to whatever cluster your port-forward is bound to. Set ' +
      'ALLOW_MUTATIONS=1 (or =true) once you have confirmed the target, or pass --dry-run to inspect ' +
      'the resolved schedule with no cluster access at all.',
  );
  process.exit(1);
}

interface AccountRow {
  id: string;
  name?: string;
}

/**
 * Proves `--account` from the server's own answer before writing anything, the same way
 * `assertExpectedAccount` in `src/fixtures/provision.ts` does for the Playwright suite: a stale or
 * wrong kube-context makes `localhost:3000` answer for whatever cluster it is bound to that day,
 * and neither `--account` nor any `ENV` label can tell that apart from production on its own.
 */
async function assertExpectedAccount(api: ApiClient, accountId: string): Promise<void> {
  const expectedName = process.env.EXPECTED_ACCOUNT_NAME;
  if (!expectedName) {
    console.error(
      'EXPECTED_ACCOUNT_NAME is not set. This tool refuses to write anything without proving, from ' +
        "the server's own answer, which account and cluster --account actually resolves to on the " +
        'other side of your kubectl port-forward. Copy .env.example, set EXPECTED_ACCOUNT_NAME to the ' +
        'exact name of the known nonprod fixture account, then re-run.',
    );
    process.exit(1);
    return;
  }
  const account = await api.get<AccountRow>(`/v5/accounts/${accountId}`, { query: { fields: 'id,name' } });
  if (account.name === expectedName) return;
  console.error(
    `Refusing to play: backend-crud returned account "${account.name ?? '(no name field)'}" for ` +
      `--account=${accountId}, but EXPECTED_ACCOUNT_NAME="${expectedName}". This almost always means ` +
      'the kubectl context behind your localhost:3000 port-forward is not the cluster you think it is ' +
      '(run `kubectl config current-context` to check) — fix that, or correct EXPECTED_ACCOUNT_NAME if ' +
      'the fixture account was legitimately renamed. Nothing has been written yet.',
  );
  process.exit(1);
}

/**
 * `--asset` was previously required and never used beyond being printed. This verifies it belongs
 * to `--account`, catching the common mistake of pasting an asset id from the wrong account/env.
 * It does NOT verify that `--serial`/`--vehicle` are actually installed on this asset: no endpoint
 * for "trackers installed on asset X" is in this suite's owned API contract (`src/api/trackers.ts`
 * exposes `getTracker(id)`, not a by-asset lookup), so a mismatched `--serial`/`--vehicle` pair
 * still reaches the wrong tracker silently. Only the account match is guarded here.
 */
async function assertAssetBelongsToAccount(api: ApiClient, assetId: string, accountId: string): Promise<void> {
  const asset = await getAsset(api, assetId);
  if (asset.account_id === accountId) return;
  console.error(
    `Refusing to play: asset ${assetId} belongs to account ${asset.account_id}, not --account=${accountId}.`,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has('list')) {
    printFixtureList();
    return;
  }

  const fixtureRef = requireValue(args, 'fixture');
  const fixture = loadFixture(fixtureRef);

  if (args.flags.has('dry-run')) {
    printDryRun(fixture);
    return;
  }

  const accountId = requireValue(args, 'account');
  const assetId = requireValue(args, 'asset');
  const gmsSerial = requireValue(args, 'serial');
  const vehicleId = requireValue(args, 'vehicle');

  const contacts = buildContacts(args);
  assertContactsCoverFixture(fixture, contacts);
  assertMutationsAllowed();

  const requestContext = await request.newContext();
  try {
    const api = ApiClient.create(requestContext, { accountId });
    await assertExpectedAccount(api, accountId);
    await assertAssetBelongsToAccount(api, assetId, accountId);

    const target: PlayTarget = { api, gmsSerial, vehicleId, contacts: contacts as Record<DriverKey, ContactRef> };

    console.log(
      `Playing ${fixture.id} — ${fixture.title} (suite ${fixture.suite}, account ${accountId}, asset ${assetId})`,
    );
    const onItem = (item: PlayedItem): void => {
      const label = item.label ? ` (${item.label})` : '';
      console.log(`  [${new Date(item.deliveredAtMs).toISOString()}] ${item.kind}${label} at=${item.timestampIso}`);
    };

    const result = await playFixture(fixture, target, { onItem });
    const labelCount = Object.keys(result.identificationsByLabel).length;
    console.log(`Done. ${result.items.length} item(s) played, ${labelCount} labelled identification(s).`);
  } finally {
    await requestContext.dispose();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
