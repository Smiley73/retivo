/**
 * Places a candidate's ladder and the assumed death ages on a copy of the
 * target scenario. `RunBalanceProjectionArgs.candidateOverlay` only carries
 * Social Security, so the scenario array itself is rewritten, the way
 * `withCandidateOverlay` does it for claim ages.
 */
import type { MagiCapWindow } from '../../db/types';
import { resolveScenario, type ScenarioAggregate } from '../scenario-resolution';
import type { RothSuggestionDeathAges } from './types';

/**
 * Returns the scenarios with the target replaced by a copy that carries:
 *  - `lifeExpectancy` seeded from the RESOLVED block, then the member ages set
 *    (resolution is section-level first-wins, so a local block shadows the
 *    parent's entirely and an inherited age for the other member would
 *    otherwise be dropped);
 *  - `magiCap: { windows }` as a local block when a ladder is given, which
 *    shadows the parent's cap entirely. Without a ladder nothing is written
 *    and the chain is inherited, including a `{ disabled: true }` sentinel.
 */
export function overlayScenarios(args: {
  readonly scenarios: readonly ScenarioAggregate[];
  readonly scenarioId: string;
  readonly deathAges: RothSuggestionDeathAges;
  readonly ladder?: readonly MagiCapWindow[];
}): ScenarioAggregate[] {
  const { scenarios, scenarioId, deathAges, ladder } = args;
  const resolved = resolveScenario(scenarioId, [...scenarios]);
  const lifeExpectancy = {
    ...(resolved.lifeExpectancy ?? {}),
    primary: deathAges.primary,
    ...(deathAges.secondary !== undefined ? { secondary: deathAges.secondary } : {}),
  };
  return scenarios.map((scenario) =>
    scenario.id !== scenarioId
      ? scenario
      : {
          ...scenario,
          payload: {
            ...scenario.payload,
            overrides: {
              ...scenario.payload.overrides,
              lifeExpectancy,
              ...(ladder !== undefined ? { magiCap: { windows: [...ladder] } } : {}),
            },
          },
        },
  );
}
