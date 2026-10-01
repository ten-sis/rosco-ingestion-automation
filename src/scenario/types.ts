/**
 * The scenario contract.
 *
 * A permutation is data, not a hand-written test body. Every O-case in the design doc's
 * Developer Test Plan is one `Scenario` object, and one runner executes any of them.
 *
 * Two independent clocks, which is what makes the delayed cases rows rather than branches:
 *
 *   LOGICAL TIME  `atSec`, an offset in seconds from the scenario's anchor T0. It becomes the
 *                 `timestamp` stamped into the GMS frame or the Rosco payload.
 *   DELIVERY TIME the position of the step in the `timeline` array. Steps are POSTed in array
 *                 order, whatever their `atSec`.
 *
 * A delayed identification is an `ident` with a small `atSec` placed late in the array.
 * A delayed trip is `ignitionOn`/`ignitionOff` with small `atSec` values placed after the
 * `ident` that belongs to them. Nothing else in the suite needs to know the difference.
 */

import type { DriverEventFlags, DriverEventType, DriverKey, TripType, Uuid } from '../types';

// ---------------------------------------------------------------------------
// Timeline steps
// ---------------------------------------------------------------------------

export interface StepBase {
  /** Logical offset in seconds from T0. Negative values are before the anchor. */
  atSec: number;
  /** Optional real wall-clock pause before this step is sent, for ordering-sensitive cases. */
  sendAfterMs?: number;
  /**
   * Set on a step whose timestamp is deliberately later than the moment it is sent (O17's
   * day-two identification). Every other step is held back until its own timestamp has passed,
   * so no event ever claims a time in the future. This one is sent on schedule instead, and is
   * left out when the runner anchors T0.
   */
  timestampAheadOfDelivery?: boolean;
  /** Free-text note surfaced in the test report and in failure messages. */
  note?: string;
}

/** Ignition on. Starts a trip on the run's asset. */
export interface IgnitionOnStep extends StepBase {
  kind: 'ignitionOn';
  /** Defaults to the run's asset. Set to provision and use a second asset. */
  assetRef?: AssetRef;
}

/** A position frame. Several of these are what make a trip a `normal` trip with distance. */
export interface MoveStep extends StepBase {
  kind: 'move';
  assetRef?: AssetRef;
  lat?: number;
  lon?: number;
}

/** A harsh-driving frame, which raises a scorecard threshold event inside the open trip. */
export interface HarshEventStep extends StepBase {
  kind: 'harshEvent';
  assetRef?: AssetRef;
  severity?: 'hardBrake' | 'hardAccel' | 'hardTurn';
}

/** Ignition off. Ends the open trip and fires the trip-ended domain event. */
export interface IgnitionOffStep extends StepBase {
  kind: 'ignitionOff';
  assetRef?: AssetRef;
}

/** A Rosco driver identification. `driver: null` emits a Type 6 unDrv. */
export interface IdentStep extends StepBase {
  kind: 'ident';
  driver: DriverKey | null;
  type?: DriverEventType;
  assetRef?: AssetRef;
  /**
   * Re-send a byte-identical payload rather than building a fresh one. Used by O16 to prove
   * the deterministic event_id collapses a redelivery onto the row it already wrote.
   */
  redeliverOf?: string;
  /** Label this step so a later step can reference it (`redeliverOf`). */
  as?: string;
  /** Send a Type 7 whose `driver_guid` matches no contact. Needs `driver: null`. */
  unknownDriver?: boolean;
  /** Send a Type 7 naming the fleet's soft-deleted fixture contact. Needs `driver: null`. */
  deletedDriver?: boolean;
  /**
   * Send a Type 7 whose `driver_guid` isn't a UUID (`malformedDriverGuid` in `scenario/runner.ts`).
   * Needs `driver: null`. Always goes through the webhook, since be-crud's publish route rejects it.
   */
  malformedDriverGuid?: boolean;
}

/** A manual asset-assignee correction, the way a human makes one in the UI. */
export interface PatchAssetAssigneeStep extends StepBase {
  kind: 'patchAssetAssignee';
  driver: DriverKey | null;
  assetRef?: AssetRef;
}

/** A support-tooling trip-driver write. No UI caller does this today. */
export interface PatchTripAssigneeStep extends StepBase {
  kind: 'patchTripAssignee';
  driver: DriverKey | null;
  tripRef?: TripRef;
}

export interface ContactStatusStep extends StepBase {
  kind: 'deactivateContact' | 'reactivateContact';
  driver: DriverKey;
}

export interface SetLicenceStep extends StepBase {
  kind: 'setLicence';
  licence: 'facialRecognition';
  enabled: boolean;
}

/** A manual violation transfer, so O13 can prove already-transferred events are excluded. */
export interface TransferViolationsStep extends StepBase {
  kind: 'transferViolations';
  driver: DriverKey;
  /** Which of the trip's threshold events to move. Default is all of them. */
  which?: 'all' | 'first' | 'last';
  tripRef?: TripRef;
}

/**
 * Wait for the pipeline to quiesce before the next step. Prefer this over `sendAfterMs`
 * when the reason for waiting is "the previous write must have landed", because it polls
 * rather than sleeping.
 */
export interface SettleStep extends StepBase {
  kind: 'settle';
  until: 'identificationPersisted' | 'tripStarted' | 'tripEnded' | 'assigneeWritten';
  budget?: TimeoutName;
}

export type Step =
  | IgnitionOnStep
  | MoveStep
  | HarshEventStep
  | IgnitionOffStep
  | IdentStep
  | PatchAssetAssigneeStep
  | PatchTripAssigneeStep
  | ContactStatusStep
  | SetLicenceStep
  | TransferViolationsStep
  | SettleStep;

/** Which asset a step acts on. `primary` is the run's asset; `secondary` is provisioned lazily. */
export type AssetRef = 'primary' | 'secondary';

/** Which trip an assertion or step means, counted in the order they started on that asset. */
export type TripRef = { assetRef?: AssetRef; index: number } | 'latest' | 'first';

export type TimeoutName = 'LIVE_BUDGET_MS' | 'TRIP_END_BUDGET_MS' | 'BACKFILL_BUDGET_MS';

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

/**
 * `'unchanged'` is a first-class expected value, not an absence. Every scenario must carry at
 * least one of them: it is the negative control that distinguishes "the feature is not built"
 * from "the feature is built and wrong".
 */
export type AssigneeExpectation = DriverKey | null | 'unchanged';

export interface DriverEventExpectation {
  /** Match the row by the driver it names. `null` matches an unDrv row. */
  driver: DriverKey | null;
  type?: DriverEventType;
  /** How many rows are expected to match. Default 1. */
  count?: number;
  isAssigneeSource?: boolean | null;
  /** `'linked'` means trip_id is set to the referenced trip; `'unlinked'` means null. */
  tripLink?: { state: 'linked'; tripRef: TripRef } | { state: 'unlinked' };
  /** Only the listed flags are asserted. Absent and false are treated as equal. */
  flags?: DriverEventFlags;
  /** The contact-status guard's real input. Prefer this over any flag. */
  contactActive?: boolean | null;
  tripDriverSetAt?: 'set' | 'null';
}

export interface ThresholdEventExpectation {
  tripRef?: TripRef;
  /** Every threshold event in the trip is expected to name this driver. */
  allAssignedTo?: DriverKey;
  /** These specific events are expected to be untouched, by their manual assignee. */
  stillAssignedTo?: { driver: DriverKey; which: 'all' | 'first' | 'last' };
  /** Assert nothing was transferred at all. */
  noTransfers?: boolean;
  /**
   * The violations only move on the scorecard backfill cron (every 5 minutes), because the
   * identification lands after its trip's trip-end pass. Polls for BACKFILL_BUDGET_MS instead of
   * TRIP_END_BUDGET_MS, so the check always spans at least one cron run.
   */
  viaBackfill?: boolean;
}

export interface TripExpectation {
  tripRef: TripRef;
  assignee: AssigneeExpectation;
  type?: TripType;
}

export interface Expectation {
  assetAssignee?: { assetRef?: AssetRef; value: AssigneeExpectation };
  trips?: TripExpectation[];
  driverEvents?: DriverEventExpectation[];
  thresholdEvents?: ThresholdEventExpectation[];
  /** Total number of driver-event rows for the run's asset, when the count itself is the point. */
  driverEventRowCount?: number;
  /** Lines a service must log during the execution, for outcomes no table records. */
  serviceLogs?: ServiceLogExpectation[];
}

/**
 * A log line some pod of `deployment` must write between `t0` and the check. `contains` is
 * matched as a substring, after `{accountId}` is replaced with the run's account.
 */
export interface ServiceLogExpectation {
  namespace: string;
  deployment: string;
  /** Text one log line must contain. A list means all of them on the same line. */
  contains: string | readonly string[];
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export interface Precondition {
  /** Set the asset assignee before the timeline runs, so a "same driver" case starts correctly. */
  assetAssignee?: DriverKey | null;
  /** Licences the account must hold for this scenario to mean anything. */
  licences?: { facialRecognition?: boolean };
  /**
   * Account integrations the scenario needs. `trackIt` creates a `trackit` integration if the
   * account has none, and the runner deletes it again when the scenario ends. Refused on the
   * shared ACCOUNT_ID, since every other fleet's trip ends would then go through TrackIt.
   */
  integrations?: { trackIt?: boolean };
  /** Provision a second asset up front rather than lazily. */
  secondaryAsset?: boolean;
  /**
   * The asset must already have a finished normal trip before the timeline runs. The consumer's
   * insert-time lookup only sets `arrived_before_trip_created` when an earlier trip ended before
   * the identification, so a scenario that asserts that flag needs one. On an asset that has
   * never had a trip (the first run of a new asset or `FIXTURE_NAMESPACE`), the runner drives a
   * short seed trip first, stamped well in the past (`seedTripHistory` in `runner.ts`).
   */
  tripHistory?: boolean;
}

export interface Scenario {
  /** The doc's case id, e.g. `O3.1`. This is what TRACEABILITY.md keys on. */
  id: string;
  title: string;
  /** P0, P1 or P2, copied from the design doc's Developer Test Plan. */
  priority: 'P0' | 'P1' | 'P2';
  tags?: Array<'@live' | '@slow' | '@race' | '@contested'>;
  preconditions?: Precondition;
  timeline: Step[];
  /** Asserted after the timeline has been delivered and the pipeline has settled. */
  expect: Expectation;
  /**
   * Asserted at a named point mid-timeline, for cases where the interesting claim is that
   * something was true *during* the trip rather than at the end of it.
   */
  expectAfterStep?: Array<{ afterIndex: number; expect: Expectation }>;
  /**
   * For a case where the pipeline writes no row, the log line that proves it handled the
   * identification. Negative checks wait for it instead of a row.
   */
  livenessLog?: ServiceLogExpectation;
  /** Number of times to repeat the whole scenario. Used by the race case. */
  repeat?: number;
  /** Why this case exists, in the design doc's own words. Printed on failure. */
  rationale: string;
  /**
   * A limit on what a pass proves, printed next to the result in the run summary. O1 uses it: the
   * doc's O1 is real hardware, and this suite can only run it simulated.
   */
  caveat?: string;
  /**
   * Set when the scenario cannot pass for a reason outside the product, with that reason. The test
   * is registered as `test.fixme` and reported as skipped, with the reason, in the run summary.
   */
  fixme?: string;
}
