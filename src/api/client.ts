/**
 * backend-crud client, over the intra-service (east-west) path.
 *
 * WHY THERE IS NO TOKEN HERE
 *
 * backend-crud's session middleware takes the intra-service branch when the request carries NO
 * Authorization header, its Host header is in INTRA_SERVICE_REQUEST_HEADER_HOSTS, and a
 * `requestor` header is present (app/middleware/session.js:21-35, 60-65). The session is then
 * built from the `requestor`, `user_id` and `account_id` headers alone.
 *
 * `localhost:3000` is in that allowlist (fluxcd-deployment/be-crud/be-crud-v5.yaml:177-178), so a
 * `kubectl port-forward` bound to LOCAL PORT 3000 puts this client on the intra-service path with
 * no Cognito login and no impersonation token. The local port must be exactly 3000, because the
 * Host header is what is matched.
 *
 * Sending an Authorization header would flip the request onto the Cognito branch, which then
 * fails the PUBLIC_SERVICE_REQUEST_HEADER_HOSTS check for localhost. So this client never sends one.
 *
 * `user_id` is deliberately omitted. The server falls back to TENNA_MICROSERVICE_USER_ID, the same
 * identity the ingestion pipeline writes as, which is what the design doc means by writes
 * rendering as Tenna Support (app/middleware/session.js:26-34).
 *
 * TRANSPORT VS AUTHORIZATION -- THIS IS NOT A PERMISSION BYPASS
 *
 * Everything above describes how the SESSION is built, not what it is allowed to do. Whenever
 * `account_id` is present, the request still goes through the full permission lookup at
 * app/middleware/permission-validator.js:44, exactly like a normal Cognito-authenticated call.
 * `tenna.tracker.manage` (trackers), `tenna.warehouse.manage` (tracker/account associations) and
 * `tenna.microservices.manage` (trips) all still apply, and all three depend on the target
 * account holding the `tenna` module licence. This client grants no exemption from any of them.
 *
 * The one real bypass is narrower than "intra-service traffic is trusted": permission-validator.js:36
 * reads `if (isIntraServiceRequest && !(user_id && account_id)) return true;`. It fires only when
 * `user_id` OR `account_id` is falsy. `user_id` is never falsy (session.js:32 substitutes
 * TENNA_MICROSERVICE_USER_ID), so in practice the bypass fires only when `account_id` is omitted --
 * which also gives up `super`/`admin`, since those are 1 only when the header account equals
 * TENNA_ACCOUNT_ID (app/utils/permissions.js:93,113-114). `POST /v5/automation-tracker` is
 * `permission(["super","admin"])` (automation-tracker/v1/index.js:10), so from this client it can
 * only succeed through that bypass, never through a licensed account's ordinary permissions.
 * Pass `{ omitAccountId: true }` (see `ApiCallOptions` below) for that call. Omitting the header
 * scopes the write by the payload rather than by the session, which is exactly how the real
 * ingestion pipeline calls it. `POST /v5/rosco-driver-events/publish` is super/admin too, but it
 * cannot use the bypass (see `emit/becrud.ts`), so it goes out as the Tenna account instead.
 */

import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env, assertNotProduction } from '../env';
import { REQUESTOR } from '../constants';

export interface ApiCallOptions {
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Default: any 2xx. Pass a number or a list to accept something else, e.g. 404. */
  expectStatus?: number | number[];
  /**
   * Omits the `account_id` header entirely, rather than sending it as-is. Needed only for
   * `POST /v5/automation-tracker`, which this client can otherwise never satisfy --
   * see the class-level comment above for exactly why. Default: false (send `account_id`).
   */
  omitAccountId?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${url} -> ${status}\n${body.slice(0, 500)}`);
    this.name = 'ApiError';
  }
}

/**
 * Extracts the first id from an array-body create/associate response.
 *
 * Guards against `send`'s 204 handling: an empty response body comes back as `undefined`, not
 * `[]` (finding 11), so an un-guarded `ids[0]` throws a raw TypeError -- "Cannot read properties
 * of undefined" -- instead of a message naming the call that produced it.
 */
export function firstId(ids: unknown, context: string): string {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error(`${context}: expected a non-empty array of ids in the response, got ${JSON.stringify(ids)}.`);
  }
  const id: unknown = ids[0];
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${context}: expected the first id to be a non-empty string, got ${JSON.stringify(id)}.`);
  }
  return id;
}

function buildQuery(query: ApiCallOptions['query']): string {
  if (!query) return '';
  const pairs = Object.entries(query)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

function accepts(status: number, expected: ApiCallOptions['expectStatus']): boolean {
  if (expected === undefined) return status >= 200 && status < 300;
  const list = Array.isArray(expected) ? expected : [expected];
  return list.includes(status);
}

export class ApiClient {
  private constructor(
    private readonly request: APIRequestContext,
    readonly baseUrl: string,
    readonly accountId: string,
  ) {}

  /**
   * Builds a client. No network call: the intra-service path needs no handshake.
   *
   * A caller-supplied `opts.baseUrl` bypasses every `env` getter (and their built-in
   * `assertNotProduction` calls), so it is checked here directly (finding 10).
   */
  static create(
    request: APIRequestContext,
    opts?: { accountId?: string; baseUrl?: string },
  ): ApiClient {
    if (opts?.baseUrl !== undefined) {
      assertNotProduction('ApiClient baseUrl', opts.baseUrl);
    }
    return new ApiClient(
      request,
      (opts?.baseUrl ?? env.crudBaseUrl).replace(/\/+$/, ''),
      opts?.accountId ?? env.accountId,
    );
  }

  /** A client for the same context scoped to a different account. */
  forAccount(accountId: string): ApiClient {
    return new ApiClient(this.request, this.baseUrl, accountId);
  }

  private intraServiceHeaders(extra?: Record<string, string>, omitAccountId?: boolean): Record<string, string> {
    return {
      'content-type': 'application/json',
      requestor: REQUESTOR,
      ...(omitAccountId ? {} : { account_id: this.accountId }),
      ...extra,
    };
  }

  private async send<T>(
    method: 'get' | 'post' | 'patch' | 'delete',
    url: string,
    body: unknown,
    o: ApiCallOptions | undefined,
    headers: Record<string, string>,
  ): Promise<T> {
    const started = Date.now();
    const response = await this.request.fetch(url, {
      method: method.toUpperCase(),
      headers,
      ...(body === undefined ? {} : { data: body }),
      failOnStatusCode: false,
    });
    const status = response.status();
    if (env.debug) {
      // eslint-disable-next-line no-console
      console.log(`[api] ${method.toUpperCase()} ${url} -> ${status} (${Date.now() - started}ms)`);
    }
    const text = await response.text();
    if (!accepts(status, o?.expectStatus)) {
      throw new ApiError(method.toUpperCase(), url, status, text);
    }
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  get<T>(path: string, o?: ApiCallOptions): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(o?.query)}`;
    return this.send<T>('get', url, undefined, o, this.intraServiceHeaders(o?.headers, o?.omitAccountId));
  }

  post<T>(path: string, body: unknown, o?: ApiCallOptions): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(o?.query)}`;
    return this.send<T>('post', url, body, o, this.intraServiceHeaders(o?.headers, o?.omitAccountId));
  }

  patch<T>(path: string, body: unknown, o?: ApiCallOptions): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(o?.query)}`;
    return this.send<T>('patch', url, body, o, this.intraServiceHeaders(o?.headers, o?.omitAccountId));
  }

  delete<T>(path: string, o?: ApiCallOptions): Promise<T> {
    const url = `${this.baseUrl}${path}${buildQuery(o?.query)}`;
    return this.send<T>('delete', url, undefined, o, this.intraServiceHeaders(o?.headers, o?.omitAccountId));
  }

  /**
   * A call to a host that is not backend-crud, with no intra-service headers. Used for the
   * webhooks service, whose Rosco route is `auth: false` and reads nothing but the body.
   *
   * `url` is caller-supplied and bypasses every `env` getter, so it is checked directly
   * (finding 10).
   */
  postAbsolute<T>(url: string, body: unknown, o?: ApiCallOptions): Promise<T> {
    assertNotProduction('postAbsolute url', url);
    return this.send<T>('post', url, body, o, { 'content-type': 'application/json', ...o?.headers });
  }

  /** A GET to a host that is not backend-crud, keeping the intra-service headers. */
  getAbsolute<T>(url: string, o?: ApiCallOptions): Promise<T> {
    return this.send<T>('get', url, undefined, o, this.intraServiceHeaders(o?.headers, o?.omitAccountId));
  }

  /**
   * A call to another Tenna service that uses the same intra-service convention.
   *
   * hapi-server-scorecards is the one this suite needs. Its `/v2/threshold-events/*` routes
   * declare `auth: 'jwt'`, but the proven service-to-service path sends only `requestor` and
   * `account_id` and no token at all: see how TrackIt calls it in
   * hapi-server-trackit/src/services/scorecardApiClient.ts, which sets exactly those two headers.
   */
  serviceCall<T>(
    method: 'get' | 'post' | 'patch',
    baseUrl: string,
    path: string,
    body?: unknown,
    o?: ApiCallOptions,
  ): Promise<T> {
    const url = `${baseUrl.replace(/\/+$/, '')}${path}${buildQuery(o?.query)}`;
    return this.send<T>(method, url, body, o, this.intraServiceHeaders(o?.headers, o?.omitAccountId));
  }
}
