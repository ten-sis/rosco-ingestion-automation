# Build steps

Ordered so that every step is checkable on its own before the next one starts. Steps 0 to 3 belong to modules A through D; they are listed here because module E's own specs (`tests/setup/provision.spec.ts` and the eight `o-*.spec.ts` files) depend on them existing, and because the acceptance checks below are what let a fresh session tell whether module E's own output is correct once those land.

## 0. Unblock, 0.25 d (operator, not code)

Bring up the three required port-forwards: `kubectl port-forward -n be-crud svc/be-crud-v5 3000:80`, `kubectl port-forward -n integration svc/webhooks-api 8081:80`, and `kubectl port-forward -n snc svc/scorecard-v2-api 3001:80` (the last one is `hapi-server-scorecards`, where the threshold-event routes actually live, not backend-crud). The DB tunnel is a fourth, optional forward, needed only for the SQL driver-events reader. Confirm a hand-rolled `POST /rosco` reaches RabbitMQ.

Acceptance: a manual curl to `localhost:8081/rosco` returns 200. Not part of any automated spec; this suite must never assume the tunnels are already up and must fail with an actionable message when they are not (see `05-VERIFICATION.md`).

## 1. Confirm the intra-service path, 0.25 d (module A)

There is no login (AGENT-BRIEF revision 2, item 1). Confirm a request to `http://localhost:3000/api/v5/assets/:id` with a `requestor` header, an `account_id`, and no `Authorization` header at all lands on backend-crud's intra-service branch and returns the asset, not a 401. This replaces what used to be a Cognito SRP spike.

Acceptance: a script outside the test suite can read an asset with no credentials beyond the `requestor` header.

## 2. Client and fixtures, 1.5 d (modules A, B, D)

`api/*`, `auth/*`, `fixtures/provision.ts`, `tests/setup/provision.spec.ts`.

Acceptance: `tests/setup/provision.spec.ts` (module E's file, already written) passes against a real environment. This is the one spec expected to go green before the feature ships, because provisioning only touches endpoints that already exist. If it fails, the harness is broken, not the feature.

## 3. Emitters, 1 d (module C)

`emit/telemetry.ts` proven by a trip that appears in `GET /v5/trips`. `emit/webhook.ts` proven by the raw event appearing in `POST /v5/rosco-events/search`.

Acceptance: both proofs above, run manually or via a throwaway script, before any `o-*.spec.ts` is trusted to mean anything.

## 4. Readers and runner, 1 d (module D)

`read/driverEvents.ts`, `scenario/runner.ts`. First target: `o-live.spec.ts`'s O2, because it is the simplest case that exercises the full write path.

Acceptance: O2 fails with a specific, attributable reason (a 404 from a not-yet-built `rosco-driver-events` table read, or a timeout against `LIVE_BUDGET_MS`), not a generic runner crash. A crash here means the runner is broken; a clean timeout or a clean "no such table" means the feature genuinely is not built yet, which is correct at this point.

## 5. The rest of the matrix (module E, already delivered as data)

`src/scenarios/*.ts` and the remaining seven `o-*.spec.ts` files are rows once the runner from step 4 works. No further runner changes should be needed to make any of them executable, only for them to start passing as the backend ships. If a scenario in this module cannot be expressed against the runner's actual `ScenarioContext` shape, that is a module D contract gap, not a reason to add logic to a spec file (spec files stay three lines).

Acceptance: `npx playwright test --list` enumerates every scenario in `TRACEABILITY.md` with a `covered` status, and `npx tsc --noEmit` is clean for every file this module owns.

## 6. Docs (module E, already delivered)

This pack, `TRACEABILITY.md`, `OUT-OF-SCOPE.md`, and the root `README.md`.

Acceptance: a Sonnet session with no other context can read `PLAN/README.md` and correctly rebuild the project's intent without opening the design doc.

## How to tell a red suite apart from a broken suite

While the feature is unimplemented, everything from step 4 onward is expected to be red. A suite that cannot tell "red because the feature is absent" apart from "red because the harness or the test itself is wrong" is worse than no suite, because every real regression hides in the same noise as every expected failure.

Three checks, in order, whenever a scenario fails:

1. **Did `tests/setup/provision.spec.ts` pass in this run?** If not, stop. The harness, not the feature, is broken: a missing or wrongly-bound port-forward (see `README.md`'s prerequisites — the be-crud forward must bind local port 3000 exactly), or Digestion never resolving the secondary tracker (`AGENT-BRIEF.md` item 2, the single most common cause of a test that passes while doing nothing). The facial-recognition licence is no longer a manual step to check here: preflight enables it through the API.
2. **Did the raw event land?** `POST /v5/rosco-events/search` (or the SQL equivalent) separates an ingestion failure (the webhook never reached RabbitMQ, or Digestion dropped it) from a consumer failure (the row landed but nothing downstream acted on it). These have different owners and different fixes.
3. **Did the negative control fail, or only the positive assertion?** Every scenario in this module carries at least one `'unchanged'` (or `noTransfers: true`, or an `expectAfterStep` checkpoint) assertion. If the positive assertion (say, `assetAssignee: { value: 'A' }`) fails while the negative control passes, that is consistent with "the feature is not built yet" (nothing changed at all). If the negative control itself fails, meaning something changed that should not have, that is a real defect regardless of whether the rest of the feature exists, and it must be triaged as a bug, not filed alongside the expected red.

`03-TEST-CASES.md`'s "what must ship" column and `06-BLOCKERS.md` exist so this triage does not require re-deriving the dependency graph from the design doc every time a test goes red.
