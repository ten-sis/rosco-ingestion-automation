/**
 * Re-exports every scenario group plus the flattened `ALL_SCENARIOS` list TRACEABILITY.md and
 * ad-hoc tooling can iterate over. Individual spec files import their own group directly rather
 * than filtering this list, so `--grep-invert @phase2` stays the mechanism for excluding phase 2.
 *
 * No `RESILIENCE_SCENARIOS` group here: O20 moved to `OUT-OF-SCOPE.md` (AGENT-BRIEF revision 2,
 * item 6). `src/scenarios/resilience.ts` and `tests/o-resilience.spec.ts` were deleted.
 */

import { LIVE_SCENARIOS } from './live';
import { TRIP_LOOKUP_SCENARIOS } from './tripLookup';
import { DELAYED_SCENARIOS } from './delayed';
import { GUARDS_SCENARIOS } from './guards';
import { RACE_SCENARIOS } from './race';
import { LICENCE_SCENARIOS } from './licence';
import { PHASE2_SCENARIOS } from './phase2';
import type { Scenario } from '../scenario/types';

export { LIVE_SCENARIOS } from './live';
export { TRIP_LOOKUP_SCENARIOS } from './tripLookup';
export { DELAYED_SCENARIOS } from './delayed';
export { GUARDS_SCENARIOS } from './guards';
export { RACE_SCENARIOS } from './race';
export { LICENCE_SCENARIOS } from './licence';
export { PHASE2_SCENARIOS } from './phase2';

export const ALL_SCENARIOS: readonly Scenario[] = [
  ...LIVE_SCENARIOS,
  ...TRIP_LOOKUP_SCENARIOS,
  ...DELAYED_SCENARIOS,
  ...GUARDS_SCENARIOS,
  ...RACE_SCENARIOS,
  ...LICENCE_SCENARIOS,
  ...PHASE2_SCENARIOS,
];
