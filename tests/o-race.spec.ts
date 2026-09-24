import { defineScenarioTests } from '../src/fixtures/test';
import { RACE_SCENARIOS } from '../src/scenarios/race';

const FLEET = 'fr-race';

defineScenarioTests(RACE_SCENARIOS, FLEET);
