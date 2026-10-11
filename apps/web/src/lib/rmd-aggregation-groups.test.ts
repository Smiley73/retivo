import { describe, it, expect } from 'vitest';
import {
  buildRmdAggregationGroups,
  type RmdGroupingAccount,
} from './rmd-aggregation-groups';
import type { AccountType } from '../db/types';

function acct(
  id: string,
  type: AccountType,
  ownerId = 'owner-a',
  name = `Account ${id}`,
): RmdGroupingAccount {
  return { id, name, type, ownerId };
}

function mapOf(...accounts: RmdGroupingAccount[]): Map<string, RmdGroupingAccount> {
  return new Map(accounts.map((a) => [a.id, a]));
}

describe('buildRmdAggregationGroups', () => {
  it('aggregates multiple IRAs (same owner) into one satisfiable-from-any group', () => {
    const accounts = mapOf(
      acct('ira1', 'RETIREMENT_IRA', 'owner-a', 'Vanguard IRA'),
      acct('ira2', 'RETIREMENT_IRA', 'owner-a', 'Fidelity IRA'),
    );
    const { groups } = buildRmdAggregationGroups(
      { ira1: 10_000, ira2: 8_000 },
      accounts,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('aggregatable');
    expect(groups[0].accountType).toBe('RETIREMENT_IRA');
    expect(groups[0].requiredCents).toBe(18_000);
    expect(groups[0].accounts).toHaveLength(2);
  });

  it('aggregates multiple 403(b)s into one group', () => {
    const accounts = mapOf(
      acct('a', 'RETIREMENT_403B'),
      acct('b', 'RETIREMENT_403B'),
    );
    const { groups } = buildRmdAggregationGroups({ a: 5_000, b: 3_000 }, accounts);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('aggregatable');
    expect(groups[0].requiredCents).toBe(8_000);
  });

  it('keeps each 401(k)/457(b)/TSP/cash-balance as its own per-plan group', () => {
    const accounts = mapOf(
      acct('k', 'RETIREMENT_401K'),
      acct('c', 'RETIREMENT_457B'),
      acct('t', 'RETIREMENT_TSP'),
      acct('cb', 'RETIREMENT_CASH_BALANCE'),
    );
    const { groups } = buildRmdAggregationGroups(
      { k: 1_000, c: 2_000, t: 3_000, cb: 4_000 },
      accounts,
    );
    expect(groups).toHaveLength(4);
    for (const g of groups) {
      expect(g.kind).toBe('per-plan');
      expect(g.accounts).toHaveLength(1);
    }
  });

  it('separates IRA groups by owner (per-owner aggregation)', () => {
    const accounts = mapOf(
      acct('p1', 'RETIREMENT_IRA', 'owner-a'),
      acct('p2', 'RETIREMENT_IRA', 'owner-a'),
      acct('s1', 'RETIREMENT_IRA', 'owner-b'),
    );
    const { groups } = buildRmdAggregationGroups(
      { p1: 5_000, p2: 5_000, s1: 7_000 },
      accounts,
    );
    expect(groups).toHaveLength(2);
    const owners = new Set(groups.map((g) => g.ownerId));
    expect(owners).toEqual(new Set(['owner-a', 'owner-b']));
    const aOwner = groups.find((g) => g.ownerId === 'owner-a');
    expect(aOwner?.requiredCents).toBe(10_000);
  });

  it("a group's required RMD equals Σ of its accounts' shares", () => {
    const accounts = mapOf(
      acct('ira1', 'RETIREMENT_IRA'),
      acct('ira2', 'RETIREMENT_IRA'),
    );
    const { groups } = buildRmdAggregationGroups(
      { ira1: 1_234, ira2: 5_678 },
      accounts,
    );
    expect(groups[0].requiredCents).toBe(
      groups[0].accounts.reduce((s, a) => s + a.requiredCents, 0),
    );
  });

  it('excludes zero-RMD and unknown-metadata accounts (Roth/HSA/taxable never carry RMD)', () => {
    const accounts = mapOf(acct('ira1', 'RETIREMENT_IRA'));
    const { groups, unmappedCents } = buildRmdAggregationGroups(
      { ira1: 9_000, missing: 4_000, zero: 0 },
      accounts,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].requiredCents).toBe(9_000);
    // The id with no metadata is surfaced as unmapped (no silent drop).
    expect(unmappedCents).toBe(4_000);
  });

  it('folds a non-RMD account type (e.g. BROKERAGE) into unmappedCents', () => {
    const accounts = mapOf(acct('b1', 'BROKERAGE'));
    const { groups, unmappedCents } = buildRmdAggregationGroups(
      { b1: 1_000 },
      accounts,
    );
    expect(groups).toHaveLength(0);
    expect(unmappedCents).toBe(1_000);
  });

  it('returns empty for an empty map', () => {
    const { groups, unmappedCents } = buildRmdAggregationGroups({}, new Map());
    expect(groups).toHaveLength(0);
    expect(unmappedCents).toBe(0);
  });
});
