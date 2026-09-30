# Design doc operation cases vs this suite

Checked 2026-09-28 against the "Facial Recognition Operation cases" table in [Rosco Facial Recognition - Design doc](https://tenna.atlassian.net/wiki/spaces/SE/pages/3662708761/Rosco+Facial+Recognition+-+Design+doc#Facial-Recognition-Operation-cases).

## Short answer

The feature is deployed on dv3, so a run exercises the real pipeline. 25 of the doc's 30 rows run by default (O1 simulated), with the caveats below. O21 is opt-in, and the other 4 are manual or not covered at all.

A run does not validate them yet, because of a harness timing bug (found 2026-09-28). The runner backdates every event timestamp (`computeT0` in `src/scenario/runner.ts`), but sets each scenario's assignee precondition at real wall-clock time. The consumer skips the asset write whenever the standing assignment is newer than the identification's timestamp (`AssigneeWriter.writeAssetAssignee` in `hapi-server-rosco-ingestion-rmq`), which is the doc's own O7 rule. So every scenario with an assignee precondition sees the asset write skipped, correctly. Until that's fixed, a failing asset-assignee assertion says nothing about the feature.

## Case by case

| Doc case | Suite | Validated by a run? | Notes |
|---|---|---|---|
| O1 Real hardware | `O1` | Simulated | The normal happy path with both event types, from a fixture TennaCAM and emulated Rosco payloads. The real-hardware check stays manual (`OUT-OF-SCOPE.md`). |
| O2 Live identification | `O2` | Yes | |
| O3.1 Delayed trip, different driver | `O3.1` | Yes | |
| O3.2 Delayed trip, same driver | `O3.2` | Yes | |
| O3.3 Delayed identification, different driver | `O3.3` | Partly | The doc allows the backfill cron's 5-minute or 2-hour run. The suite waits 6 minutes (`BACKFILL_BUDGET_MS`), so it only passes if the 5-minute run picks the violations up. |
| O3.4 Delayed identification, same driver | `O3.4` | Yes | |
| O3.5 Second delayed identification | `O3.5` | Yes | |
| O4 Second identification, one trip | `O4` | Yes | |
| O5 No covering trip | `O5` | Partly | The "no assignee change" part is asserted. The doc's "monitor the diff to the next trip start" is an observation, not something a test can pass or fail. |
| O6 Late identification, superseded trip | `O6` | Yes | |
| O7.1 Manual correction survives | `O7.1` | Differs | The doc and the consumer both compare the identification's timestamp with the manual change (`assignment.created_at >= eventTimestamp`). The suite was built on receipt order instead. |
| O7.2 Manual correction overridden | `O7.2` | Differs | Same as O7.1. As built, the identification's timestamp (logical 180 s) is older than the manual change, so by the doc's rule the asset correctly stays C. |
| O8 Deactivated contact | `O8`, `O8b` | Yes | Both ways a contact can be deactivated: after its row is written (`O8`, blocked by the trip-end guard's live re-check) and before the identification arrives (`O8b`, row flagged `contact_is_active: false`). Each asserts the doc's three outcomes: no asset write, no trip write, no reassignment. |
| O9 Insert-time race | `O9` | Yes | Runs several times, as the doc asks, alternating which side is sent first. |
| O12 Six trip-lookup outcomes | `O12a` to `O12f` | Partly | `O12e` (heartbeat or virtual trip) depends on the telemetry emitter producing one, which it can't yet (`PLAN/06-BLOCKERS.md`). The other five are covered. O12c checks the covering guard at insert (not linked) and then trip end claiming the row for the following trip. |
| O13 Excludes reassigned violations | `O13` | Partly | The "already-transferred events are excluded" half is asserted. The "events before the winner's receipt time are transferred" half is only covered indirectly. |
| O14 Timestamped before trip start | `O14` | Differs | The doc's O14 row says no assignee change. Its trip-end section, and the consumer, recover the row at trip end (previous-trip floor), so the scenario asserts the recovery. Flagged to the doc owners in `PLAN/06-BLOCKERS.md`. |
| O15 Type 6 then Type 7 | `O15` | Yes | |
| O16 Redelivered webhook | `O16` | Indirectly | The doc's mechanism is the S3 object check publishing nothing. The suite can't see S3, so it asserts the outcome instead: one row and one assignee write. That passes whether the S3 check or the unique index did the work. |
| O17 Multi-day trip | `O17` | Yes | The day-two identification is stamped ahead of its send time on purpose (README). |
| O18 Licence revoked mid-flight | `O18` | Yes | Needs `ACCOUNT_ID_FR_LICENCE`, a separate account, and its `EXPECTED_ACCOUNT_NAME_FR_LICENCE`. On dv3 that is FrTest (`d72cd091-7e2d-4dcf-bbcf-79357e31c63d`). The FR licence is turned back on when the scenario ends. |
| O19 TrackIt exclusivity | `O19` | Yes | Same separate-account requirement as O18. The runner adds a placeholder `trackit` integration for the scenario and removes it after. Asserts trackit's `Skipping TrackIt assignee override` log line for the account, read with `kubectl logs`. |
| O20 Assignee publish lost | none | No | Manual. The audit is meant to catch it (`OUT-OF-SCOPE.md`). |
| O21 First trip on an asset | `O21` | Only with `ALLOW_FRESH_ASSETS=1` | Struck in the doc for the initial release, but the trip-end pre-start tolerance shipped. Creates a new asset every run, so it's `@fresh-asset`. |
| O22 Identification before trip exists | `O22` | Yes | The doc says phase 2 only, but the trip-start consumer shipped in the initial release. |
| O23 Trip-start and trip-end both run | `O23` | Yes | Same as O22. |
| O24 Trip-started inside trip-end path | `O24` | Partly | Same as O22. Outcome only, since the adjacent publish can't be forced directly (`PLAN/06-BLOCKERS.md`). |
| O26 Redelivery before recorder writes | none | No | Ingestion-level race. Not in this suite. |
| O27 Key type isolation | none | No | Needs seeding the S3 raw folder. Not in this suite. |
| O28 S3 check unavailable | none | No | Needs an S3 outage. Not in this suite. |

## Things that affect every run

* **Backdated timestamps vs real-time preconditions.** See the short answer. 28 scenarios set an assignee precondition.
* **dv3 spot capacity.** The private node group's spot instances are being reclaimed about once a minute (2026-09-28), which drops port-forwards and in-flight requests. `scripts/tunnels.sh` and the client retry absorb most of it, but a write dropped mid-request still fails its test.
* **Contact status.** There is no `contact_active` column. The readers derive it from `flags.contact_is_active` (checked 2026-09-28).
* **`TRACEABILITY.md`** was updated to this table on 2026-09-28. It had referred to doc cases O10, O11 and O25, which the doc no longer has.
