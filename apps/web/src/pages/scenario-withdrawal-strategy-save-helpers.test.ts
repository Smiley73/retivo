/**
 * Unit tests for the five pure save-helpers.
 * Each helper has a small decision matrix; modal integration tests
 * exercise the common paths but cannot easily enumerate every branch in
 * isolation. These tests pin the contract per branch.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AccountPayload,
  AccountType,
  Aggregate,
  HouseholdMemberPayload,
  MagiCapOverride,
  ScenarioPayload,
} from '../db/types';
import {
  buildNextAcaCoverage,
  buildNextHealthCoverage,
  buildNextCostBasis,
  buildNextCustomOrder,
  buildNextMagiBootstrap,
  buildNextMagiCap,
  buildNextStrategy,
  buildNextTaxAssumptions,
} from './scenario-withdrawal-strategy-save-helpers';
import {
  DEFAULT_COST_BASIS_PCT,
  toDraftHealthRows,
  type DraftMagiCapWindow,
} from './scenario-withdrawal-strategy-shared';

type ScenarioOverrides = ScenarioPayload['overrides'];
const empty: ScenarioOverrides = {};

/** Minimal active account fixture for the prune-aware custom-order helper. */
function acct(id: string, type: AccountType = 'RETIREMENT_401K'): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'hh-1',
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: id,
      type,
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'PRE_TAX',
      ownerId: 'member-1',
      institution: '',
      notes: '',
      planningReturnPct: 7,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 80, bondsPct: 20, cashPct: 0 },
    },
  };
}

/** A single-window cap window (draft + persisted share the shape here). */
function win(over: Partial<DraftMagiCapWindow> = {}): DraftMagiCapWindow {
  return {
    start: { kind: 'retirementStart' },
    end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
    magiCeilingAnnualDollars: 90_000,
    capMode: 'minimize',
    capMagiLine: 'irmaa',
    ...over,
  };
}

const cap: MagiCapOverride = { windows: [win() as MagiCapOverride['windows'][number]] };

describe('buildNextStrategy', () => {
  it('returns override when the user changed kind from the effective value', () => {
    expect(
      buildNextStrategy({
        strategyKind: 'taxEfficient',
        effective: { withdrawalStrategy: { kind: 'rothFirst' } },
        localOverrides: empty,
      }),
    ).toEqual({ withdrawalStrategy: { kind: 'taxEfficient' } });
  });

  it('preserves an existing local override when the user did not touch the picker', () => {
    expect(
      buildNextStrategy({
        strategyKind: 'taxEfficient',
        effective: { withdrawalStrategy: { kind: 'taxEfficient' } },
        localOverrides: { withdrawalStrategy: { kind: 'taxEfficient' } },
      }),
    ).toEqual({ withdrawalStrategy: { kind: 'taxEfficient' } });
  });

  it('omits the key when kind is unchanged AND there is no local override', () => {
    expect(
      buildNextStrategy({
        strategyKind: 'taxEfficient',
        effective: { withdrawalStrategy: { kind: 'taxEfficient' } },
        localOverrides: empty,
      }),
    ).toEqual({});
  });

  it('treats a missing effective.withdrawalStrategy as taxEfficient (the default)', () => {
    expect(
      buildNextStrategy({
        strategyKind: 'taxEfficient',
        effective: empty,
        localOverrides: empty,
      }),
    ).toEqual({});
  });
});

describe('buildNextCostBasis', () => {
  it('returns the fraction when the slider differs from the effective percent', () => {
    expect(
      buildNextCostBasis({
        costBasisPct: 60,
        effective: { assumedCostBasisFractionOfTaxableWithdrawal: 0.5 },
        localOverrides: empty,
      }),
    ).toEqual({ assumedCostBasisFractionOfTaxableWithdrawal: 0.6 });
  });

  it('uses DEFAULT_COST_BASIS_PCT when no effective value is present', () => {
    expect(
      buildNextCostBasis({
        costBasisPct: DEFAULT_COST_BASIS_PCT,
        effective: empty,
        localOverrides: empty,
      }),
    ).toEqual({});
  });

  it('preserves an existing local override when the slider matches effective', () => {
    expect(
      buildNextCostBasis({
        costBasisPct: 50,
        effective: { assumedCostBasisFractionOfTaxableWithdrawal: 0.5 },
        localOverrides: { assumedCostBasisFractionOfTaxableWithdrawal: 0.5 },
      }),
    ).toEqual({ assumedCostBasisFractionOfTaxableWithdrawal: 0.5 });
  });

  it('omits the key when unchanged AND no local override exists', () => {
    expect(
      buildNextCostBasis({
        costBasisPct: 50,
        effective: { assumedCostBasisFractionOfTaxableWithdrawal: 0.5 },
        localOverrides: empty,
      }),
    ).toEqual({});
  });
});

describe('buildNextMagiBootstrap', () => {
  it('omits the key when the engine-default toggle is on', () => {
    expect(buildNextMagiBootstrap({ useEngineDefault: true, magiDraft: 99_999 })).toEqual({});
  });

  it('persists the rounded dollar value into BOTH split lookback fields when the toggle is off', () => {
    expect(buildNextMagiBootstrap({ useEngineDefault: false, magiDraft: 80_000.4 })).toEqual({
      magiBootstrapLookbackMinus2: 80_000,
      magiBootstrapLookbackMinus1: 80_000,
    });
  });

  it('clamps a negative draft to zero (both fields)', () => {
    expect(buildNextMagiBootstrap({ useEngineDefault: false, magiDraft: -500 })).toEqual({
      magiBootstrapLookbackMinus2: 0,
      magiBootstrapLookbackMinus1: 0,
    });
  });
});

describe('buildNextCustomOrder', () => {
  it('persists the tier layout when customOrder is active + draft differs from effective', () => {
    expect(
      buildNextCustomOrder({
        strategyKind: 'customOrder',
        tiers: [['a'], ['b']],
        excludedAccountIds: ['c'],
        effective: empty,
        localOverrides: empty,
        accounts: [acct('a'), acct('b'), acct('c')],
      }),
    ).toEqual({
      customDrawdownOrder: { tiers: [['a'], ['b']], excludedAccountIds: ['c'] },
    });
  });

  it('clears the override (key: undefined) when a non-custom strategy is active', () => {
    expect(
      buildNextCustomOrder({
        strategyKind: 'taxEfficient',
        tiers: [['a']],
        excludedAccountIds: [],
        effective: empty,
        localOverrides: empty,
        accounts: [acct('a')],
      }),
    ).toEqual({ customDrawdownOrder: undefined });
  });

  it('omits the key when the tier layout is inherited + draft still equals inherited', () => {
    expect(
      buildNextCustomOrder({
        strategyKind: 'customOrder',
        tiers: [['a'], ['b']],
        excludedAccountIds: ['c'],
        effective: {
          customDrawdownOrder: { tiers: [['a'], ['b']], excludedAccountIds: ['c'] },
        },
        localOverrides: empty,
        accounts: [acct('a'), acct('b'), acct('c')],
      }),
    ).toEqual({});
  });

  it('persists when an existing local override is present (preserves explicit local)', () => {
    expect(
      buildNextCustomOrder({
        strategyKind: 'customOrder',
        tiers: [['a'], ['b']],
        excludedAccountIds: ['c'],
        effective: {
          customDrawdownOrder: { tiers: [['a'], ['b']], excludedAccountIds: ['c'] },
        },
        localOverrides: {
          customDrawdownOrder: { tiers: [['a'], ['b']], excludedAccountIds: ['c'] },
        },
        accounts: [acct('a'), acct('b'), acct('c')],
      }),
    ).toEqual({
      customDrawdownOrder: { tiers: [['a'], ['b']], excludedAccountIds: ['c'] },
    });
  });

  it('persists when inherited but the draft tier order has been edited', () => {
    expect(
      buildNextCustomOrder({
        strategyKind: 'customOrder',
        tiers: [['b'], ['a']],
        excludedAccountIds: ['c'],
        effective: {
          customDrawdownOrder: { tiers: [['a'], ['b']], excludedAccountIds: ['c'] },
        },
        localOverrides: empty,
        accounts: [acct('a'), acct('b'), acct('c')],
      }),
    ).toEqual({
      customDrawdownOrder: { tiers: [['b'], ['a']], excludedAccountIds: ['c'] },
    });
  });

  // The inherited order can still carry a CBP id (legacy data, or a
  // parent saved before CBP became non-orderable). The draft is already
  // CBP-pruned by seedTierState; the comparison must prune the inherited
  // order the same way so a CBP-only difference is NOT mistaken for an edit.
  it('omits the key when the inherited order differs only by a pruned CBP id (no local override)', () => {
    expect(
      buildNextCustomOrder({
        strategyKind: 'customOrder',
        // Draft: CBP already pruned out by seedTierState.
        tiers: [['acct-401k']],
        excludedAccountIds: [],
        effective: {
          // Inherited: still references the now-non-orderable CBP account.
          customDrawdownOrder: { tiers: [['acct-401k', 'acct-cbp']], excludedAccountIds: [] },
        },
        localOverrides: empty,
        accounts: [acct('acct-401k'), acct('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      }),
    ).toEqual({});
  });

  it('persists when the inherited order differs by a real (non-CBP) edit on top of CBP pruning', () => {
    expect(
      buildNextCustomOrder({
        strategyKind: 'customOrder',
        // Draft moved acct-ira to its own tier (a genuine edit), CBP pruned.
        tiers: [['acct-401k'], ['acct-ira']],
        excludedAccountIds: [],
        effective: {
          customDrawdownOrder: {
            tiers: [['acct-401k', 'acct-ira', 'acct-cbp']],
            excludedAccountIds: [],
          },
        },
        localOverrides: empty,
        accounts: [
          acct('acct-401k'),
          acct('acct-ira'),
          acct('acct-cbp', 'RETIREMENT_CASH_BALANCE'),
        ],
      }),
    ).toEqual({
      customDrawdownOrder: { tiers: [['acct-401k'], ['acct-ira']], excludedAccountIds: [] },
    });
  });
});

/** `buildNextMagiCap` takes the Fill/Minimize + line + target-Roth
 *  fields explicitly from the UI draft. This helper supplies the default draft
 *  values (Minimize / IRMAA / no target) so each test states only the fields it
 *  exercises; the defaults are OMITTED from the written payload (the engine
 *  reads today's behavior from their absence). */
function mc(args: {
  magiCapEnabled: boolean;
  magiCapWindows: DraftMagiCapWindow[];
  localOverrides: ScenarioOverrides;
  parentCap: MagiCapOverride | undefined;
}): Parameters<typeof buildNextMagiCap>[0] {
  return args;
}

describe('buildNextMagiCap', () => {
  it('omits the key when the cap is inherited + no local + draft ladder equals the parent ladder', () => {
    expect(
      buildNextMagiCap(
        mc({
          magiCapEnabled: true,
          magiCapWindows: [win()],
          localOverrides: empty,
          parentCap: cap,
        }),
      ),
    ).toEqual({});
  });

  it('persists a child override when inherited + no local + draft differs from the parent ladder', () => {
    expect(
      buildNextMagiCap(
        mc({
          magiCapEnabled: true,
          magiCapWindows: [win({ magiCeilingAnnualDollars: 200_000 })],
          localOverrides: empty,
          parentCap: cap,
        }),
      ),
    ).toEqual({
      magiCap: { windows: [win({ magiCeilingAnnualDollars: 200_000 })] },
    });
  });

  it('persists the ladder when enabled + no parent cap', () => {
    expect(
      buildNextMagiCap(
        mc({
          magiCapEnabled: true,
          magiCapWindows: [
            win({
              end: { kind: 'age', memberId: 'secondary', years: 67, months: 0 },
              magiCeilingAnnualDollars: 100_000,
            }),
          ],
          localOverrides: empty,
          parentCap: undefined,
        }),
      ),
    ).toEqual({
      magiCap: {
        windows: [
          win({
            end: { kind: 'age', memberId: 'secondary', years: 67, months: 0 },
            magiCeilingAnnualDollars: 100_000,
          }),
        ],
      },
    });
  });

  it('persists a MULTI-window ladder (Fill + Minimize)', () => {
    const fill = win({
      end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      capMode: 'fill',
      targetRothAccountId: 'roth-1',
    });
    const minimize = win({
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'age', memberId: 'primary', years: 70, months: 0 },
      magiCeilingAnnualDollars: 60_000,
    });
    const result = buildNextMagiCap(
      mc({
        magiCapEnabled: true,
        magiCapWindows: [fill, minimize],
        localOverrides: empty,
        parentCap: undefined,
      }),
    ) as { magiCap: MagiCapOverride };
    expect(result.magiCap.windows).toHaveLength(2);
    expect(result.magiCap.windows[0].capMode).toBe('fill');
    expect(result.magiCap.windows[0].targetRothAccountId).toBe('roth-1');
    expect(result.magiCap.windows[1].capMode).toBe('minimize');
  });

  it('writes the disable sentinel when off + a parent cap is active (explicit override)', () => {
    expect(
      buildNextMagiCap(
        mc({
          magiCapEnabled: false,
          magiCapWindows: [win()],
          localOverrides: empty,
          parentCap: cap,
        }),
      ),
    ).toEqual({ magiCap: { disabled: true } });
  });

  it('clears the local override when disabled + no parent cap', () => {
    expect(
      buildNextMagiCap(
        mc({
          magiCapEnabled: false,
          magiCapWindows: [win()],
          localOverrides: { magiCap: cap },
          parentCap: undefined,
        }),
      ),
    ).toEqual({ magiCap: undefined });
  });

  it('persists a real ladder on re-enable after a local disable sentinel (parent cap active)', () => {
    expect(
      buildNextMagiCap(
        mc({
          magiCapEnabled: true,
          magiCapWindows: [win({ magiCeilingAnnualDollars: 75_000 })],
          localOverrides: { magiCap: { disabled: true } },
          parentCap: cap,
        }),
      ),
    ).toEqual({ magiCap: { windows: [win({ magiCeilingAnnualDollars: 75_000 })] } });
  });

  it('omits the targetRothAccountId key when absent for a clean payload', () => {
    const result = buildNextMagiCap(
      mc({
        magiCapEnabled: true,
        magiCapWindows: [win({ capMode: 'minimize', targetRothAccountId: undefined })],
        localOverrides: empty,
        parentCap: undefined,
      }),
    ) as { magiCap: MagiCapOverride };
    expect(
      Object.prototype.hasOwnProperty.call(result.magiCap.windows[0], 'targetRothAccountId'),
    ).toBe(false);
  });

  it('omits the key when disabled + no parent cap + no local override', () => {
    expect(
      buildNextMagiCap(
        mc({
          magiCapEnabled: false,
          magiCapWindows: [win()],
          localOverrides: empty,
          parentCap: undefined,
        }),
      ),
    ).toEqual({});
  });
});

describe('buildNextTaxAssumptions', () => {
  it('persists the emergency-HSA qualified percentage (emergency withdrawals only) when changed from the effective value', () => {
    expect(
      buildNextTaxAssumptions({
        hsaQualifiedPct: 80,
        penaltyExemptIds: [],
        effective: { hsaQualifiedMedicalExpensePct: 100 },
        localOverrides: empty,
        accounts: [],
      }),
    ).toEqual({ hsaQualifiedMedicalExpensePct: 80 });
  });

  it('omits both keys when nothing changed and no local override exists', () => {
    expect(
      buildNextTaxAssumptions({
        hsaQualifiedPct: 100,
        penaltyExemptIds: [],
        effective: empty,
        localOverrides: empty,
        accounts: [],
      }),
    ).toEqual({});
  });

  it('persists the exempt list when the user toggles a live account on', () => {
    expect(
      buildNextTaxAssumptions({
        hsaQualifiedPct: 100,
        penaltyExemptIds: ['acct-a'],
        effective: empty,
        localOverrides: empty,
        accounts: [acct('acct-a')],
      }),
    ).toEqual({ earlyWithdrawalPenaltyExemptAccountIds: ['acct-a'] });
  });

  it('prunes an orphaned id (deleted account) from a LOCAL exempt override on save', () => {
    // The scenario locally exempts acct-a + acct-gone; acct-gone was deleted
    // (absent from `accounts`). Saving drops the orphan and keeps the live id.
    expect(
      buildNextTaxAssumptions({
        hsaQualifiedPct: 100,
        penaltyExemptIds: ['acct-a', 'acct-gone'],
        effective: {
          earlyWithdrawalPenaltyExemptAccountIds: ['acct-a', 'acct-gone'],
        },
        localOverrides: {
          earlyWithdrawalPenaltyExemptAccountIds: ['acct-a', 'acct-gone'],
        },
        accounts: [acct('acct-a')],
      }),
    ).toEqual({ earlyWithdrawalPenaltyExemptAccountIds: ['acct-a'] });
  });

  it('does not materialise a child override when the orphan is purely inherited', () => {
    // No local override; the orphan lives only in the inherited (effective)
    // list. Pruning both sides for the comparison means the lists match after
    // pruning, so no key is written — the inherited orphan is left untouched.
    expect(
      buildNextTaxAssumptions({
        hsaQualifiedPct: 100,
        penaltyExemptIds: ['acct-gone'],
        effective: {
          earlyWithdrawalPenaltyExemptAccountIds: ['acct-gone'],
        },
        localOverrides: empty,
        accounts: [acct('acct-a')],
      }),
    ).toEqual({});
  });

  it('keeps an inactive-but-present account id (restorable, not deleted)', () => {
    const inactive = acct('acct-inactive');
    inactive.payload.active = false;
    expect(
      buildNextTaxAssumptions({
        hsaQualifiedPct: 100,
        penaltyExemptIds: ['acct-inactive'],
        effective: empty,
        localOverrides: {
          earlyWithdrawalPenaltyExemptAccountIds: ['acct-inactive'],
        },
        accounts: [inactive],
      }),
    ).toEqual({ earlyWithdrawalPenaltyExemptAccountIds: ['acct-inactive'] });
  });
});

/** Minimal household-member fixture for the ACA opt-out prune helper. */
function member(id: string): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: 'hh-1',
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary: id === 'm-primary',
      firstName: id,
      lastName: 'Test',
      birthdate: '1962-01-01',
    } as HouseholdMemberPayload,
  };
}

describe('buildNextAcaCoverage', () => {
  it('persists the opt-out set when a live member is toggled off the Marketplace', () => {
    expect(
      buildNextAcaCoverage({
        acaOptOutMemberIds: ['m-secondary'],
        effective: empty,
        localOverrides: empty,
        members: [member('m-primary'), member('m-secondary')],
      }),
    ).toEqual({ acaMarketplaceOptOutMemberIds: ['m-secondary'] });
  });

  it('omits the key when nothing changed and no local override exists (sparse)', () => {
    expect(
      buildNextAcaCoverage({
        acaOptOutMemberIds: [],
        effective: empty,
        localOverrides: empty,
        members: [member('m-primary'), member('m-secondary')],
      }),
    ).toEqual({});
  });

  it('prunes an orphaned id (deleted member) from a LOCAL opt-out override on save', () => {
    expect(
      buildNextAcaCoverage({
        acaOptOutMemberIds: ['m-secondary', 'm-gone'],
        effective: { acaMarketplaceOptOutMemberIds: ['m-secondary', 'm-gone'] },
        localOverrides: { acaMarketplaceOptOutMemberIds: ['m-secondary', 'm-gone'] },
        members: [member('m-primary'), member('m-secondary')],
      }),
    ).toEqual({ acaMarketplaceOptOutMemberIds: ['m-secondary'] });
  });

  it('does not materialise a child override when the orphan is purely inherited', () => {
    expect(
      buildNextAcaCoverage({
        acaOptOutMemberIds: ['m-gone'],
        effective: { acaMarketplaceOptOutMemberIds: ['m-gone'] },
        localOverrides: empty,
        members: [member('m-primary'), member('m-secondary')],
      }),
    ).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildNextHealthCoverage
// ---------------------------------------------------------------------------

describe('buildNextHealthCoverage', () => {
  const members = [member('m-primary'), member('m-secondary')];
  const base = { effective: empty, localOverrides: empty, members };

  it('omits every key when the draft matches the defaults and nothing was local', () => {
    expect(
      buildNextHealthCoverage({
        ...base,
        fplRegion: 'contiguous',
        coverageRows: [],
        benchmarkRows: [],
      }),
    ).toEqual({});
  });

  it('persists a changed region only', () => {
    expect(
      buildNextHealthCoverage({
        ...base,
        fplRegion: 'hawaii',
        coverageRows: [],
        benchmarkRows: [],
      }),
    ).toEqual({ acaFplRegion: 'hawaii' });
  });

  it('keeps a pre-existing LOCAL key even when the draft equals the default', () => {
    expect(
      buildNextHealthCoverage({
        effective: { acaFplRegion: 'alaska' },
        localOverrides: { acaFplRegion: 'alaska' },
        members,
        fplRegion: 'contiguous',
        coverageRows: [],
        benchmarkRows: [],
      }).acaFplRegion,
    ).toBe('contiguous');
  });

  it('stores only the months the user actually stated, clamped to 0..12', () => {
    expect(
      buildNextHealthCoverage({
        ...base,
        fplRegion: 'contiguous',
        coverageRows: [
          {
            memberId: 'm-primary',
            taxYear: 2030,
            partBMonths: 99,
            partDMonths: null,
            marketplaceMonths: 5.9,
          },
        ],
        benchmarkRows: [],
      }).healthCoverageMonths,
    ).toEqual({
      perMember: { 'm-primary': { 2030: { partBMonths: 12, marketplaceMonths: 5 } } },
    });
  });

  it('drops a row that states no month at all and a row whose member is gone', () => {
    expect(
      buildNextHealthCoverage({
        ...base,
        fplRegion: 'contiguous',
        coverageRows: [
          {
            memberId: 'm-primary',
            taxYear: 2030,
            partBMonths: null,
            partDMonths: null,
            marketplaceMonths: null,
          },
          {
            memberId: 'm-deleted',
            taxYear: 2031,
            partBMonths: 6,
            partDMonths: 6,
            marketplaceMonths: null,
          },
        ],
        benchmarkRows: [],
      }),
    ).toEqual({});
  });

  it('dedupes benchmark rows by year (later wins), drops unusable ones, and sorts', () => {
    expect(
      buildNextHealthCoverage({
        ...base,
        fplRegion: 'contiguous',
        coverageRows: [],
        benchmarkRows: [
          { taxYear: 2032, annualSlcspDollars: 9_000 },
          { taxYear: 2030, annualSlcspDollars: 8_000 },
          { taxYear: 2030, annualSlcspDollars: 8_400 },
          { taxYear: 2033, annualSlcspDollars: -1 },
        ],
      }).acaPtcBenchmark,
    ).toEqual([
      { taxYear: 2030, annualSlcspDollars: 8_400 },
      { taxYear: 2032, annualSlcspDollars: 9_000 },
    ]);
  });

  it('does not materialise a child override for a purely-inherited orphan row', () => {
    // The inherited map names a member who no longer exists. Both sides prune to
    // the same empty map, so no local key is written.
    expect(
      buildNextHealthCoverage({
        effective: {
          healthCoverageMonths: { perMember: { 'm-deleted': { 2030: { partBMonths: 6 } } } },
        },
        localOverrides: empty,
        members,
        fplRegion: 'contiguous',
        coverageRows: [
          {
            memberId: 'm-deleted',
            taxYear: 2030,
            partBMonths: 6,
            partDMonths: null,
            marketplaceMonths: null,
          },
        ],
        benchmarkRows: [],
      }),
    ).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildNextHealthCoverage — review regressions
// ---------------------------------------------------------------------------

describe('buildNextHealthCoverage — review regressions', () => {
  const members = [member('m-primary'), member('m-secondary')];
  const base = { effective: empty, localOverrides: empty, members };
  const row = (over: Record<string, unknown> = {}) => ({
    memberId: 'm-primary',
    taxYear: 2030,
    partBMonths: null,
    partDMonths: null,
    marketplaceMonths: null,
    ...over,
  }) as never;

  it('prunes a benchmark row left at $0 rather than storing a verbatim $0 benchmark', () => {
    // Every engine treats a stored override as the household's benchmark plan
    // price, so a `$0` row would floor the premium tax credit to $0 and raise
    // the funded withdrawal — from a row the user only clicked "Add" on.
    expect(
      buildNextHealthCoverage({
        ...base,
        fplRegion: 'contiguous',
        coverageRows: [],
        benchmarkRows: [{ taxYear: 2030, annualSlcspDollars: 0 }],
      }),
    ).toEqual({});
    // A positive price on the same row IS stored.
    expect(
      buildNextHealthCoverage({
        ...base,
        fplRegion: 'contiguous',
        coverageRows: [],
        benchmarkRows: [{ taxYear: 2030, annualSlcspDollars: 9_000 }],
      }),
    ).toEqual({ acaPtcBenchmark: [{ taxYear: 2030, annualSlcspDollars: 9_000 }] });
  });

  it('merges two rows sharing one (member, year) key field-wise instead of dropping the first', () => {
    // Both Add buttons seed the same default key, so adding and filling two rows
    // for one member/year used to discard the earlier row's values silently.
    const next = buildNextHealthCoverage({
      ...base,
      fplRegion: 'contiguous',
      coverageRows: [row({ partBMonths: 7 }), row({ marketplaceMonths: 5 })],
      benchmarkRows: [],
    });
    expect(next.healthCoverageMonths).toEqual({
      perMember: { 'm-primary': { 2030: { partBMonths: 7, marketplaceMonths: 5 } } },
    });
  });

  it('a region-only save does NOT materialise a coverage-months child override when member order differs', () => {
    // The stored map's key order is insertion order; the editor's rows are
    // sorted by (taxYear, memberId). An order-sensitive comparison declared the
    // semantically-identical map "changed" and wrote a child override the
    // "does not materialise" contract forbids.
    const stored = {
      healthCoverageMonths: {
        perMember: {
          'm-secondary': { 2030: { partBMonths: 12 } },
          'm-primary': { 2030: { partBMonths: 7 } },
        },
      },
    };
    const next = buildNextHealthCoverage({
      effective: stored as never,
      localOverrides: empty,
      members,
      fplRegion: 'alaska',
      coverageRows: [
        row({ memberId: 'm-primary', partBMonths: 7 }),
        row({ memberId: 'm-secondary', partBMonths: 12 }),
      ],
      benchmarkRows: [],
    });
    expect(next.acaFplRegion).toBe('alaska');
    expect(next.healthCoverageMonths).toBeUndefined();
  });

  it('a null member / year entry in an IMPORTED map reads as "nothing stated" instead of throwing', () => {
    // `data-import` validates the aggregate envelope and forbidden keys, not
    // override shapes, so `{ perMember: { id: null } }` is reachable. Before the
    // shared reader, seeding the editor from it threw a TypeError that took out
    // the whole Health coverage modal.
    const nullMember = { perMember: { 'm-primary': null } };
    const nullYear = { perMember: { 'm-primary': { 2030: null } } };
    expect(toDraftHealthRows(nullMember as never)).toEqual([]);
    expect(toDraftHealthRows(nullYear as never)).toEqual([]);
    expect(toDraftHealthRows({ perMember: null } as never)).toEqual([]);

    const next = buildNextHealthCoverage({
      effective: { healthCoverageMonths: nullMember } as never,
      localOverrides: empty,
      members,
      fplRegion: 'alaska',
      coverageRows: [],
      benchmarkRows: [],
    });
    expect(next.acaFplRegion).toBe('alaska');
    // Nothing was stated, and the draft states nothing either → no child
    // override is materialised.
    expect(next.healthCoverageMonths).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildNextHealthCoverage — untrusted stored/imported data
// ---------------------------------------------------------------------------

describe('buildNextHealthCoverage — imported-data hardening', () => {
  const members = [member('m-primary'), member('m-secondary')];
  const base = { effective: empty, localOverrides: empty, members };

  // Belt-and-braces: if the guard ever regresses, the assertions below fail
  // FIRST and this only stops one poisoned prototype from cascading into
  // unrelated tests in the same worker.
  afterEach(() => {
    delete (Object.prototype as unknown as Record<string, unknown>)['2030'];
  });

  it('an imported `__proto__` member id cannot pollute Object.prototype (CWE-1321)', () => {
    // `data-import.ts` rejects `__proto__` in KEY position but PERMITS it as an
    // aggregate-id VALUE, so a household member can genuinely carry that id and
    // reach the editor's member picker. Indexing a plain `{}` accumulator with
    // it resolved to `Object.prototype`, so saving the row wrote the tax year
    // onto every object in the page and stored NO own member entry.
    const polluted = member('__proto__');
    const next = buildNextHealthCoverage({
      effective: empty,
      localOverrides: empty,
      members: [...members, polluted],
      fplRegion: 'contiguous',
      coverageRows: [
        {
          memberId: '__proto__',
          taxYear: 2030,
          partBMonths: 6,
          partDMonths: null,
          marketplaceMonths: null,
        },
      ],
      benchmarkRows: [],
    });

    // (1) Nothing leaked onto the prototype chain.
    expect(Object.hasOwn(Object.prototype, '2030')).toBe(false);
    expect(({} as Record<string, unknown>)['2030']).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>)['2030']).toBeUndefined();
    // (2) The dangerous id is not persisted either — the save writes no key at
    //     all, because the only row was dropped and nothing else changed.
    expect(next.healthCoverageMonths).toBeUndefined();
  });

  it('a legitimate member id alongside a `__proto__` one still saves normally', () => {
    const next = buildNextHealthCoverage({
      effective: empty,
      localOverrides: empty,
      members: [...members, member('__proto__')],
      fplRegion: 'contiguous',
      coverageRows: [
        {
          memberId: '__proto__',
          taxYear: 2030,
          partBMonths: 6,
          partDMonths: null,
          marketplaceMonths: null,
        },
        {
          memberId: 'm-primary',
          taxYear: 2030,
          partBMonths: 7,
          partDMonths: null,
          marketplaceMonths: null,
        },
      ],
      benchmarkRows: [],
    });
    expect(Object.hasOwn(Object.prototype, '2030')).toBe(false);
    expect(next.healthCoverageMonths?.perMember).toEqual({
      'm-primary': { 2030: { partBMonths: 7 } },
    });
    expect(Object.keys(next.healthCoverageMonths?.perMember ?? {})).toEqual(['m-primary']);
  });

  it('a malformed stored YEAR key does not spuriously materialise a child override', () => {
    // The stored map arrives from an envelope-only-validated import, so a year
    // key like `"NaN"` is reachable. It used to survive the shared reader, seed
    // an editor row the year picker has no option for, and then be discarded by
    // the save path (which requires an integer year) — so an unrelated save
    // silently dropped it AND wrote a child override that differed from what
    // was inherited.
    const stored = {
      healthCoverageMonths: {
        perMember: { 'm-primary': { NaN: { partBMonths: 6 }, 1999: { partBMonths: 5 } } },
      },
    };
    // The editor seeds from the same shared reader, so both sides agree there
    // is nothing stated.
    expect(toDraftHealthRows(stored.healthCoverageMonths as never)).toEqual([]);
    const next = buildNextHealthCoverage({
      effective: stored as never,
      localOverrides: empty,
      members,
      fplRegion: 'alaska',
      coverageRows: toDraftHealthRows(stored.healthCoverageMonths as never),
      benchmarkRows: [],
    });
    expect(next.acaFplRegion).toBe('alaska');
    expect(next.healthCoverageMonths).toBeUndefined();
  });

  it('a non-array imported benchmark payload reads as "no override" instead of throwing', () => {
    const stored = { acaPtcBenchmark: { taxYear: 2030, annualSlcspDollars: 9_000 } };
    expect(() =>
      buildNextHealthCoverage({
        effective: stored as never,
        localOverrides: empty,
        members,
        fplRegion: 'contiguous',
        coverageRows: [],
        benchmarkRows: [],
      }),
    ).not.toThrow();
    expect(
      buildNextHealthCoverage({
        effective: stored as never,
        localOverrides: empty,
        members,
        fplRegion: 'contiguous',
        coverageRows: [],
        benchmarkRows: [],
      }),
    ).toEqual({});
  });

  it('malformed benchmark rows (bad year, negative or non-numeric price) are dropped', () => {
    expect(
      buildNextHealthCoverage({
        ...base,
        fplRegion: 'contiguous',
        coverageRows: [],
        benchmarkRows: [
          { taxYear: '2030', annualSlcspDollars: 9_000 },
          { taxYear: 1999, annualSlcspDollars: 9_000 },
          { taxYear: 2101, annualSlcspDollars: 9_000 },
          { taxYear: 2030, annualSlcspDollars: '9000' },
          { taxYear: 2031, annualSlcspDollars: Number.NaN },
          null,
          { taxYear: 2032, annualSlcspDollars: 9_600 },
        ] as never,
      }).acaPtcBenchmark,
    ).toEqual([{ taxYear: 2032, annualSlcspDollars: 9_600 }]);
  });
});
