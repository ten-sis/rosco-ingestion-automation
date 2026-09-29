import { defineScenarioTests } from '../src/fixtures/test';
import { GUARDS_SCENARIOS } from '../src/scenarios/guards';

const FLEET = 'fr-guards';

// O8 and O8b both deactivate driver D, which no other scenario here uses, so they run one after
// the other while the rest of the file runs alongside them.
defineScenarioTests(GUARDS_SCENARIOS, FLEET, { parallel: true, inOrder: [['O8', 'O8b']] });
