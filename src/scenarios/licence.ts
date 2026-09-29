/**
 * `o-licence.spec.ts` scenarios: O18, O19. Fleet `fr-licence`.
 *
 * Both cases have fixtures under `fixtures/` and are compiled from them via
 * `fixturePlayback.ts`'s `expandFixtureToSteps`. `setLicence` has no fixture-format equivalent, so
 * O18 splices it in around the compiled fixture steps. Both run on `ACCOUNT_ID_FR_LICENCE`, an
 * account no other fleet uses, since O18 turns the FR licence off and O19 adds a trackit
 * integration. The runner puts both back when each scenario ends (`restoreAccountState`).
 */

import type { Fixture } from '../fixture/types';
import type { Scenario, Step } from '../scenario/types';
import o18Fixture from '../../fixtures/O18-licence-revoked-mid-flight.json';
import o19Fixture from '../../fixtures/O19-trackit-exclusivity.json';
import { expandFixtureToSteps, insertAfterIndex, lastIndexWhere } from './fixturePlayback';

// ---------------------------------------------------------------------------
// O18 — compiled from fixtures/O18-licence-revoked-mid-flight.json
// ---------------------------------------------------------------------------

const o18Base = expandFixtureToSteps(o18Fixture as Fixture);
const o18IgnitionOnIndex = lastIndexWhere(o18Base, (s) => s.kind === 'ignitionOn');
const o18IdentAIndex = lastIndexWhere(o18Base, (s) => s.kind === 'ident' && s.driver === 'A');
const o18WithAssigneeSettle = insertAfterIndex(o18Base, o18IdentAIndex, {
  kind: 'settle',
  atSec: 61,
  until: 'assigneeWritten',
  budget: 'LIVE_BUDGET_MS',
});
const o18AssigneeSettleIndex = o18IdentAIndex + 1;
const o18Timeline: Step[] = insertAfterIndex(o18WithAssigneeSettle, o18AssigneeSettleIndex, {
  kind: 'setLicence',
  atSec: 62,
  licence: 'facialRecognition',
  enabled: false,
});

const O18: Scenario = {
  id: 'O18',
  title: 'Licence revoked mid-flight',
  priority: 'P1',
  tags: ['@live'],
  preconditions: { licences: { facialRecognition: true } },
  timeline: o18Timeline,
  expectAfterStep: [
    { afterIndex: o18IgnitionOnIndex, expect: { assetAssignee: { value: 'unchanged' } } },
    { afterIndex: o18AssigneeSettleIndex, expect: { assetAssignee: { value: 'A' }, trips: [{ tripRef: 'latest', assignee: 'A' }] } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    driverEventRowCount: 1,
    driverEvents: [{ driver: 'A', isAssigneeSource: true, count: 1 }],
  },
  rationale:
    "The doc: 'All three consumers stop acting on new messages. Webhook traffic continues to arrive, which is the accepted behaviour.' The identification consumer 'checks the license first and stops, logging only, if it is not active', before ever resolving the contact or persisting the row, so B's post-revocation identification is expected to leave no `rosco_driver_events` row at all: `driverEventRowCount: 1` asserts that directly rather than asserting B's row has some inert shape. Compiled from fixtures/O18-licence-revoked-mid-flight.json (A identified live and wins the claim; B identified later, at atSec 200) via fixturePlayback.ts; the `setLicence` revocation is spliced in right after A's `assigneeWritten` settle and before B's identification, since the fixture format has no field for it. The checkpoint right after ignition-on, before A's identification, is this scenario's required negative control (`'unchanged'` resolves against the pre-timeline snapshot); the identical literal 'A' repeated afterward is what shows B's post-revocation identification did not move it.",
};

// ---------------------------------------------------------------------------
// O19 — compiled from fixtures/O19-trackit-exclusivity.json
// ---------------------------------------------------------------------------

const o19Base = expandFixtureToSteps(o19Fixture as Fixture);
const o19IgnitionOnIndex = lastIndexWhere(o19Base, (s) => s.kind === 'ignitionOn');
const o19WithTripStarted = insertAfterIndex(o19Base, o19IgnitionOnIndex, {
  kind: 'settle',
  atSec: 1,
  until: 'tripStarted',
  budget: 'LIVE_BUDGET_MS',
});
const o19TripStartedIndex = o19IgnitionOnIndex + 1;
const o19IgnitionOffIndex = lastIndexWhere(o19WithTripStarted, (s) => s.kind === 'ignitionOff');
const o19Timeline: Step[] = insertAfterIndex(o19WithTripStarted, o19IgnitionOffIndex, {
  kind: 'settle',
  atSec: 181,
  until: 'tripEnded',
  budget: 'TRIP_END_BUDGET_MS',
});

const O19: Scenario = {
  id: 'O19',
  title: 'TrackIt exclusivity on an account with facial recognition and a TrackIt integration',
  priority: 'P1',
  tags: ['@live'],
  // TrackIt is an account integration, not a licence (`TRACKIT_PARTNER` in constants.ts). The
  // runner adds a placeholder one for the scenario and removes it afterward.
  preconditions: { licences: { facialRecognition: true }, integrations: { trackIt: true } },
  timeline: o19Timeline,
  expectAfterStep: [
    { afterIndex: o19TripStartedIndex, expect: { trips: [{ tripRef: 'latest', assignee: 'unchanged' }] } },
  ],
  expect: {
    assetAssignee: { value: 'A' },
    trips: [{ tripRef: 'latest', assignee: 'A' }],
    thresholdEvents: [{ tripRef: 'latest', allAssignedTo: 'A' }],
    // The direct proof that TrackIt stood down: its early exit logs this for an FR account. The
    // outcome checks above can't tell that apart from TrackIt failing on the placeholder key.
    serviceLogs: [
      {
        namespace: 'integration',
        deployment: 'trackit-ingestion-rmq-0',
        contains: 'Skipping TrackIt assignee override: facial_recognition license enabled for account: {accountId}',
      },
    ],
  },
  rationale:
    "The doc: 'TripEventService.getAssigneeOverrides()'s early exit: when facial recognition is enabled, skip the rest of the trip-ended processing.' TrackIt's early exit writes nothing, so this asserts its info log line directly (`serviceLogs`), alongside the outcome it would otherwise be free to disturb (a clean, uncontested convergence on A). The trackit integration is a placeholder, so without the log check a TrackIt that ran and failed on the fake key would pass too. Compiled from fixtures/O19-trackit-exclusivity.json (one violation, HARDBRAKE at atSec 100, before the identification's claimed atSec 150, delivered live while the trip is still open) via fixturePlayback.ts.",
};

export const LICENCE_SCENARIOS: readonly Scenario[] = [O18, O19];
