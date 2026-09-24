import { defineScenarioTests } from '../src/fixtures/test';
import { GUARDS_SCENARIOS } from '../src/scenarios/guards';

const FLEET = 'fr-guards';

defineScenarioTests(GUARDS_SCENARIOS, FLEET);
