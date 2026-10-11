/**
 * Pure demo-dataset definitions, extracted from `demo-data-loader.ts`
 * so the loader file stays within reach of the shape limit.
 *
 * This module is data + pure helpers ONLY — no IndexedDB access, no
 * mutation-queue writes, no side effects. It holds the hand-tuned demo
 * roster the loader materializes: historical return sequences, the
 * account roster, the per-year balance generator, the canonical expense
 * set, the single CBP-payout income stream, and the deterministic
 * expense-category id map. `demo-data-loader.ts` imports these and does
 * all the transactional orchestration (preconditions, id computation,
 * queueing, snapshot/sync wiring).
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
  /** Recorded designated-Roth IN-PLAN ROLLOVER principal for this year
   *  (§402A(c)(4)), taxable half. Sparse — set only on the one year the
   *  rollover happened, and always alongside a matching inbound `rollover`
   *  leg on the same row. */
  rothInPlanRolloverTaxableAmount?: number;
}

export type ReturnProfile = 'equityHeavy' | 'balanced' | 'conservative' | 'stableValue' | 'cash';

// Hand-tuned 10-year return % sequences (oldest → newest). Designed to
// feel like a realistic decade — drawdowns, recoveries, rate-driven cash
// bumps — rather than the prior flat-return placeholder. Falls back to
// the last value if a longer demo window is ever generated.
//
// The geometric mean of each sequence (equityHeavy ≈ 6.9%, balanced ≈
// 6.6%, conservative ≈ 5.9%, stableValue ≈ 4.1%) is tuned to sit close
// to the *planning* return of the accounts that use it, so the seeded
// 10-year history (which drives the Historical / time-weighted-return
// projection) lands in the same place as the forward Planned projection
// AND inside the middle of the Monte Carlo fan — the three views tell one
// coherent story instead of three unrelated ones. These are deliberately
// a notch below the long-run market average (a conservative "don't assume
// the good decade repeats" posture); the Monte Carlo engine samples the
// fuller 1950+ history on top of the per-account asset mix, so its upside
// tail still runs well above these lines.
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
  /** Stable slug used to derive deterministic aggregate IDs so repeated
   *  demo-data loads (e.g. multi-device) produce the same UUIDs and
   *  IndexedDB `put` overwrites instead of creating duplicates. */
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
  /** Inclusive year of the last contribution. After this year, contributions
   *  drop to 0 (models a paused/closed contribution stream — role change,
   *  Roth pivot, etc.). Omitted = contribute every year in the window. */
  contributionsStopYear?: number;
  plannedContributionPreTax: number;
  plannedContributionPostTax: number;
  /** Optional per-account contribution annual-increase rate (percent).
   *  Absent → tracks inflation (the default — holds real value). Explicit
   *  number incl. `0` → fixed COLA (`0` = flat-nominal). Exercises all
   *  three tiers across the demo accounts. */
  contributionGrowthPct?: number;
  /** Optional recorded designated-Roth IN-PLAN ROLLOVER (§402A(c)(4)) — money
   *  moved from an employer plan's pre-tax side to its Roth side in ONE tax
   *  year. `yearOffset` is the 0-based index into the account's generated
   *  balance years. Only meaningful on a designated-Roth employer account, and
   *  deliberately NOT on a MIXED plan, where the same event is a pre-tax →
   *  post-tax shift inside that row's own split fields rather than money
   *  arriving. */
  inPlanRollover?: { yearOffset: number; taxableDollars: number };
  /** Slug of the sibling account this CLOSED account was consolidated into.
   *  Only meaningful with `active: false`: the closure rollover-OUT the loader
   *  writes is then matched by an inbound `rollover` leg of the same size on the
   *  named account's row for the same year, so the money the closure moved is
   *  still held by the household. Required on a closed account whose recorded
   *  history is BASIS somewhere (a Roth IRA's contributions stay §408A basis in
   *  the owner's pool after the account closes) — otherwise the pool would resolve
   *  basis with no balance behind it. */
  consolidatedIntoSlug?: string;
  /** Demo asset mix — varied per account so the Monte Carlo page shows
   *  a non-trivial fan. Cash wrappers stay 100% cash; retirement/HSA
   *  lean equity-heavy with primary being the more aggressive
   *  accumulator. CBP carries a stub mix that the engine ignores. */
  assetMixStocks: number;
  assetMixBonds: number;
  assetMixCash: number;
}

export function accountDefs(): AccountDef[] {
  return [
    // A realistic middle-class dual-earner household of two, ~10 years
    // into serious saving, holding roughly $515k of usable retirement
    // savings today spread across 401(k), IRA, Roth, HSA, a cash balance
    // plan, and a taxable joint brokerage.
    //
    // IMPORTANT — `initialBalance` is the balance ~10 YEARS AGO, not today.
    // The loader seeds a 10-year history (startYear = currentYear − 9) by
    // compounding `initialBalance` forward through the returnProfile
    // sequence with `annualContrib` each year, so the *ending* balance of
    // the current-year row is today's value. The small initial anchors
    // below grow (with modest ~$18k/yr total contributions) to ~$515k
    // today — the story is "an ordinary family that got serious about
    // saving about a decade ago," not a wealthy one.
    //
    // Planning return %s are deliberately conservative forward
    // assumptions (~6.25–7.25%, a notch below the long-run market
    // average), so the Planned projection lands in the MIDDLE of the
    // Monte Carlo fan rather than at its optimistic top — the planned and
    // historical lines read as a sober central estimate, not a best case.
    // Asset mixes are a moderate couple-in-their-50s posture (45–65%
    // stocks), varied per account so the Monte Carlo page (which samples
    // the fuller 1950+ history on top of the mix) shows a non-trivial fan.
    // The base scenario stays solvent through plan end and its modified
    // adjusted gross income (MAGI) stays BELOW the inflation-extrapolated
    // MFJ IRMAA tier-1 threshold in its first Medicare years (no surcharge).
    // Institution names are deliberately fictional (Northbrook, Lakeside,
    // Summit, …) so no real-world brand from any production export appears
    // in the demo. Balances are current-year approximations, not anchored
    // to a fixed calendar year.
    { slug: 'john-401k', name: 'Demo Primary 401(k)', type: 'RETIREMENT_401K', ownership: 'INDIVIDUAL', tax: 'MIXED', ownerKey: 'primary', institution: 'Northbrook Investments', notes: 'Primary employer plan; match up to 6%', initialBalance: 26000, annualContrib: 10000, returnPct: 7.0, returnProfile: 'equityHeavy', preTaxPct: 0.75, plannedContributionPreTax: 7500, plannedContributionPostTax: 2500, contributionGrowthPct: 4, assetMixStocks: 60, assetMixBonds: 35, assetMixCash: 5 },
    { slug: 'john-ira', name: 'Demo Primary IRA', type: 'RETIREMENT_IRA', ownership: 'INDIVIDUAL', tax: 'PRE_TAX', ownerKey: 'primary', institution: 'Northbrook Investments', notes: 'Rollover IRA; receives the cash-balance-plan lump sum at retirement', initialBalance: 21000, annualContrib: 0, returnPct: 6.5, returnProfile: 'balanced', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 0, assetMixStocks: 50, assetMixBonds: 40, assetMixCash: 10 },
    { slug: 'john-roth-ira', name: 'Demo Primary Roth IRA', type: 'RETIREMENT_ROTH_IRA', ownership: 'INDIVIDUAL', tax: 'ROTH', ownerKey: 'primary', institution: 'Lakeside Brokerage', notes: null, initialBalance: 0, annualContrib: 3000, returnPct: 7.25, returnProfile: 'equityHeavy', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 3000, assetMixStocks: 65, assetMixBonds: 30, assetMixCash: 5 },
    // Carries the demo's one designated-Roth IN-PLAN ROLLOVER: $20,000
    // moved from the employer plan's pre-tax side into its Roth side five years
    // ago. It sits on this PURE-Roth account rather than the MIXED `john-401k`
    // because, modelled as a separate account, the money genuinely arrives — so
    // an inbound `rollover` leg on that row is correct balance arithmetic. That
    // principal is this account's whole designated-Roth basis.
    { slug: 'john-roth-401k', name: 'Demo Primary Roth 401(k)', type: 'RETIREMENT_ROTH_401K', ownership: 'INDIVIDUAL', tax: 'ROTH', ownerKey: 'primary', institution: 'Northbrook Investments', notes: 'Designated-Roth slice of the primary employer plan; after-tax contributions', initialBalance: 8000, annualContrib: 2500, returnPct: 7.0, returnProfile: 'equityHeavy', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 2500, inPlanRollover: { yearOffset: 4, taxableDollars: 20000 }, assetMixStocks: 70, assetMixBonds: 25, assetMixCash: 5 },
    // Consolidated, CLOSED Roth IRA — a decade of real contribution
    // history rolled into `john-roth-ira` in the current year. Its closure row
    // is a positive start → $0 end fully explained by an outbound `rollover`,
    // so it imputes no withdrawal; its recorded contributions are still John's
    // §408A basis and enter his pool with no status gate. `consolidatedIntoSlug`
    // is what makes that honest: the closure is TWO-SIDED, so every pooled basis
    // dollar is still backed by a balance dollar in the pool.
    { slug: 'john-roth-ira-old', name: 'Demo Primary Consolidated Roth IRA', type: 'RETIREMENT_ROTH_IRA', ownership: 'INDIVIDUAL', tax: 'ROTH', ownerKey: 'primary', institution: 'Cedarpoint Retirement', notes: 'Former Roth IRA; consolidated into the primary Roth IRA', initialBalance: 12000, annualContrib: 2000, returnPct: 6.75, returnProfile: 'balanced', preTaxPct: undefined, active: false, consolidatedIntoSlug: 'john-roth-ira', plannedContributionPreTax: 0, plannedContributionPostTax: 0, assetMixStocks: 55, assetMixBonds: 40, assetMixCash: 5 },
    { slug: 'john-hsa', name: 'Demo Primary HSA', type: 'HSA', ownership: 'INDIVIDUAL', tax: 'HSA', ownerKey: 'primary', institution: 'Summit Health Savings', notes: 'Triple-tax-advantaged; invested', initialBalance: 0, annualContrib: 1500, returnPct: 6.75, returnProfile: 'balanced', preTaxPct: undefined, plannedContributionPreTax: 1500, plannedContributionPostTax: 0, assetMixStocks: 55, assetMixBonds: 40, assetMixCash: 5 },
    { slug: 'john-old-401k', name: 'Demo Primary Old 401(k)', type: 'RETIREMENT_401K', ownership: 'INDIVIDUAL', tax: 'PRE_TAX', ownerKey: 'primary', institution: 'Cedarpoint Retirement', notes: 'Closed former-employer plan; rolled out, zero balance', initialBalance: 0, annualContrib: 0, returnPct: 6.5, returnProfile: 'balanced', preTaxPct: undefined, active: false, plannedContributionPreTax: 0, plannedContributionPostTax: 0, assetMixStocks: 50, assetMixBonds: 45, assetMixCash: 5 },
    { slug: 'jane-401k', name: 'Demo Secondary 401(k)', type: 'RETIREMENT_401K', ownership: 'INDIVIDUAL', tax: 'PRE_TAX', ownerKey: 'secondary', institution: 'Harborview Funds', notes: 'Current employer plan; contribution held flat-nominal', initialBalance: 12000, annualContrib: 5500, returnPct: 6.75, returnProfile: 'balanced', preTaxPct: undefined, plannedContributionPreTax: 5500, plannedContributionPostTax: 0, contributionGrowthPct: 0, assetMixStocks: 55, assetMixBonds: 40, assetMixCash: 5 },
    { slug: 'jane-401k-former', name: 'Demo Secondary Former 401(k)', type: 'RETIREMENT_401K', ownership: 'INDIVIDUAL', tax: 'MIXED', ownerKey: 'secondary', institution: 'Maplewood Retirement', notes: 'Funded former-employer plan; no new contributions', initialBalance: 28000, annualContrib: 0, returnPct: 6.75, returnProfile: 'balanced', preTaxPct: 0.7, active: false, plannedContributionPreTax: 0, plannedContributionPostTax: 0, assetMixStocks: 55, assetMixBonds: 40, assetMixCash: 5 },
    { slug: 'jane-roth-ira', name: 'Demo Secondary Roth IRA', type: 'RETIREMENT_ROTH_IRA', ownership: 'INDIVIDUAL', tax: 'ROTH', ownerKey: 'secondary', institution: 'Lakeside Brokerage', notes: null, initialBalance: 0, annualContrib: 2500, returnPct: 7.0, returnProfile: 'equityHeavy', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 2500, assetMixStocks: 60, assetMixBonds: 35, assetMixCash: 5 },
    // Inherited Roth IRA — the one account shape the demo lacked. Its
    // beneficiary rule is seeded complete in the loader, so it raises no
    // required-withdrawal blocker; withdrawals from it are entirely tax-free and
    // it carries no Roth basis state of any kind.
    { slug: 'jane-inherited-roth-ira', name: 'Demo Secondary Inherited Roth IRA', type: 'RETIREMENT_ROTH_IRA', ownership: 'INDIVIDUAL', tax: 'ROTH', ownerKey: 'secondary', institution: 'Harborview Funds', notes: 'Inherited from a parent; beneficiary withdrawals only', initialBalance: 9000, annualContrib: 0, returnPct: 6.75, returnProfile: 'balanced', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 0, assetMixStocks: 55, assetMixBonds: 40, assetMixCash: 5 },
    { slug: 'jane-hsa', name: 'Demo Secondary HSA', type: 'HSA', ownership: 'INDIVIDUAL', tax: 'HSA', ownerKey: 'secondary', institution: 'Summit Health Savings', notes: 'Triple-tax-advantaged; invested', initialBalance: 0, annualContrib: 1500, returnPct: 6.25, returnProfile: 'conservative', preTaxPct: undefined, plannedContributionPreTax: 1500, plannedContributionPostTax: 0, assetMixStocks: 45, assetMixBonds: 45, assetMixCash: 10 },
    { slug: 'cash-balance-plan', name: 'Demo Cash Balance Plan', type: 'RETIREMENT_CASH_BALANCE', ownership: 'INDIVIDUAL', tax: 'PRE_TAX', ownerKey: 'primary', institution: 'Northbrook Investments', notes: 'Active employer cash-balance plan; ~$4k/yr pay credits', initialBalance: 4000, annualContrib: 4000, returnPct: 4.0, returnProfile: 'stableValue', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 0, assetMixStocks: 0, assetMixBonds: 0, assetMixCash: 100 },
    // Taxable joint brokerage — the demo's bridge between pre-tax-heavy
    // retirement accounts and tax-free Roth. POST_TAX BROKERAGE
    // withdrawals realize the long-term-capital-gains proxy the tax
    // engine models, so the LTCG path is exercised in the demo rather
    // than invisible. Sized as a modest non-retirement cushion.
    { slug: 'joint-brokerage', name: 'Demo Joint Brokerage', type: 'BROKERAGE', ownership: 'JOINT', tax: 'POST_TAX', ownerKey: 'primary', institution: 'Lakeside Brokerage', notes: 'Taxable joint brokerage — index funds', initialBalance: 5000, annualContrib: 2000, returnPct: 6.75, returnProfile: 'balanced', preTaxPct: undefined, plannedContributionPreTax: 0, plannedContributionPostTax: 2000, assetMixStocks: 55, assetMixBonds: 35, assetMixCash: 10 },
  ];
}

// Reuses the same id-per-name map the auto-bootstrap seeds with so a
// fresh sign-up (bootstrap creates 8 categories) followed by Load
// Demo Data upserts in place rather than producing 16 categories.
export const DEMO_CATEGORY_BY_NAME = DEFAULT_EXPENSE_CATEGORY_IDS;

/**
 * Demo expenses cover each timepoint kind so the projection chart band
 * renders a representative spend curve from first paint.
 *
 * Budget is hand-tuned so the base scenario (retire 65, both members)
 * funds comfortably through life expectancy while the "Funds Run Out"
 * scenario exhausts the portfolio mid-retirement.
 *
 * Mix exercises every default category (Housing, Utilities, Food,
 * Transportation, Medical, Insurance, Entertainment, Other) with a
 * balanced essential / discretionary split, plus two one-off events
 * for the spike pattern in the chart.
 *
 * Year-anchored windows (mortgage, new-car one-off) use `currentYear + N`
 * offsets so they stay realistic whichever calendar year the demo
 * loads in: mortgage runs from `currentYear` to `currentYear + 8`; the
 * new-car one-off fires at `currentYear + 8`.
 */
export function demoExpenseDefs(
  currentYear: number,
): ReadonlyArray<{ id: string; payload: ExpensePayload }> {
  return [
  // Housing — mortgage runs to retirement-year payoff, then property
  // costs (taxes, HOA, upkeep) continue for life. Renovation one-off
  // mid-retirement exercises the spike pattern.
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

  // Food — essential groceries plus a discretionary dining-out line so
  // the category renders two stacked sub-bands.
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
      // Canonical spending glide: dining-out spend glides down to 70%
      // of today's real spend from John's age 65 to when the expense
      // ends — its own `lifetime(last)` end — then holds flat.
      // Showcases the `expenseEnd` glide-end anchor; the curve moves
      // automatically if a scenario patches the expense's end. Visible
      // on the Expenses / cashflow bands from first paint (every
      // scenario inherits it unless it patches the expense).
      discretionaryGlide: {
        endMultiplierPct: 70,
        glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
        glideEnd: { kind: 'expenseEnd' },
      },
    },
  },

  // Transportation — fuel + maintenance ongoing; new-car one-offs at
  // the start and again mid-retirement.
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

  // Medical — COBRA bridge to Medicare, then Medicare Part B for both
  // members + Medigap supplement, then a two-stage end-of-life
  // long-term-care cost (assisted living → nursing home) in the final
  // years.
  {
    // ID kept as 'demo-exp-cobra' for demo-reload stability — the
    // display name + economics evolved (private pre-Medicare health
    // coverage until 65) but the aggregate identity is the same row,
    // upserted in place on reload.
    id: 'demo-exp-cobra',
    payload: {
      name: 'Private health plan (bridge to Medicare)',
      amount: 1300,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: DEMO_CATEGORY_BY_NAME.Medical,
      start: { kind: 'retirementStart' },
      // Bridge runs from retirement until John (the PRIMARY, and the
      // younger spouse) reaches 65 and ages into Medicare. In the base
      // plan John retires at 65, so this window is empty (he goes
      // straight to Medicare). It only bites in the early-retirement
      // scenarios: John retires at 62, so he buys a private/ACA plan for
      // his 62→65 gap. Jane (older) is already Medicare-eligible by then,
      // so the bridge covers John alone — sized for one adult.
      end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      // Pre-65 marketplace / COBRA premiums are NOT HSA-qualified (§223(d)(2)).
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
      // Medicare Part B premiums are HSA-qualified once the member is 65+ (§213(d)(1)(D)).
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
      // Medigap (Medicare Supplement) premiums are NOT HSA-qualified (§223(d)(2)(C)).
      hsaQualified: false,
    },
  },
  // End-of-life long-term-care cost, modelled as a realistic two-stage
  // escalation over the household's final ~5 years: assisted living
  // first, then full nursing-home care at the very end. Both anchored to
  // the primary (John,
  // the younger spouse and therefore the last to die at the default life
  // expectancy of 95). The `age` end boundary is EXCLUSIVE, so the two
  // windows tile with no overlap and no gap: assisted living covers ages
  // 90–92, nursing home covers age 93 through death. Amounts are ~US
  // national medians (Genworth): assisted living ≈ $5,500/mo, private
  // nursing-home room ≈ $10,000/mo.
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
      // Qualified LTC services for a chronically ill person are HSA-qualified (§213(d)(1)(C)).
      hsaQualified: true,
    },
  },

  // Insurance — auto, plus an umbrella line. Term life burns off well
  // before retirement so it only shows on the pre-retirement leg.
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

  // Entertainment — go-go years travel taper, plus ongoing hobbies +
  // subscriptions for the long tail.
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

  // Other — charitable giving + gifts to grandkids. Both discretionary
  // and continuous through life.
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
 * Demo income stream — one — mirrors the real export's single-stream
 * structure: a Cash Balance Plan lump-sum rollover into the primary's
 * IRA at retirement.
 *
 * `payoutType: 'lumpSum'` + `linkedCbpAccountId` → the engine derives
 * the deposit from the source CBP account's projected balance at the
 * event month and routes it to `targetAccountId`; the entered
 * `lumpSumAmount` is hidden/forced to 0 for linked CBP lump sums,
 * so the ~$100k estimate is reference only.
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
      // Fires at the primary owner's retirement date.
      start: { kind: 'retirementStart' },
      linkedCbpAccountId: 'demo-account-cash-balance-plan',
      targetAccountId: 'demo-account-john-ira',
      taxable: true,
    }),
  },
];
