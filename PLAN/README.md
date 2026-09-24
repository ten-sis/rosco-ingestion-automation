# PLAN index

- `AGENT-BRIEF.md` — the shared context every build module (A through E) was given. Read first, not maintained by module E.
- `00-CONTEXT.md` — the feature, the pipeline, what exists today, what is blocked.
- `01-ARCHITECTURE.md` — module map, the two-clock model, `ScenarioContext`, why `workers: 1`.
- `02-BUILD-STEPS.md` — the ordered build steps with an acceptance check each, and how to tell a red suite from a broken one.
- `03-TEST-CASES.md` — one section per O-case: preconditions, timeline, expected end state, negative control, what must ship first.
- `04-API-REFERENCE.md` — every endpoint this suite calls: method, path, auth, body shape, file:line citation.
- `05-VERIFICATION.md` — how to assert without `POST /api/v5/rosco-driver-events/search`, the SQL probes, the tunnel setup.
- `06-BLOCKERS.md` — one row per blocker: what is blocked, which cases, what must ship, who owns it.
- `../TRACEABILITY.md` — O-case to spec file to scenario id to status.
- `../OUT-OF-SCOPE.md` — O1 and anything else deliberately not automated, with the manual proof required.
- `../README.md` — prerequisites (three port-forwards), setup, fleets, fixtures and the `tools/play.ts` play utility, run commands, the guardrail that this suite never points at production.

## Reading order for a cold start

1. `AGENT-BRIEF.md`, in full.
2. `00-CONTEXT.md`.
3. `01-ARCHITECTURE.md`.
4. `02-BUILD-STEPS.md`, then build in that order.
5. `03-TEST-CASES.md` and `04-API-REFERENCE.md` side by side while writing the emitters, readers and clients.
6. `05-VERIFICATION.md` before writing the first assertion.
7. `06-BLOCKERS.md` and `../TRACEABILITY.md` before declaring any case done.

## Status at the time this pack was written (revision 2)

- Modules A and B (foundation, resource clients) have landed `src/env.ts`, `src/constants.ts` and `src/api/*`, already fleet-aware (`suiteAssetId(fleet)`, `suiteAccountId(fleet)`) and auth-free. Module C (`src/emit/*`, `src/read/*`) and the `tools/play.ts` fixture player have not landed yet.
- Module D's `src/fixtures/test.ts` exports `defineScenarioTests(scenarios, fleet)`, matching every spec file this module (E) owns. `src/api/licences.ts#setAccountLicence` and `src/fixtures/provision.ts#preflight` still implement the pre-revision "manual CS step / report only" behaviour for the facial-recognition licence, which AGENT-BRIEF revision 2, item 8, now calls resolved ("enabled by the preflight spec through the API"); this pack's docs describe the resolved target state, and modules B/D still need to update those two functions to match. `src/api/thresholdEvents.ts` now calls `hapi-server-scorecards` (`SCORECARDS_BASE_URL`, its own port-forward), not backend-crud, per the coordinator's correction to this pack.
- Module E (this pack, `src/scenarios/*.ts`, `tests/**`, and everything under `PLAN/`) is complete against the `Scenario`/`Fixture` contracts in `../src/scenario/types.ts`, `../src/fixture/types.ts` and `../src/types.ts`, none of which module E edited. `src/scenarios/fixturePlayback.ts` compiles the three fixture-driven cases (O2, O3.1, O3.3) into the `Step[]` timeline the frozen runner expects; see `01-ARCHITECTURE.md`'s "Fixture-driven scenarios" section for why that lives here rather than in the runner itself.
