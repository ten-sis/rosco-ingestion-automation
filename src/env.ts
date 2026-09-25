/**
 * Environment configuration.
 *
 * Every value is a lazy getter, so importing this module never throws. The throw happens on
 * access, with a message that tells the reader exactly what to put in `.env`.
 *
 * There is deliberately no Cognito or impersonation configuration here. The suite talks to
 * backend-crud over the intra-service path, which takes no token at all. See `api/client.ts`.
 */

import 'dotenv/config';

function required(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. ${hint}\nCopy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function flag(name: string): boolean {
  return process.env[name] === '1' || process.env[name] === 'true';
}

const PRODUCTION_MARKERS = [
  'api.tenna.com',
  'app.tenna.com',
  'prd.cloud',
  '.prd.',
  'prd.',
  // Broader substrings (defect: a host like `tenna-production-rw.cluster-xyz.rds.amazonaws.com`
  // passed every prior check): a hand-managed RDS instance is never this suite's target, and
  // `prod`/`production` catch names that don't follow Tenna's own `prd.` convention at all.
  'prod',
  'production',
  'rds.amazonaws.com',
];
const PRODUCTION_ENV_NAMES = ['prd', 'prod', 'production'];

/** Opt-in required for any `DB_URL` whose host is not localhost (see `dbUrl` below). */
const NON_LOCALHOST_DB_ACK_VAR = 'ACK_NON_LOCALHOST_DB';
const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/** Throws when a value looks like production. Called on every host the suite is pointed at. */
export function assertNotProduction(label: string, value: string): void {
  const lowered = value.toLowerCase();
  if (PRODUCTION_ENV_NAMES.includes(lowered) || PRODUCTION_MARKERS.some((m) => lowered.includes(m))) {
    throw new Error(
      `Refusing to use ${label}="${value}": it looks like production. This suite creates assets, ` +
        `trackers and trips, and reassigns drivers.`,
    );
  }
}

/**
 * backend-crud matches `req.headers.host` against INTRA_SERVICE_REQUEST_HEADER_HOSTS with an exact
 * string comparison (app/middleware/session.js:21-24), and the allowlisted entry is the literal
 * `localhost:3000`. Playwright sends the URL authority verbatim as the Host header, so
 * `127.0.0.1:3000` or any other port silently falls off the intra-service branch and 401s the
 * whole run. Fail at startup with the reason rather than at the first call without one.
 */
export function assertIntraServiceHost(baseUrl: string): void {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new Error(`CRUD_BASE_URL="${baseUrl}" is not a valid URL.`);
  }
  if (host !== 'localhost:3000') {
    throw new Error(
      `CRUD_BASE_URL host is "${host}", but backend-crud only treats the literal "localhost:3000" ` +
        `as an intra-service caller, and this suite sends no auth token. Bind the port-forward to ` +
        `local port 3000 and use http://localhost:3000/api:\n` +
        `  kubectl port-forward -n be-crud svc/be-crud-v5 3000:80`,
    );
  }
}

/**
 * Extracts `value`'s host for the localhost/acknowledgement gate. Throws rather than silently
 * treating an unparsable connection string as non-localhost, so a malformed `DB_URL` fails loudly
 * here instead of at the first query.
 */
function dbUrlHostname(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    throw new Error(`DB_URL="${value}" is not a valid connection URL.`);
  }
}

export interface SuiteEnv {
  /** Label only, used in fixture names and the run manifest. Does not select a host. */
  envKey: string;
  /** backend-crud over the port-forward. The host MUST be localhost:3000, see api/client.ts. */
  crudBaseUrl: string;
  /** The webhooks service over its own port-forward. */
  webhookBaseUrl: string;
  /** hapi-server-scorecards over its own port-forward. Serves /v2/threshold-events/*. */
  scorecardsBaseUrl: string;
  /** hapi-plugin-digestion-api over its own port-forward. Resolves the Rosco secondary tracker. */
  digestionBaseUrl: string;
  /** Required. The account every test acts on. */
  accountId: string;
  /** Optional pinning, for iterating against an asset that already exists. */
  assetId: string | undefined;
  trackerId: string | undefined;
  vehicleId: string | undefined;
  /** Per-suite overrides are read through `suiteAssetId()`, not from here. */
  emitter: 'webhook' | 'becrud';
  driverEventsReader: 'api' | 'sql';
  dbUrl: string | undefined;
  allowMutations: boolean;
  /**
   * Separate opt-in from `allowMutations`. `@phase2` scenarios exercise the trip-start consumer,
   * which the design explicitly places outside the initial deployment, so `ALLOW_MUTATIONS` alone
   * must not be enough to reach them (`playwright.config.ts`).
   */
  allowPhase2: boolean;
  debug: boolean;
  /** Skip provisioning writes and print what would be sent. Used to exercise the suite offline. */
  dryRun: boolean;
}

export const env: SuiteEnv = {
  get envKey(): string {
    const value = process.env.ENV ?? 'dv3';
    assertNotProduction('ENV', value);
    return value;
  },
  get crudBaseUrl(): string {
    const value = process.env.CRUD_BASE_URL ?? 'http://localhost:3000/api';
    assertNotProduction('CRUD_BASE_URL', value);
    assertIntraServiceHost(value);
    return value.replace(/\/+$/, '');
  },
  get webhookBaseUrl(): string {
    const value = process.env.WEBHOOK_BASE_URL ?? 'http://localhost:8081';
    assertNotProduction('WEBHOOK_BASE_URL', value);
    return value.replace(/\/+$/, '');
  },
  get scorecardsBaseUrl(): string {
    const value = process.env.SCORECARDS_BASE_URL ?? 'http://localhost:3001';
    assertNotProduction('SCORECARDS_BASE_URL', value);
    return value.replace(/\/+$/, '');
  },
  get digestionBaseUrl(): string {
    const value = process.env.DIGESTION_BASE_URL ?? 'http://localhost:3002';
    assertNotProduction('DIGESTION_BASE_URL', value);
    return value.replace(/\/+$/, '');
  },
  get accountId(): string {
    return required(
      'ACCOUNT_ID',
      'The account under test. It needs the rosco integration and the facial recognition licence.',
    );
  },
  get assetId(): string | undefined {
    return optional('ASSET_ID');
  },
  get trackerId(): string | undefined {
    return optional('TRACKER_ID');
  },
  get vehicleId(): string | undefined {
    return optional('VEHICLE_ID');
  },
  get emitter(): 'webhook' | 'becrud' {
    return process.env.EMITTER === 'becrud' ? 'becrud' : 'webhook';
  },
  get driverEventsReader(): 'api' | 'sql' {
    return process.env.DRIVER_EVENTS_READER === 'sql' ? 'sql' : 'api';
  },
  get dbUrl(): string | undefined {
    const value = optional('DB_URL');
    if (!value) return undefined;
    assertNotProduction('DB_URL', value);
    const hostname = dbUrlHostname(value);
    if (!LOCALHOST_HOSTNAMES.has(hostname) && !flag(NON_LOCALHOST_DB_ACK_VAR)) {
      throw new Error(
        `DB_URL points at host "${hostname}", not localhost. The SQL reader runs arbitrary ` +
          `SELECTs against whatever DB_URL names, so a non-localhost target (e.g. a tunnel bound ` +
          `to a nonprod replica's real DNS name rather than forwarded to 127.0.0.1) needs an ` +
          `explicit acknowledgement: set ${NON_LOCALHOST_DB_ACK_VAR}=1 once you have confirmed ` +
          `this host is not production.`,
      );
    }
    return value;
  },
  get allowMutations(): boolean {
    return flag('ALLOW_MUTATIONS');
  },
  get allowPhase2(): boolean {
    return flag('ALLOW_PHASE2');
  },
  get debug(): boolean {
    return flag('FR_DEBUG');
  },
  get dryRun(): boolean {
    return flag('FR_DRY_RUN');
  },
};

/**
 * Resolves the asset a suite should use, in precedence order: a suite-specific override, the
 * global ASSET_ID pin, then undefined, which means the suite provisions its own.
 *
 * The suite-specific variable is `ASSET_ID_<FLEET>`, upper-cased with non-alphanumerics replaced
 * by underscores. A file whose fleet is `fr-live` reads `ASSET_ID_FR_LIVE`.
 */
export function suiteAssetId(fleet: string): string | undefined {
  const key = `ASSET_ID_${fleet.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return optional(key) ?? env.assetId;
}

/** Same precedence as `suiteAssetId`, for the account. Lets one suite target a different account. */
export function suiteAccountId(fleet: string): string {
  const key = `ACCOUNT_ID_${fleet.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return optional(key) ?? env.accountId;
}
