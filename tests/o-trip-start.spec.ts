import { defineScenarioTests } from '../src/fixtures/test';
import { TRIP_START_SCENARIOS } from '../src/scenarios/tripStart';

const FLEET = 'fr-trip-start';

defineScenarioTests(TRIP_START_SCENARIOS, FLEET, { parallel: true });
