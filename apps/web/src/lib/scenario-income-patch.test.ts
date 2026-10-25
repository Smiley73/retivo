import { describe, expect, it } from 'vitest';
import { buildScenarioIncomePatchWrite } from './scenario-income-patch';
import type { ScenarioPayload } from '../db/types';

const baseScenario = (overrides: ScenarioPayload['overrides']): ScenarioPayload =>
  ({
    name: 'Test scenario',
    isPrimary: false,
    overrides,
  }) as ScenarioPayload;

const PREFIXED = 'aggregate:inc-1';
const RAW = 'inc-1';

describe('buildScenarioIncomePatchWrite', () => {
  it('should_write_a_non_empty_patch_under_the_prefixed_id_and_drop_the_legacy_raw_key', () => {
    const scenario = baseScenario({
      income: { patches: { [RAW]: { name: 'old' }, other: { amount: 5 } } },
    });
    const next = buildScenarioIncomePatchWrite(scenario, PREFIXED, RAW, {
      name: 'new',
    });
    expect(next.overrides.income?.patches).toEqual({
      other: { amount: 5 },
      [PREFIXED]: { name: 'new' },
    });
    expect(scenario.overrides.income?.patches?.[RAW]).toEqual({ name: 'old' });
  });

  it('should_preserve_per_key_null_clear_markers_inside_a_non_empty_patch', () => {
    const scenario = baseScenario({ income: {} });
    const next = buildScenarioIncomePatchWrite(scenario, PREFIXED, RAW, {
      linkedCbpAccountId: null,
    });
    expect(next.overrides.income?.patches?.[PREFIXED]).toEqual({
      linkedCbpAccountId: null,
    });
  });

  it('should_prune_empty_patches_and_empty_income_override_on_whole_patch_clear', () => {
    const scenario = baseScenario({
      income: { patches: { [PREFIXED]: { name: 'x' } } },
    });
    const next = buildScenarioIncomePatchWrite(scenario, PREFIXED, RAW, null);
    expect(next.overrides.income).toBeUndefined();
  });

  it('should_keep_other_income_override_keys_when_clearing_the_last_patch', () => {
    const scenario = baseScenario({
      income: {
        patches: { [PREFIXED]: { name: 'x' } },
        added: [],
      },
    });
    const next = buildScenarioIncomePatchWrite(scenario, PREFIXED, RAW, {});
    expect(next.overrides.income).toEqual({ added: [] });
  });
});
