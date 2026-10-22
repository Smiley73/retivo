/** Places a candidate's ladder and the assumed death ages on a copy of the
 *  target scenario (the projection's own overlay carries Social Security only). */
import type { MagiCapWindow } from '../../db/types';
import { resolveScenario, type ScenarioAggregate } from '../scenario-resolution';
import type { RothSuggestionDeathAges } from './types';

/** The scenarios with the target replaced by a copy carrying `lifeExpectancy`
 *  seeded from the resolved block (resolution is section-level first-wins, so
 *  an inherited partner age would otherwise drop) and, when a ladder is given,
 *  `magiCap: { windows }` as a local block; without one the chain is inherited. */
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
