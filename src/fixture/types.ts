/**
 * The fixture file contract.
 *
 * One fixture is one JSON file under `fixtures/`. It holds a trip with all of its events and a
 * separate sequence of driver identifications. The play utility (`tools/play.ts`) can run a
 * fixture on its own from the command line, and the scenario runner plays the same file.
 *
 * TWO CLOCKS, on every event and every identification:
 *
 *   atSec        logical offset in seconds from the trip's start. It becomes the timestamp
 *                stamped into the GMS frame or the Rosco payload.
 *   deliverAtSec playback offset in seconds deciding WHEN the event is actually sent.
 *                Defaults to atSec.
 *
 * A delayed identification is `atSec: 70, deliverAtSec: 400`: it claims to have happened 70
 * seconds into the trip but arrives after the trip ended. A delayed trip is the `delay.mode`
 * below, which rewrites deliverAtSec for the trip's own events.
 */

import type { DriverKey } from '../types';

/** GMS event names, as the frame carries them. */
export type GmsEventType =
  | 'IGN_ON'
  | 'ON_PERIODIC'
  | 'IGN_OFF'
  | 'HARDBRAKE'
  | 'HARDACCEL'
  | 'HARDTURN';

/**
 * How the play utility schedules the TRIP's own events. Identifications are never rewritten by
 * this; they keep their own deliverAtSec, which is what lets a fixture combine a delayed trip
 * with a live identification or the other way round.
 */
export type DelayMode =
  /** Real time. Every event is sent when its deliverAtSec arrives. */
  | { mode: 'none' }
  /**
   * The whole trip is delayed. Every trip event is sent back to back with its original atSec
   * preserved in the frame, so the trip appears in Tenna already finished, after identifications
   * that logically happened during it. The burst begins at `burstStartAtSec` (default 0), which
   * is how a fixture puts an identification on the wire before the trip that contains it.
   */
  | { mode: 'full-burst'; burstStartAtSec?: number }
  /**
   * The first part of the trip is delayed and the rest is live. Events at or before
   * `burstThroughAtSec` are sent back to back from `burstStartAtSec` (default 0) with their
   * original timestamps; everything after it is played in real time from that point on.
   */
  | { mode: 'partial-burst'; burstThroughAtSec: number; burstStartAtSec?: number };

export interface FixtureTripEvent {
  type: GmsEventType;
  atSec: number;
  deliverAtSec?: number;
  lat?: number;
  lon?: number;
  /** Optional label, so a fixture can be read at a glance. Not used by the player. */
  note?: string;
}

export interface FixtureIdentification {
  /** The timestamp claimed by the camera, as an offset from trip start. May be negative. */
  atSec: number;
  /** When it is actually POSTed. Defaults to atSec. Larger means a delayed webhook. */
  deliverAtSec?: number;
  /** `null` emits a Type 6 unDrv, which carries no identity. */
  driver: DriverKey | null;
  type?: 'identDrv' | 'unDrv';
  /** Label this identification so another entry can re-send it byte for byte. */
  as?: string;
  /** Re-send the labelled identification unchanged, for the redelivery case. */
  redeliverOf?: string;
  /** A Type 7 whose `driver_guid` matches no contact. Needs `driver: null` and `type: 'identDrv'`. */
  unknownDriver?: boolean;
  note?: string;
}

export interface Fixture {
  /** Matches the design doc's case id where there is one, e.g. `O3.1`. */
  id: string;
  title: string;
  description?: string;
  /** Which spec file plays this fixture. Also the fleet name, and so the asset it runs on. */
  suite: string;
  delay: DelayMode;
  trip: {
    /** Must end with IGN_OFF unless the fixture deliberately leaves the trip open. */
    events: FixtureTripEvent[];
    /** Set when the fixture intends a trip type the covering lookup should skip. */
    type?: 'normal' | 'heartbeat' | 'virtual';
  };
  /** Named `driver_identifications` in the JSON to match how the design doc talks about them. */
  driver_identifications: FixtureIdentification[];
}

/** A fixture whose trip events have been resolved into concrete send times and timestamps. */
export interface PlannedEvent {
  kind: 'trip' | 'ident';
  /** Milliseconds after playback start at which to send this. */
  deliverAtMs: number;
  /** The absolute timestamp to stamp into the payload. */
  timestampIso: string;
  tripEvent?: FixtureTripEvent;
  identification?: FixtureIdentification;
}

export interface PlaybackPlan {
  fixture: Fixture;
  /** Wall-clock anchor that `atSec: 0` maps to. */
  t0: Date;
  /** Ordered by deliverAtMs ascending. */
  events: PlannedEvent[];
  /** Total playback duration in milliseconds. */
  durationMs: number;
}
