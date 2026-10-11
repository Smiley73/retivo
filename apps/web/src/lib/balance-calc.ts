/**
 * Per-balance + portfolio-level math, ported from the legacy
 * `apps/api/src/account-balances/account-balances.service.ts` +
 * `portfolio-stats.ts`. The Modified-Dietz return method is explained in
 * `docs/math-income-expenses-and-returns.md`, "Measuring a past return".
 *
 * Inputs are payloads from the IndexedDB `accountBalance` aggregate
 * (apps/web/src/db/types.ts → AccountBalancePayload). The functions
 * here own the derived fields the legacy server attached to API
 * responses (gainLoss, returnPct, totalContributions, portfolio TWR /
 * GainLoss).
 */
import type {
  AccountBalancePayload,
  AccountPayload,
  AccountType,
  Aggregate,
} from '../db/types';

/**
 * Retirement account types whose MIXED post-tax sub-bucket is a
 * Roth-designated (and therefore tax-free) slice. These are exactly the
 * non-OTHER types that `TAX_TREATMENT_RULES` (apps/web/src/api/types.ts)
 * allows to be MIXED: a MIXED OTHER account's post-tax sub-bucket is plain
 * taxable money, NOT Roth, so it must stay out of the tax-free bucket.
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
 * True when a draw from this account's POST sub-bucket realises as tax-free
 * Roth: either the account is purely Roth (`taxTreatment === 'ROTH'`) or it is
 * a MIXED Roth-designated retirement type (401k/403b/457b/TSP — the post-tax
 * sub-bucket is Roth-designated money).
 *
 * Used at every post-bucket tax-classification site
 * (`splitWithdrawalsByTaxTreatment`, `isMagiNeutralPostBucket`,
 * `classifyAccountDraw`, `classifyMcWithdrawal`, `applyRothBasisOrdering`).
 *
 * NOT applied to `isRothAccount` (which guards the pre-tranche penalty
 * builder) or to the §408A basis derivation (`roth-basis-derivation.ts`),
 * which is scoped to a Roth-IRA pool by its caller.
 */
export function isRothDesignatedPostBucket(
  taxTreatment: AccountPayload['taxTreatment'],
  type: AccountType,
): boolean {
  return taxTreatment === 'ROTH' || (taxTreatment === 'MIXED' && isRothDesignatedRetirementType(type));
}

/**
 * Pure designated-Roth employer-plan account types (locked to `taxTreatment:
 * 'ROTH'`). These are modeled with §408A basis ordering + the §72(t) early-
 * withdrawal penalty (at-retirement balance = recoverable basis; pre-59½
 * growth past basis is taxable + penalized). Unlike MIXED designated-Roth
 * accounts, the full account balance is Roth — there is no pre-tax sub-bucket.
 *
 * Consumed by the §408A gather, the MC classifier, and the basis derivation.
 * Note: `RETIREMENT_ROTH_IRA` is NOT included here — it has a separate
 * basis derivation path (contribution history vs at-retirement balance).
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

/**
 * Total contributions = personal + company. The payload stores the
 * components (or splits, for MIXED); we recompute on read so the
 * invariant holds even if stale data slips through sync.
 */
export function totalContributions(p: AccountBalancePayload): number {
  if (p.contributionsPreTax !== null || p.contributionsPostTax !== null) {
    // MIXED — splits drive the total.
    const pre = p.contributionsPreTax ?? 0;
    const post = p.contributionsPostTax ?? 0;
    const compPre = p.companyContributionsPreTax ?? 0;
    const compPost = p.companyContributionsPostTax ?? 0;
    return pre + post + compPre + compPost;
  }
  // Non-MIXED — totalContributions includes personal + company.
  // We don't store personal directly; back it out of the totalContributions
  // field if present, else from endingBalance — startingBalance — companyContributions.
  // Easiest: trust whatever `totalContributions` already holds. The form
  // recomputes it on save, and the server (legacy) likewise.
  return p.totalContributions;
}

/**
 * Gain/Loss = endingBalance − startingBalance − totalContributions
 * − rollover + distributions. Distributions are spent capital
 * (withdrawals taken from any account type) — adding them back recovers
 * the gain hidden by the lower endingBalance.
 */
export function gainLoss(p: AccountBalancePayload): number {
  const tc = totalContributions(p);
  return p.endingBalance - p.startingBalance - tc - p.rollover + p.distributions;
}

/**
 * Modified-Dietz return %, rounded to 2 decimals.
 * - Contribution weight: 0.5 normally; 1.0 when startingBalance === 0
 *   (new-account year — contributions ARE the basis, not mid-year tops
 *   on an existing base).
 * - Distribution weight: always 0.5 (outflows of already-deployed
 *   capital trickle through the year).
 * - Rollovers excluded — they're transfers of existing assets, not
 *   new capital.
 */
export function returnPct(p: AccountBalancePayload): number {
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
 * Does a balance row carry any time-weighted-return information?
 *
 * Excludes the **narrow** degenerate shape — a row whose `startingBalance`,
 * `endingBalance`, `totalContributions`, `rollover`, and `distributions` are
 * ALL zero. That is exactly the auto-$0 seed an account picks up at creation
 * (so a new account "just works": it projects + is a valid Roth-conversion
 * target without a hand-entered balance). A seed
 * row has no capital and no flow, so it contributes no empirical return; folding
 * it into a TWR would fabricate a 0% year and flip a one-real-year account to
 * "has empirical history" (a 2-row diluted geometric mean).
 *
 * Deliberately NOT the broad `avgCapital === 0` test: a real **rollover-funded**
 * zero-capital row (`startingBalance == 0`, `rollover > 0`, `endingBalance > 0`)
 * has `avgCapital == 0` under Modified-Dietz (rollovers are excluded from the
 * denominator) yet DOES carry return information, so it must stay in. The five
 * explicit fields keep that row in while dropping only the genuine seed/no-flow
 * row.
 *
 * Applied before the `< 2`-row count + geometric product in all three TWR
 * surfaces (`accountReturns`, `listAccountTwr`, the `computePortfolioSummary`
 * portfolio loop) so a seed-$0 account stays `twr === null` / shows `—`
 * everywhere and never dilutes the portfolio return.
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

// ---------- Portfolio-level (account-balances list page) ----------

export interface AccountWithCurrentBalance {
  id: string;
  name: string;
  ownerDisplayName: string;
  type: AccountPayload['type'];
  taxTreatment: AccountPayload['taxTreatment'];
  active: boolean;
  /** Free-form notes from the account's canonical payload — surfaced on
   *  list rows via the shared `<NotesIndicator>`. */
  notes: string;
  currentBalance: number | null;
  /** For MIXED accounts: the Roth-designated (post-tax) sub-balance. Null for non-MIXED or no-balance accounts. */
  currentBalancePostTax: number | null;
  currentBalanceYear: number | null;
  /** `lastUpdated` of the latest-year balance entry — the date the
   *  current balance was recorded, surfaced as the list-page "As of"
   *  column. null when the account has no balance rows. */
  currentBalanceAsOf: string | null;
  /** Account's own annualized TWR (geometric mean of its yearly
   *  Modified-Dietz returns), surfaced as the list-page table column.
   *  null when the account has no balance rows — renders "—". Matches
   *  the per-account "Ann. Return (TWR)" stat on the detail page. */
  twr: number | null;
}

export interface PortfolioSummary {
  totalCurrentBalance: number;
  /** Latest-year balances bucketed by tax treatment (PRE_TAX accounts
   *  + the pre-tax split of MIXED accounts; POST_TAX likewise). The
   *  list page surfaces these as the same tax-diversification cards a
   *  MIXED account detail view shows — always rendered, $0 when empty. */
  totalPreTaxBalance: number;
  totalPostTaxBalance: number;
  /** Pre/post-tax balance as a % of totalCurrentBalance (0 when no balance). */
  preTaxPct: number;
  postTaxPct: number;
  /** Latest-year balances of accounts that are **tax-free by account type**
   *  (Roth IRA + HSA, regardless of their stored `taxTreatment`). A
   *  dashboard-only display field. HSA accounts now carry `taxTreatment:
   *  'HSA'`, whose by-`taxTreatment` balance arm is a no-op, so an HSA lands
   *  in `totalTaxFreeBalance` only — never also in `totalPreTaxBalance` /
   *  `totalPostTaxBalance`. `deriveTaxTreatmentAllocation` still derives the
   *  dashboard's pre-tax slice by subtraction (subtracting only the MIXED
   *  Roth-designated post-tax sub-bucket out of the taxable slice). */
  totalTaxFreeBalance: number;
  /** Tax-free balance as a % of totalCurrentBalance (0–100; 0 when no
   *  balance) — same scale as `preTaxPct` / `postTaxPct`. */
  taxFreePct: number;
  totalContributions: number;
  totalCompanyContributions: number;
  /** All-years contributions bucketed by tax treatment, same rule as
   *  the balance buckets above. */
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

/**
 * Per-account TWR, computed from the account's own yearly
 * Modified-Dietz returns. Mirrors the portfolio algorithm in
 * `computePortfolioSummary` scoped to one account. Returns null
 * when the account has fewer than two yearly returns — the geometric
 * mean isn't meaningful from a single point.
 *
 * Used by the Balance Projection page to surface "what would the
 * projected balance be if this account kept compounding at the rate
 * it has actually delivered?" alongside the Planned-return number.
 */
export interface AccountReturns {
  twr: number | null;
}

export function accountReturns(
  balances: Aggregate<AccountBalancePayload>[],
): AccountReturns {
  // Drop seed/degenerate rows before the count + product so an auto-$0 seed
  // never fabricates a return (a seed + one real year would otherwise be a
  // 2-row diluted geometric mean flipping the account to "has history").
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

/**
 * Per-account TWR for the list-page column. Geometric mean of the
 * account's own yearly Modified-Dietz returns — mirrors the detail
 * page's `calcTwr` so the column matches the "Ann. Return (TWR)" stat
 * you see when you open the account: a single year yields that year's
 * return, no rows yields null (rendered "—"). Distinct from
 * `accountReturns`, which the projection page uses and which requires
 * ≥2 years before reporting a compounded figure.
 */
function listAccountTwr(rows: Aggregate<AccountBalancePayload>[]): number | null {
  // Exclude seed/degenerate rows first so a seed-only account shows `—`
  // (null), not a fabricated `0%`, in the list-page "Ann. Return (TWR)"
  // column.
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

  // Tax-diversification buckets. PRE_TAX / POST_TAX accounts roll their
  // whole balance + contributions into the matching bucket; MIXED
  // accounts split via their stored pre/post fields; HSA and ROTH balances
  // are tax-free (counted in `totalTaxFreeBalance`, no-op in the pre/post
  // split). The Roth-designated (post-tax) sub-bucket of a MIXED
  // Roth-designated retirement account (401k/403b/457b/TSP) is tax-free too:
  // it goes to `totalTaxFreeBalance` ONLY, never to `totalPostTaxBalance`
  // (counting it in both would double-count it and push the percentages past
  // 100). A MIXED OTHER account's post-tax sub-bucket is plain taxable money
  // and stays in `totalPostTaxBalance`. Every account carries exactly one of
  // the five treatments (PRE_TAX, POST_TAX, MIXED, HSA, ROTH), so pre + post +
  // tax-free reconstitutes the total and the percentages always sum to 100
  // (modulo no-balance $0).
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
    // Tax-free accumulation (dashboard display). Roth + HSA earnings /
    // qualified withdrawals are both tax-free; we classify by `taxTreatment`
    // here (treatment-based) so this stays consistent with the
    // by-`taxTreatment` buckets below, which split strictly on treatment.
    // Roth accounts carry `taxTreatment: 'ROTH'` and HSA accounts carry
    // `taxTreatment: 'HSA'`; both whose pre/post arms are no-ops below, so
    // each is counted here only (no double count).
    if (tt === 'ROTH' || tt === 'HSA') {
      totalTaxFreeBalance += ending;
    } else if (mixedRothDesignated) {
      // Roth-designated sub-bucket (endingBalancePostTax) of a MIXED
      // Roth-designated retirement account (401k/403b/457b/TSP) is tax-free,
      // even though the account TYPE isn't Roth/HSA. A MIXED OTHER account's
      // post-tax sub-bucket is plain taxable money, so it is excluded here.
      totalTaxFreeBalance += latest.payload.endingBalancePostTax ?? 0;
    }
    if (tt === 'MIXED') {
      totalPreTaxBalance += latest.payload.endingBalancePreTax ?? 0;
      if (!mixedRothDesignated) {
        // MIXED OTHER: the post-tax sub-bucket is plain taxable money.
        totalPostTaxBalance += latest.payload.endingBalancePostTax ?? 0;
      }
      // MIXED Roth-designated: the post-tax sub-bucket is tax-free and is
      // already counted in `totalTaxFreeBalance` above; counting it here too
      // double-counts it and pushes the percentages past 100.
    } else if (tt === 'POST_TAX') {
      totalPostTaxBalance += ending;
    } else if (tt === 'HSA') {
      // No-op for the by-`taxTreatment` pre/post split: an HSA's balance is
      // already counted in `totalTaxFreeBalance` by the accumulator above,
      // so adding it to pre/post would double-count it.
    } else if (tt === 'ROTH') {
      // No-op: a Roth's balance is already counted in `totalTaxFreeBalance`
      // above; routing it to the pre/post split would double-count it (and
      // misclassify tax-free money as pre-tax).
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
        // HSA contributions reduce taxable income (pre-tax deductible).
        // `PortfolioSummary` has no tax-free contributions bucket, so route
        // them to `totalPreTaxContributions` to keep the figure meaningful.
        totalPreTaxContributions += totalContributions(p);
      } else if (tt === 'ROTH') {
        // Roth contributions are post-tax funded — route them to the
        // post-tax bucket (same as POST_TAX), not pre-tax.
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

  // `yearsCovered` keeps its original meaning — distinct calendar years with
  // any balance row (seed rows included).
  const yearsCovered = new Set(balances.map((b) => b.payload.year)).size;

  // Exclude seed/degenerate rows from the portfolio TWR so a cold-start
  // seed-only portfolio reports `null` (rendered `—`), not a fabricated 0%,
  // and a seed-$0 account never dilutes the portfolio geometric mean. A year
  // with no return-bearing row contributes no factor.
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
 * The dashboard's three-slice tax-treatment allocation (pre-tax / taxable /
 * tax-free). A display-only reclassification of the shared
 * `computePortfolioSummary` totals: Roth + HSA are shown as **tax-free**
 * (by account type), and the Roth-designated (post-tax) sub-bucket of a MIXED
 * Roth-designated retirement account (401k/403b/457b/TSP) is **also** tax-free,
 * independent of the ledger's by-`taxTreatment` split. A MIXED OTHER account's
 * post-tax sub-bucket is plain taxable money and stays in the taxable slice.
 * Each `*Pct` is on the 0–100 scale matching `PortfolioSummary.preTaxPct`.
 */
export interface TaxTreatmentAllocation {
  pretaxBalance: number;
  taxableBalance: number;
  /** Combined tax-free total (Roth + HSA). Kept for callers that want the
   *  rolled-up tax-free figure; `taxFreeRoth + taxFreeHsa` equals it. */
  taxFreeBalance: number;
  /** Tax-free balance from Roth-type sources: `'ROTH'`-treatment accounts
   *  plus the Roth-designated post-tax sub-bucket of MIXED retirement
   *  accounts (401k/403b/457b/TSP). */
  taxFreeRoth: number;
  /** Tax-free balance from `'HSA'`-treatment accounts. */
  taxFreeHsa: number;
  pretaxPct: number;
  taxablePct: number;
  taxFreePct: number;
}

/**
 * Derive the dashboard's pre-tax / taxable / tax-free split from the shared
 * summary. Pure; unit-tested directly (the formula lives here, not in the
 * dashboard hook).
 *
 * `accounts` are the flat `AccountWithCurrentBalance` rows
 * `computePortfolioSummary` returns (`.type` / `.taxTreatment` /
 * `.currentBalance`), needed only to split the tax-free total into its Roth
 * vs HSA halves.
 *
 * Formula (canonical):
 *  1. taxFreeBalance = summary.totalTaxFreeBalance (Roth + HSA by type, plus
 *     the MIXED Roth-designated retirement `endingBalancePostTax` sub-buckets
 *     — 401k/403b/457b/TSP only, NOT MIXED OTHER).
 *  2. taxableBalance = summary.totalPostTaxBalance — no per-account
 *     subtraction. `computePortfolioSummary` already routes the MIXED
 *     Roth-designated post-tax sub-bucket to `totalTaxFreeBalance` ONLY (never
 *     into `totalPostTaxBalance`), and standalone Roth / HSA accounts carry
 *     `taxTreatment: 'ROTH'` / `'HSA'` (no longer POST_TAX) after the v2→v3
 *     migration, so they never enter `totalPostTaxBalance` either. What remains
 *     in `totalPostTaxBalance` is exactly the genuinely-taxable money
 *     (POST_TAX accounts + MIXED OTHER post-tax sub-buckets).
 *  3. pretaxBalance = total − taxFree − taxable ("whatever isn't tax-free or
 *     taxable is pre-tax") — guarantees the three sum to the total. An HSA's
 *     `'HSA'` treatment keeps it out of `totalPreTaxBalance`, so it is counted
 *     in tax-free only with no double count.
 *  4. tax-free splits Roth vs HSA: `taxFreeHsa` is the sum of `'HSA'`-treatment
 *     account current balances; `taxFreeRoth` is the remainder
 *     (`taxFreeBalance − taxFreeHsa`) so the two halves always reconstitute
 *     `taxFreeBalance` (Roth-type accounts + MIXED Roth-designated sub-buckets).
 *  5. each *Pct = balance / total * 100 (0–100); total ≤ 0 → all zero.
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
  // `summary.totalPostTaxBalance` already holds only genuinely-taxable money:
  // `computePortfolioSummary` routes the MIXED Roth-designated post-tax
  // sub-bucket to `totalTaxFreeBalance` ONLY, and standalone Roth / HSA
  // accounts (now `taxTreatment: 'ROTH'` / `'HSA'`) never enter it. So the
  // taxable slice needs no per-account subtraction.
  const taxableBalance = summary.totalPostTaxBalance;
  const pretaxBalance = total - taxFreeBalance - taxableBalance;

  // Split the tax-free total into HSA vs Roth. HSA tax-free money is exactly
  // the current balance of `'HSA'`-treatment accounts; the remainder of the
  // tax-free total is Roth-type (standalone Roth accounts + the MIXED
  // Roth-designated post-tax sub-buckets already folded into
  // `summary.totalTaxFreeBalance`). Deriving Roth by subtraction guarantees
  // `taxFreeRoth + taxFreeHsa === taxFreeBalance`.
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
