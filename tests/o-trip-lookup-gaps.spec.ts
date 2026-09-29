import { defineScenarioTests } from '../src/fixtures/test';
import { TRIP_LOOKUP_GAP_SCENARIOS } from '../src/scenarios/tripLookup';

// O12c and O6 each wait about ten minutes before their first step, so they get their own fleet and
// asset and run in parallel with the other trip-lookup cases (src/scenarios/tripLookup.ts).
const FLEET = 'fr-trip-lookup-gaps';

defineScenarioTests(TRIP_LOOKUP_GAP_SCENARIOS, FLEET, { parallel: true });
