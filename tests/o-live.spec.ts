import { defineScenarioTests } from '../src/fixtures/test';
import { LIVE_SCENARIOS } from '../src/scenarios/live';

const FLEET = 'fr-live';

defineScenarioTests(LIVE_SCENARIOS, FLEET, { parallel: true });
