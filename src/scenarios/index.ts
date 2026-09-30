/**
 * Re-exports every scenario group plus the flattened `ALL_SCENARIOS` list TRACEABILITY.md and
 * ad-hoc tooling can iterate over. Individual spec files import their own group directly rather
 * than filtering this list.
 *
 * No `RESILIENCE_SCENARIOS` group here: O20 moved to `OUT-OF-SCOPE.md` (AGENT-BRIEF revision 2,
 * item 6). `src/scenarios/resilience.ts` and `tests/o-resilience.spec.ts` were deleted.
 */

import { LIVE_SCENARIOS } from './live';
import { TRIP_LOOKUP_GAP_SCENARIOS, TRIP_LOOKUP_SCENARIOS } from './tripLookup';
import { DELAYED_SCENARIOS } from './delayed';
import { GUARDS_SCENARIOS } from './guards';
import { RACE_SCENARIOS } from './race';
import { LICENCE_SCENARIOS } from './licence';
import { TRIP_START_SCENARIOS } from './tripStart';
import { FIRST_TRIP_SCENARIOS } from './firstTrip';
import type { Scenario } from '../scenario/types';

export { LIVE_SCENARIOS } from './live';
export { TRIP_LOOKUP_GAP_SCENARIOS, TRIP_LOOKUP_SCENARIOS } from './tripLookup';
export { DELAYED_SCENARIOS } from './delayed';
export { GUARDS_SCENARIOS } from './guards';
export { RACE_SCENARIOS } from './race';
export { LICENCE_SCENARIOS } from './licence';
export { TRIP_START_SCENARIOS } from './tripStart';
export { FIRST_TRIP_SCENARIOS } from './firstTrip';

export const ALL_SCENARIOS: readonly Scenario[] = [
  ...LIVE_SCENARIOS,
  ...TRIP_LOOKUP_SCENARIOS,
  ...TRIP_LOOKUP_GAP_SCENARIOS,
  ...DELAYED_SCENARIOS,
  ...GUARDS_SCENARIOS,
  ...RACE_SCENARIOS,
  ...LICENCE_SCENARIOS,
  ...TRIP_START_SCENARIOS,
  ...FIRST_TRIP_SCENARIOS,
];
