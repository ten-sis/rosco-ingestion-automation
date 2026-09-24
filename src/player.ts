/**
 * The shared playback engine. `tools/play.ts` and the scenario runner both call `playFixture`,
 * so a fixture behaves identically whether it is played by hand or inside a Playwright test.
 */
import type { DriverKey, RoscoDriverWebhookPayload } from './types';
import type { ApiClient } from './api/client';
import type { Fixture, FixtureIdentification, PlannedEvent } from './fixture/types';
import { planPlayback } from './fixture/planner';
import { createTelemetryEmitter, type TelemetryEmitter, type TelemetryFrame } from './emit/telemetry';
import { createDriverEventEmitter, buildDriverEventPayload, type DriverEventEmitter } from './emit/index';

export interface PlayTarget {
  api: ApiClient;
  gmsSerial: string;
  vehicleId: string;
  contacts: Record<DriverKey, { id: string; first: string; last: string }>;
}

export interface PlayedItem {
  kind: 'trip' | 'ident';
  label?: string;
  timestampIso: string;
  deliveredAtMs: number;
  payload: unknown;
}

export interface PlayResult {
  t0: Date;
  items: PlayedItem[];
  identificationsByLabel: Record<string, RoscoDriverWebhookPayload>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTripItem(item: PlannedEvent, target: PlayTarget, telemetry: TelemetryEmitter): Promise<PlayedItem> {
  const tripEvent = item.tripEvent;
  if (!tripEvent) {
    throw new Error('playFixture: a "trip" planned item is missing its tripEvent');
  }
  const frame: TelemetryFrame = {
    gmsSerial: target.gmsSerial,
    event: tripEvent.type,
    atIso: item.timestampIso,
    lat: tripEvent.lat,
    lon: tripEvent.lon,
  };
  await telemetry.send(frame);
  return {
    kind: 'trip',
    label: tripEvent.note,
    timestampIso: item.timestampIso,
    deliveredAtMs: Date.now(),
    payload: frame,
  };
}

/** `type` decides identity when given; otherwise a non-null `driver` implies `identDrv`. */
function isIdentified(identification: FixtureIdentification): boolean {
  if (identification.type) return identification.type === 'identDrv';
  return identification.driver !== null;
}

function resolveContact(
  target: PlayTarget,
  identification: FixtureIdentification,
): { id: string; first: string; last: string } {
  if (identification.driver === null) {
    throw new Error(
      `playFixture: identification resolves to identDrv but "driver" is null (${identification.note ?? identification.atSec})`,
    );
  }
  const contact = target.contacts[identification.driver];
  if (!contact) {
    throw new Error(
      `playFixture: no contact provisioned for driver "${identification.driver}" ` +
        `(${identification.note ?? identification.atSec})`,
    );
  }
  return contact;
}

function buildIdentPayload(
  identification: FixtureIdentification,
  target: PlayTarget,
  timestampIso: string,
): RoscoDriverWebhookPayload {
  const identified = isIdentified(identification);
  const contact = identified ? resolveContact(target, identification) : undefined;
  return buildDriverEventPayload({
    vehicleId: target.vehicleId,
    timestampIso,
    driverGuid: identified ? (contact as { id: string }).id : null,
    driverFirst: contact?.first,
    driverLast: contact?.last,
  });
}

interface IdentOutcome {
  playedItem: PlayedItem;
  storeAs?: { label: string; payload: RoscoDriverWebhookPayload };
}

async function sendIdentItem(
  item: PlannedEvent,
  target: PlayTarget,
  emitter: DriverEventEmitter,
  identificationsByLabel: Readonly<Record<string, RoscoDriverWebhookPayload>>,
): Promise<IdentOutcome> {
  const identification = item.identification;
  if (!identification) {
    throw new Error('playFixture: an "ident" planned item is missing its identification');
  }

  if (identification.redeliverOf) {
    const stored = identificationsByLabel[identification.redeliverOf];
    if (!stored) {
      throw new Error(
        `playFixture: redeliverOf "${identification.redeliverOf}" has no earlier identification ` +
          `labelled "as: ${identification.redeliverOf}"`,
      );
    }
    await emitter.reemit(stored);
    return {
      playedItem: {
        kind: 'ident',
        label: identification.as,
        timestampIso: item.timestampIso,
        deliveredAtMs: Date.now(),
        payload: stored,
      },
    };
  }

  const payload = buildIdentPayload(identification, target, item.timestampIso);
  const sent = await emitter.emit(payload);
  const playedItem: PlayedItem = {
    kind: 'ident',
    label: identification.as,
    timestampIso: item.timestampIso,
    deliveredAtMs: Date.now(),
    payload: sent,
  };
  return identification.as ? { playedItem, storeAs: { label: identification.as, payload: sent } } : { playedItem };
}

/**
 * Plays a fixture against `target`: schedules every trip event and identification at its planned
 * delivery offset from a scheduling anchor, waiting only the real remaining delta before each
 * send so a wait already elapsed is skipped rather than slept through.
 *
 * The scheduling anchor is deliberately NOT always `plan.t0`. `PlannedEvent.deliverAtMs` is
 * documented (`fixture/types.ts`) as milliseconds after PLAYBACK START, a concept distinct from
 * `t0` (the anchor `atSec: 0` maps to for the STAMPED timestamp). When the caller gives no
 * `opts.t0`, `planPlayback` now resolves its own default anchor from the fixture's trip span
 * (`planner.ts`'s `defaultAnchor`) so stamped timestamps land safely in the past — but that value
 * can be tens or hundreds of seconds behind real "now", and scheduling deliveries from it would
 * fire every item immediately (all already "due"), collapsing a live, real-time fixture like O2
 * into an instant burst instead of actually pacing it. So the default case schedules from real
 * "now" instead, decoupled from the (possibly backdated) stamp anchor.
 *
 * When the caller DOES pass an explicit `opts.t0` — replaying a historical window — scheduling
 * anchors on that same value, which is what lets an already-elapsed item's wait be skipped rather
 * than slept through: the caller asked for these exact historical timestamps, so items whose
 * `deliverAtMs` from that anchor is already in the past fire immediately, in order.
 */
export async function playFixture(
  fixture: Fixture,
  target: PlayTarget,
  opts?: { dryRun?: boolean; t0?: Date; onItem?: (item: PlayedItem) => void },
): Promise<PlayResult> {
  const plan = planPlayback(fixture, { t0: opts?.t0 });
  const scheduleAnchorMs = (opts?.t0 ?? new Date()).getTime();
  const telemetryEmitter = createTelemetryEmitter(target.api, { dryRun: opts?.dryRun });
  const driverEventEmitter = createDriverEventEmitter(target.api, { dryRun: opts?.dryRun });

  let items: PlayedItem[] = [];
  let identificationsByLabel: Record<string, RoscoDriverWebhookPayload> = {};

  for (const item of plan.events) {
    const absoluteAtMs = scheduleAnchorMs + item.deliverAtMs;
    const remaining = absoluteAtMs - Date.now();
    if (remaining > 0) {
      await sleep(remaining);
    }

    if (item.kind === 'trip') {
      const playedItem = await sendTripItem(item, target, telemetryEmitter);
      items = [...items, playedItem];
      opts?.onItem?.(playedItem);
      continue;
    }

    const outcome = await sendIdentItem(item, target, driverEventEmitter, identificationsByLabel);
    items = [...items, outcome.playedItem];
    if (outcome.storeAs) {
      identificationsByLabel = { ...identificationsByLabel, [outcome.storeAs.label]: outcome.storeAs.payload };
    }
    opts?.onItem?.(outcome.playedItem);
  }

  return { t0: plan.t0, items, identificationsByLabel };
}
