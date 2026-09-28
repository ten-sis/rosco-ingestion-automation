/**
 * The "Facial Recognition Operation cases" table from the design doc, verbatim, keyed by case id.
 * Generated from https://tenna.atlassian.net/wiki/spaces/SE/pages/3662708761 on 2026-09-28. The
 * run summary (`summaryReporter.ts`) prints these next to what each scenario asserts, so a reader
 * can see what the doc asks for without opening it. Regenerate when the doc's table changes.
 */

export interface DesignDocCase {
  case: string;
  expected: string;
  priority: string;
}

export const DESIGN_DOC_OPERATION_CASES: Readonly<Record<string, DesignDocCase>> = {
  "O1": {
    case: "Real hardware, both event types, end to end",
    expected: "Both resolve, persist and behave as designed",
    priority: "P0",
  },
  "O2": {
    case: "Identification during an open trip, nothing delayed",
    expected: "Both writes fire immediately. Scorecard trip assignee is changed in cache. At trip end the consumer finds both already set and has nothing to reassign",
    priority: "P0",
  },
  "O3.1": {
    case: "Delayed trip, identified driver is different than driver at the beginning of trip",
    expected: "At the end of the trip asset/trip/violations assignee changed",
    priority: "P0",
  },
  "O3.2": {
    case: "Delayed trip but the identified driver is the same as at the beginning of trip",
    expected: "No asset/trip/violation assignee changes",
    priority: "",
  },
  "O3.3": {
    case: "Delayed identification, identified driver is different than driver at the beginning of trip",
    expected: "If first identification within trip - asset/trip assignees are changed. Scorecard backfill job re-assigns violations assignee on next 5minute or 2hour cron run whichever comes first.",
    priority: "",
  },
  "O3.4": {
    case: "Delayed identification, identified driver is the same as driver at the beginning of trip",
    expected: "Assignee is not changed",
    priority: "",
  },
  "O3.5": {
    case: "2nd delayed identification within the same trip, different driver",
    expected: "Assignee is not changed",
    priority: "",
  },
  "O4": {
    case: "Nothing is delayed. 2nd identification in one trip",
    expected: "Only first identification changes the assignees. The second persists audit-only",
    priority: "P0",
  },
  "O5": {
    case: "Identification with no covering trip",
    expected: "No assignee changed for identification without trip. Monitor the diff between identification and the next trip start. it would be necessary to decide if we need to implement trip start handler.",
    priority: "P0",
  },
  "O6": {
    case: "Late identification for a superseded trip",
    expected: "No asset write. The trip write and any reassignment for that earlier trip still happen",
    priority: "P0",
  },
  "O7.1": {
    case: "Manual correction survives later automated runs",
    expected: "Begin a trip, set a different assignee on the asset by hand. End trip. Late arrived identification for trip has older timestamp than manual change. asset assignee doesn’t change. trip assignee is changed regardless. violations should be re-assigned by the scorecard backfill cron job later.",
    priority: "P0",
  },
  "O7.2": {
    case: "Manual correction doesn’t survive later automated runs that has newer timestamp",
    expected: "Begin a trip, set a different assignee on the asset by hand. End trip. Late arrived identification for trip has more recent timestamp than manual change. asset assignee shoudl change. trip assignee is changed regardless. violations should be re-assigned by the scorecard backfill cron job later.",
    priority: "",
  },
  "O8": {
    case: "Driver identification for  deactivated Contact",
    expected: "No asset write, no trip write, no reassignment",
    priority: "P0",
  },
  "O9": {
    case: "Insert-time race on the claim. driver identification and trip end fired in at the same time. Run several times.",
    expected: "Eventual outcome regardless of which events is processed first: - asset assignee changed - trip assignee changed - violations assignee changed either by trip end or by scorecard backfill",
    priority: "P1",
  },
  "O12": {
    case: "All six trip-lookup outcomes",
    expected: "Each produces the covering-guard result in the table above, and the heartbeat and virtual fixtures are skipped by the type filter",
    priority: "P0",
  },
  "O13": {
    case: "Later arrived identification excludes manually reassigned violations",
    expected: "Events before the winner's receipt time with a different assignee are transferred. Already-transferred events are excluded",
    priority: "P0",
  },
  "O14": {
    case: "An identification timestamped before its trip started",
    expected: "inserted, but no assignee change across the board. Monitor clock drift, if there is considerable amount of under one minute early fires - consider artificially widening the trip overlap window with identification events",
    priority: "P0",
  },
  "O15": {
    case: "Type 6 followed by Type 7 in the same trip",
    expected: "The identified event wins and becomes the assignee source. The unidentified row persists and is ignored",
    priority: "P0",
  },
  "O16": {
    case: "A redelivered webhook, identical payload",
    expected: "The branch finds the object already in S3 and publishes nothing, so neither consumer runs a second time. The unique index on the generated id is the backstop behind that, not the first line of defence, and is what the S3-outage case falls back on",
    priority: "P0",
  },
  "O17": {
    case: "A multi-day trip with a second driver identified on day two",
    expected: "The assignee does not change. The second identification persists and is ignored",
    priority: "P1",
  },
  "O18": {
    case: "License revoked mid-flight",
    expected: "All three consumers stop acting on new messages. Webhook traffic continues to arrive, which is the accepted behaviour",
    priority: "P1",
  },
  "O19": {
    case: "TrackIt exclusivity",
    expected: "On an account holding both, TrackIt exits early and this feature's writes stand",
    priority: "P1",
  },
  "O20": {
    case: "The assignee publish is lost",
    expected: "The trip stays stale until trip-end reassignment corrects it, and no error surfaces to the identification path. Audit should catch it.",
    priority: "P2",
  },
  "O21": {
    case: "~~An asset's very first trip, with no previous trip to floor the window ~~Not applicable for initial release, monitor the early starts before doing anything.",
    expected: "~~The pre-start tolerance is used and a pre-start identification is still linked ~~",
    priority: "P1",
  },
  "O22": {
    case: "An identification arrives before its trip exists, then that trip starts.Not applicable for initial release, monitor the early starts before doing anything.",
    expected: "The trip-start consumer links it and awards the claim if unclaimed, and both writes fire at trip start rather than waiting for trip end",
    priority: "P0",
  },
  "O23": {
    case: "The trip-start and trip-end passes both run against the same linked row",
    expected: "Trip end finds the claim already decided and both writes already in place, and performs neither again",
    priority: "P0",
  },
  "O24": {
    case: "A trip-started message published inside the trip-end path, immediately before trip-ended",
    expected: "The trip-start consumer must not assume the trip is open. The recency and trip-driver guards produce the same outcome as a trip-end-only run",
    priority: "P1",
  },
  "O26": {
    case: "A redelivered webhook sent before the recorder has written the object",
    expected: "Both deliveries publish, and the second collapses onto the original row by the generated id with no duplicate and no second assignee write. This is the race the unique index exists for",
    priority: "",
  },
  "O27": {
    case: "Key type isolation",
    expected: "Seed the raw folder with `ros.<hash>` for a hash equal to the one an identification will generate, then send that identification. It must still be published and stored, under `rosdrv.<hash>`. This is the collision that would otherwise drop an identification with no trace",
    priority: "",
  },
  "O28": {
    case: "S3 check unavailable",
    expected: "The check throws, is read as not found, and the identification is published rather than lost. The duplicate it may cause is absorbed at the upsert",
    priority: "",
  },
};

/** The doc row for a scenario id. `O12a` to `O12f` all map to the doc's single `O12` row. */
export function designDocCaseFor(scenarioId: string): DesignDocCase | undefined {
  return DESIGN_DOC_OPERATION_CASES[scenarioId] ?? DESIGN_DOC_OPERATION_CASES[scenarioId.replace(/[a-z]$/, '')];
}
