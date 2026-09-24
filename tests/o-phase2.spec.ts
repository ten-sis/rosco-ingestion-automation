import { defineScenarioTests } from '../src/fixtures/test';
import { PHASE2_SCENARIOS } from '../src/scenarios/phase2';

const FLEET = 'fr-phase2';

defineScenarioTests(PHASE2_SCENARIOS, FLEET);
