/**
 * Unit tests for the scenario-resolution helpers.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolveScenario,
  resetField,
  resetAllOverrides,
  wouldCreateCycle,
  descendantIds,
  resolveAccountContributionsForScenario,
  resolveAccountReturnsForScenario,
  resolveContributionGrowth,
  resolveInflationForScenario,
  resolveMedicalInflationPct,
  resolvePreRetirementRothConversions,
  resolveQcdForScenario,
  resolveAccountFloorsForScenario,
  resolveDownturnGuardrailsForScenario,
  type ScenarioAggregate,
} from './scenario-resolution';
import type {
  AccountPayload,
  Aggregate,
  DownturnGuardrailsOverride,
  HouseholdMemberPayload,
  QcdEntry,
  ScenarioPayload,
} from '../db/types';

const HOUSEHOLD_ID = 'h1';

function scenario(
  id: string,
  payload: Partial<ScenarioPayload> & { name: string },
  overrides: Partial<ScenarioPayload> = {},
): ScenarioAggregate {
  return {
    id,
    householdId: HOUSEHOLD_ID,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd1',
    aggregateType: 'scenario',
    payload: {
      name: payload.name,
      description: payload.description ?? '',
      parentScenarioId: payload.parentScenarioId ?? null,
      isPrimary: payload.isPrimary ?? false,
      notes: payload.notes ?? '',
      overrides: payload.overrides ?? {},
      ...overrides,
    },
  };
}

describe('resolveScenario', () => {
  it('returns primary overrides when resolving the primary itself', () => {
    const primary = scenario('p', {
      name: 'Primary',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    });
    expect(resolveScenario('p', [primary])).toEqual(primary.payload.overrides);
  });

  it('returns child overrides when child defines the section', () => {
    const primary = scenario('p', {
      name: 'Primary',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    });
    const child = scenario('c', {
      name: 'Aggressive',
      parentScenarioId: 'p',
      overrides: {
        retirementAge: {
          primary: { ageYears: 60, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    });
    const resolved = resolveScenario('c', [primary, child]);
    expect(resolved.retirementAge?.primary).toEqual({ ageYears: 60, ageMonths: 0 });
  });

  it('falls through to parent when child does not override the section', () => {
    const primary = scenario('p', {
      name: 'Primary',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    });
    const child = scenario('c', {
      name: 'Empty',
      parentScenarioId: 'p',
      overrides: {},
    });
    const resolved = resolveScenario('c', [primary, child]);
    expect(resolved.retirementAge?.primary).toEqual({ ageYears: 65, ageMonths: 0 });
  });

  it('walks the chain to the first ancestor with a value (deep tree)', () => {
    const primary = scenario('p', {
      name: 'Primary',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 67, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    });
    const middle = scenario('m', {
      name: 'Middle',
      parentScenarioId: 'p',
      overrides: {},
    });
    const leaf = scenario('l', {
      name: 'Leaf',
      parentScenarioId: 'm',
      overrides: {},
    });
    const resolved = resolveScenario('l', [primary, middle, leaf]);
    expect(resolved.retirementAge?.primary.ageYears).toBe(67);
  });

  it('returns an empty section when no ancestor defines it', () => {
    const primary = scenario('p', {
      name: 'Primary',
      isPrimary: true,
      overrides: {},
    });
    const child = scenario('c', {
      name: 'Child',
      parentScenarioId: 'p',
      overrides: {},
    });
    const resolved = resolveScenario('c', [primary, child]);
    expect(resolved.retirementAge).toBeUndefined();
  });

  it('throws on unknown scenario id', () => {
    expect(() => resolveScenario('missing', [])).toThrow(
      /unknown scenario id missing/,
    );
  });

  it('breaks out of cycles in stored data without infinite-looping', () => {
    const a = scenario('a', { name: 'A', parentScenarioId: 'b' });
    const b = scenario('b', { name: 'B', parentScenarioId: 'a' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => resolveScenario('a', [a, b])).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cycle'),
      expect.any(Object),
    );
    warn.mockRestore();
  });
});

describe('resetField', () => {
  it('removes the section key from overrides', () => {
    const payload: ScenarioPayload = {
      name: 'Child',
      description: '',
      parentScenarioId: 'p',
      isPrimary: false,
      notes: '',
      overrides: {
        retirementAge: {
          primary: { ageYears: 60, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    };
    const next = resetField(payload, 'retirementAge');
    expect(next.overrides.retirementAge).toBeUndefined();
  });

  it('preserves non-overrides fields', () => {
    const payload: ScenarioPayload = {
      name: 'Child',
      description: 'A child plan',
      parentScenarioId: 'p',
      isPrimary: false,
      notes: 'remember this',
      overrides: {
        retirementAge: {
          primary: { ageYears: 60, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    };
    const next = resetField(payload, 'retirementAge');
    expect(next.name).toBe('Child');
    expect(next.description).toBe('A child plan');
    expect(next.parentScenarioId).toBe('p');
    expect(next.isPrimary).toBe(false);
    expect(next.notes).toBe('remember this');
  });

  it('is idempotent on a payload with no override for the section', () => {
    const payload: ScenarioPayload = {
      name: 'Empty',
      description: '',
      parentScenarioId: 'p',
      isPrimary: false,
      notes: '',
      overrides: {},
    };
    expect(resetField(payload, 'retirementAge')).toEqual(payload);
  });
});

describe('resetAllOverrides', () => {
  it('clears overrides entirely', () => {
    const payload: ScenarioPayload = {
      name: 'Child',
      description: '',
      parentScenarioId: 'p',
      isPrimary: false,
      notes: 'keep me',
      overrides: {
        retirementAge: {
          primary: { ageYears: 60, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    };
    const next = resetAllOverrides(payload);
    expect(next.overrides).toEqual({});
  });

  it('preserves notes', () => {
    const payload: ScenarioPayload = {
      name: 'Child',
      description: '',
      parentScenarioId: 'p',
      isPrimary: false,
      notes: 'keep me',
      overrides: { retirementAge: { primary: { ageYears: 60, ageMonths: 0 }, sameDateAnchor: 'primary' } },
    };
    expect(resetAllOverrides(payload).notes).toBe('keep me');
  });
});

describe('wouldCreateCycle', () => {
  const primary = scenario('p', { name: 'Primary', isPrimary: true });
  const a = scenario('a', { name: 'A', parentScenarioId: 'p' });
  const b = scenario('b', { name: 'B', parentScenarioId: 'a' });
  const c = scenario('c', { name: 'C', parentScenarioId: 'b' });
  const all = [primary, a, b, c];

  it('flags self as a parent', () => {
    expect(wouldCreateCycle('a', 'a', all)).toBe(true);
  });

  it('flags a descendant as a parent', () => {
    // Re-parenting A under C (its grandchild) would form a cycle.
    expect(wouldCreateCycle('a', 'c', all)).toBe(true);
  });

  it('allows re-parenting upward to an ancestor', () => {
    // C currently → B → A → primary. Re-parenting C directly to A
    // (its grandparent) does not form a cycle.
    expect(wouldCreateCycle('c', 'a', all)).toBe(false);
  });

  it('allows re-parenting to an unrelated branch', () => {
    const sibling = scenario('s', { name: 'Sibling', parentScenarioId: 'p' });
    expect(wouldCreateCycle('a', 's', [...all, sibling])).toBe(false);
  });

  it('returns false when candidate parent is missing from the inventory', () => {
    expect(wouldCreateCycle('a', 'missing', all)).toBe(false);
  });
});

function makeAccount(
  id: string,
  payload: Partial<AccountPayload> = {},
): Aggregate<AccountPayload> {
  return {
    id,
    householdId: HOUSEHOLD_ID,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd1',
    aggregateType: 'account',
    payload: {
      name: payload.name ?? `Account ${id}`,
      type: payload.type ?? 'RETIREMENT_401K',
      ownershipType: payload.ownershipType ?? 'INDIVIDUAL',
      taxTreatment: payload.taxTreatment ?? 'MIXED',
      ownerId: payload.ownerId ?? 'm1',
      institution: payload.institution ?? 'Vanguard',
      notes: payload.notes ?? '',
      planningReturnPct: payload.planningReturnPct ?? 5,
      active: payload.active ?? true,
      plannedContributionPreTax: payload.plannedContributionPreTax ?? 1000,
      plannedContributionPostTax: payload.plannedContributionPostTax ?? 500,
      ...(payload.contributionGrowthPct !== undefined
        ? { contributionGrowthPct: payload.contributionGrowthPct }
        : {}),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  };
}

describe('resolvePreRetirementRothConversions', () => {
  const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    sourceAccountId: 'pre',
    targetRothAccountId: 'roth',
    annualAmountDollars: 10_000,
    start: { kind: 'year', year: 2026 },
    end: { kind: 'year', year: 2030 },
    ...overrides,
  });
  const accounts = [
    makeAccount('pre', { type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX' }),
    makeAccount('roth', { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' }),
  ].map((a) => ({ id: a.id, payload: a.payload }));

  function withConv(overrides: Record<string, unknown>): ScenarioAggregate {
    return scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: overrides as ScenarioPayload['overrides'],
    });
  }

  it('returns a validated entry + clamped rate for a well-formed config', () => {
    const sc = withConv({
      preRetirementRothConversions: [entry()],
      preRetirementRothConversionTaxRatePct: 24,
    });
    const r = resolvePreRetirementRothConversions('p', [sc], accounts);
    expect(r.conversions).toHaveLength(1);
    expect(r.conversions[0].annualAmountDollars).toBe(10_000);
    expect(r.taxRatePct).toBe(24);
  });

  it('defaults the rate to 0 when absent', () => {
    const sc = withConv({ preRetirementRothConversions: [entry()] });
    const r = resolvePreRetirementRothConversions('p', [sc], accounts);
    expect(r.taxRatePct).toBe(0);
  });

  it('clamps an out-of-range tax rate to [0, 100]', () => {
    expect(
      resolvePreRetirementRothConversions(
        'p',
        [withConv({ preRetirementRothConversions: [entry()], preRetirementRothConversionTaxRatePct: 250 })],
        accounts,
      ).taxRatePct,
    ).toBe(100);
    expect(
      resolvePreRetirementRothConversions(
        'p',
        [withConv({ preRetirementRothConversions: [entry()], preRetirementRothConversionTaxRatePct: -5 })],
        accounts,
      ).taxRatePct,
    ).toBe(0);
  });

  it('drops a non-finite amount entry (CWE-20)', () => {
    const sc = withConv({
      preRetirementRothConversions: [entry({ annualAmountDollars: Number.POSITIVE_INFINITY })],
    });
    expect(resolvePreRetirementRothConversions('p', [sc], accounts).conversions).toHaveLength(0);
  });

  it('clamps a negative amount to 0', () => {
    const sc = withConv({ preRetirementRothConversions: [entry({ annualAmountDollars: -500 })] });
    const r = resolvePreRetirementRothConversions('p', [sc], accounts);
    expect(r.conversions).toHaveLength(1);
    expect(r.conversions[0].annualAmountDollars).toBe(0);
  });

  it('drops a dangling / cross-household source or target id', () => {
    expect(
      resolvePreRetirementRothConversions(
        'p',
        [withConv({ preRetirementRothConversions: [entry({ sourceAccountId: 'ghost' })] })],
        accounts,
      ).conversions,
    ).toHaveLength(0);
    expect(
      resolvePreRetirementRothConversions(
        'p',
        [withConv({ preRetirementRothConversions: [entry({ targetRothAccountId: 'ghost' })] })],
        accounts,
      ).conversions,
    ).toHaveLength(0);
  });

  it('drops an entry whose source is POST_TAX (not a valid source type)', () => {
    const accts = [
      makeAccount('pre', { type: 'BROKERAGE', taxTreatment: 'POST_TAX' }),
      makeAccount('roth', { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' }),
    ].map((a) => ({ id: a.id, payload: a.payload }));
    const sc = withConv({ preRetirementRothConversions: [entry()] });
    expect(resolvePreRetirementRothConversions('p', [sc], accts).conversions).toHaveLength(0);
  });

  it('keeps an entry whose source is a MIXED 401k', () => {
    const accts = [
      makeAccount('pre', { type: 'RETIREMENT_401K', taxTreatment: 'MIXED', ownerId: 'm1' }),
      makeAccount('roth', { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH', ownerId: 'm1' }),
    ].map((a) => ({ id: a.id, payload: a.payload }));
    const sc = withConv({ preRetirementRothConversions: [entry()] });
    expect(resolvePreRetirementRothConversions('p', [sc], accts).conversions).toHaveLength(1);
  });

  it('keeps a same-account MIXED in-plan conversion', () => {
    const accts = [
      makeAccount('pre', { type: 'RETIREMENT_401K', taxTreatment: 'MIXED', ownerId: 'm1' }),
    ].map((a) => ({ id: a.id, payload: a.payload }));
    const sameAccountEntry = {
      sourceAccountId: 'pre',
      targetRothAccountId: 'pre', // same id
      annualAmountDollars: 10_000,
      start: { kind: 'year', year: 2026 },
      end: { kind: 'year', year: 2030 },
    };
    const sc = withConv({ preRetirementRothConversions: [sameAccountEntry] });
    const r = resolvePreRetirementRothConversions('p', [sc], accts);
    expect(r.conversions).toHaveLength(1);
    expect(r.conversions[0].targetRothAccountId).toBe('pre');
  });

  it('drops a denied pair: MIXED source + cross-account dedicated-Roth 401k target (deferral)', () => {
    // A separate RETIREMENT_ROTH_401K account — a deferred case; only
    // same-account MIXED in-plan conversions are accepted, not separate Roth employer targets.
    const accts = [
      makeAccount('pre', { type: 'RETIREMENT_401K', taxTreatment: 'MIXED', ownerId: 'm1' }),
      makeAccount('roth', { type: 'RETIREMENT_ROTH_401K', taxTreatment: 'ROTH', ownerId: 'm1' }),
    ].map((a) => ({ id: a.id, payload: a.payload }));
    const sc = withConv({ preRetirementRothConversions: [entry()] });
    expect(resolvePreRetirementRothConversions('p', [sc], accts).conversions).toHaveLength(0);
  });

  it('drops an entry whose target is NOT a Roth IRA and NOT the same-account MIXED (§408A guard)', () => {
    // A designated Roth 401(k) as a separate account would silently no-op the basis fold.
    const accts = [
      makeAccount('pre', { type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX', ownerId: 'm1' }),
      makeAccount('roth', { type: 'RETIREMENT_401K', taxTreatment: 'ROTH', ownerId: 'm1' }),
    ].map((a) => ({ id: a.id, payload: a.payload }));
    const sc = withConv({ preRetirementRothConversions: [entry()] });
    expect(resolvePreRetirementRothConversions('p', [sc], accts).conversions).toHaveLength(0);
  });

  it('drops a cross-owner pair (IRC §408A is per-individual)', () => {
    const accts = [
      makeAccount('pre', { type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX', ownerId: 'm1' }),
      makeAccount('roth', { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH', ownerId: 'm2' }),
    ].map((a) => ({ id: a.id, payload: a.payload }));
    const sc = withConv({ preRetirementRothConversions: [entry()] });
    expect(resolvePreRetirementRothConversions('p', [sc], accts).conversions).toHaveLength(0);
  });

  it('preserves stored array order for same-source entries', () => {
    const sc = withConv({
      preRetirementRothConversions: [
        entry({ annualAmountDollars: 1_000 }),
        entry({ annualAmountDollars: 2_000 }),
      ],
    });
    const r = resolvePreRetirementRothConversions('p', [sc], accounts);
    expect(r.conversions.map((c) => c.annualAmountDollars)).toEqual([1_000, 2_000]);
  });
});

function makeMember(
  id: string,
  birthdate: string,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: HOUSEHOLD_ID,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd1',
    aggregateType: 'householdMember',
    payload: {
      isPrimary: id === 'm1',
      firstName: id,
      lastName: 'Doe',
      email: `${id}@x.test`,
      birthdate,
    },
  };
}

describe('resolveQcdForScenario', () => {
  // m1 born 1954-01-15 → first eligible tax year 2024.
  const members = [makeMember('m1', '1954-01-15'), makeMember('m2', '1980-01-01')];
  const accounts = [
    makeAccount('ira', { type: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX', ownerId: 'm1' }),
  ].map((a) => ({ id: a.id, payload: a.payload }));

  const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    memberId: 'm1',
    sourceAccountId: 'ira',
    annualAmountDollars: 10_000,
    start: { kind: 'year', year: 2030 },
    end: { kind: 'year', year: 2040 },
    ...overrides,
  });

  function withQcd(qcd: unknown[]): ScenarioAggregate {
    return scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: { qualifiedCharitableDistributions: qcd } as ScenarioPayload['overrides'],
    });
  }

  it('passes a well-formed entry through with the correct fields', () => {
    const r = resolveQcdForScenario('p', [withQcd([entry()])], accounts, members);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].memberId).toBe('m1');
    expect(r.entries[0].sourceAccountId).toBe('ira');
    expect(r.entries[0].annualAmountDollars).toBe(10_000);
    expect(r.entries[0].start).toEqual({ kind: 'year', year: 2030 });
    expect(r.entries[0].end).toEqual({ kind: 'year', year: 2040 });
  });

  it('clamps the start up to the 70½ first-eligible tax year', () => {
    // start 2020 < floor 2024 → clamped to 2024.
    const r = resolveQcdForScenario(
      'p',
      [withQcd([entry({ start: { kind: 'year', year: 2020 } })])],
      accounts,
      members,
    );
    expect(r.entries[0].start).toEqual({ kind: 'year', year: 2024 });
  });

  it('resolves numeric startYear (clamped to the 70½ floor) + exclusive endYear', () => {
    // start 2020 < floor 2024 → startYear clamped to 2024; a `year` end of 2040
    // resolves to the EXCLUSIVE boundary 2041 (active through 2040).
    const r = resolveQcdForScenario(
      'p',
      [withQcd([entry({ start: { kind: 'year', year: 2020 }, end: { kind: 'year', year: 2040 } })])],
      accounts,
      members,
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].startYear).toBe(2024);
    expect(r.entries[0].endYear).toBe(2041);
  });

  it('drops a cross-owner source (account owned by m2, entry says m1)', () => {
    const accts = [
      makeAccount('ira', { type: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX', ownerId: 'm2' }),
    ].map((a) => ({ id: a.id, payload: a.payload }));
    const r = resolveQcdForScenario('p', [withQcd([entry()])], accts, members);
    expect(r.entries).toHaveLength(0);
  });

  it('drops a non-IRA source (brokerage)', () => {
    const accts = [
      makeAccount('ira', { type: 'BROKERAGE', taxTreatment: 'POST_TAX', ownerId: 'm1' }),
    ].map((a) => ({ id: a.id, payload: a.payload }));
    const r = resolveQcdForScenario('p', [withQcd([entry()])], accts, members);
    expect(r.entries).toHaveLength(0);
  });

  it('drops a non-PRE_TAX source (Roth IRA)', () => {
    const accts = [
      makeAccount('ira', { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH', ownerId: 'm1' }),
    ].map((a) => ({ id: a.id, payload: a.payload }));
    const r = resolveQcdForScenario('p', [withQcd([entry()])], accts, members);
    expect(r.entries).toHaveLength(0);
  });

  it('drops a dangling memberId', () => {
    const r = resolveQcdForScenario('p', [withQcd([entry({ memberId: 'ghost' })])], accounts, members);
    expect(r.entries).toHaveLength(0);
  });

  it('drops a dangling sourceAccountId', () => {
    const r = resolveQcdForScenario('p', [withQcd([entry({ sourceAccountId: 'ghost' })])], accounts, members);
    expect(r.entries).toHaveLength(0);
  });

  it('drops a non-finite annualAmountDollars', () => {
    const r = resolveQcdForScenario(
      'p',
      [withQcd([entry({ annualAmountDollars: Number.POSITIVE_INFINITY })])],
      accounts,
      members,
    );
    expect(r.entries).toHaveLength(0);
  });

  it('clamps a negative annualAmountDollars to 0', () => {
    const r = resolveQcdForScenario(
      'p',
      [withQcd([entry({ annualAmountDollars: -500 })])],
      accounts,
      members,
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].annualAmountDollars).toBe(0);
  });

  it('drops an invalid window (start >= end after clamp)', () => {
    const r = resolveQcdForScenario(
      'p',
      [withQcd([entry({ start: { kind: 'year', year: 2040 }, end: { kind: 'year', year: 2035 } })])],
      accounts,
      members,
    );
    expect(r.entries).toHaveLength(0);
  });

  it('keeps a single-year YEAR window {start:Y, end:Y} (end is inclusive)', () => {
    // Y comfortably above m1's 70½ floor (2024). The `year` end resolves to the
    // EXCLUSIVE boundary Y+1, so startYear 2030 < endYear 2031 → kept.
    const r = resolveQcdForScenario(
      'p',
      [withQcd([entry({ start: { kind: 'year', year: 2030 }, end: { kind: 'year', year: 2030 } })])],
      accounts,
      members,
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].start).toEqual({ kind: 'year', year: 2030 });
    expect(r.entries[0].end).toEqual({ kind: 'year', year: 2030 });
  });

  it('drops a genuinely inverted YEAR window {start:Y+1, end:Y}', () => {
    // startYear 2031 >= exclusive endYear 2031 (2030 + 1) → empty span, dropped.
    const r = resolveQcdForScenario(
      'p',
      [withQcd([entry({ start: { kind: 'year', year: 2031 }, end: { kind: 'year', year: 2030 } })])],
      accounts,
      members,
    );
    expect(r.entries).toHaveLength(0);
  });

  it('resolves an age-anchored window against the owner birth year', () => {
    // m1 born 1954 → age 75 = 2029, age 90 = 2044; floor 2024 < 2029.
    const r = resolveQcdForScenario(
      'p',
      [
        withQcd([
          entry({
            start: { kind: 'age', years: 75, months: 0 },
            end: { kind: 'age', years: 90, months: 0 },
          }),
        ]),
      ],
      accounts,
      members,
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].start).toEqual({ kind: 'year', year: 2029 });
  });

  it('is prototype-safe against an Object.create(null) account map edge case', () => {
    // A source id matching a dangerous prototype key must not resolve via the
    // prototype chain — the resolver uses a Map, so "__proto__" is a miss.
    const r = resolveQcdForScenario(
      'p',
      [withQcd([entry({ sourceAccountId: '__proto__' })])],
      accounts,
      members,
    );
    expect(r.entries).toHaveLength(0);
  });

  it('drops a malformed null start anchor without throwing', () => {
    let r: ReturnType<typeof resolveQcdForScenario>;
    expect(() => {
      r = resolveQcdForScenario(
        'p',
        [withQcd([entry({ start: null })])],
        accounts,
        members,
      );
    }).not.toThrow();
    expect(r!.entries).toHaveLength(0);
  });

  it('drops a garbage-kind start anchor without throwing', () => {
    let r: ReturnType<typeof resolveQcdForScenario>;
    expect(() => {
      r = resolveQcdForScenario(
        'p',
        [withQcd([entry({ start: { kind: 'garbage' } })])],
        accounts,
        members,
      );
    }).not.toThrow();
    expect(r!.entries).toHaveLength(0);
  });

  it('returns empty when the section is absent', () => {
    const sc = scenario('p', { name: 'Base', isPrimary: true });
    expect(resolveQcdForScenario('p', [sc], accounts, members).entries).toHaveLength(0);
  });

  it('honors `months` on an age anchor that crosses into the next tax year', () => {
    // Owner born December 1950. Age {years:80, months:11} resolves month-precise:
    // birth month index = 1950*12 + 11; + (80*12 + 11) months crosses December
    // into the next calendar year → tax year 2031, not 2030 (birthYear+years).
    // Start well above 70½ (floor 2021) so the clamp does not mask the month.
    const decMembers = [makeMember('m1', '1950-12-15'), makeMember('m2', '1980-01-01')];
    const r = resolveQcdForScenario(
      'p',
      [
        withQcd([
          entry({
            start: { kind: 'age', years: 80, months: 11 },
            end: { kind: 'year', year: 2040 },
          }),
        ]),
      ],
      accounts,
      decMembers,
    );
    expect(r.entries).toHaveLength(1);
    // years-only would give 1950 + 80 = 2030; month-crossing pushes to 2031.
    expect(r.entries[0].start).toEqual({ kind: 'year', year: 2031 });
  });

  it('resolves an age anchor with months:0 to birthYear + years (unchanged)', () => {
    const decMembers = [makeMember('m1', '1950-12-15'), makeMember('m2', '1980-01-01')];
    const r = resolveQcdForScenario(
      'p',
      [
        withQcd([
          entry({
            start: { kind: 'age', years: 80, months: 0 },
            end: { kind: 'year', year: 2040 },
          }),
        ]),
      ],
      accounts,
      decMembers,
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].start).toEqual({ kind: 'year', year: 2030 });
  });

  it('coerces a non-array qualifiedCharitableDistributions to empty without throwing', () => {
    const malformed = scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        qualifiedCharitableDistributions: {} as unknown as QcdEntry[],
      } as ScenarioPayload['overrides'],
    });
    let r: ReturnType<typeof resolveQcdForScenario>;
    expect(() => {
      r = resolveQcdForScenario('p', [malformed], accounts, members);
    }).not.toThrow();
    expect(r!.entries).toHaveLength(0);
  });
});

describe('resolveAccountContributionsForScenario', () => {
  it('returns baseline values when no scenario in the chain overrides', () => {
    const primary = scenario('p', { name: 'Base', isPrimary: true });
    const acct = makeAccount('a1', {
      plannedContributionPreTax: 8000,
      plannedContributionPostTax: 2000,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    });
    const result = resolveAccountContributionsForScenario('p', [primary], [acct]);
    expect(result.get('a1')).toEqual({
      plannedContributionPreTax: 8000,
      plannedContributionPostTax: 2000,
    });
  });

  it('applies overrides from the current scenario', () => {
    const primary = scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountContributions: {
          perAccount: {
            a1: { plannedContributionPreTax: 15000, plannedContributionPostTax: 5000 },
          },
        },
      },
    });
    const acct = makeAccount('a1');
    const result = resolveAccountContributionsForScenario('p', [primary], [acct]);
    expect(result.get('a1')).toEqual({
      plannedContributionPreTax: 15000,
      plannedContributionPostTax: 5000,
    });
  });

  it('walks the chain per-account: child override on A, parent override on B', () => {
    // The point: child overrides only account A; account B's parent
    // override survives in the resolved view. This is the per-key
    // inheritance the UI's "resolved-from-parent" baseline depends on.
    const primary = scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountContributions: {
          perAccount: {
            a: { plannedContributionPreTax: 1000, plannedContributionPostTax: 100 },
            b: { plannedContributionPreTax: 2000, plannedContributionPostTax: 200 },
          },
        },
      },
    });
    const child = scenario('c', {
      name: 'Child',
      parentScenarioId: 'p',
      overrides: {
        accountContributions: {
          perAccount: {
            a: { plannedContributionPreTax: 9999 },
          },
        },
      },
    });
    const accts = [
      makeAccount('a', { plannedContributionPreTax: 50, plannedContributionPostTax: 50 }),
      makeAccount('b', { plannedContributionPreTax: 50, plannedContributionPostTax: 50 }),
    ];
    const result = resolveAccountContributionsForScenario('c', [primary, child], accts);
    // A: pre overridden in child → 9999. Post not set in child → falls to parent's 100.
    expect(result.get('a')).toEqual({
      plannedContributionPreTax: 9999,
      plannedContributionPostTax: 100,
    });
    // B: no override in child → parent's values both survive.
    expect(result.get('b')).toEqual({
      plannedContributionPreTax: 2000,
      plannedContributionPostTax: 200,
    });
  });

  it('per-field fallback through the chain: pre from child, post from parent, neither from grandparent', () => {
    const base = scenario('base', {
      name: 'Base',
      isPrimary: true,
      // No accountContributions in base — exercises the account-baseline fallback.
    });
    const middle = scenario('mid', {
      name: 'Middle',
      parentScenarioId: 'base',
      overrides: {
        accountContributions: {
          perAccount: { a: { plannedContributionPostTax: 777 } },
        },
      },
    });
    const leaf = scenario('leaf', {
      name: 'Leaf',
      parentScenarioId: 'mid',
      overrides: {
        accountContributions: {
          perAccount: { a: { plannedContributionPreTax: 333 } },
        },
      },
    });
    const acct = makeAccount('a', {
      plannedContributionPreTax: 50,
      plannedContributionPostTax: 60,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    });
    const result = resolveAccountContributionsForScenario(
      'leaf',
      [base, middle, leaf],
      [acct],
    );
    expect(result.get('a')).toEqual({
      plannedContributionPreTax: 333, // leaf
      plannedContributionPostTax: 777, // middle
    });
  });

  it('ignores stale accountIds in the override map (no such account)', () => {
    const primary = scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountContributions: {
          perAccount: {
            ghost: { plannedContributionPreTax: 99999 },
          },
        },
      },
    });
    const acct = makeAccount('real', { plannedContributionPreTax: 100 });
    const result = resolveAccountContributionsForScenario('p', [primary], [acct]);
    expect(result.get('real')?.plannedContributionPreTax).toBe(100);
    expect(result.has('ghost')).toBe(false);
  });
});

describe('resolveAccountReturnsForScenario', () => {
  it('returns baseline planningReturnPct when no override', () => {
    const primary = scenario('p', { name: 'Base', isPrimary: true });
    const acct = makeAccount('a1', { planningReturnPct: 6.5 });
    const result = resolveAccountReturnsForScenario('p', [primary], [acct]);
    expect(result.get('a1')).toBe(6.5);
  });

  it('overrides at the current scenario', () => {
    const primary = scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountReturns: { perAccount: { a1: { planningReturnPct: 3.5 } } },
      },
    });
    const acct = makeAccount('a1', { planningReturnPct: 6.5 });
    const result = resolveAccountReturnsForScenario('p', [primary], [acct]);
    expect(result.get('a1')).toBe(3.5);
  });

  it('per-account walks: child A wins, parent B survives in child', () => {
    const primary = scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountReturns: {
          perAccount: {
            a: { planningReturnPct: 5 },
            b: { planningReturnPct: 4 },
          },
        },
      },
    });
    const child = scenario('c', {
      name: 'Child',
      parentScenarioId: 'p',
      overrides: {
        accountReturns: { perAccount: { a: { planningReturnPct: 7 } } },
      },
    });
    const accts = [
      makeAccount('a', { planningReturnPct: 1 }),
      makeAccount('b', { planningReturnPct: 1 }),
    ];
    const result = resolveAccountReturnsForScenario('c', [primary, child], accts);
    expect(result.get('a')).toBe(7);
    expect(result.get('b')).toBe(4);
  });

  it('falls back to baseline when chain has no return overrides anywhere', () => {
    const primary = scenario('p', { name: 'Base', isPrimary: true });
    const child = scenario('c', { name: 'Child', parentScenarioId: 'p' });
    const acct = makeAccount('a', { planningReturnPct: 2.5 });
    const result = resolveAccountReturnsForScenario('c', [primary, child], [acct]);
    expect(result.get('a')).toBe(2.5);
  });

  it('allows negative override rates (modeling loss assumptions)', () => {
    const primary = scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountReturns: { perAccount: { a: { planningReturnPct: -2 } } },
      },
    });
    const acct = makeAccount('a', { planningReturnPct: 5 });
    expect(resolveAccountReturnsForScenario('p', [primary], [acct]).get('a')).toBe(-2);
  });
});

describe('descendantIds', () => {
  const primary = scenario('p', { name: 'Primary', isPrimary: true });
  const a = scenario('a', { name: 'A', parentScenarioId: 'p' });
  const b = scenario('b', { name: 'B', parentScenarioId: 'a' });
  const c = scenario('c', { name: 'C', parentScenarioId: 'b' });
  const sibling = scenario('s', { name: 'Sibling', parentScenarioId: 'p' });

  it('returns the scenario itself plus all transitive descendants', () => {
    expect(descendantIds('a', [primary, a, b, c, sibling])).toEqual(
      new Set(['a', 'b', 'c']),
    );
  });

  it('returns just the scenario when it has no children', () => {
    expect(descendantIds('c', [primary, a, b, c])).toEqual(new Set(['c']));
  });
});

describe('resolveInflationForScenario', () => {
  const inflationScenario = (
    id: string,
    parentScenarioId: string | null,
    inflation: { ratePct?: number; categoryRates?: Record<string, number> } | undefined,
    isPrimary = false,
  ): ScenarioAggregate =>
    scenario(id, {
      name: id,
      isPrimary,
      parentScenarioId,
      overrides: inflation
        ? {
            inflation: {
              ratePct: inflation.ratePct ?? 3,
              ...(inflation.categoryRates
                ? { categoryRates: inflation.categoryRates }
                : {}),
            },
          }
        : {},
    });

  it('Medical default = general + 2pp, others = general', () => {
    const base = inflationScenario('b', null, { ratePct: 3 }, true);
    const r = resolveInflationForScenario('b', [base]);
    expect(r.ratePct).toBe(3);
    expect(r.categoryRates.get('cat-medical')).toBe(5);
    // A non-medical category has no entry → defaults to general at read.
    expect(r.categoryRates.get('cat-food')).toBeUndefined();
  });

  it('the materialised Medical default tracks an overridden general rate', () => {
    const base = inflationScenario('b', null, { ratePct: 6 }, true);
    const r = resolveInflationForScenario('b', [base]);
    expect(r.ratePct).toBe(6);
    expect(r.categoryRates.get('cat-medical')).toBe(8);
  });

  it('defaults general to 3% when no scenario in the chain sets it', () => {
    const base = scenario('b', { name: 'b', isPrimary: true, overrides: {} });
    const r = resolveInflationForScenario('b', [base]);
    expect(r.ratePct).toBe(3);
    expect(r.categoryRates.get('cat-medical')).toBe(5);
  });

  it('per-key first-ancestor-wins: child overriding one category keeps parent general + other categories', () => {
    const parent = inflationScenario('p', null, {
      ratePct: 4,
      categoryRates: { 'cat-housing': 6 },
    }, true);
    // Child sets only Food; it must NOT clobber parent general (4) or the
    // parent's Housing override.
    const child = inflationScenario('c', 'p', {
      ratePct: 4,
      categoryRates: { 'cat-food': 2 },
    });
    const r = resolveInflationForScenario('c', [parent, child]);
    expect(r.ratePct).toBe(4);
    expect(r.categoryRates.get('cat-food')).toBe(2);
    expect(r.categoryRates.get('cat-housing')).toBe(6);
    // Medical default tracks the resolved general (4 + 2).
    expect(r.categoryRates.get('cat-medical')).toBe(6);
  });

  it('an explicit Medical override wins over the +2pp default', () => {
    const base = inflationScenario('b', null, {
      ratePct: 3,
      categoryRates: { 'cat-medical': 4 },
    }, true);
    const r = resolveInflationForScenario('b', [base]);
    expect(r.categoryRates.get('cat-medical')).toBe(4);
  });

  it('materialises +2pp (uncapped) for EVERY id in an explicit medical set the chain has not set', () => {
    const base = inflationScenario('b', null, { ratePct: 3 }, true);
    const set = new Set(['cat-medical-recreated-uuid', 'cat-second-medical']);
    const r = resolveInflationForScenario('b', [base], set);
    // A recreated Medical (new id) flagged in the set now GETS +2pp (inverts
    // the legacy "recreated defaults to general" behaviour). The seeded id is
    // NOT in this set, so it has no default entry.
    expect(r.categoryRates.get('cat-medical-recreated-uuid')).toBe(5);
    expect(r.categoryRates.get('cat-second-medical')).toBe(5);
    expect(r.categoryRates.get('cat-medical')).toBeUndefined();
  });

  it('legacy default: with the param omitted, +2pp materialises for cat-medical only', () => {
    const base = inflationScenario('b', null, { ratePct: 3 }, true);
    const r = resolveInflationForScenario('b', [base]);
    expect(r.categoryRates.get('cat-medical')).toBe(5);
    expect(r.categoryRates.get('cat-medical-recreated-uuid')).toBeUndefined();
  });

  it('an explicit override on a flagged medical id wins over the +2pp default', () => {
    const base = inflationScenario('b', null, {
      ratePct: 3,
      categoryRates: { 'cat-care': 4 },
    }, true);
    const r = resolveInflationForScenario('b', [base], new Set(['cat-care']));
    expect(r.categoryRates.get('cat-care')).toBe(4);
  });

  it('a dangling/orphan categoryRates key resolves inert without leaking onto siblings', () => {
    const base = inflationScenario('b', null, {
      ratePct: 3,
      categoryRates: { 'cat-deleted-orphan': 7, 'cat-food': 2 },
    }, true);
    const r = resolveInflationForScenario('b', [base]);
    // The orphan key is preserved in the resolved map (inert — no expense
    // carries it) but does not affect the live Food rate.
    expect(r.categoryRates.get('cat-deleted-orphan')).toBe(7);
    expect(r.categoryRates.get('cat-food')).toBe(2);
  });

  it('drops a __proto__ / NaN / out-of-range entry and does not pollute Object.prototype', () => {
    const base = inflationScenario('b', null, {
      ratePct: 3,
      categoryRates: {
        ['__proto__' as string]: 9,
        ['constructor' as string]: 9,
        ['prototype' as string]: 9,
        'cat-nan': Number.NaN,
        'cat-too-high': 99,
        'cat-negative': -4,
        'cat-ok': 5,
      },
    }, true);
    const r = resolveInflationForScenario('b', [base]);
    expect(r.categoryRates.get('__proto__')).toBeUndefined();
    expect(r.categoryRates.get('constructor')).toBeUndefined();
    expect(r.categoryRates.get('prototype')).toBeUndefined();
    expect(r.categoryRates.get('cat-nan')).toBeUndefined();
    expect(r.categoryRates.get('cat-too-high')).toBeUndefined();
    expect(r.categoryRates.get('cat-negative')).toBeUndefined();
    expect(r.categoryRates.get('cat-ok')).toBe(5);
    // No prototype pollution.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['9']).toBeUndefined();
  });
});

describe('resolveContributionGrowth', () => {
  it('absent everywhere → tracks-inflation at the scenario general rate', () => {
    const primary = scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: { inflation: { ratePct: 4 } },
    });
    const acct = makeAccount('a1'); // no contributionGrowthPct
    const r = resolveContributionGrowth('p', [primary], [acct]);
    expect(r.get('a1')).toEqual({ mode: 'tracks-inflation', ratePct: 4 });
  });

  it('absent + no inflation override → tracks-inflation at the 3% default', () => {
    const primary = scenario('p', { name: 'Base', isPrimary: true });
    const acct = makeAccount('a1');
    const r = resolveContributionGrowth('p', [primary], [acct]);
    expect(r.get('a1')).toEqual({ mode: 'tracks-inflation', ratePct: 3 });
  });

  it('account baseline explicit rate → fixed mode', () => {
    const primary = scenario('p', { name: 'Base', isPrimary: true });
    const acct = makeAccount('a1', { contributionGrowthPct: 2.5 });
    const r = resolveContributionGrowth('p', [primary], [acct]);
    expect(r.get('a1')).toEqual({ mode: 'fixed', ratePct: 2.5 });
  });

  it('explicit 0 is preserved as fixed (flat-nominal), NOT collapsed to tracks-inflation', () => {
    const primary = scenario('p', { name: 'Base', isPrimary: true });
    const acct = makeAccount('a1', { contributionGrowthPct: 0 });
    const r = resolveContributionGrowth('p', [primary], [acct]);
    expect(r.get('a1')).toEqual({ mode: 'fixed', ratePct: 0 });
  });

  it('scenario override wins over the account baseline (override > baseline)', () => {
    const primary = scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountContributions: {
          perAccount: { a1: { contributionGrowthPct: 6 } },
        },
      },
    });
    const acct = makeAccount('a1', { contributionGrowthPct: 2 });
    const r = resolveContributionGrowth('p', [primary], [acct]);
    expect(r.get('a1')).toEqual({ mode: 'fixed', ratePct: 6 });
  });

  it('per-account first-ancestor-wins down the parent chain', () => {
    const primary = scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountContributions: { perAccount: { a: { contributionGrowthPct: 1 } } },
      },
    });
    const child = scenario('c', {
      name: 'Child',
      parentScenarioId: 'p',
      overrides: {
        accountContributions: { perAccount: { a: { contributionGrowthPct: 7 } } },
      },
    });
    const r = resolveContributionGrowth('c', [primary, child], [
      makeAccount('a'),
    ]);
    expect(r.get('a')).toEqual({ mode: 'fixed', ratePct: 7 });
  });

  it('resolves growth independently of the contribution AMOUNT override', () => {
    // Child overrides only the amount; the growth rate must still resolve
    // from the parent's growth override (per-key independence).
    const primary = scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountContributions: { perAccount: { a: { contributionGrowthPct: 5 } } },
      },
    });
    const child = scenario('c', {
      name: 'Child',
      parentScenarioId: 'p',
      overrides: {
        accountContributions: {
          perAccount: { a: { plannedContributionPreTax: 9999 } },
        },
      },
    });
    const r = resolveContributionGrowth('c', [primary, child], [
      makeAccount('a'),
    ]);
    expect(r.get('a')).toEqual({ mode: 'fixed', ratePct: 5 });
  });

  it('independence from categoryRates — never reads a category rate', () => {
    // A Medical category rate must not leak into the contribution-growth
    // default; the default is the GENERAL inflation rate only.
    const primary = scenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        inflation: { ratePct: 3, categoryRates: { 'cat-medical': 9 } },
      },
    });
    const r = resolveContributionGrowth('p', [primary], [makeAccount('a')]);
    expect(r.get('a')).toEqual({ mode: 'tracks-inflation', ratePct: 3 });
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-100 boundary', -100],
    ['above the 25 cap', 30],
  ])(
    'a non-finite / out-of-band stored rate (%s) degrades to tracks-inflation',
    (_label, pct) => {
      const primary = scenario('p', {
        name: 'Base',
        isPrimary: true,
        overrides: { inflation: { ratePct: 2 } },
      });
      const acct = makeAccount('a1', { contributionGrowthPct: pct });
      const r = resolveContributionGrowth('p', [primary], [acct]);
      expect(r.get('a1')).toEqual({ mode: 'tracks-inflation', ratePct: 2 });
    },
  );

  it('every account always has an entry (mixed explicit + absent)', () => {
    const primary = scenario('p', { name: 'Base', isPrimary: true });
    const accts = [
      makeAccount('x', { contributionGrowthPct: 0 }),
      makeAccount('y'),
    ];
    const r = resolveContributionGrowth('p', [primary], accts);
    expect(r.get('x')).toEqual({ mode: 'fixed', ratePct: 0 });
    expect(r.get('y')).toEqual({ mode: 'tracks-inflation', ratePct: 3 });
  });
});

describe('resolveAccountFloorsForScenario', () => {
  it('returns no entry for an account the chain never floors (absent = no floor)', () => {
    const primary = scenario('p', { name: 'P', isPrimary: true });
    const acct = makeAccount('a', { taxTreatment: 'POST_TAX', type: 'BROKERAGE' });
    const r = resolveAccountFloorsForScenario('p', [primary], [acct]);
    expect(r.has('a')).toBe(false);
  });

  it('resolves a numeric floor with the default emergencyOnly hsaMode', () => {
    const primary = scenario('p', {
      name: 'P',
      isPrimary: true,
      overrides: { accountFloors: { perAccount: { a: { floorDollars: 10000 } } } },
    });
    const acct = makeAccount('a', { taxTreatment: 'HSA', type: 'HSA' });
    const r = resolveAccountFloorsForScenario('p', [primary], [acct]);
    expect(r.get('a')).toEqual({ floorDollars: 10000, hsaMode: 'emergencyOnly' });
  });

  it("resolves an explicit hsaMode 'strict'", () => {
    const primary = scenario('p', {
      name: 'P',
      isPrimary: true,
      overrides: {
        accountFloors: { perAccount: { a: { floorDollars: 5000, hsaMode: 'strict' } } },
      },
    });
    const acct = makeAccount('a', { taxTreatment: 'HSA', type: 'HSA' });
    const r = resolveAccountFloorsForScenario('p', [primary], [acct]);
    expect(r.get('a')).toEqual({ floorDollars: 5000, hsaMode: 'strict' });
  });

  it('reads any non-strict hsaMode as emergencyOnly (CWE-20 strict-equality)', () => {
    const primary = scenario('p', {
      name: 'P',
      isPrimary: true,
      overrides: {
        accountFloors: {
          // A corrupt import value that is not strictly 'strict'.
          perAccount: { a: { floorDollars: 1000, hsaMode: 'STRICT' as never } },
        },
      },
    });
    const acct = makeAccount('a', { taxTreatment: 'HSA', type: 'HSA' });
    const r = resolveAccountFloorsForScenario('p', [primary], [acct]);
    expect(r.get('a')?.hsaMode).toBe('emergencyOnly');
  });

  it('drops a non-finite floor (no floor)', () => {
    const primary = scenario('p', {
      name: 'P',
      isPrimary: true,
      overrides: {
        accountFloors: { perAccount: { a: { floorDollars: Number.NaN } } },
      },
    });
    const acct = makeAccount('a', { taxTreatment: 'POST_TAX', type: 'BROKERAGE' });
    const r = resolveAccountFloorsForScenario('p', [primary], [acct]);
    expect(r.has('a')).toBe(false);
  });

  it('drops a negative floor (no floor)', () => {
    const primary = scenario('p', {
      name: 'P',
      isPrimary: true,
      overrides: { accountFloors: { perAccount: { a: { floorDollars: -5000 } } } },
    });
    const acct = makeAccount('a', { taxTreatment: 'POST_TAX', type: 'BROKERAGE' });
    const r = resolveAccountFloorsForScenario('p', [primary], [acct]);
    expect(r.has('a')).toBe(false);
  });

  it('keeps a 0 floor (finite, non-negative) — a degenerate but valid floor', () => {
    const primary = scenario('p', {
      name: 'P',
      isPrimary: true,
      overrides: { accountFloors: { perAccount: { a: { floorDollars: 0 } } } },
    });
    const acct = makeAccount('a', { taxTreatment: 'POST_TAX', type: 'BROKERAGE' });
    const r = resolveAccountFloorsForScenario('p', [primary], [acct]);
    expect(r.get('a')).toEqual({ floorDollars: 0, hsaMode: 'emergencyOnly' });
  });

  it('null floorDollars on the child clears the inherited floor', () => {
    const primary = scenario('p', {
      name: 'P',
      isPrimary: true,
      overrides: { accountFloors: { perAccount: { a: { floorDollars: 10000 } } } },
    });
    const child = scenario('c', {
      name: 'C',
      parentScenarioId: 'p',
      overrides: { accountFloors: { perAccount: { a: { floorDollars: null } } } },
    });
    const acct = makeAccount('a', { taxTreatment: 'POST_TAX', type: 'BROKERAGE' });
    const r = resolveAccountFloorsForScenario('c', [primary, child], [acct]);
    expect(r.has('a')).toBe(false);
  });

  it('per-field first-ancestor-wins: child floor override does not clobber ancestor hsaMode', () => {
    const primary = scenario('p', {
      name: 'P',
      isPrimary: true,
      overrides: {
        accountFloors: { perAccount: { a: { floorDollars: 8000, hsaMode: 'strict' } } },
      },
    });
    const child = scenario('c', {
      name: 'C',
      parentScenarioId: 'p',
      // Child overrides only the dollar amount — hsaMode must inherit 'strict'.
      overrides: { accountFloors: { perAccount: { a: { floorDollars: 12000 } } } },
    });
    const acct = makeAccount('a', { taxTreatment: 'HSA', type: 'HSA' });
    const r = resolveAccountFloorsForScenario('c', [primary, child], [acct]);
    expect(r.get('a')).toEqual({ floorDollars: 12000, hsaMode: 'strict' });
  });

  it("null hsaMode on the child clears the ancestor's 'strict' (defaults to emergencyOnly)", () => {
    // F-07: an explicit `null` hsaMode is a DEFINED value that clears the
    // ancestor's setting; the per-field first-ancestor-wins walk stops at the
    // null, and the CWE-20 default (anything not strictly 'strict') resolves to
    // emergencyOnly. The dollar floor still inherits from the ancestor.
    const primary = scenario('p', {
      name: 'P',
      isPrimary: true,
      overrides: {
        accountFloors: { perAccount: { a: { floorDollars: 9000, hsaMode: 'strict' } } },
      },
    });
    const child = scenario('c', {
      name: 'C',
      parentScenarioId: 'p',
      overrides: { accountFloors: { perAccount: { a: { hsaMode: null } } } },
    });
    const acct = makeAccount('a', { taxTreatment: 'HSA', type: 'HSA' });
    const r = resolveAccountFloorsForScenario('c', [primary, child], [acct]);
    expect(r.get('a')).toEqual({ floorDollars: 9000, hsaMode: 'emergencyOnly' });
  });
});

describe('resolveDownturnGuardrailsForScenario', () => {
  const cfg = {
    enabled: true,
    lowerBandPct: 80,
    upperBandPct: 120,
    stepPct: 15,
    maxRaisePct: 130,
  };

  it('returns undefined when no scenario in the chain sets guardrails', () => {
    const p = scenario('p', { name: 'P', isPrimary: true, overrides: {} });
    const c = scenario('c', { name: 'C', parentScenarioId: 'p', overrides: {} });
    expect(resolveDownturnGuardrailsForScenario('c', [p, c])).toBeUndefined();
  });

  it('resolves the scenario own config when set', () => {
    const p = scenario('p', { name: 'P', isPrimary: true, overrides: { downturnGuardrails: cfg } });
    // The resolver materializes the discretionary-floor default (50) on top of
    // the stored config, so the own-config result is `cfg` + floor 50.
    expect(resolveDownturnGuardrailsForScenario('p', [p])).toEqual({ ...cfg, discretionaryFloorPct: 50 });
  });

  it('first-ancestor-wins: child config shadows the parent', () => {
    const p = scenario('p', { name: 'P', isPrimary: true, overrides: { downturnGuardrails: cfg } });
    const childCfg = { ...cfg, stepPct: 5, enabled: false };
    const c = scenario('c', { name: 'C', parentScenarioId: 'p', overrides: { downturnGuardrails: childCfg } });
    expect(resolveDownturnGuardrailsForScenario('c', [p, c])).toEqual({ ...childCfg, discretionaryFloorPct: 50 });
  });

  it('inherits the parent config when the child does not set it', () => {
    const p = scenario('p', { name: 'P', isPrimary: true, overrides: { downturnGuardrails: cfg } });
    const c = scenario('c', { name: 'C', parentScenarioId: 'p', overrides: {} });
    expect(resolveDownturnGuardrailsForScenario('c', [p, c])).toEqual({ ...cfg, discretionaryFloorPct: 50 });
  });

  it('coerces an inverted/invalid resolved config to a safe disabled default (now carrying discretionaryFloorPct: 50)', () => {
    const bad = { enabled: true, lowerBandPct: 120, upperBandPct: 80, stepPct: 10, maxRaisePct: 120 };
    const p = scenario('p', { name: 'P', isPrimary: true, overrides: { downturnGuardrails: bad } });
    const r = resolveDownturnGuardrailsForScenario('p', [p]);
    expect(r).toEqual({
      enabled: false,
      lowerBandPct: 85,
      upperBandPct: 115,
      stepPct: 10,
      maxRaisePct: 100,
      discretionaryFloorPct: 50,
    });
  });

  it('round-trips a set discretionaryFloorPct', () => {
    const withFloor = { ...cfg, discretionaryFloorPct: 75 };
    const p = scenario('p', { name: 'P', isPrimary: true, overrides: { downturnGuardrails: withFloor } });
    const r = resolveDownturnGuardrailsForScenario('p', [p]);
    expect(r?.discretionaryFloorPct).toBe(75);
    expect(r).toEqual(withFloor);
  });

  it('materializes the default discretionaryFloorPct (50) when the source config does not set it', () => {
    const p = scenario('p', { name: 'P', isPrimary: true, overrides: { downturnGuardrails: cfg } });
    const r = resolveDownturnGuardrailsForScenario('p', [p]);
    // An enabled guardrail always resolves to an explicit floor (keep-50% default),
    // so the editor card / report / engine / cache key all agree. The
    // resolver is the single source of truth for the default (not `?? 0` scattered
    // across each consumer).
    expect(r?.discretionaryFloorPct).toBe(50);
  });

  it('coerces to disabled when discretionaryFloorPct is out of range (invalid ENABLED config)', () => {
    const bad = { ...cfg, discretionaryFloorPct: 150 };
    const p = scenario('p', { name: 'P', isPrimary: true, overrides: { downturnGuardrails: bad } });
    const r = resolveDownturnGuardrailsForScenario('p', [p]);
    expect(r?.enabled).toBe(false);
    expect(r?.discretionaryFloorPct).toBe(50); // safe disabled default
  });

  it('returns undefined without throwing when the resolved config is null (corrupt import)', () => {
    // A malformed import bundle can carry `downturnGuardrails: null`; the merge
    // only skips `undefined`, so it reaches the resolver. It must not throw a
    // TypeError from destructuring null in the validity check.
    const p = scenario('p', {
      name: 'P',
      isPrimary: true,
      overrides: { downturnGuardrails: null as unknown as DownturnGuardrailsOverride },
    });
    expect(() => resolveDownturnGuardrailsForScenario('p', [p])).not.toThrow();
    expect(resolveDownturnGuardrailsForScenario('p', [p])).toBeUndefined();
  });

  it('returns undefined without throwing when the resolved config is a primitive (corrupt import)', () => {
    const p = scenario('p', {
      name: 'P',
      isPrimary: true,
      overrides: { downturnGuardrails: 42 as unknown as DownturnGuardrailsOverride },
    });
    expect(() => resolveDownturnGuardrailsForScenario('p', [p])).not.toThrow();
    expect(resolveDownturnGuardrailsForScenario('p', [p])).toBeUndefined();
  });
});

describe('resolveMedicalInflationPct', () => {
  const withInflation = (
    id: string,
    parentScenarioId: string | null,
    inflation: { ratePct: number; categoryRates?: Record<string, number> } | undefined,
    isPrimary = false,
  ): ScenarioAggregate =>
    scenario(id, {
      name: id,
      isPrimary,
      parentScenarioId,
      overrides: inflation ? { inflation } : {},
    });

  it('a chain with no inflation resolves to the 3% default + 2 pp = 5', () => {
    const base = withInflation('b', null, undefined, true);
    expect(resolveMedicalInflationPct('b', [base])).toBe(5);
  });

  it('general 4 with no Medical rate resolves to 6', () => {
    const base = withInflation('b', null, { ratePct: 4 }, true);
    expect(resolveMedicalInflationPct('b', [base])).toBe(6);
  });

  it('an explicit Medical category rate of 7 resolves to 7', () => {
    const base = withInflation(
      'b',
      null,
      { ratePct: 4, categoryRates: { 'cat-medical': 7 } },
      true,
    );
    expect(resolveMedicalInflationPct('b', [base])).toBe(7);
  });

  it('a child scenario inherits the parent’s Medical rate', () => {
    const parent = withInflation(
      'p',
      null,
      { ratePct: 4, categoryRates: { 'cat-medical': 7 } },
      true,
    );
    const child = withInflation('c', 'p', { ratePct: 4 });
    expect(resolveMedicalInflationPct('c', [parent, child])).toBe(7);
  });

  it('does not depend on the household’s category list or other category rates', () => {
    const base = withInflation(
      'b',
      null,
      { ratePct: 4, categoryRates: { 'cat-housing': 9, 'some-other-medical': 1 } },
      true,
    );
    expect(resolveMedicalInflationPct('b', [base])).toBe(6);
  });
});
