/**
 * `POST /v5/rosco-driver-events/publish` emitter (`EMITTER=becrud`). This is the port-forward-free
 * path to the webhook: backend-crud posts each message, unchanged, to the webhooks server's
 * `/rosco` route (`backend-crud/app/modules/rosco_driver_events/v5`, `sendWebhook`, then
 * `app/utils/rosco_webhooks.js`'s `sendRoscoWebhooks`). The body is an array of raw Rosco payloads.
 *
 * The request schema (`docs/components/schemas/rosco-driver-events.yaml`,
 * `RoscoDriverEventBulkPublishRequest`) takes `name` of `identDrv` or `unDrv`, requires
 * `driver_guid` (a uuid) on `identDrv`, and types `location.lat`/`lon` as strings and `driverId`
 * as an integer. ajv runs without type coercion, so a mismatch is a 422.
 *
 * No `event_id` is sent. Rosco does not send one, and without it ingestion derives the id from
 * `vehicle_id` and `timestamp`, the same as for a payload that arrives through `EMITTER=webhook`.
 */
import type { ApiClient } from '../api/client';
import { ApiError } from '../api/client';
import type { RoscoDriverWebhookPayload } from '../types';
import { env } from '../env';
import type { DriverEventEmitter } from './index';

const PUBLISH_PATH = '/v5/rosco-driver-events/publish';

function rejectedError(err: ApiError): Error {
  return new Error(
    `POST ${PUBLISH_PATH} rejected the driver event with 422 (${err.body.slice(0, 300)}). ` +
      'The payload does not match RoscoDriverEventBulkPublishRequest in ' +
      'backend-crud/docs/components/schemas/rosco-driver-events.yaml.',
  );
}

async function publish(api: ApiClient, payload: RoscoDriverWebhookPayload): Promise<void> {
  try {
    // The route is permission(["super","admin"]) (rosco_driver_events/v5/index.js), so it has to
    // go out as the Tenna account. The intra-service bypass (omitting account_id, as
    // emit/telemetry.ts does) is not an option here: backend-crud forwards session.account_id as a
    // header on the webhook call, and superagent throws on an undefined header value, which
    // surfaces as a 500. Ingestion resolves the device's own account from vehicle_id, so the
    // header account does not scope the event.
    await api.forAccount(env.tennaAccountId).post<unknown>(PUBLISH_PATH, [payload]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) {
      throw rejectedError(err);
    }
    throw err;
  }
}

/** Creates the becrud-backed `DriverEventEmitter`. */
export function createBecrudEmitter(api: ApiClient, opts?: { dryRun?: boolean }): DriverEventEmitter {
  const isDryRun = opts?.dryRun ?? env.dryRun;

  return {
    kind: 'becrud',
    async emit(payload: RoscoDriverWebhookPayload): Promise<RoscoDriverWebhookPayload> {
      if (isDryRun) return payload;
      await publish(api, payload);
      return payload;
    },
    async reemit(payload: RoscoDriverWebhookPayload): Promise<void> {
      if (isDryRun) return;
      // Sent unchanged: backend-crud forwards the body as-is, so the second delivery reaches the
      // webhook byte-identical to the first.
      await publish(api, payload);
    },
  };
}
