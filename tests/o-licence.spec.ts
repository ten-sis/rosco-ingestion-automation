import { defineScenarioTests } from '../src/fixtures/test';
import { LICENCE_SCENARIOS } from '../src/scenarios/licence';

const FLEET = 'fr-licence';

defineScenarioTests(LICENCE_SCENARIOS, FLEET);
