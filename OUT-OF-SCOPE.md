# Out of scope

## O1 — Real hardware, both event types, end to end

The suite runs O1 simulated (`O1` in `src/scenarios/live.ts`): the normal happy path with both event types, driven by a fixture TennaCAM and emulated Rosco payloads. The run summary prints that caveat next to its result. What stays out of scope is the real-hardware version below.

Needs a TennaCAM 2.0 installed on a drivable test vehicle, producing genuine Type 6 and Type 7 events from an actual camera and an actual Rosco recognition pass. Every other case in this suite emulates the webhook; O1 exists specifically to prove the emulation matches reality, so it cannot itself be emulated without defeating its own purpose.

Manual proof required: drive the vehicle, capture the Rosco session per the design doc's "Test tools" section, confirm through `GET /api/v1.0/companies/:id/events` that Rosco actually sent Type 6/7, and confirm through this suite's own SQL probes (`PLAN/05-VERIFICATION.md`) that the row landed and behaved as O2 through O17 already assert programmatically for the emulated path. Sign off by pasting the resulting `rosco_driver_events` row and the trip/asset assignee state into the ticket.

## Registration (R) and audit (A) cases

Out of scope for this entire project, not only for this module, per the top-level scope decision in `AGENT-BRIEF.md` and this suite's own plan. R1 through R20 and A1 through A18 are not tracked in `TRACEABILITY.md` at all.

## O26, O27, O28

Ingestion-level cases: a redelivered webhook racing the recorder (O26), key type isolation in the S3 raw folder (O27), and the S3 check being unavailable (O28). Each needs control this suite doesn't have from outside the cluster (the recorder's timing, seeding S3, or an S3 outage), so none has a scenario (`TRACEABILITY.md`). If a follow-up picks them up, they belong in new `src/scenarios/` files, not folded into the existing ones, to keep one O-case family per file.

## O20 — The live assignee publish is lost

Not automated. The design doc's own case: identify A while the trip is open, raise a violation afterward, end the trip; the claim is that trip-end reassignment lands on A regardless of whether the live `ros.{hash}.driver-trip-assignee` publish succeeded. A lost publish cannot be forced from outside the cluster, so any automated proof here would have to observe the same end state O2 already produces when nothing is lost — it cannot distinguish "the publish succeeded and nothing needed correcting" from "the publish was lost and the correction saved it." The design's own audit surface for this is `facial_recognition_trip_assignee_write_total{result="no_state"}`, a Prometheus counter the team already reacts to; the audit is the control, and there is nothing left for an automated test in this suite to prove. `src/scenarios/resilience.ts` and `tests/o-resilience.spec.ts`, which previously covered the observable outcome as a proxy, are deleted (AGENT-BRIEF revision 2, item 6).

Manual proof required, if this is ever needed for a specific incident rather than as standing coverage: query the counter in Grafana for the `rosco-operations` dashboard's time window, filtered to `result="no_state"`, and cross-reference against the asset/trip in question using the SQL probes in `PLAN/05-VERIFICATION.md`.

## O12e's non-`normal` trip type

Covered as a scenario (`O12e` in `src/scenarios/tripLookup.ts`), but flagged: no `Step` kind can force the telemetry emitter to produce a heartbeat or virtual trip. If module C's emitter cannot select trip type on demand, this case's fixture becomes manual: create a heartbeat/virtual trip directly through whatever internal tooling produces one (not through this suite's own `POST /v5/automation-tracker` frames), then run the identification against it and confirm through the SQL probes that it was skipped by the lookup's type filter.

## O24's adjacent-publish ordering

Covered as a best-effort proxy (`O24` in `src/scenarios/phase2.ts`), which asserts the outcome (degrades to O23) without forcing the specific adjacent-publish ordering the case describes. If that ordering needs to be proven directly rather than inferred from the outcome, it requires publishing `asset.#.#.trip-started` out of band immediately before a real `trip-ended` message, which is outside anything this suite's webhook/telemetry emitters do. Manual or a dedicated integration test against `hapi-plugin-gms-event-interrogator` directly, not this suite.
