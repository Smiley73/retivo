import { describe, it, expect } from 'vitest';
import { SCENARIO_SETTING_COVERAGE } from './report-scenario-settings';

describe('SCENARIO_SETTING_COVERAGE', () => {
  it('registers the override keys the Scenario page renders', () => {
    // The `satisfies` in report-scenario-settings.ts is the compile-time guard; this keeps the ledger referenced.
    expect(SCENARIO_SETTING_COVERAGE.magiCap).toBe(true);
    expect(SCENARIO_SETTING_COVERAGE.withdrawalStrategy).toBe(true);
    expect(SCENARIO_SETTING_COVERAGE.accountReturns).toBe(true);
  });
});
