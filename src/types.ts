/**
 * Shared domain types for the facial-recognition operation suite.
 *
 * This file is the contract every other module builds against. Changing a type here
 * changes several modules at once, so prefer adding over editing.
 */

export type Uuid = string;

/** Logical driver slots. Resolved to real contact ids by the provisioning step. */
export type DriverKey = 'A' | 'B' | 'C' | 'D';

/** Rosco driver-event types. Type 7 is identDrv, Type 6 is unDrv. */
export type DriverEventType = 'identDrv' | 'unDrv';

/** Trip types as backend-crud stores them. Only `normal` participates in the covering lookup. */
export type TripType = 'normal' | 'heartbeat' | 'virtual';

/**
 * `deleted_at` is typed as the literal `null`, never `string`, because it can never legitimately
 * be anything else here (defect C2). `CONTACT_FIELDS`
 * (`backend-crud/app/modules/contact/v4/schema.js:114`, `[...READONLY_FIELDS,
 * ...Object.keys(contactProperties)]`) has no `deleted_at` entry at all, so neither `GET
 * /v5/contacts/:id` nor `POST /v5/contacts/search`'s `fields` can ever return a real value for it
 * — `../api/contacts.ts` attaches `deleted_at: null` itself on every `Contact` it builds, rather
 * than trusting anything the API sent for that key. That is not a guess: the Contact model is
 * `paranoid: true` (`backend-crud/app/db/models/contact.js:93`), so a normal read excludes a
 * soft-deleted row unless the caller opts in via `include_deleted`/`includeDeleted`, which nothing
 * in this suite ever does, and nothing in this suite ever soft-deletes a contact either (only
 * `enabled` is toggled). So every `Contact` this suite can ever construct is provably live.
 */
export interface Contact {
  id: Uuid;
  first_name: string;
  last_name: string;
  /** Null on fixture contacts created before provisioning started giving them one. */
  email: string | null;
  enabled: boolean;
  deleted_at: null;
}

export interface Trip {
  id: Uuid;
  account_id: Uuid;
  asset_id: Uuid;
  type: TripType;
  start_date: string;
  end_date: string | null;
  assignee_id: Uuid | null;
}

/**
 * The `contacts.assignee` value `GET /v5/assets/:id?include=contacts` actually returns, confirmed
 * from `normalizeContacts` (`backend-crud/app/modules/assets/v4/controller.js:2928-2969`): for
 * each `asset_contact_association`, it builds `contacts[association.type] = { ...fields }` from
 * the joined `contact` row, setting `id` only `if (contact)` (line ~2960, `if (contact)
 * contact_struct.id = contact.id;`). So `assignee` is:
 *   - ABSENT (no `assignee` key at all) when the asset has no assignee association row.
 *   - an OBJECT WITH NO `id` PROPERTY when an assignee association row exists but its joined
 *     `contact` is falsy (e.g. the contact record failed to join) — `contact_struct` stays `{}`.
 *   - an object with `id` (plus whichever of `first_name`/`last_name`/`email`/`address`/`phones`/
 *     `tags`/`type`/`organization_id` the contact happens to have) when a live contact is joined.
 * It is never the literal value `null` — `normalizeContacts` never assigns `null` to `assignee`.
 */
export interface AssetAssigneeContact {
  id?: Uuid;
  first_name?: string;
  last_name?: string;
  email?: string;
  type?: string;
  organization_id?: Uuid;
}

export interface Asset {
  id: Uuid;
  account_id: Uuid;
  name: string;
  fleet?: string;
  /** Present when the asset is read with the contacts include. See `AssetAssigneeContact`. */
  contacts?: { assignee?: AssetAssigneeContact } | null;
  /** Present when the asset is read with the tracker include. Null when nothing is installed. */
  tracker?: AssetTracker | null;
}

/**
 * The installed tracker as `include=tracker` returns it on `POST /v5/assets/search` and
 * `GET /v5/assets/:id`. Observed live on dv3 2026-09-28, which also confirmed that
 * `tracker_asset_association_id` is on it, so the install can be read without a second lookup.
 */
export interface AssetTracker {
  id: Uuid;
  type: string;
  serial_number: string;
  secondary_tracker_serial_number: string | null;
  tracker_asset_association_id: Uuid;
}

export interface Tracker {
  id: Uuid;
  type: string;
  make: string;
  model: string | null;
  serial_number: string;
  secondary_tracker_serial_number: string | null;
  secondary_tracker_data: { device_id?: string } | null;
}

/**
 * A row of `rosco_driver_events`, as the design doc specifies it.
 *
 * Neither the table nor `POST /api/v5/rosco-driver-events/search` exists yet. Both the SQL
 * reader and the API reader normalise onto this shape so scenarios never branch on the source.
 */
export interface DriverEventRow {
  id: Uuid;
  account_id: Uuid;
  asset_id: Uuid;
  tracker_id: Uuid;
  event_id: string;
  type: DriverEventType;
  contact_id: Uuid | null;
  driver_guid: string | null;
  trip_id: Uuid | null;
  is_assignee_source: boolean | null;
  /**
   * Whether the resolved contact was live when the row was written. The design makes this a
   * first-class column precisely because the award step's eligibility predicate reads it, and
   * says explicitly that nothing in `flags` decides anything. Assert the contact-status guard
   * through this, never through a flag.
   */
  contact_active: boolean | null;
  trip_driver_set_at: string | null;
  timestamp: string;
  received_at: string;
  data: Record<string, unknown> | null;
  flags: DriverEventFlags | null;
}

/**
 * Support and troubleshooting only, per the design doc. Absent and false mean the same thing, so
 * assertions must treat `undefined` as `false`, which also means asserting a flag `false` can
 * never fail on its own. Pair every `false` with at least one `true` on the same row set.
 *
 * These three keys are the whole domain (design doc, rosco_driver_events flags column). There is
 * deliberately no `contact_inactive`: contact status is asserted through `contact_active`.
 */
export interface DriverEventFlags {
  arrived_before_trip_created?: boolean;
  arrived_after_trip_ended?: boolean;
  resulted_in_assignee_change?: boolean;
}

export interface ThresholdEvent {
  id: Uuid;
  trip_id: Uuid | null;
  contact_id: Uuid | null;
  transferred_by_id: Uuid | null;
  received_at: string;
}

/** The Rosco webhook payload for a driver event, as it arrives at `POST /rosco`. */
export interface RoscoDriverWebhookPayload {
  vehicle_id: string;
  name: DriverEventType;
  timestamp: string;
  /** Strings, as Rosco sends them. `POST /v5/rosco-driver-events/publish` rejects numbers. */
  location: { lat: string; lon: string };
  /** Absent on unDrv. */
  driver_guid?: string;
  driver_fn?: string;
  driver_ln?: string;
  driver_name?: string;
}

/** Everything the provisioning step hands to the scenarios. */
export interface RunContext {
  runId: string;
  accountId: Uuid;
  assetId: Uuid;
  trackerId: Uuid;
  /** GMS serial, the `esn` for automation-tracker frames. */
  gmsSerial: string;
  /** Rosco camera device id, the `vehicle_id` on every driver event. */
  vehicleId: string;
  contacts: Record<DriverKey, Contact>;
}
