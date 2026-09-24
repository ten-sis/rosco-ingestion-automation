# Traceability

O-case to spec file to scenario id to status. Status values: `covered` (a scenario exists and the case is fully expressible), `blocked` (out of this module's assigned scope, or a real gap in what the `Scenario` type can express), `manual` (not automatable), `phase2` (built, tagged `@phase2`, excluded from the default run).

| O-case | Spec file | Scenario id(s) | Status | Note |
|---|---|---|---|---|
| O1 | — | — | manual | Real hardware end to end. See `OUT-OF-SCOPE.md` |
| O2 | `o-live.spec.ts` | `O2` | covered | |
| O3 | `o-delayed.spec.ts` | `O3.1`, `O3.2`, `O3.3`, `O3.4`, `O3.5` | covered | |
| O4 | `o-live.spec.ts` | `O4` | covered | |
| O5 | `o-trip-lookup.spec.ts` | `O5` | covered | The doc's own O5 also calls for a gap-timing measurement; not expressible, see `PLAN/06-BLOCKERS.md` |
| O6 | `o-trip-lookup.spec.ts` | `O6` | covered | |
| O7 | `o-guards.spec.ts` | `O7.1`, `O7.2` | covered | Differentiator encoded as delivery order, not event timestamp; see `PLAN/06-BLOCKERS.md` |
| O8 | `o-guards.spec.ts` | `O8` | covered | |
| O9 | `o-race.spec.ts` | `O9` | covered | By mechanism this is the design doc's O10 (trip-end award race); see `PLAN/06-BLOCKERS.md` |
| O10 | — | — | blocked | Not in this module's assigned case list. The design doc's own "insert-time race on the claim" (two concurrent identifications, no trip end) is uncovered |
| O11 | — | — | blocked | Not in this module's assigned case list. Cached-state write across all three fixtures is a `hapi-server-live-events`/`processor-scorecard` concern this module was not asked to cover |
| O12a | `o-trip-lookup.spec.ts` | `O12a` | covered | |
| O12b | `o-trip-lookup.spec.ts` | `O12b` | covered | |
| O12c | `o-trip-lookup.spec.ts` | `O12c` | covered | |
| O12d | `o-trip-lookup.spec.ts` | `O12d` | covered | |
| O12e | `o-trip-lookup.spec.ts` | `O12e` | covered | Depends on module C exposing a heartbeat/virtual trip fixture; see `PLAN/06-BLOCKERS.md` |
| O12f | `o-trip-lookup.spec.ts` | `O12f` | covered | |
| O13 | `o-guards.spec.ts` | `O13` | covered | Reassignment half of the assertion only indirectly covered; see `PLAN/06-BLOCKERS.md` |
| O14 | `o-trip-lookup.spec.ts` | `O14` | covered | Resolved: search window is floored at this trip's own start_date; see `PLAN/06-BLOCKERS.md` |
| O15 | `o-live.spec.ts` | `O15` | covered | |
| O16 | `o-live.spec.ts` | `O16` | covered | |
| O17 | `o-live.spec.ts` | `O17` | covered | |
| O18 | `o-licence.spec.ts` | `O18` | covered | |
| O19 | `o-licence.spec.ts` | `O19` | covered | |
| O20 | — | — | manual | Moved out of automated coverage: the audit detects a lost publish and the team reacts to it, nothing for a test to prove. See `OUT-OF-SCOPE.md` and `PLAN/06-BLOCKERS.md` |
| O21 | `o-phase2.spec.ts` | `O21` | phase2 | |
| O22 | `o-phase2.spec.ts` | `O22` | phase2 | |
| O23 | `o-phase2.spec.ts` | `O23` | phase2 | |
| O24 | `o-phase2.spec.ts` | `O24` | phase2 | Adjacent-publish ordering not directly forceable; see `PLAN/06-BLOCKERS.md` |
| O25 to O28 | — | — | blocked | Not in this module's assigned case list (ingestion-level S3 dedupe and key-isolation cases, plus the trip-start pre-start-window variant); out of scope for the operation-flow suite this project builds |

Scenario count per group: `live` 5, `tripLookup` 9, `delayed` 5, `guards` 4, `race` 1, `licence` 2, `phase2` 4. Total 30 scenarios across 23 distinct O-case labels with a `Scenario` object (several O-cases have multiple sub-scenarios: O3 x5, O12 x6, O7 x2). O20 is a 24th labelled row, tracked as `manual` with no `Scenario` object; O1 makes 25 labelled rows total, also `manual`.
