/**
 * Unit test for `SCENARIO_SETTING_COVERAGE` — split out of `report-data.test.ts`
 * alongside the `buildScenarioSettings`
 * source move to `report-scenario-settings.ts`. `buildScenarioSettings`
 * itself stays covered end-to-end via `buildReportData` in
 * `report-data.test.ts` (it is not independently exported/tested there).
 */
import { describe, it, expect } from 'vitest';
import { SCENARIO_SETTING_COVERAGE } from './report-scenario-settings';

describe('SCENARIO_SETTING_COVERAGE', () => {
  it('registers the override keys the Scenario page renders', () => {
    // The `satisfies Record<keyof ScenarioOverrides, true>` in
    // report-scenario-settings.ts is the real compile-time guard (adding an
    // override key fails tsc until it is registered here); this keeps the
    // ledger referenced + intentional.
    expect(SCENARIO_SETTING_COVERAGE.magiCap).toBe(true);
    expect(SCENARIO_SETTING_COVERAGE.withdrawalStrategy).toBe(true);
    expect(SCENARIO_SETTING_COVERAGE.accountReturns).toBe(true);
  });
});
