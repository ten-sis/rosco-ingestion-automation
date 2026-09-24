/**
 * `POST /v5/rosco-events/publish` emitter (`EMITTER=becrud`). This is the port-forward-free
 * path (proxies to `/rosco` in-cluster: `backend-crud/app/modules/rosco_events/v5/service.js`,
 * `sendWebhook`, body is the raw event array), but it is BLOCKED today: the publish schema
 * requires `event_id` on each element and pins `name` to the enum `["events"]`
 * (`backend-crud/app/modules/rosco_events/v5/index.js`'s `publishSchema`,
 * `be-crud.json`'s `/api/v5/rosco-events/publish` request schema). A driver-identification
 * payload's `name` is `"identDrv"`/`"unDrv"`, which that enum rejects with a 400. Carrying
 * Types 6 and 7 through this endpoint is an expected backend change not yet made (see
 * PLAN/06-BLOCKERS.md). `EMITTER=webhook` (`src/emit/webhook.ts`) is the working path meanwhile.
 */
import type { ApiClient } from '../api/client';
import { ApiError } from '../api/client';
import type { RoscoDriverWebhookPayload } from '../types';
import { env } from '../env';
import { driverEventId } from '../hash';
import type { DriverEventEmitter } from './index';

const PUBLISH_PATH = '/v5/rosco-events/publish';

function blockedError(err: ApiError): Error {
  return new Error(
    `POST ${PUBLISH_PATH} rejected the driver event with 400 (${err.body.slice(0, 200)}). ` +
      'The publish schema still requires "event_id" and pins "name" to the enum ["events"] ' +
      '(backend-crud/app/modules/rosco_events/v5, be-crud.json\'s publish request schema) — ' +
      'carrying Types 6/7 ("identDrv"/"unDrv") through this endpoint is an expected backend ' +
      'change not yet made (see PLAN/06-BLOCKERS.md). Use EMITTER=webhook, the working path, ' +
      'until that schema widens.',
  );
}

async function publish(api: ApiClient, payload: RoscoDriverWebhookPayload): Promise<void> {
  const eventId = driverEventId(payload.vehicle_id, payload.name, payload.timestamp, payload.driver_guid);
  const body = [{ ...payload, event_id: eventId }];
  try {
  // See the note in emit/telemetry.ts: this route is permission(["super","admin"]) too
  // (rosco_events/v5/index.js:79), so the account_id header has to be dropped for the
  // intra-service permission bypass to fire.
    await api.post<unknown>(PUBLISH_PATH, body, { omitAccountId: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      throw blockedError(err);
    }
    throw err;
  }
}

/** Creates the becrud-backed `DriverEventEmitter`. Inert until the publish schema widens. */
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
      // The event_id is a pure function of (vehicle_id, name, timestamp, driver_guid), so
      // re-publishing this exact payload reproduces the exact same body sent the first time.
      await publish(api, payload);
    },
  };
}
