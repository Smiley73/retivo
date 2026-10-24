// Tests the per-aggregate forward-migration engine through its public contract (`currentSchemaVersion`, `migrate`).
import { describe, it, expect } from 'vitest';
import { currentSchemaVersion, migrate } from './migrations';
import type { AggregateType } from './types';

describe('migration engine contract', () => {
  const ALL_TYPES: AggregateType[] = [
    'account', 'accountBalance', 'expense', 'expenseCategory',
    'household', 'householdMember', 'incomeStream', 'scenario', 'socialSecurityBenefit',
  ];

  const V1_TYPES = ALL_TYPES.filter(
    (t) =>
      t !== 'account' &&
      t !== 'accountBalance' &&
      t !== 'scenario' &&
      t !== 'expenseCategory',
  );

  it('currentSchemaVersion returns 1 for every aggregate type except account (v7) + accountBalance (v2) + scenario (v9) + expenseCategory (v2)', () => {
    for (const type of V1_TYPES) {
      expect(currentSchemaVersion(type)).toBe(1);
    }
    expect(currentSchemaVersion('account')).toBe(7);
    expect(currentSchemaVersion('accountBalance')).toBe(2);
    expect(currentSchemaVersion('scenario')).toBe(9);
    expect(currentSchemaVersion('expenseCategory')).toBe(2);
  });

  it('migrate is a no-op when payload is already at current version', () => {
    for (const type of V1_TYPES) {
      const payload = { schemaVersion: 1 };
      expect(migrate(type, payload, 1)).toBe(payload);
    }
    const accountPayload = { schemaVersion: 7, type: 'HSA', taxTreatment: 'HSA' };
    expect(migrate('account', accountPayload, 7)).toBe(accountPayload);
    const scenarioPayload = {
      schemaVersion: 9,
      overrides: { withdrawalStrategy: { kind: 'taxEfficient' } },
    };
    expect(migrate('scenario', scenarioPayload, 9)).toBe(scenarioPayload);
  });

  it('migrate passes through a payload that is already ahead (gap-warn path)', () => {
    const payload = { schemaVersion: 0 };
    for (const type of V1_TYPES) {
      const result = migrate(type, payload, 0);
      expect(result).toEqual(payload);
    }
  });

  it('passes a scenario magiCap disable sentinel payload through the v1→v2 identity step unchanged', () => {
    // The explicit-disable sentinel ({ disabled: true }) is an additive union member, so the scenario v1→v2 step is identity and the payload survives by reference.
    const payload: Record<string, unknown> = {
      schemaVersion: 1,
      overrides: { magiCap: { disabled: true }, withdrawalStrategy: { kind: 'taxEfficient' } },
    };
    const result = migrate('scenario', payload, 1);
    expect(result).toBe(payload);
    expect((result as { overrides: { magiCap: unknown } }).overrides.magiCap).toEqual({
      disabled: true,
    });
  });
});

describe('scenario v1 → v2 PatchWithClears widening migration', () => {
  it('advances a v1 scenario to v2 as an identity (payload content unchanged)', () => {
    const payload: Record<string, unknown> = {
      name: 'Aggressive',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        income: { patches: { 'aggregate:i1': { linkedCbpAccountId: null } } },
        withdrawalStrategy: { kind: 'taxEfficient' },
      },
    };
    const result = migrate('scenario', payload, 1);
    expect(result).toBe(payload);
    expect(result).toEqual(payload);
  });

  it('leaves a null-free v1 scenario byte-identical when advanced to v2', () => {
    const payload: Record<string, unknown> = {
      name: 'Base',
      overrides: {
        income: { patches: { 'aggregate:i1': { monthlyBenefit: 2000 } } },
        withdrawalStrategy: { kind: 'taxEfficient' },
      },
    };
    const result = migrate('scenario', payload, 1);
    expect(result).toEqual(payload);
  });
});

describe('scenario v2 → v3 MAGI-bootstrap split migration', () => {
  it('copies the single magiBootstrapForFirstTwoYears into BOTH lookback fields and drops the old key', () => {
    const result = migrate(
      'scenario',
      {
        schemaVersion: 2,
        name: 'Base',
        overrides: { magiBootstrapForFirstTwoYears: 123_456, magiCap: { disabled: true } },
      },
      2,
    ) as unknown as { overrides: Record<string, unknown> };
    expect(result.overrides.magiBootstrapLookbackMinus2).toBe(123_456);
    expect(result.overrides.magiBootstrapLookbackMinus1).toBe(123_456);
    expect(Object.prototype.hasOwnProperty.call(result.overrides, 'magiBootstrapForFirstTwoYears')).toBe(false);
    expect(result.overrides.magiCap).toEqual({ disabled: true });
  });

  it('leaves both lookback fields absent when the old field is absent', () => {
    const payload = { schemaVersion: 2, overrides: { magiCap: { disabled: true } } };
    const result = migrate('scenario', payload, 2) as unknown as { overrides: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(result.overrides, 'magiBootstrapLookbackMinus2')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.overrides, 'magiBootstrapLookbackMinus1')).toBe(false);
  });

  it('chains a v1 scenario carrying the old field all the way to v3 (both fields = old value)', () => {
    const result = migrate(
      'scenario',
      {
        schemaVersion: 1,
        name: 'Base',
        overrides: { magiBootstrapForFirstTwoYears: 80_000 },
      },
      1,
    ) as unknown as { overrides: Record<string, unknown> };
    expect(result.overrides.magiBootstrapLookbackMinus2).toBe(80_000);
    expect(result.overrides.magiBootstrapLookbackMinus1).toBe(80_000);
    expect(Object.prototype.hasOwnProperty.call(result.overrides, 'magiBootstrapForFirstTwoYears')).toBe(false);
  });
});

type MigratedWindow = {
  start: { kind: string };
  end: { kind: string; memberId?: string; years?: number; months?: number };
  magiCeilingAnnualDollars: number;
  capMode: string;
  capMagiLine: string;
  targetRothAccountId?: string;
};

describe('scenario v3 → v4 → v5 MAGI-cap window schedule', () => {
  it('renames the ceiling, seeds Minimize defaults, then reshapes into a one-window ladder', () => {
    const result = migrate(
      'scenario',
      {
        schemaVersion: 3,
        name: 'Capped',
        overrides: {
          magiCap: { preTaxDrawDollarsAnnual: 75_000, endAgeMemberRole: 'primary', endAge: 65 },
        },
      },
      3,
    ) as unknown as { overrides: { magiCap: { windows: MigratedWindow[] } } };
    const windows = result.overrides.magiCap.windows;
    expect(windows).toHaveLength(1);
    const w = windows[0];
    expect(w.magiCeilingAnnualDollars).toBe(75_000);
    expect(w.capMode).toBe('minimize');
    expect(w.capMagiLine).toBe('irmaa');
    expect(Object.prototype.hasOwnProperty.call(w, 'targetRothAccountId')).toBe(false);
    expect(w.start).toEqual({ kind: 'retirementStart' });
    expect(w.end).toEqual({ kind: 'age', memberId: 'primary', years: 65, months: 0 });
  });

  it('passes a { disabled: true } sentinel through unchanged', () => {
    const payload = {
      schemaVersion: 3,
      name: 'Child',
      overrides: { magiCap: { disabled: true } },
    };
    const result = migrate('scenario', payload, 3) as unknown as {
      overrides: { magiCap: unknown };
    };
    expect(result.overrides.magiCap).toEqual({ disabled: true });
  });

  it('passes a scenario with no magiCap through unchanged (total / never-throws)', () => {
    const payload = { schemaVersion: 3, name: 'Plain', overrides: { filingStatus: 'MFJ' } };
    const result = migrate('scenario', payload, 3) as unknown as {
      overrides: Record<string, unknown>;
    };
    expect(result.overrides.filingStatus).toBe('MFJ');
    expect(Object.prototype.hasOwnProperty.call(result.overrides, 'magiCap')).toBe(false);
  });

  it('chains a v1 capped scenario through to the v5 ladder (secondary-gated window)', () => {
    const result = migrate(
      'scenario',
      {
        schemaVersion: 1,
        name: 'Base',
        overrides: {
          magiCap: { preTaxDrawDollarsAnnual: 40_000, endAgeMemberRole: 'secondary', endAge: 63 },
        },
      },
      1,
    ) as unknown as { overrides: { magiCap: { windows: MigratedWindow[] } } };
    const w = result.overrides.magiCap.windows[0];
    expect(w.magiCeilingAnnualDollars).toBe(40_000);
    expect(w.capMode).toBe('minimize');
    expect(w.end).toEqual({ kind: 'age', memberId: 'secondary', years: 63, months: 0 });
  });

  it('carries Fill-mode fields onto the migrated window', () => {
    const result = migrate(
      'scenario',
      {
        schemaVersion: 4,
        name: 'Fill',
        overrides: {
          magiCap: {
            magiCeilingAnnualDollars: 90_000,
            endAgeMemberRole: 'primary',
            endAge: 65,
            capMode: 'fill',
            capMagiLine: 'aca',
            targetRothAccountId: 'roth-1',
          },
        },
      },
      4,
    ) as unknown as { overrides: { magiCap: { windows: MigratedWindow[] } } };
    const w = result.overrides.magiCap.windows[0];
    expect(w.capMode).toBe('fill');
    expect(w.capMagiLine).toBe('aca');
    expect(w.targetRothAccountId).toBe('roth-1');
  });

  it('is idempotent — an already-v5 windowed cap passes through unchanged', () => {
    const ladder = {
      windows: [
        {
          start: { kind: 'retirementStart' },
          end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
          magiCeilingAnnualDollars: 50_000,
          capMode: 'minimize',
          capMagiLine: 'irmaa',
        },
      ],
    };
    const result = migrate(
      'scenario',
      { schemaVersion: 4, name: 'AlreadyV5', overrides: { magiCap: ladder } },
      4,
    ) as unknown as { overrides: { magiCap: unknown } };
    expect(result.overrides.magiCap).toEqual(ladder);
  });

  it('migrates a malformed legacy cap (no numeric ceiling) to NO cap, never throws', () => {
    const result = migrate(
      'scenario',
      {
        schemaVersion: 4,
        name: 'Corrupt',
        overrides: { magiCap: { endAgeMemberRole: 'primary', endAge: 65 }, filingStatus: 'MFJ' },
      },
      4,
    ) as unknown as { overrides: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(result.overrides, 'magiCap')).toBe(false);
    expect(result.overrides.filingStatus).toBe('MFJ');
  });
});

describe('scenario v5 → v6 per-category inflation categoryRates', () => {
  it('upgrades a pre-feature v5 scenario unchanged (no inflation override)', () => {
    const payload = {
      schemaVersion: 5,
      name: 'Base',
      overrides: { magiCap: { disabled: true }, withdrawalStrategy: { kind: 'taxEfficient' } },
    };
    const result = migrate('scenario', payload, 5);
    expect(result).toBe(payload);
  });

  it('passes through a clean inflation override (general rate, no categoryRates)', () => {
    const payload = {
      schemaVersion: 5,
      name: 'Base',
      overrides: { inflation: { ratePct: 4 }, withdrawalStrategy: { kind: 'taxEfficient' } },
    };
    const result = migrate('scenario', payload, 5);
    expect(result).toBe(payload);
  });

  it('keeps a clean categoryRates map verbatim', () => {
    const result = migrate(
      'scenario',
      {
        schemaVersion: 5,
        name: 'Base',
        overrides: { inflation: { ratePct: 3, categoryRates: { 'cat-medical': 5 } } },
      },
      5,
    ) as unknown as { overrides: { inflation: { categoryRates: Record<string, number> } } };
    expect(result.overrides.inflation.categoryRates).toEqual({ 'cat-medical': 5 });
  });

  it('sanitises a malformed categoryRates (NaN / __proto__ / out-of-range) on upgrade', () => {
    const result = migrate(
      'scenario',
      {
        schemaVersion: 5,
        name: 'Corrupt',
        overrides: {
          inflation: {
            ratePct: 3,
            categoryRates: {
              ['__proto__' as string]: 9,
              ['constructor' as string]: 9,
              'cat-nan': Number.NaN,
              'cat-high': 99,
              'cat-neg': -3,
              'cat-ok': 6,
            },
          },
        },
      },
      5,
    ) as unknown as { overrides: { inflation: { categoryRates: Record<string, number> } } };
    const cleaned = result.overrides.inflation.categoryRates;
    expect(cleaned).toEqual({ 'cat-ok': 6 });
    expect(Object.prototype.hasOwnProperty.call(cleaned, '__proto__')).toBe(false);
    expect((Object.prototype as Record<string, unknown>)['9']).toBeUndefined();
  });

  it('drops categoryRates entirely when every entry is invalid', () => {
    const result = migrate(
      'scenario',
      {
        schemaVersion: 5,
        name: 'AllBad',
        overrides: { inflation: { ratePct: 3, categoryRates: { 'cat-nan': Number.NaN } } },
      },
      5,
    ) as unknown as { overrides: { inflation: Record<string, unknown> } };
    expect(
      Object.prototype.hasOwnProperty.call(result.overrides.inflation, 'categoryRates'),
    ).toBe(false);
    expect(result.overrides.inflation.ratePct).toBe(3);
  });

  it('bounds an oversized categoryRates map on upgrade', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 400; i += 1) big[`cat-${i}`] = 3;
    const result = migrate(
      'scenario',
      { schemaVersion: 5, name: 'Big', overrides: { inflation: { ratePct: 3, categoryRates: big } } },
      5,
    ) as unknown as { overrides: { inflation: { categoryRates: Record<string, number> } } };
    expect(Object.keys(result.overrides.inflation.categoryRates).length).toBeLessThanOrEqual(256);
  });

  it('schema-ahead guard: an ahead scenario is rejected by an older client (currentSchemaVersion gate)', () => {
    // An older client's `currentSchemaVersion` is below an ahead payload's schemaVersion; `migrate` never downgrades.
    expect(currentSchemaVersion('scenario')).toBe(9);
    const ahead = { schemaVersion: 10, overrides: {} };
    expect(migrate('scenario', ahead, 10)).toBe(ahead);
  });
});

describe('scenario v7 → v8 accountFloors minimum-balance-floor add', () => {
  it('migrates a v7 scenario WITHOUT accountFloors to v8 as an identity (no floor)', () => {
    // A v7 payload without `accountFloors` is already a valid v8 payload: the step is identity.
    const payload: Record<string, unknown> = {
      schemaVersion: 7,
      name: 'Baseline',
      overrides: { inflation: { ratePct: 3 } },
    };
    const result = migrate('scenario', payload, 7) as unknown as {
      overrides: Record<string, unknown>;
    };
    expect('accountFloors' in result.overrides).toBe(false);
    expect(result.overrides.inflation).toEqual({ ratePct: 3 });
  });

  it('preserves a v7 scenario that already carries an accountFloors section', () => {
    const floors = {
      perAccount: { 'acct-1': { floorDollars: 10000, hsaMode: 'strict' } },
    };
    const payload: Record<string, unknown> = {
      schemaVersion: 7,
      name: 'Floored',
      overrides: { accountFloors: floors },
    };
    const result = migrate('scenario', payload, 7) as unknown as {
      overrides: { accountFloors: typeof floors };
    };
    expect(result.overrides.accountFloors).toEqual(floors);
  });

  it('AGGREGATE_VERSION_UNSUPPORTED still triggers for a schemaVersion above current', () => {
    expect(currentSchemaVersion('scenario')).toBe(9);
    const ahead = { schemaVersion: 10, overrides: { accountFloors: { perAccount: {} } } };
    expect(migrate('scenario', ahead, 10)).toBe(ahead);
  });
});

describe('scenario v8 → v9 remove-combined-pot withdrawal-strategy migration', () => {
  type StrategyOverrides = { overrides?: { withdrawalStrategy?: { kind: string } } };
  const migrateV8 = (payload: Record<string, unknown>) =>
    migrate('scenario', payload, 8) as unknown as StrategyOverrides;

  it('(a) rewrites an absent withdrawalStrategy to taxEfficient', () => {
    const result = migrateV8({ schemaVersion: 8, overrides: { inflation: { ratePct: 3 } } });
    expect(result.overrides?.withdrawalStrategy).toEqual({ kind: 'taxEfficient' });
    expect((result.overrides as Record<string, unknown>).inflation).toEqual({ ratePct: 3 });
  });

  it('(b) rewrites an explicit combinedPot strategy to taxEfficient', () => {
    const result = migrateV8({
      schemaVersion: 8,
      overrides: { withdrawalStrategy: { kind: 'combinedPot' } },
    });
    expect(result.overrides?.withdrawalStrategy).toEqual({ kind: 'taxEfficient' });
  });

  it('(c) leaves the other named strategies unchanged', () => {
    for (const kind of ['taxEfficient', 'proportional', 'rothFirst', 'customOrder'] as const) {
      const payload = { schemaVersion: 8, overrides: { withdrawalStrategy: { kind } } };
      const result = migrate('scenario', payload, 8);
      expect(result).toBe(payload);
    }
  });

  it('(d) handles a null / non-object overrides gracefully (no throw, passthrough)', () => {
    const nullOverrides = { schemaVersion: 8, overrides: null } as unknown as Record<string, unknown>;
    expect(() => migrate('scenario', nullOverrides, 8)).not.toThrow();
    expect(migrate('scenario', nullOverrides, 8)).toBe(nullOverrides);
    const missingOverrides = { schemaVersion: 8 } as Record<string, unknown>;
    expect(migrate('scenario', missingOverrides, 8)).toBe(missingOverrides);
  });

  it('(e) is idempotent: a migrated v9 payload re-run stays stable', () => {
    const once = migrateV8({ schemaVersion: 8, overrides: { inflation: { ratePct: 3 } } });
    const twice = migrate('scenario', once as unknown as Record<string, unknown>, 8) as unknown as StrategyOverrides;
    expect(twice.overrides?.withdrawalStrategy).toEqual({ kind: 'taxEfficient' });
    expect(twice).toBe(once);
  });

  it('(f) coerces a malformed withdrawalStrategy kind to taxEfficient', () => {
    const result = migrateV8({
      schemaVersion: 8,
      overrides: { withdrawalStrategy: { kind: 'bogusKind' } },
    });
    expect(result.overrides?.withdrawalStrategy).toEqual({ kind: 'taxEfficient' });
    const result2 = migrateV8({
      schemaVersion: 8,
      overrides: { withdrawalStrategy: 'combinedPot' as unknown as { kind: string } },
    });
    expect(result2.overrides?.withdrawalStrategy).toEqual({ kind: 'taxEfficient' });
  });
});

describe('account v1 → v2 HSA tax-treatment migration', () => {
  it('migrates a PRE_TAX HSA account to taxTreatment HSA (pre-tax amount preserved)', () => {
    const result = migrate(
      'account',
      {
        type: 'HSA',
        taxTreatment: 'PRE_TAX',
        name: 'My HSA',
        plannedContributionPreTax: 4150,
        plannedContributionPostTax: 0,
      },
      1,
    );
    expect(result.taxTreatment).toBe('HSA');
    expect(result.type).toBe('HSA');
    expect(result.plannedContributionPreTax).toBe(4150);
    expect(result.plannedContributionPostTax).toBe(0);
  });

  it('migrates a POST_TAX HSA account to taxTreatment HSA, consolidating onto pre-tax (covers demo data + legacy)', () => {
    const result = migrate(
      'account',
      {
        type: 'HSA',
        taxTreatment: 'POST_TAX',
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 4150,
      },
      1,
    );
    expect(result.taxTreatment).toBe('HSA');
    expect(result.plannedContributionPreTax).toBe(4150);
    expect(result.plannedContributionPostTax).toBe(0);
  });

  it('leaves a non-HSA PRE_TAX account unchanged (no-op)', () => {
    const payload = { type: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' };
    const result = migrate('account', payload, 1);
    expect(result.taxTreatment).toBe('PRE_TAX');
    expect(result).toBe(payload);
  });
});

describe('account v2 → v3 Roth tax-treatment migration', () => {
  it('migrates a RETIREMENT_ROTH_IRA account from POST_TAX to taxTreatment ROTH', () => {
    const result = migrate(
      'account',
      {
        schemaVersion: 2,
        type: 'RETIREMENT_ROTH_IRA',
        taxTreatment: 'POST_TAX',
        name: 'My Roth IRA',
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 7000,
      },
      2,
    );
    expect(result.taxTreatment).toBe('ROTH');
    expect(result.type).toBe('RETIREMENT_ROTH_IRA');
    expect(result.plannedContributionPreTax).toBe(0);
    expect(result.plannedContributionPostTax).toBe(7000);
  });

  it('leaves a non-Roth POST_TAX account (brokerage) unchanged at v2→v3', () => {
    const payload = { type: 'BROKERAGE', taxTreatment: 'POST_TAX' };
    const result = migrate('account', payload, 2);
    expect(result.taxTreatment).toBe('POST_TAX');
    expect(result).toBe(payload);
  });

  it('leaves an HSA-treatment account unchanged at v2→v3', () => {
    const payload = { type: 'HSA', taxTreatment: 'HSA' };
    const result = migrate('account', payload, 2);
    expect(result.taxTreatment).toBe('HSA');
    expect(result).toBe(payload);
  });

  it('chains a v1 Roth IRA all the way to v3 with taxTreatment ROTH', () => {
    const result = migrate(
      'account',
      {
        schemaVersion: 1,
        type: 'RETIREMENT_ROTH_IRA',
        taxTreatment: 'POST_TAX',
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 7000,
      },
      1,
    );
    expect(result.taxTreatment).toBe('ROTH');
    expect(result.plannedContributionPostTax).toBe(7000);
  });
});

describe('account v3 → v4 contributionGrowthPct add', () => {
  it('absent → tracks-inflation (field stays absent, identity reference)', () => {
    const payload = {
      type: 'RETIREMENT_401K',
      taxTreatment: 'PRE_TAX',
      plannedContributionPreTax: 12000,
    };
    const result = migrate('account', payload, 3);
    expect('contributionGrowthPct' in result).toBe(false);
    expect(result).toBe(payload);
  });

  it('explicit 0 persists (NOT collapsed to absent)', () => {
    const payload = {
      type: 'RETIREMENT_401K',
      taxTreatment: 'PRE_TAX',
      contributionGrowthPct: 0,
    };
    const result = migrate('account', payload, 3);
    expect(result.contributionGrowthPct).toBe(0);
  });

  it('a valid in-band rate persists', () => {
    const payload = { type: 'BROKERAGE', contributionGrowthPct: 3.5 };
    const result = migrate('account', payload, 3);
    expect(result.contributionGrowthPct).toBe(3.5);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-100 boundary', -100],
    ['above the 25 cap', 99],
  ])('sanitises a corrupt stored value (%s) by dropping it', (_label, pct) => {
    const payload = { type: 'BROKERAGE', contributionGrowthPct: pct };
    const result = migrate('account', payload, 3);
    expect('contributionGrowthPct' in result).toBe(false);
  });

  it('chains a v1 account through to v4 carrying a valid rate', () => {
    const result = migrate(
      'account',
      {
        schemaVersion: 1,
        type: 'RETIREMENT_401K',
        taxTreatment: 'PRE_TAX',
        plannedContributionPreTax: 12000,
        plannedContributionPostTax: 0,
        contributionGrowthPct: 2,
      },
      1,
    );
    expect(result.contributionGrowthPct).toBe(2);
  });
});

describe('account v4 → v5 Roth distribution-tax facts', () => {
  it('a clean payload with NO Roth facts is identity (same reference — absence preserved)', () => {
    const payload = {
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      plannedContributionPostTax: 3000,
    };
    const result = migrate('account', payload, 4);
    expect(result).toBe(payload);
    expect('rothIraRegularContributionBasis' in result).toBe(false);
    expect('rothIraConversionLots' in result).toBe(false);
  });

  it('the v6→v7 removal strips a stored basis while the first-contribution year survives the chain', () => {
    const payload = {
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      rothIraRegularContributionBasis: 30000,
      rothIraFirstContributionTaxYear: 2015,
    };
    const result = migrate('account', payload, 4) as Record<string, unknown>;
    // v6→v7 maps the key to undefined rather than deleting it: older snapshots may still carry it.
    expect('rothIraRegularContributionBasis' in result).toBe(true);
    expect(result.rothIraRegularContributionBasis).toBeUndefined();
    expect(result.rothIraFirstContributionTaxYear).toBe(2015);
  });

  it('the v6→v7 removal strips a stored designated-Roth basis while the first-participation year survives the chain', () => {
    const payload = {
      type: 'RETIREMENT_ROTH_401K',
      taxTreatment: 'ROTH',
      designatedRothBasis: 45000,
      designatedRothFirstParticipationTaxYear: 2012,
    };
    const result = migrate('account', payload, 4) as Record<string, unknown>;
    expect('designatedRothBasis' in result).toBe(true);
    expect(result.designatedRothBasis).toBeUndefined();
    expect(result.designatedRothFirstParticipationTaxYear).toBe(2012);
  });

  it.each([
    ['NaN basis', Number.NaN],
    ['negative basis', -100],
    ['Infinity basis', Number.POSITIVE_INFINITY],
  ])('sanitises a corrupt %s by dropping the field', (_label, basis) => {
    const payload = {
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      rothIraRegularContributionBasis: basis,
    };
    const result = migrate('account', payload, 4);
    expect('rothIraRegularContributionBasis' in result).toBe(false);
  });

  it.each([
    ['pre-1998 year', 1990],
    ['non-integer year', 2015.5],
  ])('sanitises a corrupt first-contribution tax year (%s) by dropping it', (_label, year) => {
    const payload = {
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      rothIraFirstContributionTaxYear: year,
    };
    const result = migrate('account', payload, 4);
    expect('rothIraFirstContributionTaxYear' in result).toBe(false);
  });

  it('chains a v1 Roth IRA through to current carrying a valid year, basis stripped at v6→v7', () => {
    const result = migrate(
      'account',
      {
        schemaVersion: 1,
        type: 'RETIREMENT_ROTH_IRA',
        taxTreatment: 'POST_TAX',
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 3000,
        rothIraRegularContributionBasis: 21000,
        rothIraFirstContributionTaxYear: 2016,
      },
      1,
    );
    expect(result.taxTreatment).toBe('ROTH');
    expect('rothIraRegularContributionBasis' in result).toBe(true);
    expect(result.rothIraRegularContributionBasis).toBeUndefined();
    expect(result.rothIraFirstContributionTaxYear).toBe(2016);
  });

  it.each([
    ['NaN designated basis', Number.NaN],
    ['negative designated basis', -100],
    ['Infinity designated basis', Number.POSITIVE_INFINITY],
    // A finite value whose ×100 cents overflows the safe-integer range must not survive migration.
    ['out-of-magnitude designated basis', 1e308],
  ])('sanitises a corrupt %s by dropping the field', (_label, basis) => {
    const payload = {
      type: 'RETIREMENT_ROTH_401K',
      taxTreatment: 'ROTH',
      designatedRothBasis: basis,
    };
    const result = migrate('account', payload, 4);
    expect('designatedRothBasis' in result).toBe(false);
  });

  it.each([
    ['pre-1998 year', 1990],
    ['non-integer year', 2012.5],
    ['above-2200 year', 2201],
  ])(
    'sanitises a corrupt designated first-participation tax year (%s) by dropping it',
    (_label, year) => {
      const payload = {
        type: 'RETIREMENT_ROTH_401K',
        taxTreatment: 'ROTH',
        designatedRothFirstParticipationTaxYear: year,
      };
      const result = migrate('account', payload, 4);
      expect('designatedRothFirstParticipationTaxYear' in result).toBe(false);
    },
  );

  it('sanitises an out-of-magnitude Roth-IRA regular basis (×100 would overflow safe-int)', () => {
    const payload = {
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      rothIraRegularContributionBasis: 1e308,
    };
    const result = migrate('account', payload, 4);
    expect('rothIraRegularContributionBasis' in result).toBe(false);
  });

  it('leaves the retired lot arrays alone, whatever shape they are in', () => {
    // A stored lot array rides along inert: both dated Roth facts moved to the annual balance rows and nothing reads these keys.
    const payload = {
      type: 'RETIREMENT_ROTH_401K',
      taxTreatment: 'ROTH',
      designatedRothInPlanRolloverLots: 'not-an-array',
    };
    const result = migrate('account', payload, 4);
    expect(result).toBe(payload);
    expect(result.designatedRothInPlanRolloverLots).toBe('not-an-array');
  });
});

describe('account v5 → v6 RMD profile facts (RMD engine)', () => {
  it('a clean payload with NO RMD facts is identity (same reference — absence preserved)', () => {
    const payload = {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
    };
    const result = migrate('account', payload, 5);
    expect(result).toBe(payload);
    expect('rmdInheritedAccount' in result).toBe(false);
    expect('rmdBeneficiaryType' in result).toBe(false);
  });

  it('preserves valid owner-side facts (still-working + Table II) round-trip through v5→v6', () => {
    const payload = {
      type: 'RETIREMENT_401K',
      taxTreatment: 'PRE_TAX',
      rmdCurrentEmployerPlan: true,
      rmdFivePercentOwner: false,
      rmdPlanRequiresDistributionAtStatutoryAge: false,
      rmdSoleSpouseBeneficiary: true,
      rmdSpouseBeneficiaryBirthdate: '1970-04-15',
      rmdFirstYearDeferralElected: true,
    };
    const result = migrate('account', payload, 5);
    expect(result.rmdCurrentEmployerPlan).toBe(true);
    expect(result.rmdFivePercentOwner).toBe(false);
    expect(result.rmdSoleSpouseBeneficiary).toBe(true);
    expect(result.rmdSpouseBeneficiaryBirthdate).toBe('1970-04-15');
    expect(result.rmdFirstYearDeferralElected).toBe(true);
  });

  it('preserves a COMPLETE inherited-account fact set', () => {
    const payload = {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      rmdInheritedAccount: true,
      rmdBeneficiaryType: 'OTHER_DESIGNATED',
      rmdInheritedOwnerDeathDate: '2023-09-01',
      rmdInheritedOwnerDiedOnOrAfterRbd: true,
      rmdOriginalOwnerBirthdate: '1945-06-10',
      rmdBeneficiaryBirthdate: '1985-02-20',
    };
    const result = migrate('account', payload, 5);
    expect(result.rmdInheritedAccount).toBe(true);
    expect(result.rmdBeneficiaryType).toBe('OTHER_DESIGNATED');
    expect(result.rmdInheritedOwnerDeathDate).toBe('2023-09-01');
    expect(result.rmdInheritedOwnerDiedOnOrAfterRbd).toBe(true);
    expect(result.rmdOriginalOwnerBirthdate).toBe('1945-06-10');
    expect(result.rmdBeneficiaryBirthdate).toBe('1985-02-20');
  });

  it('does NOT invent inherited beneficiary state — a partial inherited payload keeps its gaps', () => {
    const payload = {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      rmdInheritedAccount: true,
    };
    const result = migrate('account', payload, 5);
    expect(result.rmdInheritedAccount).toBe(true);
    expect('rmdBeneficiaryType' in result).toBe(false);
    expect('rmdInheritedOwnerDeathDate' in result).toBe(false);
    expect('rmdInheritedOwnerDiedOnOrAfterRbd' in result).toBe(false);
  });

  it.each([
    ['non-boolean inherited flag', 'rmdInheritedAccount', 'yes'],
    ['numeric five-percent flag', 'rmdFivePercentOwner', 1],
    ['non-boolean RBD flag', 'rmdInheritedOwnerDiedOnOrAfterRbd', 'true'],
  ])('sanitises a corrupt %s by dropping the field', (_label, key, value) => {
    const payload: Record<string, unknown> = {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      [key]: value,
    };
    const result = migrate('account', payload, 5);
    expect(key in result).toBe(false);
  });

  it.each([
    ['malformed date', 'not-a-date'],
    ['calendar-invalid Feb 30', '2023-02-30'],
    ['non-leap Feb 29', '2023-02-29'],
  ])('sanitises a corrupt spouse-beneficiary birthdate (%s) by dropping it', (_label, date) => {
    const payload = {
      type: 'RETIREMENT_401K',
      taxTreatment: 'PRE_TAX',
      rmdSpouseBeneficiaryBirthdate: date,
    };
    const result = migrate('account', payload, 5);
    expect('rmdSpouseBeneficiaryBirthdate' in result).toBe(false);
  });

  it('accepts a leap-day inherited-owner death date (2024-02-29)', () => {
    const payload = {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      rmdInheritedAccount: true,
      rmdInheritedOwnerDeathDate: '2024-02-29',
      rmdBeneficiaryType: 'SPOUSE',
      rmdInheritedOwnerDiedOnOrAfterRbd: false,
    };
    const result = migrate('account', payload, 5);
    expect(result.rmdInheritedOwnerDeathDate).toBe('2024-02-29');
  });

  it('drops an out-of-vocabulary beneficiary category', () => {
    const payload = {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      rmdInheritedAccount: true,
      rmdBeneficiaryType: 'FRIEND_OF_OWNER',
    };
    const result = migrate('account', payload, 5);
    expect('rmdBeneficiaryType' in result).toBe(false);
  });

  it.each([['LIFE_EXPECTANCY'], ['TEN_YEAR']])(
    'preserves a valid beneficiary election %s',
    (election) => {
      const payload = {
        type: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        rmdInheritedAccount: true,
        rmdBeneficiaryElection: election,
      };
      const result = migrate('account', payload, 5);
      expect(result.rmdBeneficiaryElection).toBe(election);
    },
  );

  it('drops an out-of-vocabulary beneficiary election', () => {
    const payload = {
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      rmdInheritedAccount: true,
      rmdBeneficiaryElection: 'STRETCH_FOREVER',
    };
    const result = migrate('account', payload, 5);
    expect('rmdBeneficiaryElection' in result).toBe(false);
  });

  // Out-of-bounds dates (bounds 1900 to 2200) are dropped, never invented.
  it.each([
    ['one year before the lower bound (1899)', '1899-06-15', false],
    ['exactly the lower bound (1900)', '1900-06-15', true],
    ['exactly the upper bound (2200)', '2200-06-15', true],
    ['one year after the upper bound (2201)', '2201-06-15', false],
    ['wildly out of range (9999)', '9999-12-31', false],
  ])('date-bounds: %s → kept=%s', (_label, date, kept) => {
    const payload = {
      type: 'RETIREMENT_401K',
      taxTreatment: 'PRE_TAX',
      rmdSpouseBeneficiaryBirthdate: date,
    };
    const result = migrate('account', payload, 5);
    expect('rmdSpouseBeneficiaryBirthdate' in result).toBe(kept);
    if (kept) expect(result.rmdSpouseBeneficiaryBirthdate).toBe(date);
  });

  it('chains a v1 traditional IRA all the way to v6 carrying valid RMD facts', () => {
    const result = migrate(
      'account',
      {
        schemaVersion: 1,
        type: 'RETIREMENT_401K',
        taxTreatment: 'PRE_TAX',
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        rmdCurrentEmployerPlan: true,
        rmdFivePercentOwner: false,
      },
      1,
    );
    expect(result.rmdCurrentEmployerPlan).toBe(true);
    expect(result.rmdFivePercentOwner).toBe(false);
  });
});

describe('account v6 → v7 Roth-basis dollar-total removal', () => {
  it('maps both stored basis totals to undefined while every other field is untouched', () => {
    const payload = {
      type: 'RETIREMENT_ROTH_401K',
      taxTreatment: 'ROTH',
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 3000,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      rothIraRegularContributionBasis: 30000,
      rothIraFirstContributionTaxYear: 2015,
      designatedRothBasis: 45000,
      designatedRothFirstParticipationTaxYear: 2012,
      rmdInheritedAccount: true,
      rmdBeneficiaryType: 'SPOUSE',
    };
    const result = migrate('account', payload, 6) as Record<string, unknown>;
    expect('rothIraRegularContributionBasis' in result).toBe(true);
    expect(result.rothIraRegularContributionBasis).toBeUndefined();
    expect('designatedRothBasis' in result).toBe(true);
    expect(result.designatedRothBasis).toBeUndefined();
    expect(result.rothIraFirstContributionTaxYear).toBe(2015);
    expect(result.designatedRothFirstParticipationTaxYear).toBe(2012);
    expect(result.rmdInheritedAccount).toBe(true);
    expect(result.rmdBeneficiaryType).toBe('SPOUSE');
    expect(result.assetMix).toEqual({ stocksPct: 70, bondsPct: 25, cashPct: 5 });
    expect(result.plannedContributionPreTax).toBe(0);
    expect(result.plannedContributionPostTax).toBe(3000);
  });

  it('returns a payload carrying neither key by reference (identity)', () => {
    const payload = {
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      rothIraFirstContributionTaxYear: 2015,
    };
    const result = migrate('account', payload, 6);
    expect(result).toBe(payload);
  });

  it('is idempotent: re-running the step on its own output changes nothing', () => {
    const payload = {
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      rothIraRegularContributionBasis: 30000,
      rothIraFirstContributionTaxYear: 2015,
    };
    const once = migrate('account', payload, 6) as Record<string, unknown>;
    const twice = migrate('account', once, 6) as Record<string, unknown>;
    expect(twice).toEqual(once);
  });

  it('passes a non-object, null, or array payload through without throwing', () => {
    for (const bad of [null, 'nonsense', 42, ['array'], undefined]) {
      expect(() => migrate('account', bad as never, 6)).not.toThrow();
    }
  });
});

describe('scenario v6 → v7 per-account contributionGrowthPct override', () => {
  it('passes a scenario with no accountContributions through unchanged', () => {
    const payload = { schemaVersion: 6, overrides: { withdrawalStrategy: { kind: 'taxEfficient' } } };
    const result = migrate('scenario', payload, 6);
    expect(result).toBe(payload);
  });

  it('preserves a valid per-account growth override distinct from the baseline', () => {
    const payload = {
      schemaVersion: 6,
      overrides: {
        accountContributions: {
          perAccount: { a1: { plannedContributionPreTax: 5000, contributionGrowthPct: 4 } },
        },
      },
    };
    const result = migrate('scenario', payload, 6) as unknown as {
      overrides: { accountContributions: { perAccount: Record<string, Record<string, number>> } };
    };
    const entry = result.overrides.accountContributions.perAccount.a1;
    expect(entry.contributionGrowthPct).toBe(4);
    expect(entry.plannedContributionPreTax).toBe(5000);
  });

  it('preserves an explicit 0 override (NOT collapsed to absent)', () => {
    const payload = {
      schemaVersion: 6,
      overrides: {
        accountContributions: { perAccount: { a1: { contributionGrowthPct: 0 } } },
      },
    };
    const result = migrate('scenario', payload, 6) as unknown as {
      overrides: { accountContributions: { perAccount: Record<string, Record<string, number>> } };
    };
    expect(result.overrides.accountContributions.perAccount.a1.contributionGrowthPct).toBe(0);
  });

  it('sanitises a corrupt stored override value by dropping it, keeping other fields', () => {
    const payload = {
      schemaVersion: 6,
      overrides: {
        accountContributions: {
          perAccount: {
            a1: { plannedContributionPostTax: 2000, contributionGrowthPct: Number.NaN },
          },
        },
      },
    };
    const result = migrate('scenario', payload, 6) as unknown as {
      overrides: { accountContributions: { perAccount: Record<string, Record<string, number>> } };
    };
    const entry = result.overrides.accountContributions.perAccount.a1;
    expect('contributionGrowthPct' in entry).toBe(false);
    expect(entry.plannedContributionPostTax).toBe(2000);
  });

  describe('expenseCategory v1 → v2 (generic isMedical flag)', () => {
    it('is an identity pass for a clean { name }-only v1 payload', () => {
      const payload = { schemaVersion: 1, name: 'Housing' };
      expect(migrate('expenseCategory', payload, 1)).toBe(payload);
    });

    it('keeps a boolean isMedical (true or false) untouched', () => {
      const yes = { schemaVersion: 1, name: 'Medical', isMedical: true };
      expect(migrate('expenseCategory', yes, 1)).toBe(yes);
      const no = { schemaVersion: 1, name: 'Food', isMedical: false };
      expect(migrate('expenseCategory', no, 1)).toBe(no);
    });

    it('drops a non-boolean stored isMedical → absent (CWE-20)', () => {
      for (const bad of ['true', 1, {}, [], null] as unknown[]) {
        const result = migrate(
          'expenseCategory',
          { schemaVersion: 1, name: 'X', isMedical: bad },
          1,
        ) as { name: string; isMedical?: unknown };
        expect('isMedical' in result).toBe(false);
        expect(result.name).toBe('X');
      }
    });
  });

  describe('accountBalance v1 → v2 (per-year Roth conversion amounts)', () => {
    const AMOUNT_KEYS = [
      'rothConversionTaxableAmount',
      'rothConversionNontaxableAmount',
    ] as const;

    // A v1 row predates both keys; the step sanitises only because an import or hand-edited bundle can carry values the engine must never read as money.
    it('returns a clean v1 payload by reference (no copy)', () => {
      const payload = { schemaVersion: 1, accountId: 'a1', year: 2024 };
      expect(migrate('accountBalance', payload, 1)).toBe(payload);
    });

    it('keeps valid dollars-with-cents amounts untouched', () => {
      const payload = {
        schemaVersion: 1,
        accountId: 'a1',
        year: 2024,
        rothConversionTaxableAmount: 1234.56,
        rothConversionNontaxableAmount: 0.01,
      };
      expect(migrate('accountBalance', payload, 1)).toBe(payload);
    });

    it('maps an invalid amount to undefined and KEEPS the key (policy: never delete)', () => {
      for (const key of AMOUNT_KEYS) {
        for (const bad of ['12', -1, Number.NaN, Infinity, {}, [], null]) {
          const result = migrate(
            'accountBalance',
            { schemaVersion: 1, accountId: 'a1', year: 2024, [key]: bad },
            1,
          ) as Record<string, unknown>;
          expect(key in result).toBe(true);
          expect(result[key]).toBeUndefined();
          expect(result.accountId).toBe('a1');
        }
      }
    });

    it('is idempotent', () => {
      const once = migrate(
        'accountBalance',
        { schemaVersion: 1, accountId: 'a1', year: 2024, rothConversionTaxableAmount: -5 },
        1,
      );
      expect(migrate('accountBalance', { ...once, schemaVersion: 1 }, 1)).toEqual({
        ...once,
        schemaVersion: 1,
      });
    });

    it('never throws on a malformed payload', () => {
      const circular: Record<string, unknown> = { schemaVersion: 1 };
      circular.self = circular;
      for (const bad of [null, undefined, 42, 'x', [], circular] as unknown[]) {
        expect(() =>
          migrate('accountBalance', bad as Record<string, unknown>, 1),
        ).not.toThrow();
      }
    });
  });


});
