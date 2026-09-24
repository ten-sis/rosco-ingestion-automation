/**
 * Driver-event emitter selection and payload building.
 *
 * `createDriverEventEmitter` picks the webhook or becrud implementation per `env.emitter`
 * (`EMITTER=webhook|becrud`); both live in sibling files and share this file's
 * `DriverEventEmitter` contract.
 */
import type { ApiClient } from '../api/client';
import type { DriverEventType, RoscoDriverWebhookPayload } from '../types';
import { env } from '../env';
import { createWebhookEmitter } from './webhook';
import { createBecrudEmitter } from './becrud';

export interface DriverEventEmitter {
  /** Sends a fresh identification. Returns the payload actually sent. */
  emit(payload: RoscoDriverWebhookPayload): Promise<RoscoDriverWebhookPayload>;
  /** Resends `payload` unchanged, for the O16 redelivery case. */
  reemit(payload: RoscoDriverWebhookPayload): Promise<void>;
  readonly kind: 'webhook' | 'becrud';
}

/**
 * Builds a Rosco driver-identification webhook payload. The event type decides the shape in this
 * one place: identity fields are attached only when `type` resolves to `identDrv`, and dropped
 * outright for `unDrv`, regardless of whether a `driverGuid` happens to be present. That is what
 * makes `type: 'unDrv'` paired with a non-null driver — a shape the design has no case for —
 * impossible to build, rather than merely impossible to see once a caller relabels `name` after
 * the fact.
 *
 * `type` is optional and, when omitted, is inferred from `driverGuid` (`null` means unidentified)
 * for backward compatibility with the two existing callers (`src/scenario/runner.ts`,
 * `tools/play.ts`, neither owned here) that predate this parameter and do not pass it yet.
 * Whoever owns `runner.ts` should pass `type` explicitly here instead of building an
 * identity-carrying payload and overwriting just `name` afterward (its own doc comment on
 * `deliverIdentStep` already flags that override as provisional) — that post-hoc override is
 * exactly the bug this parameter closes, and leaving it in place means the runner's `unDrv` steps
 * with a non-null `driver` still carry identity fields.
 *
 * design brief item 4: `driver_guid` is the Tenna Contact UUID; its absence means no identity was
 * resolved.
 *
 * VERIFY: `FixtureIdentification` (src/fixture/types.ts) carries no lat/lon, so a
 * fixture-driven identification always defaults `location` to `{0, 0}` here. Confirm against a
 * real Rosco payload whether an identification ever carries its own position, or always
 * inherits the trip's last-known one, once a live call is possible.
 */
export function buildDriverEventPayload(input: {
  vehicleId: string;
  timestampIso: string;
  driverGuid: string | null;
  /** Defaults to inferring identDrv/unDrv from `driverGuid` when omitted. See doc comment above. */
  type?: DriverEventType;
  driverFirst?: string;
  driverLast?: string;
  lat?: number;
  lon?: number;
}): RoscoDriverWebhookPayload {
  const eventType: DriverEventType = input.type ?? (input.driverGuid !== null ? 'identDrv' : 'unDrv');
  const isIdentified = eventType === 'identDrv';
  const fullName = [input.driverFirst, input.driverLast].filter((part): part is string => Boolean(part)).join(' ');

  const base: RoscoDriverWebhookPayload = {
    vehicle_id: input.vehicleId,
    name: eventType,
    timestamp: input.timestampIso,
    location: { lat: input.lat ?? 0, lon: input.lon ?? 0 },
  };

  if (!isIdentified) {
    return base;
  }

  return {
    ...base,
    driver_guid: input.driverGuid as string,
    driverId: input.driverGuid as string,
    ...(input.driverFirst ? { driver_fn: input.driverFirst } : {}),
    ...(input.driverLast ? { driver_ln: input.driverLast } : {}),
    ...(fullName ? { driver_name: fullName } : {}),
  };
}

/** Selects the webhook or becrud emitter per `env.emitter`. */
export function createDriverEventEmitter(api: ApiClient, opts?: { dryRun?: boolean }): DriverEventEmitter {
  return env.emitter === 'becrud' ? createBecrudEmitter(api, opts) : createWebhookEmitter(api, opts);
}
