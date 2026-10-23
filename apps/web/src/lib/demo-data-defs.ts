/**
 * Pure demo-dataset definitions (data and helpers only, no IndexedDB or mutation-queue access) that `demo-data-loader.ts` materializes.
 * Covers the return sequences, account roster, per-year balance generator, expense set, the single CBP-payout income stream and the expense-category id map.
 */
import { DEFAULT_EXPENSE_CATEGORY_IDS } from './expense-categories-bootstrap';
import type {
  AccountOwnershipType,
  AccountTaxTreatment,
  AccountType,
  ExpensePayload,
  IncomeStreamPayload,
} from '../db/types';

export interface BalanceRow {
  year: number;
  startingBalance: number;
  startingBalancePreTax?: number;
  startingBalancePostTax?: number;
  totalContributions: number;
  companyContributions: number;
  contributionsPreTax?: number;
  contributionsPostTax?: number;
  rollover: number;
  endingBalance: number;
  endingBalancePreTax?: number;
  endingBalancePostTax?: number;
  /**
   * Recorded in-plan rollover principal, taxable half; sparse, set only on the rollover year
   * alongside a matching inbound `rollover` leg.
   */
  rothInPlanRolloverTaxableAmount?: number;
}

export type ReturnProfile = 'equityHeavy' | 'balanced' | 'conservative' | 'stableValue' | 'cash';

// Hand-tuned 10-year return % sequences (oldest → newest) shaped like a realistic decade; the last
// value repeats if a longer window is generated. Each geometric mean (equityHeavy ≈ 6.9%, balanced
// ≈ 6.6%, conservative ≈ 5.9%, stableValue ≈ 4.1%) sits near its accounts' planning return, so the
// Historical, Planned and Monte Carlo views tell one story. They sit a notch below the long-run
// average; Monte Carlo's fuller 1950+ sampling still runs well above them.
export const RETURN_SEQUENCES: Record<ReturnProfile, readonly number[]> = {
  equityHeavy: [15, -6, 16, 9, -9, 14, 8, 11, 5, 9],
  balanced: [13, -3, 14, 8, -5, 12, 7, 9, 5, 8],
  conservative: [10, 1, 11, 6, -2, 9, 6, 7, 5, 7],
  stableValue: [4, 4.5, 4.2, 3.8, 3.5, 4, 4.2, 4.5, 4, 4],
  cash: [0.8, 1.2, 1.8, 2.0, 0.5, 1.0, 4.0, 5.0, 4.5, 4.0],
};

export function generateBalances(
  startYear: number,
  endYear: number,
  initialBalance: number,
  annualContribution: number,
  returnSequence: readonly number[],
  isMixed: boolean,
  preTaxPct?: number,
  contributionsStopYear?: number,
): BalanceRow[] {
  const balances: BalanceRow[] = [];
  let runningTotal = initialBalance;
  let runningPre = isMixed ? Math.round(initialBalance * (preTaxPct ?? 0.5)) : 0;
  let runningPost = isMixed ? initialBalance - runningPre : 0;

  for (let year = startYear; year <= endYear; year++) {
    const idx = year - startYear;
    const annualReturnPct =
      returnSequence[idx] ?? returnSequence[returnSequence.length - 1] ?? 0;
    const contributionsStopped =
      contributionsStopYear !== undefined && year > contributionsStopYear;
    const contrib = contributionsStopped ? 0 : annualContribution;
    const contribPre = isMixed ? Math.round(contrib * (preTaxPct ?? 0.5)) : 0;
    const contribPost = isMixed ? contrib - contribPre : 0;

    const avgCapital = runningTotal + contrib / 2;
    const gain = Math.round(avgCapital * (annualReturnPct / 100));
    const ending = runningTotal + contrib + gain;

    const endingPre = isMixed
      ? Math.round(
          runningPre +
            contribPre +
            Math.round((runningPre + contribPre / 2) * (annualReturnPct / 100)),
        )
      : 0;
    const endingPost = isMixed ? ending - endingPre : 0;

    balances.push({
      year,
      startingBalance: runningTotal,
      startingBalancePreTax: isMixed ? runningPre : undefined,
      startingBalancePostTax: isMixed ? runningPost : undefined,
      totalContributions: contrib,
      companyContributions: 0,
      contributionsPreTax: isMixed ? contribPre : undefined,
      contributionsPostTax: isMixed ? contribPost : undefined,
      rollover: 0,
      endingBalance: ending,
      endingBalancePreTax: isMixed ? endingPre : undefined,
      endingBalancePostTax: isMixed ? endingPost : undefined,
    });

    runningTotal = ending;
    runningPre = endingPre;
    runningPost = endingPost;
  }

  return balances;
}

export interface AccountDef {
  /**
   * Stable slug deriving deterministic aggregate IDs, so repeated loads (e.g. multi-device)
   * overwrite rather than duplicate.
   */
  slug: string;
  name: string;
  type: AccountType;
  ownership: AccountOwnershipType;
  tax: AccountTaxTreatment;
  ownerKey: 'primary' | 'secondary';
  institution: string;
  notes: string | null;
  initialBalance: number;
  annualContrib: number;
  /** Forward-looking planning return % stored on the account payload. */
  returnPct: number;
  /** Volatility profile used to generate historical year-by-year returns. */
  returnProfile: ReturnProfile;
  preTaxPct: number | undefined;
  active?: boolean;
  /**
   * Inclusive year of the last contribution; later years contribute 0. Omitted means every year.
   */
  contributionsStopYear?: number;
  plannedContributionPreTax: number;
  plannedContributionPostTax: number;
  /**
   * Contribution annual-increase rate (percent): absent tracks inflation, an explicit number
   * including `0` is a fixed COLA (`0` = flat-nominal).
   */
  contributionGrowthPct?: number;
  /**
   * Recorded designated-Roth in-plan rollover (§402A(c)(4)): money moved from an employer plan's
   * pre-tax side to its Roth side in one tax year, `yearOffset` indexing the generated balance
   * years. Only on a designated-Roth employer account, not a MIXED plan, where the same event is a
   * pre-tax → post-tax shift inside the row's own split fields.
   */
  inPlanRollover?: { yearOffset: number; taxableDollars: number };
  /**
   * Slug of the sibling account a closed (`active: false`) account was consolidated into: the
   * loader's closure rollover-out is matched by an inbound `rollover` leg of the same size on that
   * account's row, so the household still holds the money. Required when the closed account's
   * history is basis (a Roth IRA's contributions stay §408A basis in the owner's pool).
   */
  consolidatedIntoSlug?: string;
  /**
   * Varied per account so the Monte Carlo page shows a non-trivial fan: cash wrappers are 100%
   * cash, retirement/HSA lean equity with the primary more aggressive; the CBP carries a stub mix
   * the engine ignores.
   */
  assetMixStocks: number;
  assetMixBonds: number;
  assetMixCash: number;
}

export function accountDefs(): AccountDef[] {
  return [
    // A realistic dual-earner household ~10 years into saving, holding about $515k of retirement
    // savings across 401(k), IRA, Roth, HSA, a cash balance plan and a taxable joint brokerage.
    // `initialBalance` is the balance ~10 years ago, not today: the loader seeds a 10-year history
    // (startYear = currentYear − 9) by compounding it with `annualContrib` through the return
    // profile, so the current-year row's ending balance is today's value.
    // Planning returns (~6.25–7.25%) and moderate mixes (45–65% stocks) are deliberately
    // conservative so the Planned line sits mid-fan; the base scenario stays solvent and its MAGI
    // stays below the MFJ IRMAA tier-1 threshold in its first Medicare years.
    // Institution names are fictional so no real brand appears in the demo.
    { slug: 'john-401k', name: 'Demo Primary 401(k)', type: 'RETIREMENT_401K', ownership: 'INDIVIDUAL', tax: 'MIXED', ownerKey: 'primary', institution: 'Northbrook Investments', notes: 'Primary employer plan; match up to 6%', initialBalance: 26000, annualContrib: 10000, returnPct: 7.0, returnProfile: 'equityHeavy', preTaxPct: 0.75, plannedContributionPreTax: 7500, plannedContributionPostTax: 2500, contributionGrowthPct: 4, assetMixStocks: 60, assetMixBonds: 35, assetMixCash: 5 },
    { slug: 'john-ira', name: 'Demo Primary IRA', type: 'RETIREMENT_IRA', ownership: 'INDIVIDUAL', tax: 'PRE_TAX', ownerKey: 'primary', institution: 'Northbrook Investments', notes: 'Rollover IRA; receives the cash-balance-plan lump sum at retirement', initialBalance: 21000, annualContrib: 0, returnPct: 6.5, returnProfile: 'balanced', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 0, assetMixStocks: 50, assetMixBonds: 40, assetMixCash: 10 },
    { slug: 'john-roth-ira', name: 'Demo Primary Roth IRA', type: 'RETIREMENT_ROTH_IRA', ownership: 'INDIVIDUAL', tax: 'ROTH', ownerKey: 'primary', institution: 'Lakeside Brokerage', notes: null, initialBalance: 0, annualContrib: 3000, returnPct: 7.25, returnProfile: 'equityHeavy', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 3000, assetMixStocks: 65, assetMixBonds: 30, assetMixCash: 5 },
    // Carries the demo's one designated-Roth in-plan rollover ($20,000 five years ago). It sits on
    // this pure-Roth account, not the MIXED `john-401k`, because a separate account genuinely
    // receives the money, so the inbound `rollover` leg is correct; that principal is the account's
    // whole designated-Roth basis.
    { slug: 'john-roth-401k', name: 'Demo Primary Roth 401(k)', type: 'RETIREMENT_ROTH_401K', ownership: 'INDIVIDUAL', tax: 'ROTH', ownerKey: 'primary', institution: 'Northbrook Investments', notes: 'Designated-Roth slice of the primary employer plan; after-tax contributions', initialBalance: 8000, annualContrib: 2500, returnPct: 7.0, returnProfile: 'equityHeavy', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 2500, inPlanRollover: { yearOffset: 4, taxableDollars: 20000 }, assetMixStocks: 70, assetMixBonds: 25, assetMixCash: 5 },
    // A consolidated, closed Roth IRA: its closure row (positive start → $0 end, explained by an
    // outbound `rollover`) imputes no withdrawal, and its contributions remain John's §408A basis.
    // `consolidatedIntoSlug` makes the two-sided closure honest, so every pooled basis dollar is
    // backed by a balance dollar.
    { slug: 'john-roth-ira-old', name: 'Demo Primary Consolidated Roth IRA', type: 'RETIREMENT_ROTH_IRA', ownership: 'INDIVIDUAL', tax: 'ROTH', ownerKey: 'primary', institution: 'Cedarpoint Retirement', notes: 'Former Roth IRA; consolidated into the primary Roth IRA', initialBalance: 12000, annualContrib: 2000, returnPct: 6.75, returnProfile: 'balanced', preTaxPct: undefined, active: false, consolidatedIntoSlug: 'john-roth-ira', plannedContributionPreTax: 0, plannedContributionPostTax: 0, assetMixStocks: 55, assetMixBonds: 40, assetMixCash: 5 },
    { slug: 'john-hsa', name: 'Demo Primary HSA', type: 'HSA', ownership: 'INDIVIDUAL', tax: 'HSA', ownerKey: 'primary', institution: 'Summit Health Savings', notes: 'Triple-tax-advantaged; invested', initialBalance: 0, annualContrib: 1500, returnPct: 6.75, returnProfile: 'balanced', preTaxPct: undefined, plannedContributionPreTax: 1500, plannedContributionPostTax: 0, assetMixStocks: 55, assetMixBonds: 40, assetMixCash: 5 },
    { slug: 'john-old-401k', name: 'Demo Primary Old 401(k)', type: 'RETIREMENT_401K', ownership: 'INDIVIDUAL', tax: 'PRE_TAX', ownerKey: 'primary', institution: 'Cedarpoint Retirement', notes: 'Closed former-employer plan; rolled out, zero balance', initialBalance: 0, annualContrib: 0, returnPct: 6.5, returnProfile: 'balanced', preTaxPct: undefined, active: false, plannedContributionPreTax: 0, plannedContributionPostTax: 0, assetMixStocks: 50, assetMixBonds: 45, assetMixCash: 5 },
    { slug: 'jane-401k', name: 'Demo Secondary 401(k)', type: 'RETIREMENT_401K', ownership: 'INDIVIDUAL', tax: 'PRE_TAX', ownerKey: 'secondary', institution: 'Harborview Funds', notes: 'Current employer plan; contribution held flat-nominal', initialBalance: 12000, annualContrib: 5500, returnPct: 6.75, returnProfile: 'balanced', preTaxPct: undefined, plannedContributionPreTax: 5500, plannedContributionPostTax: 0, contributionGrowthPct: 0, assetMixStocks: 55, assetMixBonds: 40, assetMixCash: 5 },
    { slug: 'jane-401k-former', name: 'Demo Secondary Former 401(k)', type: 'RETIREMENT_401K', ownership: 'INDIVIDUAL', tax: 'MIXED', ownerKey: 'secondary', institution: 'Maplewood Retirement', notes: 'Funded former-employer plan; no new contributions', initialBalance: 28000, annualContrib: 0, returnPct: 6.75, returnProfile: 'balanced', preTaxPct: 0.7, active: false, plannedContributionPreTax: 0, plannedContributionPostTax: 0, assetMixStocks: 55, assetMixBonds: 40, assetMixCash: 5 },
    { slug: 'jane-roth-ira', name: 'Demo Secondary Roth IRA', type: 'RETIREMENT_ROTH_IRA', ownership: 'INDIVIDUAL', tax: 'ROTH', ownerKey: 'secondary', institution: 'Lakeside Brokerage', notes: null, initialBalance: 0, annualContrib: 2500, returnPct: 7.0, returnProfile: 'equityHeavy', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 2500, assetMixStocks: 60, assetMixBonds: 35, assetMixCash: 5 },
    // Inherited Roth IRA: its beneficiary rule is seeded complete in the loader so it raises no
    // required-withdrawal blocker; withdrawals are entirely tax-free and it carries no Roth basis
    // state.
    { slug: 'jane-inherited-roth-ira', name: 'Demo Secondary Inherited Roth IRA', type: 'RETIREMENT_ROTH_IRA', ownership: 'INDIVIDUAL', tax: 'ROTH', ownerKey: 'secondary', institution: 'Harborview Funds', notes: 'Inherited from a parent; beneficiary withdrawals only', initialBalance: 9000, annualContrib: 0, returnPct: 6.75, returnProfile: 'balanced', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 0, assetMixStocks: 55, assetMixBonds: 40, assetMixCash: 5 },
    { slug: 'jane-hsa', name: 'Demo Secondary HSA', type: 'HSA', ownership: 'INDIVIDUAL', tax: 'HSA', ownerKey: 'secondary', institution: 'Summit Health Savings', notes: 'Triple-tax-advantaged; invested', initialBalance: 0, annualContrib: 1500, returnPct: 6.25, returnProfile: 'conservative', preTaxPct: undefined, plannedContributionPreTax: 1500, plannedContributionPostTax: 0, assetMixStocks: 45, assetMixBonds: 45, assetMixCash: 10 },
    { slug: 'cash-balance-plan', name: 'Demo Cash Balance Plan', type: 'RETIREMENT_CASH_BALANCE', ownership: 'INDIVIDUAL', tax: 'PRE_TAX', ownerKey: 'primary', institution: 'Northbrook Investments', notes: 'Active employer cash-balance plan; ~$4k/yr pay credits', initialBalance: 4000, annualContrib: 4000, returnPct: 4.0, returnProfile: 'stableValue', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 0, assetMixStocks: 0, assetMixBonds: 0, assetMixCash: 100 },
    // Taxable joint brokerage bridging pre-tax-heavy retirement accounts and tax-free Roth;
    // POST_TAX BROKERAGE withdrawals realize the LTCG proxy, so the LTCG path is exercised in the
    // demo.
    { slug: 'joint-brokerage', name: 'Demo Joint Brokerage', type: 'BROKERAGE', ownership: 'JOINT', tax: 'POST_TAX', ownerKey: 'primary', institution: 'Lakeside Brokerage', notes: 'Taxable joint brokerage — index funds', initialBalance: 5000, annualContrib: 2000, returnPct: 6.75, returnProfile: 'balanced', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 2000, assetMixStocks: 55, assetMixBonds: 35, assetMixCash: 10 },
  ];
}

// Reuses the auto-bootstrap's id-per-name map so a fresh sign-up followed by Load Demo Data upserts
// in place instead of producing 16 categories.
export const DEMO_CATEGORY_BY_NAME = DEFAULT_EXPENSE_CATEGORY_IDS;

/**
 * Demo expenses covering each timepoint kind so the chart band renders a representative spend curve
 * from first paint. The budget is tuned so the base scenario (retire 65, both members) funds
 * comfortably through life expectancy while "Funds Run Out" exhausts the portfolio mid-retirement.
 * Year-anchored windows use `currentYear + N` offsets so they stay realistic in any load year.
 */
export function demoExpenseDefs(
  currentYear: number,
): ReadonlyArray<{ id: string; payload: ExpensePayload }> {
  return [
  // Housing — mortgage to payoff, then property costs for life; a renovation one-off exercises the
  // spike pattern.
  {
    id: 'demo-exp-mortgage',
    payload: {
      name: 'Mortgage',
      amount: 2200,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Housing,
      start: { kind: 'year', year: currentYear },
      end: { kind: 'year', year: currentYear + 8 },
    },
  },
  {
    id: 'demo-exp-property-tax',
    payload: {
      name: 'Property tax',
      amount: 9000,
      frequency: 'yearly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Housing,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  },
  {
    id: 'demo-exp-hoa',
    payload: {
      name: 'HOA fees',
      amount: 400,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Housing,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  },
  {
    id: 'demo-exp-home-maintenance',
    payload: {
      name: 'Home maintenance',
      amount: 500,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Housing,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  },
  {
    id: 'demo-exp-home-insurance',
    payload: {
      name: 'Home insurance',
      amount: 250,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Housing,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  },
  {
    id: 'demo-exp-home-renovation',
    payload: {
      name: 'Home renovation (one-off)',
      amount: 25000,
      frequency: 'oneOff',
      classification: 'discretionary',
      categoryId: DEMO_CATEGORY_BY_NAME.Housing,
      start: { kind: 'age', memberId: 'primary', years: 70, months: 0 },
    },
  },

  // Utilities — one continuous essential line for the household.
  {
    id: 'demo-exp-utilities',
    payload: {
      name: 'Utilities (gas + electric + internet)',
      amount: 650,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Utilities,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  },

  // Food — essential groceries plus discretionary dining out, so the category renders two stacked
  // sub-bands.
  {
    id: 'demo-exp-groceries',
    payload: {
      name: 'Groceries',
      amount: 1300,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Food,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  },
  {
    id: 'demo-exp-dining-out',
    payload: {
      name: 'Dining out',
      amount: 550,
      frequency: 'monthly',
      classification: 'discretionary',
      categoryId: DEMO_CATEGORY_BY_NAME.Food,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
      // Dining-out spend glides to 70% of today's real spend from John's age 65 to the expense's
      // own end, then holds; shows the `expenseEnd` glide-end anchor, which follows a scenario
      // patch of the end.
      discretionaryGlide: {
        endMultiplierPct: 70,
        glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
        glideEnd: { kind: 'expenseEnd' },
      },
    },
  },

  // Transportation — ongoing fuel and maintenance, with new-car one-offs.
  {
    id: 'demo-exp-fuel-maintenance',
    payload: {
      name: 'Fuel & vehicle maintenance',
      amount: 400,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Transportation,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  },
  {
    id: 'demo-exp-new-car',
    payload: {
      name: 'New car (one-off)',
      amount: 28000,
      frequency: 'oneOff',
      classification: 'discretionary',
      categoryId: DEMO_CATEGORY_BY_NAME.Transportation,
      start: { kind: 'year', year: currentYear + 8 },
    },
  },
  {
    id: 'demo-exp-replacement-car',
    payload: {
      name: 'Replacement car (one-off)',
      amount: 25000,
      frequency: 'oneOff',
      classification: 'discretionary',
      categoryId: DEMO_CATEGORY_BY_NAME.Transportation,
      start: { kind: 'age', memberId: 'primary', years: 75, months: 0 },
    },
  },

  // Medical — a private plan bridging to Medicare, Part B for both, a Medigap supplement, then
  // two-stage long-term care.
  {
    // ID kept for demo-reload stability: the row is upserted in place though its name and economics
    // evolved.
    id: 'demo-exp-cobra',
    payload: {
      name: 'Private health plan (bridge to Medicare)',
      amount: 1300,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Medical,
      start: { kind: 'retirementStart' },
      // Runs from retirement until John (primary, the younger spouse) reaches 65; empty in the base
      // plan (he retires at 65) and only bites in early-retirement scenarios, sized for one adult
      // as Jane is already Medicare-eligible.
      end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      // Pre-65 marketplace / COBRA premiums are not HSA-qualified (§223(d)(2)).
      hsaQualified: false,
    },
  },
  {
    id: 'demo-exp-medicare-john',
    payload: {
      name: 'John Medicare Part B',
      amount: 185,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Medical,
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'primary' },
      // Medicare Part B premiums are HSA-qualified once the member is 65+ (§213(d)(1)(D)).
      hsaQualified: true,
    },
  },
  {
    id: 'demo-exp-medicare-jane',
    payload: {
      name: 'Jane Medicare Part B',
      amount: 185,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Medical,
      start: { kind: 'age', memberId: 'secondary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'secondary' },
      hsaQualified: true,
    },
  },
  {
    id: 'demo-exp-medigap',
    payload: {
      name: 'Medigap supplement (both)',
      amount: 600,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Medical,
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'last' },
      // Medigap (Medicare Supplement) premiums are not HSA-qualified (§223(d)(2)(C)).
      hsaQualified: false,
    },
  },
  // End-of-life long-term care in two stages anchored to John (the last to die at the default life
  // expectancy of 95): assisted living at ages 90–92, then nursing home from 93. The `age` end is
  // exclusive so the windows tile; amounts are ~US national medians (Genworth, ≈ $5,500/mo and ≈
  // $10,000/mo).
  {
    id: 'demo-exp-ltc-care',
    payload: {
      name: 'Long-term care (assisted living)',
      amount: 5500,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Medical,
      start: { kind: 'age', memberId: 'primary', years: 90, months: 0 },
      end: { kind: 'age', memberId: 'primary', years: 93, months: 0 },
      // Qualified LTC services for a chronically ill person are HSA-qualified (§213(d)(1)(C)).
      hsaQualified: true,
    },
  },
  {
    id: 'demo-exp-ltc-nursing',
    payload: {
      name: 'Long-term care (nursing home)',
      amount: 10000,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Medical,
      start: { kind: 'age', memberId: 'primary', years: 93, months: 0 },
      end: { kind: 'lifetime', whose: 'last' },
      hsaQualified: true,
    },
  },

  // Insurance — auto plus an umbrella line.
  {
    id: 'demo-exp-car-insurance',
    payload: {
      name: 'Car insurance',
      amount: 300,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Insurance,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  },
  {
    id: 'demo-exp-umbrella',
    payload: {
      name: 'Umbrella policy',
      amount: 600,
      frequency: 'yearly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Insurance,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  },

  // Entertainment — go-go years travel taper plus ongoing hobbies.
  {
    id: 'demo-exp-travel',
    payload: {
      name: 'Travel — go-go years',
      amount: 10000,
      frequency: 'yearly',
      classification: 'discretionary',
      categoryId: DEMO_CATEGORY_BY_NAME.Entertainment,
      start: { kind: 'retirementStart' },
      end: { kind: 'durationFromStart', months: 120 },
    },
  },
  {
    id: 'demo-exp-hobbies',
    payload: {
      name: 'Hobbies & subscriptions',
      amount: 350,
      frequency: 'monthly',
      classification: 'discretionary',
      categoryId: DEMO_CATEGORY_BY_NAME.Entertainment,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  },

  // Other — charitable giving and family gifts, discretionary and continuous.
  {
    id: 'demo-exp-charity',
    payload: {
      name: 'Charitable giving',
      amount: 300,
      frequency: 'monthly',
      classification: 'discretionary',
      categoryId: DEMO_CATEGORY_BY_NAME.Other,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  },
  {
    id: 'demo-exp-gifts',
    payload: {
      name: 'Gifts & family support',
      amount: 200,
      frequency: 'monthly',
      classification: 'discretionary',
      categoryId: DEMO_CATEGORY_BY_NAME.Other,
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  },
  ];
}

/**
 * The demo's single income stream, mirroring the real export: a Cash Balance Plan lump-sum rollover
 * into the primary's IRA at retirement. A linked CBP lump sum derives its deposit from the plan's
 * projected balance at the event month, so the entered `lumpSumAmount` (~$100k) is reference only.
 */
export const DEMO_INCOME_DEFS: ReadonlyArray<{
  id: string;
  forMember: 'primary' | 'secondary';
  payload: (memberId: string) => IncomeStreamPayload;
}> = [
  {
    id: 'demo-income-cbp-payout',
    forMember: 'primary',
    payload: (memberId) => ({
      name: 'CBP Payout to IRA',
      notes:
        'Cash Balance Plan lump-sum rollover into the IRA at retirement; amount derived from the plan balance at the event month (~$100k estimate, reference only).',
      memberId,
      kind: 'pension',
      payoutType: 'lumpSum',
      start: { kind: 'retirementStart' },
      linkedCbpAccountId: 'demo-account-cash-balance-plan',
      targetAccountId: 'demo-account-john-ira',
      taxable: true,
    }),
  },
];
