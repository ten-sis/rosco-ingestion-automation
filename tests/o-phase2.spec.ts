import { defineScenarioTests } from '../src/fixtures/test';
import { PHASE2_SCENARIOS } from '../src/scenarios/phase2';

const FLEET = 'fr-phase2';

// O21 needs "an asset's very first trip", which a reused asset can never give it, so this file
// keeps creating new assets per worker (PLAN/07-ASSET-REUSE.md, "Fleets that need a fresh asset").
defineScenarioTests(PHASE2_SCENARIOS, FLEET, { freshAsset: true });
