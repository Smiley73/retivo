// Per-balance and portfolio-level balance math: gain/loss, Modified-Dietz return, TWR, tax buckets.
// The return method is in `docs/math-income-expenses-and-returns.md`, "Measuring a past return".

import type {
  AccountBalancePayload,
  AccountPayload,
  AccountType,
  Aggregate,
} from '../db/types';

/**
 * The non-OTHER account types that may be MIXED, whose post-tax sub-bucket is
 * Roth. A MIXED OTHER account's post-tax sub-bucket is plain taxable money.
 */
export function isRothDesignatedRetirementType(type: AccountType): boolean {
  return (
    type === 'RETIREMENT_401K' ||
    type === 'RETIREMENT_403B' ||
    type === 'RETIREMENT_457B' ||
    type === 'RETIREMENT_TSP'
  );
}

/**
 * True when a draw from the post sub-bucket is tax-free Roth: a `ROTH` account
 * or a MIXED Roth-designated retirement type. Not applied to `isRothAccount`
 * (the pre-tranche penalty builder) or the basis derivation, which its caller
 * scopes to a Roth-IRA pool.
 */
export function isRothDesignatedPostBucket(
  taxTreatment: AccountPayload['taxTreatment'],
  type: AccountType,
): boolean {
  return taxTreatment === 'ROTH' || (taxTreatment === 'MIXED' && isRothDesignatedRetirementType(type));
}

/**
 * Pure designated-Roth employer-plan types (`taxTreatment: 'ROTH'`), modeled
 * with basis ordering and the early-withdrawal penalty; the whole balance is
 * Roth. Excludes `RETIREMENT_ROTH_IRA`, which has its own basis derivation.
 */
export function isPureRothEmployerType(type: AccountType): boolean {
  return (
    type === 'RETIREMENT_ROTH_401K' ||
    type === 'RETIREMENT_ROTH_403B' ||
    type === 'RETIREMENT_ROTH_457B' ||
    type === 'RETIREMENT_ROTH_TSP'
  );
}

/** Per-row numbers the UI renders straight off (annual table). */
export interface BalanceDerived {
  totalContributions: number;
  gainLoss: number;
  returnPct: number;
}

/** Personal plus company contributions: the splits drive MIXED rows, the stored total the rest. */
export function totalContributions(p: AccountBalancePayload): number {
  if (p.contributionsPreTax !== null || p.contributionsPostTax !== null) {
    const pre = p.contributionsPreTax ?? 0;
    const post = p.contributionsPostTax ?? 0;
    const compPre = p.companyContributionsPreTax ?? 0;
    const compPost = p.companyContributionsPostTax ?? 0;
    return pre + post + compPre + compPost;
  }
  // Non-MIXED: the stored total already holds personal plus company.
  return p.totalContributions;
}

/**
 * endingBalance − startingBalance − contributions − rollover + distributions.
 * Distributions are spent capital, added back to recover the gain the lower
 * ending balance hides.
 */
export function gainLoss(p: AccountBalancePayload): number {
  const tc = totalContributions(p);
  return p.endingBalance - p.startingBalance - tc - p.rollover + p.distributions;
}

/**
 * Modified-Dietz return %, 2 decimals. Contributions weigh 1.0 in a new-account
 * year (starting balance 0), else 0.5; distributions 0.5; rollovers are
 * excluded as transfers of existing assets.
 */
function returnPct(p: AccountBalancePayload): number {
  const tc = totalContributions(p);
  const gl = gainLoss(p);
  const contributionWeight = p.startingBalance === 0 ? 1 : 0.5;
  const avgCapital = Math.max(
    0,
    p.startingBalance + contributionWeight * tc - 0.5 * p.distributions,
  );
  if (avgCapital === 0) return 0;
  return Math.round((gl / avgCapital) * 10000) / 100;
}

export function deriveAll(p: AccountBalancePayload): BalanceDerived {
  return {
    totalContributions: totalContributions(p),
    gainLoss: gainLoss(p),
    returnPct: returnPct(p),
  };
}

/**
 * False for the auto-$0 seed row (starting, ending, contributions, rollover and
 * distributions all zero): it carries no return, and folding it into a TWR would
 * fabricate a 0% year. Not the broader `avgCapital === 0`, which would drop a
 * rollover-funded zero-capital row that does carry a return.
 */
export function isReturnBearingRow(p: AccountBalancePayload): boolean {
  return !(
    p.startingBalance === 0 &&
    p.endingBalance === 0 &&
    totalContributions(p) === 0 &&
    p.rollover === 0 &&
    p.distributions === 0
  );
}

export interface AccountWithCurrentBalance {
  id: string;
  name: string;
  ownerDisplayName: string;
  type: AccountPayload['type'];
  taxTreatment: AccountPayload['taxTreatment'];
  active: boolean;
  notes: string;
  currentBalance: number | null;
  /** For MIXED accounts: the Roth-designated (post-tax) sub-balance. Null for non-MIXED or no-balance accounts. */
  currentBalancePostTax: number | null;
  currentBalanceYear: number | null;
  /** `lastUpdated` of the latest-year balance row: the list page's "As of" column. */
  currentBalanceAsOf: string | null;
  /** Annualized TWR (geometric mean of yearly returns); null with no balance rows. */
  twr: number | null;
}

export interface PortfolioSummary {
  totalCurrentBalance: number;
  /** Latest-year balances by tax treatment (pre-tax plus the pre-tax split of MIXED accounts; post-tax likewise). */
  totalPreTaxBalance: number;
  totalPostTaxBalance: number;
  /** Pre/post-tax balance as a % of totalCurrentBalance (0 when no balance). */
  preTaxPct: number;
  postTaxPct: number;
  /** Latest-year tax-free balance: Roth and HSA accounts by treatment plus the
     *  Roth-designated post-tax sub-bucket of MIXED retirement accounts. Never also
     *  in the pre/post totals. */
  totalTaxFreeBalance: number;
  /** 0–100, like `preTaxPct`. */
  taxFreePct: number;
  totalContributions: number;
  totalCompanyContributions: number;
  totalPreTaxContributions: number;
  totalPostTaxContributions: number;
  totalDistributions: number;
  totalGainLoss: number;
  twr: number | null;
  yearsCovered: number;
}

export interface SummaryResult {
  accounts: AccountWithCurrentBalance[];
  summary: PortfolioSummary;
}

interface AccountInput {
  account: Aggregate<AccountPayload>;
  ownerDisplayName: string;
}

function avgCapital(p: AccountBalancePayload): number {
  const tc = totalContributions(p);
  const w = p.startingBalance === 0 ? 1 : 0.5;
  return Math.max(0, p.startingBalance + w * tc - 0.5 * p.distributions);
}

function balanceGainLoss(p: AccountBalancePayload): number {
  return gainLoss(p);
}

/** TWR of one account's yearly returns; null below two return-bearing rows, since a geometric mean needs more than one point. */
export interface AccountReturns {
  twr: number | null;
}

export function accountReturns(
  balances: Aggregate<AccountBalancePayload>[],
): AccountReturns {
  // Drop seed rows so an auto-$0 seed never fabricates a return.
  const returnBearing = balances.filter((b) => isReturnBearingRow(b.payload));
  if (returnBearing.length < 2) {
    return { twr: null };
  }
  const sorted = [...returnBearing].sort(
    (a, b) => a.payload.year - b.payload.year,
  );
  const yearly = sorted.map((b) => returnPct(b.payload));
  const product = yearly.reduce((acc, r) => acc * (1 + r / 100), 1);
  const twr = (Math.pow(product, 1 / yearly.length) - 1) * 100;
  return { twr };
}

// Unlike `accountReturns`, a single year yields that year's return; no rows yields null.
function listAccountTwr(rows: Aggregate<AccountBalancePayload>[]): number | null {
  const returnBearing = rows.filter((b) => isReturnBearingRow(b.payload));
  if (returnBearing.length === 0) return null;
  const product = returnBearing.reduce(
    (acc, b) => acc * (1 + returnPct(b.payload) / 100),
    1,
  );
  return (Math.pow(product, 1 / returnBearing.length) - 1) * 100;
}

export function computePortfolioSummary(
  accounts: AccountInput[],
  balances: Aggregate<AccountBalancePayload>[],
): SummaryResult {
  const balancesByAccount = new Map<string, Aggregate<AccountBalancePayload>[]>();
  for (const b of balances) {
    const list = balancesByAccount.get(b.payload.accountId);
    if (list) list.push(b);
    else balancesByAccount.set(b.payload.accountId, [b]);
  }

  const accountsWithCurrent: AccountWithCurrentBalance[] = accounts.map(({ account, ownerDisplayName }) => {
    const rows = balancesByAccount.get(account.id) ?? [];
    if (rows.length === 0) {
      return {
        id: account.id,
        name: account.payload.name,
        ownerDisplayName,
        type: account.payload.type,
        taxTreatment: account.payload.taxTreatment,
        active: account.payload.active,
        notes: account.payload.notes,
        currentBalance: null,
        currentBalancePostTax: null,
        currentBalanceYear: null,
        currentBalanceAsOf: null,
        twr: null,
      };
    }
    const latest = rows.reduce((best, r) =>
      r.payload.year > best.payload.year ? r : best,
    );
    return {
      id: account.id,
      name: account.payload.name,
      ownerDisplayName,
      type: account.payload.type,
      taxTreatment: account.payload.taxTreatment,
      active: account.payload.active,
      notes: account.payload.notes,
      currentBalance: latest.payload.endingBalance,
      currentBalancePostTax:
        account.payload.taxTreatment === 'MIXED'
          ? latest.payload.endingBalancePostTax ?? null
          : null,
      currentBalanceYear: latest.payload.year,
      currentBalanceAsOf: latest.payload.lastUpdated,
      twr: listAccountTwr(rows),
    };
  });

  const totalCurrentBalance = accountsWithCurrent.reduce(
    (sum, a) => sum + (a.currentBalance ?? 0),
    0,
  );
  const totalContributionsSum = balances.reduce(
    (sum, b) => sum + totalContributions(b.payload),
    0,
  );
  const totalCompanyContributions = balances.reduce(
    (sum, b) => sum + b.payload.companyContributions,
    0,
  );
  const totalDistributions = balances.reduce(
    (sum, b) => sum + b.payload.distributions,
    0,
  );

  // Tax-free (HSA, ROTH, and a MIXED Roth-designated post-tax sub-bucket) goes to
  // `totalTaxFreeBalance` only: counting it in the post-tax total too would
  // double-count it and push the percentages past 100. A MIXED OTHER post-tax
  // sub-bucket is plain taxable money.
  let totalPreTaxBalance = 0;
  let totalPostTaxBalance = 0;
  let totalTaxFreeBalance = 0;
  let totalPreTaxContributions = 0;
  let totalPostTaxContributions = 0;
  for (const { account } of accounts) {
    const rows = balancesByAccount.get(account.id) ?? [];
    if (rows.length === 0) continue;
    const tt = account.payload.taxTreatment;
    const latest = rows.reduce((best, r) =>
      r.payload.year > best.payload.year ? r : best,
    );
    const ending = latest.payload.endingBalance;
    const mixedRothDesignated =
      tt === 'MIXED' && isRothDesignatedRetirementType(account.payload.type);
    // Classified by `taxTreatment`, consistent with the buckets below.
    if (tt === 'ROTH' || tt === 'HSA') {
      totalTaxFreeBalance += ending;
    } else if (mixedRothDesignated) {
      // A MIXED OTHER account's post-tax sub-bucket is plain taxable money, so it is excluded.
      totalTaxFreeBalance += latest.payload.endingBalancePostTax ?? 0;
    }
    if (tt === 'MIXED') {
      totalPreTaxBalance += latest.payload.endingBalancePreTax ?? 0;
      if (!mixedRothDesignated) {
        totalPostTaxBalance += latest.payload.endingBalancePostTax ?? 0;
      }
      // MIXED Roth-designated: the post-tax sub-bucket is already in `totalTaxFreeBalance`.
    } else if (tt === 'POST_TAX') {
      totalPostTaxBalance += ending;
    } else if (tt === 'HSA') {
      // Already in `totalTaxFreeBalance`; adding it here would double-count it.
    } else if (tt === 'ROTH') {
      // Already in `totalTaxFreeBalance`; adding it here would double-count it.
    } else {
      totalPreTaxBalance += ending;
    }
    for (const b of rows) {
      const p = b.payload;
      if (tt === 'MIXED') {
        totalPreTaxContributions +=
          (p.contributionsPreTax ?? 0) + (p.companyContributionsPreTax ?? 0);
        totalPostTaxContributions +=
          (p.contributionsPostTax ?? 0) + (p.companyContributionsPostTax ?? 0);
      } else if (tt === 'POST_TAX') {
        totalPostTaxContributions += totalContributions(p);
      } else if (tt === 'HSA') {
        // HSA contributions are pre-tax deductible, and there is no tax-free contributions bucket.
        totalPreTaxContributions += totalContributions(p);
      } else if (tt === 'ROTH') {
        // Roth contributions are post-tax funded.
        totalPostTaxContributions += totalContributions(p);
      } else {
        totalPreTaxContributions += totalContributions(p);
      }
    }
  }
  const preTaxPct =
    totalCurrentBalance > 0 ? (totalPreTaxBalance / totalCurrentBalance) * 100 : 0;
  const postTaxPct =
    totalCurrentBalance > 0 ? (totalPostTaxBalance / totalCurrentBalance) * 100 : 0;
  const taxFreePct =
    totalCurrentBalance > 0 ? (totalTaxFreeBalance / totalCurrentBalance) * 100 : 0;

  let totalGainLoss = 0;
  for (const [, rows] of balancesByAccount) {
    if (rows.length === 0) continue;
    const sorted = [...rows].sort((a, b) => a.payload.year - b.payload.year);
    const first = sorted[0].payload;
    const last = sorted[sorted.length - 1].payload;
    const sumContrib = sorted.reduce((s, b) => s + totalContributions(b.payload), 0);
    const sumRollover = sorted.reduce((s, b) => s + b.payload.rollover, 0);
    const sumDistrib = sorted.reduce((s, b) => s + b.payload.distributions, 0);
    totalGainLoss +=
      last.endingBalance - first.startingBalance - sumContrib - sumRollover + sumDistrib;
  }

  // Seed rows count here.
  const yearsCovered = new Set(balances.map((b) => b.payload.year)).size;

  // Seed rows are excluded so a seed-only portfolio reports null, not a fabricated 0%,
  // and a seed account never dilutes the geometric mean.
  const returnBearingBalances = balances.filter((b) =>
    isReturnBearingRow(b.payload),
  );
  const yearSet = new Set(returnBearingBalances.map((b) => b.payload.year));
  const years = [...yearSet].sort((a, b) => a - b);

  const yearlyPortfolioReturns: number[] = [];
  for (const year of years) {
    const yearBalances = returnBearingBalances.filter(
      (b) => b.payload.year === year,
    );
    const yearGainLoss = yearBalances.reduce((s, b) => s + balanceGainLoss(b.payload), 0);
    const yearCapital = yearBalances.reduce((s, b) => s + avgCapital(b.payload), 0);
    const yearReturn = yearCapital === 0 ? 0 : (yearGainLoss / yearCapital) * 100;
    yearlyPortfolioReturns.push(yearReturn);
  }

  let twr: number | null = null;
  if (yearlyPortfolioReturns.length > 0) {
    const product = yearlyPortfolioReturns.reduce((acc, r) => acc * (1 + r / 100), 1);
    twr = (Math.pow(product, 1 / yearlyPortfolioReturns.length) - 1) * 100;
  }

  return {
    accounts: accountsWithCurrent,
    summary: {
      totalCurrentBalance,
      totalPreTaxBalance,
      totalPostTaxBalance,
      preTaxPct,
      postTaxPct,
      totalTaxFreeBalance,
      taxFreePct,
      totalContributions: totalContributionsSum,
      totalCompanyContributions,
      totalPreTaxContributions,
      totalPostTaxContributions,
      totalDistributions,
      totalGainLoss,
      twr,
      yearsCovered,
    },
  };
}

/**
 * Dashboard pre-tax / taxable / tax-free split. Roth and HSA, plus the
 * Roth-designated post-tax sub-bucket of MIXED retirement accounts, are
 * tax-free. `*Pct` is 0–100.
 */
export interface TaxTreatmentAllocation {
  pretaxBalance: number;
  taxableBalance: number;
  /** Roth plus HSA; `taxFreeRoth + taxFreeHsa` equals it. */
  taxFreeBalance: number;
  /** `'ROTH'`-treatment accounts plus the Roth-designated post-tax sub-bucket of MIXED retirement accounts. */
  taxFreeRoth: number;
  /** Tax-free balance from `'HSA'`-treatment accounts. */
  taxFreeHsa: number;
  pretaxPct: number;
  taxablePct: number;
  taxFreePct: number;
}

/**
 * Derives the dashboard split from the shared summary; `accounts` only splits
 * tax-free into Roth and HSA. Taxable is `totalPostTaxBalance` unchanged, pre-tax
 * is the remainder so the slices sum to the total, and total <= 0 gives all zeros.
 */
export function deriveTaxTreatmentAllocation(
  summary: PortfolioSummary,
  accounts: ReadonlyArray<AccountWithCurrentBalance>,
): TaxTreatmentAllocation {
  const total = summary.totalCurrentBalance;
  if (total <= 0) {
    return {
      pretaxBalance: 0,
      taxableBalance: 0,
      taxFreeBalance: 0,
      taxFreeRoth: 0,
      taxFreeHsa: 0,
      pretaxPct: 0,
      taxablePct: 0,
      taxFreePct: 0,
    };
  }

  const taxFreeBalance = summary.totalTaxFreeBalance;
  // `totalPostTaxBalance` already holds only taxable money: Roth/HSA accounts and the
  // Roth-designated sub-bucket are routed to tax-free by `computePortfolioSummary`.
  const taxableBalance = summary.totalPostTaxBalance;
  const pretaxBalance = total - taxFreeBalance - taxableBalance;

  // Roth is the remainder, so the two halves always reconstitute `taxFreeBalance`.
  const taxFreeHsa = accounts.reduce(
    (sum, a) =>
      a.taxTreatment === 'HSA' ? sum + (a.currentBalance ?? 0) : sum,
    0,
  );
  const taxFreeRoth = taxFreeBalance - taxFreeHsa;

  return {
    pretaxBalance,
    taxableBalance,
    taxFreeBalance,
    taxFreeRoth,
    taxFreeHsa,
    pretaxPct: (pretaxBalance / total) * 100,
    taxablePct: (taxableBalance / total) * 100,
    taxFreePct: (taxFreeBalance / total) * 100,
  };
}
