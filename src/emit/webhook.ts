/**
 * Rosco webhook emitter: the WORKING emission path (`EMITTER=webhook`, the default).
 *
 * `POST http://localhost:8081/rosco`, over `kubectl port-forward -n integration
 * svc/webhooks-api 8081:80`. `auth: false` on that route (hapi-plugin-webhooks's
 * `roscoHandler.js`, route `configure()` around :173), so no intra-service headers are needed —
 * the body alone drives the publish, verbatim, to `ros.{h}.{h}.raw-events` on exchange `too_ti`.
 */
import type { ApiClient } from '../api/client';
import type { RoscoDriverWebhookPayload } from '../types';
import { env } from '../env';
import type { DriverEventEmitter } from './index';

/** Creates the webhook-backed `DriverEventEmitter`. */
export function createWebhookEmitter(api: ApiClient, opts?: { dryRun?: boolean }): DriverEventEmitter {
  const isDryRun = opts?.dryRun ?? env.dryRun;
  const url = `${env.webhookBaseUrl}/rosco`;

  return {
    kind: 'webhook',
    async emit(payload: RoscoDriverWebhookPayload): Promise<RoscoDriverWebhookPayload> {
      if (isDryRun) return payload;
      await api.postAbsolute<unknown>(url, payload);
      return payload;
    },
    async reemit(payload: RoscoDriverWebhookPayload): Promise<void> {
      if (isDryRun) return;
      // Sent unchanged: no rebuild, no re-derivation, so the second delivery is byte-identical.
      await api.postAbsolute<unknown>(url, payload);
    },
  };
}
