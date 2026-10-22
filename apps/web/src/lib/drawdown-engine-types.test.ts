/** Direct unit tests for `rmdEligibleWithdrawnCents` in `drawdown-engine-types.ts`. */
import { describe, it, expect } from 'vitest';
import { rmdEligibleWithdrawnCents } from './drawdown-engine-types';
import type { DrawdownAccountYear } from './drawdown-engine-types';

function makeRow(overrides: Partial<DrawdownAccountYear> = {}): DrawdownAccountYear {
  return {
    balance: 1_000_000,
    preEnd: 0,
    postEnd: 0,
    withdrawn: 10_000,
    deposit: 0,
    ...overrides,
  };
}

describe('rmdEligibleWithdrawnCents', () => {
  it('PRE_TAX: returns round(withdrawn * 100)', () => {
    const row = makeRow({ withdrawn: 10_000.005 });
    expect(rmdEligibleWithdrawnCents(row, 'PRE_TAX')).toBe(Math.round(10_000.005 * 100));
  });

  it('PRE_TAX: zero withdrawal yields zero', () => {
    const row = makeRow({ withdrawn: 0 });
    expect(rmdEligibleWithdrawnCents(row, 'PRE_TAX')).toBe(0);
  });

  it('MIXED: returns preWithdrawnCents when present', () => {
    const row = makeRow({ withdrawn: 10_000, preWithdrawnCents: 600_000 });
    expect(rmdEligibleWithdrawnCents(row, 'MIXED')).toBe(600_000);
  });

  it('MIXED: returns 0 when preWithdrawnCents is absent (conservative fallback)', () => {
    const row = makeRow({ withdrawn: 10_000 });
    // preWithdrawnCents is undefined: defensive ?? 0.
    expect(rmdEligibleWithdrawnCents(row, 'MIXED')).toBe(0);
  });

  it('MIXED: returns 0 when preWithdrawnCents is explicitly undefined', () => {
    const row = makeRow({ withdrawn: 10_000, preWithdrawnCents: undefined });
    expect(rmdEligibleWithdrawnCents(row, 'MIXED')).toBe(0);
  });

  // A pure Roth account carries a required amount only when inherited (§401(a)(9)(B)), and the distribution amount satisfies
  // it regardless of tax treatment, so the beneficiary's untaxed draw counts in full.
  it('ROTH: the whole withdrawal counts toward an inherited-Roth requirement', () => {
    const row = makeRow({ withdrawn: 50_000 });
    expect(rmdEligibleWithdrawnCents(row, 'ROTH')).toBe(5_000_000);
  });

  it('POST_TAX: the whole withdrawal counts toward an inherited-Roth requirement', () => {
    const row = makeRow({ withdrawn: 30_000 });
    expect(rmdEligibleWithdrawnCents(row, 'POST_TAX')).toBe(3_000_000);
  });

  it('ROTH: zero withdrawal yields zero', () => {
    const row = makeRow({ withdrawn: 0 });
    expect(rmdEligibleWithdrawnCents(row, 'ROTH')).toBe(0);
  });

  it('HSA: returns 0 regardless of withdrawn amount (never RMD-subject)', () => {
    const row = makeRow({ withdrawn: 20_000 });
    expect(rmdEligibleWithdrawnCents(row, 'HSA')).toBe(0);
  });
});
