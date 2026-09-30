import { defineScenarioTests } from '../src/fixtures/test';
import { FIRST_TRIP_SCENARIOS } from '../src/scenarios/firstTrip';

const FLEET = 'fr-first-trip';

// O21 needs "an asset's very first trip", which a reused asset can never give it, so this file
// creates a new asset per worker (PLAN/07-ASSET-REUSE.md, "Fleets that need a fresh asset").
defineScenarioTests(FIRST_TRIP_SCENARIOS, FLEET, { freshAsset: true });
