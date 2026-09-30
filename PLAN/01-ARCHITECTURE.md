# Architecture

## Module map

| Module | Files | Depends on |
|---|---|---|
| A. Foundation | `src/env.ts`, `src/environments.ts`, `src/auth/cognito.ts`, `src/auth/impersonate.ts`, `src/api/client.ts`, `src/constants.ts` | types |
| B. Resource clients | `src/api/{assets,trackers,contacts,trips,thresholdEvents,roscoEvents,digestion,licences}.ts` | A, types |
| C. Emitters and readers | `src/emit/{webhook,becrud,telemetry,index}.ts`, `src/read/driverEvents.ts`, `src/db/pool.ts`, `src/hash.ts` | A, B, types |
| D. Runner and fixtures | `src/scenario/{runner,waits,timeouts}.ts`, `src/fixtures/{provision,manifest,test}.ts` | A-C, scenario/types |
| E. Scenarios and docs (this module) | `tests/**`, `src/scenarios/*.ts`, `PLAN/*.md`, `TRACEABILITY.md`, `OUT-OF-SCOPE.md`, `README.md` | all |

Module E never imports from `src/api/*`, `src/emit/*` or `src/db/*` directly. It only imports `Scenario`/`Step` and their constituent types from `src/scenario/types.ts` and `src/types.ts`, `Fixture` and its constituent types from `src/fixture/types.ts`, and it imports `defineScenarioTests` from `src/fixtures/test` in each spec file. Everything module E produces is data plus documentation; the only executable logic beyond that is the tiny per-spec-file glue and `src/scenarios/fixturePlayback.ts` (see "Fixture-driven scenarios" below), which compiles a fixture's own declared trip and identifications into the `Step[]` the frozen runner walks — it is a compile step over data this module owns, not new business logic.

## The two-clock model

Every scenario step carries `atSec`, an offset in seconds from the run's anchor T0. This is logical time: it becomes the `timestamp` stamped into the GMS frame or the Rosco payload, and it is what the pipeline's own guards reason about (trip windows, the pre-start tolerance, the previous-trip floor).

Separately, a step's position in the `timeline` array is delivery time: steps are sent in array order, regardless of their `atSec`. This is what the runner (module D) actually controls in real time, optionally paced further by `sendAfterMs`.

The two clocks are independent by design, and collapsing six of the design doc's cases into rows of one table depends on keeping them that way:

- A delayed identification is an `ident` step with a small `atSec` (an early logical time) placed late in the array (a late delivery). Example: O3.3, O6.
- A delayed trip is `ignitionOn`/`ignitionOff` steps with small `atSec` values placed after the `ident` that belongs to them. Example: O3.1, O12f.
- The asset-write guard compares the standing assignment's `created_at` with the identification's own `timestamp`, not with `received_at` (`AssigneeWriter.writeAssetAssignee` in hapi-server-rosco-ingestion-rmq, checked 2026-09-28). So O7.1/O7.2 turn on `atSec` relative to the real time of the manual change. Because precondition and manual writes happen in real time, T0 is anchored just after each scenario's preconditions and no event is sent before its own timestamp (`anchorTimeline` in `src/scenario/runner.ts`).

## `ScenarioContext`

Owned by module D, passed into `runScenario(scenario, sc)`. Module E does not define its shape and imports nothing from it directly. What module E assumes, because the `Scenario` type and the per-case specs in `03-TEST-CASES.md` require it, is that `ScenarioContext` (or whatever `defineScenarioTests` builds internally per test) provides at minimum: the `RunContext` from `src/types.ts` (asset, tracker, contacts A-D), a way to send each `Step` kind against the right emitter, a `DriverEventsReader`, and a way to evaluate an `Expectation` including the `'unchanged'` comparison described below. If `ScenarioContext`'s real shape differs, only `src/fixtures/test.ts` and `src/scenario/runner.ts` need to change; no scenario file in this module references it.

### `defineScenarioTests`, fleet-aware

AGENT-BRIEF revision 2, item 5, requires one asset per spec file, provisioned once per fleet and reused by every scenario in that file. Every spec file this module owns now declares its fleet name and calls `defineScenarioTests(scenarios, fleet)` — e.g. `defineScenarioTests(LIVE_SCENARIOS, 'fr-live')` — the signature module D settled on, matching `src/env.ts`'s already-landed `suiteAssetId(fleet)` / `suiteAccountId(fleet)`.

## Fixture-driven scenarios

Where a fixture file exists under `fixtures/` with the same case id (O2, O3.1, O3.3, per AGENT-BRIEF revision 2, item 7), that scenario's `timeline` is compiled from the fixture via `src/scenarios/fixturePlayback.ts#expandFixtureToSteps`, not hand-authored. The fixture stays the single source of truth for the trip's shape and the identifications; the scenario file adds only the `settle` waits the fixture format has no field for (it describes a trip, not a wait-for-pipeline-state instruction) and the `expectAfterStep`/`expect` assertions, using `lastIndexWhere`/`insertAfterIndex` to locate and splice those waits in rather than hand-counting array positions.

This is a workaround, not the intended end state: `scenario/types.ts` (frozen to this module) still declares `Scenario.timeline` as a required `Step[]` with no field naming a fixture at all, so there is no way to hand the frozen runner a fixture directly. The cleaner fix — an optional `fixtureId` on `Scenario`, with `runner.ts` compiling it itself the same way `tools/play.ts` does — belongs to `scenario/types.ts` and `scenario/runner.ts`, neither of which this module may edit. `fixturePlayback.ts` produces the identical practical result (a `Step[]` faithful to the fixture) without touching either.

## The `'unchanged'` comparison, precisely

`AssigneeExpectation`'s `'unchanged'` value is the suite's negative control. Its actual semantics, confirmed against module D's implementation (`src/scenario/context.ts#captureUnchangedSnapshots`, `runner.ts#runOneExecution`, `waits.ts#resolveAssigneeValue`) once it landed: `'unchanged'` resolves to a snapshot of that field's real value, taken once, after `Precondition`s are applied but before the timeline's first step runs. It does **not** chain forward through `expectAfterStep` checkpoints; every `'unchanged'` anywhere in a scenario (`expect` or any `expectAfterStep`) always compares against that same single pre-timeline value for the whole scenario execution. A `TripRef` that does not resolve to an existing trip at snapshot time (the common case — most scenarios create their trip after step 1) is recorded with a `null` baseline.

Concretely, this means: to prove a value stayed at the state a real write produced (the more demanding and more useful negative control, e.g. "trip end did not move what the live path already set"), a scenario must repeat the literal value (`{ value: 'A' }`) at both the establishing checkpoint and the later assertion — `'unchanged'` cannot express that, because the pre-timeline baseline is `null`/precondition, not the intermediate value. `'unchanged'` is reserved for genuinely proving either (a) the fixture started clean, immediately after the first step or two and before anything has had a chance to write, or (b) a true no-op case (O3.2, O3.4, O8, O12c/d/e, O14, O19...) where the field's value at the end of the scenario really does equal its value before the timeline started, including cases carrying a non-null `Precondition` (O3.2's/O3.4's asset assignee, O3.3's/O3.5's/O7.1's B/C precondition). Every scenario in this module carries at least one instance of usage (a), positioned as early in the timeline as the first meaningful checkpoint allows, specifically so the mandatory negative control requirement in `AGENT-BRIEF.md`/`scenario/types.ts` is met by a `'unchanged'` value that is actually true rather than one that happens to look right.

An earlier draft of this module used the chaining interpretation described above, before module D's runner existed to check it against. That was wrong and has been corrected everywhere in `src/scenarios/*.ts`; see the git history of this pack if the earlier reasoning is useful context for a similar contract question elsewhere.

## Why one asset per spec file, not one per worker or one for the whole suite

Several cases need two sequential trips on the same asset (O6, O9, O12f, O3.1) and the trip-recency guard is asset-scoped: a second normal trip's mere existence changes the outcome of a write guard evaluated against the first. Sharing one asset across every scenario in the whole suite (the pre-revision model) would force `workers: 1` for the entire run, serializing 30 scenarios' worth of `LIVE_BUDGET_MS`/`TRIP_END_BUDGET_MS`/`BACKFILL_BUDGET_MS` waits into one lane. AGENT-BRIEF revision 2, item 5, instead scopes one asset per **spec file** (one per fleet: `fr-live`, `fr-trip-lookup`, `fr-delayed`, `fr-guards`, `fr-race`, `fr-licence`, `fr-trip-start`, `fr-first-trip`), provisioned once and reused by every scenario in that file. `playwright.config.ts` (not owned by this module, already updated) reflects this: `fullyParallel: false` plus `workers > 1` means files run concurrently across fleets while scenarios inside one file stay serial, which keeps every scenario's asset and trip history exactly what that scenario's own timeline put there, the same guarantee the old single-asset model gave, at the granularity that actually needs it. `O9`'s `repeat: 5` is a within-scenario loop, not a source of parallelism, for the same reason. Scenarios were grouped into these seven files, not one file per O-case, specifically to keep the number of provisioned assets and trackers small.

## Tags

`@live` marks a scenario whose identification lands while its trip is genuinely open. `@slow` marks a scenario whose final assertion has to wait past the scorecard backfill cron's five-minute run (`BACKFILL_BUDGET_MS`), which this module applied not only to the one case the plan text called out explicitly (O3.3) but consistently to every case that relies on the same cron mechanism (O3.4, O6, O7.1, O7.2, O13); see `06-BLOCKERS.md`. `@race` marks O9 only. O14 no longer carries a tag of its own: the previous `@contested` tag is gone now that `06-BLOCKERS.md` records its resolution as a decision rather than an open question.
