import { defineScenarioTests } from '../src/fixtures/test';
import { DELAYED_SCENARIOS } from '../src/scenarios/delayed';

const FLEET = 'fr-delayed';

defineScenarioTests(DELAYED_SCENARIOS, FLEET, { parallel: true });
