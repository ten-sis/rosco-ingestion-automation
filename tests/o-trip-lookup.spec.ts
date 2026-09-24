import { defineScenarioTests } from '../src/fixtures/test';
import { TRIP_LOOKUP_SCENARIOS } from '../src/scenarios/tripLookup';

const FLEET = 'fr-trip-lookup';

defineScenarioTests(TRIP_LOOKUP_SCENARIOS, FLEET);
