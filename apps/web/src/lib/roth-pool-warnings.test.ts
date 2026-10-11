/**
 * The account-delete warning trigger, as a pure predicate. The
 * retype-into-Roth-IRA predicate this file used to also cover
 * (`hasRecordedPersonalContributions`) is retired — the universal retype
 * block (`lib/account-retype-block.ts`) supersedes it.
 *
 * The delete matrix deliberately includes the two shapes where the account's own
 * outflow is IMPUTED rather than recorded — a same-row zero-out and a
 * netted span shortfall. Those are precisely the cases a
 * "does this account record a withdrawal" heuristic gets wrong, so a suite
 * without them would not test the decision this predicate exists to make.
 */
import { describe, expect, it } from 'vitest';
import type { AccountBalancePayload, AccountPayload } from '../db/types';
import { deletingRothIraRaisesPooledTaxFree } from './roth-pool-warnings';

/** Minimal Roth-IRA `AccountPayload`, same fixture shape as the balance-projection
 *  Roth tests. Every account here belongs to `member-primary` unless overridden. */
function rothIra(extra: Partial<AccountPayload> = {}): AccountPayload {
  return {
    name: 'Roth IRA',
    type: 'RETIREMENT_ROTH_IRA',
    ownershipType: 'INDIVIDUAL',
    taxTreatment: 'ROTH',
    ownerId: 'member-primary',
    institution: '',
    notes: '',
    planningReturnPct: 6,
    active: true,
    plannedContributionPreTax: 0,
    plannedContributionPostTax: 0,
    assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    ...extra,
  };
}

/** One flat (non-MIXED) annual balance row. The two personal split keys are
 *  `null` explicitly: that pair is what distinguishes a flat row from a MIXED
 *  one, and leaving them `undefined` would read as MIXED. */
function row(
  accountId: string,
  year: number,
  over: Partial<AccountBalancePayload> = {},
): { payload: AccountBalancePayload } {
  return {
    payload: {
      accountId,
      year,
      lastUpdated: `${String(year)}-12-31`,
      startingBalance: 0,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance: 0,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
      ...over,
    },
  };
}

/** The sibling that funds the owner's pool: $50k of recorded contributions and
 *  no outflow of its own. Every warning case below turns on whether the account
 *  under test consumed THIS money. */
const SIBLING_CONTRIBUTED = row('acc-keep', 2020, {
  totalContributions: 50_000,
  endingBalance: 50_000,
});

const KEEPER = { id: 'acc-keep', payload: rothIra({ name: 'Keeper Roth IRA' }) };
const CONSUMER = { id: 'acc-drop', payload: rothIra({ name: 'Consumer Roth IRA' }) };

describe('deletingRothIraRaisesPooledTaxFree', () => {
  it('warns when the account carries a RECORDED distribution that consumed the pool', () => {
    // Rollover-funded, then withdrawn: the $50k charge is the sibling's basis, so
    // deleting this account hands that basis back to the household.
    const balances = [
      SIBLING_CONTRIBUTED,
      row('acc-drop', 2020, { rollover: 50_000, endingBalance: 50_000 }),
      row('acc-drop', 2021, { startingBalance: 50_000, distributions: 50_000 }),
    ];
    expect(
      deletingRothIraRaisesPooledTaxFree('acc-drop', [KEEPER, CONSUMER], balances),
    ).toBe(true);
  });

  it('warns when the outflow is only IMPUTED by the same-row zero-out', () => {
    // Identical money movement, but `distributions` was never filled in: the row
    // simply takes a positive start to a $0 ending. A recorded-outflow heuristic
    // sees nothing here and stays silent.
    const balances = [
      SIBLING_CONTRIBUTED,
      row('acc-drop', 2020, { rollover: 50_000, endingBalance: 50_000 }),
      row('acc-drop', 2021, { startingBalance: 50_000, endingBalance: 0 }),
    ];
    expect(
      deletingRothIraRaisesPooledTaxFree('acc-drop', [KEEPER, CONSUMER], balances),
    ).toBe(true);
  });

  it('warns when the outflow is only IMPUTED by a boundary shortfall across a $0-starting row', () => {
    // $60k → (a $0-starting row the walk passes over) → $40k. The unexplained
    // $20k is charged against the owner's pool with nothing recorded anywhere.
    const balances = [
      SIBLING_CONTRIBUTED,
      row('acc-drop', 2019, { startingBalance: 60_000, endingBalance: 60_000 }),
      row('acc-drop', 2020, { startingBalance: 0, endingBalance: 40_000 }),
      row('acc-drop', 2021, { startingBalance: 40_000, endingBalance: 40_000 }),
    ];
    expect(
      deletingRothIraRaisesPooledTaxFree('acc-drop', [KEEPER, CONSUMER], balances),
    ).toBe(true);
  });

  it('does NOT warn for an account that only ever contributed', () => {
    // Deleting it lowers the household's tax-free figure; there is nothing to
    // warn about, and warning here would train the user to ignore the message.
    const balances = [
      SIBLING_CONTRIBUTED,
      row('acc-drop', 2020, { totalContributions: 10_000, endingBalance: 10_000 }),
    ];
    expect(
      deletingRothIraRaisesPooledTaxFree('acc-drop', [KEEPER, CONSUMER], balances),
    ).toBe(false);
  });

  it('does NOT warn for the owner’s ONLY Roth IRA, however it was drawn down', () => {
    // With no sibling left there is no pool to raise: the figure goes to $0.
    const balances = [
      row('acc-drop', 2020, { totalContributions: 50_000, endingBalance: 50_000 }),
      row('acc-drop', 2021, { startingBalance: 50_000, endingBalance: 0 }),
    ];
    expect(deletingRothIraRaisesPooledTaxFree('acc-drop', [CONSUMER], balances)).toBe(
      false,
    );
  });

  it('does NOT warn for an INHERITED Roth IRA', () => {
    // An inherited account has no pool at all, so its history never charged
    // the owner's figure and removing it cannot raise one.
    const inherited = {
      id: 'acc-drop',
      payload: rothIra({ rmdInheritedAccount: true }),
    };
    const balances = [
      SIBLING_CONTRIBUTED,
      row('acc-drop', 2020, { rollover: 50_000, endingBalance: 50_000 }),
      row('acc-drop', 2021, { startingBalance: 50_000, distributions: 50_000 }),
    ];
    expect(
      deletingRothIraRaisesPooledTaxFree('acc-drop', [KEEPER, inherited], balances),
    ).toBe(false);
  });

  it('does NOT warn for a non-Roth-IRA account, whatever its history', () => {
    // A designated-Roth plan's basis is its recorded in-plan-rollover principal,
    // which is per-account and pools with nothing.
    const employerPlan = {
      id: 'acc-drop',
      payload: rothIra({ type: 'RETIREMENT_ROTH_401K', name: 'Roth 401(k)' }),
    };
    const balances = [
      SIBLING_CONTRIBUTED,
      row('acc-drop', 2020, { rollover: 50_000, endingBalance: 50_000 }),
      row('acc-drop', 2021, { startingBalance: 50_000, distributions: 50_000 }),
    ];
    expect(
      deletingRothIraRaisesPooledTaxFree('acc-drop', [KEEPER, employerPlan], balances),
    ).toBe(false);
  });

  it('does NOT warn for an account with no balance rows at all', () => {
    expect(
      deletingRothIraRaisesPooledTaxFree(
        'acc-drop',
        [KEEPER, CONSUMER],
        [SIBLING_CONTRIBUTED],
      ),
    ).toBe(false);
  });

  it('does NOT warn for an account id that is not in the household set', () => {
    expect(
      deletingRothIraRaisesPooledTaxFree('acc-missing', [KEEPER], [SIBLING_CONTRIBUTED]),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Conversion lots — the OTHER half of the figure being compared.
  // Every case above turns on pooled contribution basis alone, so a
  // contribution-basis-only comparison would satisfy them. These two do not:
  // one warns only because lots are counted, the other stays silent only
  // because they are.
  // -------------------------------------------------------------------------

  it('does NOT warn when the account leaves with its OWN conversion lot, even though pooled basis rises', () => {
    // `acc-keep` contributes $10k; `acc-drop` converts $60k in and withdraws $20k.
    // The withdrawal is charged contributions-first, so it consumes the whole $10k
    // of pooled basis and then $10k of the lot: $50k of tax-free money remains WITH
    // the account and $10k without it. Comparing contribution basis alone sees $0
    // vs $10k and would warn before an irreversible delete that LOWERS the figure.
    const balances = [
      row('acc-keep', 2020, { totalContributions: 10_000, endingBalance: 10_000 }),
      row('acc-drop', 2020, {
        rothConversionTaxableAmount: 60_000,
        rollover: 60_000,
        endingBalance: 60_000,
      }),
      row('acc-drop', 2021, {
        startingBalance: 60_000,
        distributions: 20_000,
        endingBalance: 40_000,
      }),
    ];
    expect(
      deletingRothIraRaisesPooledTaxFree('acc-drop', [KEEPER, CONSUMER], balances),
    ).toBe(false);
  });

  it('warns when the SURVIVING sibling holds the lot the deleted account consumed', () => {
    // Mirror shape: the $60k conversion lot is the KEEPER's, and `acc-drop` is a
    // pure consumer — its $50k withdrawal charges that lot down to $10k. Deleting
    // it hands the $50k back. Neither side has any contribution basis at all, so a
    // contribution-basis-only comparison sees $0 vs $0 and misses a real warning.
    const balances = [
      row('acc-keep', 2020, {
        rothConversionTaxableAmount: 60_000,
        rollover: 60_000,
        endingBalance: 60_000,
      }),
      row('acc-drop', 2020, { rollover: 50_000, endingBalance: 50_000 }),
      row('acc-drop', 2021, { startingBalance: 50_000, distributions: 50_000 }),
    ];
    expect(
      deletingRothIraRaisesPooledTaxFree('acc-drop', [KEEPER, CONSUMER], balances),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Inactive accounts — the pool covers every Roth IRA the member owns, active or not.
  // Substituting the active-only list the accounts page already builds would
  // silence the first case and break the second, and no other test here would
  // notice: every other fixture is active.
  // -------------------------------------------------------------------------

  it('warns when the pool-funding sibling is INACTIVE', () => {
    // The recorded contributions of an inactive Roth IRA still fund its owner's
    // figure, so the deleted account's outflow really did consume them.
    const inactiveKeeper = {
      id: 'acc-keep',
      payload: rothIra({ name: 'Keeper Roth IRA', active: false }),
    };
    const balances = [
      SIBLING_CONTRIBUTED,
      row('acc-drop', 2020, { rollover: 50_000, endingBalance: 50_000 }),
      row('acc-drop', 2021, { startingBalance: 50_000, distributions: 50_000 }),
    ];
    expect(
      deletingRothIraRaisesPooledTaxFree('acc-drop', [inactiveKeeper, CONSUMER], balances),
    ).toBe(true);
  });

  it('warns when the account being deleted is itself INACTIVE', () => {
    // An inactive account's outflows are charged against the pool exactly as an
    // active one's are, so deleting it hands the same charges back.
    const inactiveConsumer = {
      id: 'acc-drop',
      payload: rothIra({ name: 'Consumer Roth IRA', active: false }),
    };
    const balances = [
      SIBLING_CONTRIBUTED,
      row('acc-drop', 2020, { rollover: 50_000, endingBalance: 50_000 }),
      row('acc-drop', 2021, { startingBalance: 50_000, distributions: 50_000 }),
    ];
    expect(
      deletingRothIraRaisesPooledTaxFree('acc-drop', [KEEPER, inactiveConsumer], balances),
    ).toBe(true);
  });
});
