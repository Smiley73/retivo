/**
 * Client-side demo data loader: seeds the single-household demo dataset (two members, 14 accounts, 10 years of balances, Social Security PIAs, one CBP-payout income stream and four scenarios) into IndexedDB as queued mutations.
 * Refuses to run when the household already has any account or non-primary member outside the demo set.
 */
import {
  clearMutationQueue,
  listAggregates,
  listAggregatesIncludingDeleted,
  listAllMutations,
  withBatchedStoreSignals,
} from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import {
  realignAggregateVersions,
  serverAcknowledgedVersions,
} from '../sync/version-truth';
import { BASE_SCENARIO_NAME } from './scenario-bootstrap';
import { notifyWorkspaceChanged } from './workspace-events';
import { isPureRothEmployerType } from './balance-calc';
import { TWR_METHOD_LABEL } from './projection-method-labels';
import {
  DEMO_CATEGORY_BY_NAME,
  DEMO_INCOME_DEFS,
  RETURN_SEQUENCES,
  accountDefs,
  demoExpenseDefs,
  generateBalances,
  type AccountDef,
  type BalanceRow,
  type ReturnProfile,
} from './demo-data-defs';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  AggregateType,
  ExpenseCategoryPayload,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  ScenarioPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';

export class DemoDataExistsError extends Error {
  readonly code = 'DEMO_DATA_EXISTS' as const;
  constructor() {
    super(
      'Workspace already has household or account data. Demo data can only be loaded into an empty workspace.',
    );
    this.name = 'DemoDataExistsError';
  }
}

// RMD profile facts (both engines read them) per demo account slug; empty for accounts on the owner
// Uniform-Lifetime default.
// `john-ira` records Jane (three years older than John, so not more than ten years younger) as sole
// spouse beneficiary and leaves `rmdSoleSpouseBeneficiary` absent: Uniform Lifetime applies.
// `jane-inherited-roth-ira` is the one inherited account (from a mother who died after 2019, the
// only regime modeled), seeded with a complete beneficiary rule: an incomplete one reads `blocked`,
// which suppresses the inherited-Roth disclosure in `report-data.ts`. A child of the owner is a
// non-eligible designated beneficiary, so the ten-year rule applies with no election.
function rmdFactsForSlug(slug: string, currentYear: number): Partial<AccountPayload> {
  if (slug === 'john-ira') {
    return {
      rmdSpouseBeneficiaryBirthdate: `${currentYear - 52}-03-15`,
    };
  }
  if (slug === 'jane-inherited-roth-ira') {
    return {
      rmdInheritedAccount: true,
      rmdBeneficiaryType: 'OTHER_DESIGNATED',
      rmdInheritedOwnerDeathDate: `${currentYear - 3}-06-12`,
      // Past the required beginning date; on a Roth account the engine forces the pre-RBD regime
      // anyway.
      rmdInheritedOwnerDiedOnOrAfterRbd: true,
      rmdOriginalOwnerBirthdate: `${currentYear - 84}-02-08`,
    };
  }
  return {};
}

export interface LoadDemoDataInput {
  householdId: string;
  /** The signed-in user's email (used for the primary member's email). */
  email: string;
  /**
   * The signed-in user's display name; unused, since the demo hard-codes the primary as "John Doe".
   */
  displayName: string;
  /**
   * Override the "current year" for birth dates and balance-window offsets (default
   * `new Date().getUTCFullYear()`); parity tests pass `fixture.anchor.todayYear`.
   */
  todayYear?: number;
}

interface LoadDemoDataResult {
  primaryMemberId: string;
  secondaryMemberId: string;
  accountsCreated: number;
  balancesCreated: number;
  socialSecurityCreated: number;
  scenariosCreated: number;
}

const PRIMARY_MEMBER_ID = 'demo-member-primary';
const SECONDARY_MEMBER_ID = 'demo-member-secondary';
const DEMO_SCENARIO_BASE_ID = 'demo-scenario-base';
const DEMO_SCENARIO_EARLY_ID = 'demo-scenario-early';
const DEMO_SCENARIO_DELAY_ID = 'demo-scenario-delay';
const DEMO_SCENARIO_EARLY_NO_CONTRIB_ID = 'demo-scenario-early-no-contrib';

function balanceAggregateId(accountId: string, year: number): string {
  return `bal-${accountId}-${year}`;
}

// Credit an inbound rollover to `balances[arrivalIdx]` at year end (that row's recorded gain is
// unchanged) and carry it forward, so later years start from and compound the raised figure. Used
// for the in-plan rollover into `john-roth-401k` and the Roth-IRA consolidation into
// `john-roth-ira`; mutates in place, non-MIXED accounts only (on a split plan the same event is a
// within-row bucket shift).
function creditInboundRollover(
  balances: BalanceRow[],
  arrivalIdx: number,
  amountDollars: number,
  returnProfile: ReturnProfile,
): void {
  const returns = RETURN_SEQUENCES[returnProfile];
  let carried = amountDollars;
  for (let i = arrivalIdx; i < balances.length; i += 1) {
    const row = balances[i];
    if (i === arrivalIdx) {
      row.rollover += amountDollars;
    } else {
      row.startingBalance += carried;
      carried = Math.round(
        carried * (1 + (returns[i] ?? returns[returns.length - 1] ?? 0) / 100),
      );
    }
    row.endingBalance += carried;
  }
}

function ssAggregateId(memberId: string): string {
  return `ss-${memberId}`;
}

interface DemoAggregateIds {
  readonly members: ReadonlySet<string>;
  readonly accounts: ReadonlySet<string>;
  readonly balances: ReadonlySet<string>;
  readonly socialSecurity: ReadonlySet<string>;
  readonly scenarios: ReadonlySet<string>;
  readonly expenseCategories: ReadonlySet<string>;
  readonly expenses: ReadonlySet<string>;
  readonly incomeStreams: ReadonlySet<string>;
}

// Every aggregate id `loadDemoData` will write: the wipe skips these (they are upserted) and the
// loader's precondition ignores them.
function computeDemoAggregateIds(
  currentYear: number,
  primaryId: string,
  secondaryId: string,
  baseScenarioId: string,
): DemoAggregateIds {
  const accounts = new Set<string>();
  const balances = new Set<string>();
  const startYear = currentYear - 9;
  for (const def of accountDefs()) {
    const accountId = `demo-account-${def.slug}`;
    accounts.add(accountId);
    for (let year = startYear; year <= currentYear; year++) {
      balances.add(balanceAggregateId(accountId, year));
    }
  }
  return {
    members: new Set([primaryId, secondaryId]),
    accounts,
    balances,
    socialSecurity: new Set([ssAggregateId(primaryId), ssAggregateId(secondaryId)]),
    scenarios: new Set([
      baseScenarioId,
      DEMO_SCENARIO_EARLY_ID,
      DEMO_SCENARIO_DELAY_ID,
      DEMO_SCENARIO_EARLY_NO_CONTRIB_ID,
    ]),
    expenseCategories: new Set(Object.values(DEMO_CATEGORY_BY_NAME)),
    expenses: new Set(demoExpenseDefs(currentYear).map((e) => e.id)),
    incomeStreams: new Set(DEMO_INCOME_DEFS.map((d) => d.id)),
  };
}

export async function loadDemoData(input: LoadDemoDataInput): Promise<LoadDemoDataResult> {
  const currentYear = input.todayYear ?? new Date().getUTCFullYear();
  const startYear = currentYear - 9;

  const [accounts, members, scenarios] = await Promise.all([
    listAggregates('account') as Promise<Aggregate<AccountPayload>[]>,
    listAggregates('householdMember') as Promise<Aggregate<HouseholdMemberPayload>[]>,
    listAggregates('scenario') as Promise<Aggregate<ScenarioPayload>[]>,
  ]);

  // Reuse the existing primary if on file, else the canonical "John Doe"; `displayName` is ignored
  // so seeded workspaces read the same.
  const existingPrimary = members.find((m) => m.payload.isPrimary);
  const primaryId = existingPrimary?.id ?? PRIMARY_MEMBER_ID;
  const secondaryId = SECONDARY_MEMBER_ID;

  // Reuse the existing base scenario (auto-created at first sign-in by `ensureBaseScenario`), else
  // the deterministic demo id; the payload is rewritten either way.
  const existingBaseScenario = scenarios.find((s) => s.payload.isPrimary);
  const baseScenarioId = existingBaseScenario?.id ?? DEMO_SCENARIO_BASE_ID;

  // Existing data is only OK when it matches demo ids (the upsert path); anything else must be
  // cleared first via `wipeWorkspaceForDemoReload`.
  const demoIds = computeDemoAggregateIds(currentYear, primaryId, secondaryId, baseScenarioId);
  const nonDemoAccounts = accounts.filter((a) => !demoIds.accounts.has(a.id));
  const nonDemoMembers = members.filter(
    (m) => !m.payload.isPrimary && !demoIds.members.has(m.id),
  );
  if (nonDemoAccounts.length > 0 || nonDemoMembers.length > 0) {
    throw new DemoDataExistsError();
  }

  // Version lookup so the upsert path queues `update @ expectedVersion=current` rather than
  // `create @ 0`, which would conflict against a version-bumped cloud row and show "Refresh needed"
  // after a successful load. It includes tombstones: tombstoned server rows for demo ids are never
  // reaped, so only an `update @ tombstone_version` (which clears `deletedAt`) succeeds.
  const [
    allAccounts,
    allMembers,
    allBalances,
    allSS,
    allScenarios,
    allCategories,
    allExpenses,
    allIncomeStreams,
  ] = await Promise.all([
    listAggregatesIncludingDeleted('account'),
    listAggregatesIncludingDeleted('householdMember'),
    listAggregatesIncludingDeleted('accountBalance'),
    listAggregatesIncludingDeleted('socialSecurityBenefit'),
    listAggregatesIncludingDeleted('scenario'),
    listAggregatesIncludingDeleted('expenseCategory'),
    listAggregatesIncludingDeleted('expense'),
    listAggregatesIncludingDeleted('incomeStream'),
  ]);
  const versionByKey = new Map<string, number>();
  for (const a of allAccounts) versionByKey.set(`account:${a.id}`, a.version);
  for (const m of allMembers) versionByKey.set(`householdMember:${m.id}`, m.version);
  for (const b of allBalances) versionByKey.set(`accountBalance:${b.id}`, b.version);
  for (const s of allSS) versionByKey.set(`socialSecurityBenefit:${s.id}`, s.version);
  for (const sc of allScenarios) versionByKey.set(`scenario:${sc.id}`, sc.version);
  for (const c of allCategories) versionByKey.set(`expenseCategory:${c.id}`, c.version);
  for (const e of allExpenses) versionByKey.set(`expense:${e.id}`, e.version);
  for (const is of allIncomeStreams) versionByKey.set(`incomeStream:${is.id}`, is.version);

  function chooseOp(
    type: AggregateType,
    id: string,
  ): { operation: 'create' | 'update'; expectedVersion: number } {
    const v = versionByKey.get(`${type}:${id}`);
    return v !== undefined
      ? { operation: 'update', expectedVersion: v }
      : { operation: 'create', expectedVersion: 0 };
  }

  // One fine signal per touched store on scope exit instead of one per row; `batch` threads through
  // every `queueLocalMutation` below.
  let accountsCreated = 0;
  let balancesCreated = 0;
  let socialSecurityCreated = 0;
  await withBatchedStoreSignals(async (batch) => {
  // Always seed/overwrite the demo "John Doe" identity (name and birthdate included); email is
  // preserved when a primary exists, and the id is reused so references stay valid.
  await queueLocalMutation<HouseholdMemberPayload>({
    type: 'householdMember',
    aggregateId: primaryId,
    householdId: input.householdId,
    ...chooseOp('householdMember', primaryId),
    payload: {
      isPrimary: true,
      firstName: 'John',
      lastName: 'Doe',
      email: existingPrimary?.payload.email ?? input.email,
      // Dynamic birth year keeps the couple ~10 years from early retirement in any load year (John
      // is always ~49).
      birthdate: `${currentYear - 49}-06-15`,
    },
  }, batch);

  await queueLocalMutation<HouseholdMemberPayload>({
    type: 'householdMember',
    aggregateId: secondaryId,
    householdId: input.householdId,
    ...chooseOp('householdMember', secondaryId),
    payload: {
      isPrimary: false,
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane.doe@example.com',
      // Jane is always ~52, slightly older than John.
      birthdate: `${currentYear - 52}-03-15`,
    },
  }, batch);

  const ownerByKey: Record<AccountDef['ownerKey'], string> = {
    primary: primaryId,
    secondary: secondaryId,
  };

  // Cap the current-year row's `lastUpdated` at today: a mid-year load would otherwise plant a
  // future "as-of" date that the balance form rejects.
  const todayIso = new Date().toISOString();
  const currentYearLastUpdated = (year: number): string =>
    year === currentYear ? todayIso : `${year}-12-31T23:59:59Z`;

  // Generate every balance history before queueing any account: a consolidation moves money between
  // two accounts, so the receiving rows are only final once the closing account's are.
  const defs = accountDefs();
  const balancesBySlug = new Map<string, BalanceRow[]>();
  for (const def of defs) {
    const balances = generateBalances(
      startYear,
      currentYear,
      def.initialBalance,
      def.annualContrib,
      RETURN_SEQUENCES[def.returnProfile],
      def.tax === 'MIXED',
      def.preTaxPct,
      def.contributionsStopYear,
    );

    // The demo's one recorded designated-Roth in-plan rollover (§402A(c)(4)); its principal is the
    // plan's only designated-Roth basis. On a separate pure-Roth account the money genuinely
    // arrives, so a matching inbound `rollover` leg on the same row keeps it reconcilable against
    // the balance history.
    if (def.inPlanRollover !== undefined && balances.length > def.inPlanRollover.yearOffset) {
      const { yearOffset, taxableDollars } = def.inPlanRollover;
      creditInboundRollover(balances, yearOffset, taxableDollars, def.returnProfile);
      balances[yearOffset].rothInPlanRolloverTaxableAmount = taxableDollars;
    }

    // Inactive accounts must end at zero — model the closure as a rollover-out.
    if (def.active === false && balances.length > 0) {
      const last = balances[balances.length - 1];
      last.rollover = (last.rollover ?? 0) - last.endingBalance;
      last.endingBalance = 0;
      if (last.endingBalancePreTax !== undefined) last.endingBalancePreTax = 0;
      if (last.endingBalancePostTax !== undefined) last.endingBalancePostTax = 0;
    }

    balancesBySlug.set(def.slug, balances);
  }

  // The consolidation's receiving leg: a closed Roth IRA's contributions stay §408A basis in the
  // owner's pool, so the sibling must receive the rolled-out money (same year, same amount,
  // opposite sign). `john-old-401k` needs no such leg because it is PRE_TAX and derives no basis.
  for (const def of defs) {
    if (def.consolidatedIntoSlug === undefined) continue;
    const closed = balancesBySlug.get(def.slug);
    const receiving = defs.find((d) => d.slug === def.consolidatedIntoSlug);
    const into = receiving ? balancesBySlug.get(receiving.slug) : undefined;
    if (!closed || !into || !receiving || closed.length === 0) continue;
    const closureRow = closed[closed.length - 1];
    const rolledOutDollars = -closureRow.rollover;
    const arrivalIdx = into.findIndex((b) => b.year === closureRow.year);
    if (rolledOutDollars <= 0 || arrivalIdx < 0) continue;
    creditInboundRollover(into, arrivalIdx, rolledOutDollars, receiving.returnProfile);
  }

  for (const def of defs) {
    const accountId = `demo-account-${def.slug}`;
    const balances = balancesBySlug.get(def.slug) ?? [];

    // Roth tax facts: only the two first-year anchors are stored (schema v7 dropped the stored
    // basis totals); basis is derived from recorded history. §408A basis is pool-level, so every
    // basis dollar must be backed by a balance dollar in the owner's pool, not just its own
    // account: the in-plan rollover seeds a matching inbound leg on the same row, and the
    // consolidation's closure rollover-out is matched by an inbound leg on the receiving sibling.
    // No §408A conversion is seeded, since one without a matching inflow would be unsupported
    // basis; seed one with its inflow if the history gains a conversion year.
    const rothFacts: Partial<AccountPayload> = {};
    if (def.type === 'RETIREMENT_ROTH_IRA') {
      rothFacts.rothIraFirstContributionTaxYear = startYear;
    } else if (isPureRothEmployerType(def.type)) {
      rothFacts.designatedRothFirstParticipationTaxYear = startYear;
    }

    // Per-slug RMD facts consistent with the demo demographics (see `rmdFactsForSlug`); other
    // accounts leave them absent.
    const rmdFacts = rmdFactsForSlug(def.slug, currentYear);

    const accountPayload: AccountPayload = {
      name: def.name,
      type: def.type,
      ownershipType: def.ownership,
      taxTreatment: def.tax,
      ownerId: ownerByKey[def.ownerKey],
      institution: def.institution,
      notes: def.notes ?? '',
      planningReturnPct: def.returnPct,
      active: def.active ?? true,
      plannedContributionPreTax: def.plannedContributionPreTax,
      plannedContributionPostTax: def.plannedContributionPostTax,
      ...(def.contributionGrowthPct !== undefined
        ? { contributionGrowthPct: def.contributionGrowthPct }
        : {}),
      assetMix: {
        stocksPct: def.assetMixStocks,
        bondsPct: def.assetMixBonds,
        cashPct: def.assetMixCash,
      },
      ...rothFacts,
      ...rmdFacts,
    };

    await queueLocalMutation<AccountPayload>({
      type: 'account',
      aggregateId: accountId,
      householdId: input.householdId,
      ...chooseOp('account', accountId),
      payload: accountPayload,
    }, batch);
    accountsCreated += 1;

    for (const b of balances) {
      const balancePayload: AccountBalancePayload = {
        accountId,
        year: b.year,
        lastUpdated: currentYearLastUpdated(b.year),
        startingBalance: b.startingBalance,
        startingBalancePreTax: b.startingBalancePreTax ?? null,
        startingBalancePostTax: b.startingBalancePostTax ?? null,
        contributionsPreTax: b.contributionsPreTax ?? null,
        contributionsPostTax: b.contributionsPostTax ?? null,
        companyContributions: b.companyContributions,
        companyContributionsPreTax: null,
        companyContributionsPostTax: null,
        rollover: b.rollover,
        distributions: 0,
        endingBalance: b.endingBalance,
        endingBalancePreTax: b.endingBalancePreTax ?? null,
        endingBalancePostTax: b.endingBalancePostTax ?? null,
        totalContributions: b.totalContributions,
        comment: null,
        // Sparse-optional: omitted on years with no in-plan rollover, since absent is a weaker
        // claim than a stored 0.
        ...(b.rothInPlanRolloverTaxableAmount !== undefined
          ? { rothInPlanRolloverTaxableAmount: b.rothInPlanRolloverTaxableAmount }
          : {}),
      };
      const balanceId = balanceAggregateId(accountId, b.year);
      await queueLocalMutation<AccountBalancePayload>({
        type: 'accountBalance',
        aggregateId: balanceId,
        householdId: input.householdId,
        ...chooseOp('accountBalance', balanceId),
        payload: balancePayload,
      }, batch);
      balancesCreated += 1;
    }
  }

  // Illustrative monthly PIAs in today's dollars ($2,900 John, $1,800 Jane, ≈ $56k/yr combined) for
  // a dual-earner household with full careers.
  for (const [memberId, pia] of [
    [primaryId, 2900],
    [secondaryId, 1800],
  ] as const) {
    // Jan 1 of the current year is never a future date, so the PIA date needs no wall-clock clamp
    // and stays deterministic under a pinned `todayYear`; its year is the COLA anchor.
    const ssPayload: SocialSecurityBenefitPayload = {
      householdMemberId: memberId,
      pia,
      piaAsOfDate: `${currentYear}-01-01`,
      notes: 'From SSA statement — illustrative only.',
    };
    const ssId = ssAggregateId(memberId);
    await queueLocalMutation<SocialSecurityBenefitPayload>({
      type: 'socialSecurityBenefit',
      aggregateId: ssId,
      householdId: input.householdId,
      ...chooseOp('socialSecurityBenefit', ssId),
      payload: ssPayload,
    }, batch);
    socialSecurityCreated += 1;
  }

  // The same eight defaults the auto-bootstrap seeds, with deterministic ids so demo expenses can
  // reference them.
  for (const [name, catId] of Object.entries(DEMO_CATEGORY_BY_NAME)) {
    // The Medical category carries the `isMedical` flag, so the `cat-medical` rate pin and the +2pp
    // default follow the persisted flag.
    const payload: ExpenseCategoryPayload =
      catId === DEMO_CATEGORY_BY_NAME.Medical
        ? { name, isMedical: true }
        : { name };
    await queueLocalMutation<ExpenseCategoryPayload>({
      type: 'expenseCategory',
      aggregateId: catId,
      householdId: input.householdId,
      ...chooseOp('expenseCategory', catId),
      payload,
    }, batch);
  }

  for (const def of demoExpenseDefs(currentYear)) {
    await queueLocalMutation<ExpensePayload>({
      type: 'expense',
      aggregateId: def.id,
      householdId: input.householdId,
      ...chooseOp('expense', def.id),
      payload: def.payload,
    }, batch);
  }

  // Demo income stream — the single CBP-payout-to-IRA lump sum.
  for (const def of DEMO_INCOME_DEFS) {
    const memberId = def.forMember === 'primary' ? primaryId : secondaryId;
    await queueLocalMutation<IncomeStreamPayload>({
      type: 'incomeStream',
      aggregateId: def.id,
      householdId: input.householdId,
      ...chooseOp('incomeStream', def.id),
      payload: def.payload(memberId),
    }, batch);
  }

  // Inflate the CMS Rev. Proc. 2025-55 Table 4 MFJ tier-1 IRMAA threshold (source year 2026) to
  // John's first Medicare year (currentYear + 16: born currentYear − 49, retires at 65), so the
  // IRMAA contrast holds in any load year.
  const IRMAA_2026_MFJ_TIER1 = 218_000; // CMS Rev. Proc. 2025-55 Table 4, source year 2026
  const firstMedicareYear = currentYear + 16;
  const inflatedThreshold = Math.round(
    IRMAA_2026_MFJ_TIER1 * Math.pow(1.03, firstMedicareYear - 2026),
  );
  // ~45% of the inflated threshold (≈ the couple's ~$150k working income) seeds the IRMAA look-back
  // below the threshold, so the base scenario shows no surcharge.
  const baseMagiBootstrap = Math.round(inflatedThreshold * 0.45);

  // Base scenario: primary retires at 65 and both claim Social Security at FRA 67, same-date mode
  // anchored on primary, so a fresh demo lands on the supported case without the "different ages"
  // warning. "Delay — work to 70" is the deliberate contrast.
  const scenarioPayload: ScenarioPayload = {
    name: BASE_SCENARIO_NAME,
    description: 'Default plan — primary retires at 65, both claim Social Security at full retirement age (67).',
    parentScenarioId: null,
    isPrimary: true,
    notes:
      'Demo base scenario — primary retires at age 65; both household members claim Social Security at their full retirement age of 67.',
    overrides: {
      retirementAge: {
        primary: { ageYears: 65, ageMonths: 0 },
        // Jane retires the same day as John: her stored age (68y 3m) is pre-computed from John's
        // retirement date (currentYear + 16, June 15) and her birthdate (currentYear − 52, March
        // 15); the modal recomputes it on every anchor edit.
        secondary: { ageYears: 68, ageMonths: 3 },
        sameDateAnchor: 'primary',
      },
      socialSecurity: {
        primary: { ageYears: 67, ageMonths: 0 },
        secondary: { ageYears: 67, ageMonths: 0 },
        // Survivor claim ages, seeded at each member's FRA so the demo exercises the survivor rules
        // instead of the withheld state.
        survivor: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        colaTracksInflation: true,
      },
      withdrawalStrategy: { kind: 'taxEfficient' },
      // Married-couple filing plan: joint while both are alive, Single afterward; no relationship
      // metadata is stored on members. Seeded so the demo round-trips a real filing plan through
      // push/pull.
      taxFilingPlan: { kind: 'joint' },
      // Medical is pinned to the 3% general rate (the seeded default would be 5%) to keep the base
      // scenario funded to life expectancy, which also round-trips a real `categoryRates` map;
      // Housing at 2.5% demonstrates a genuinely different per-category rate.
      inflation: {
        ratePct: 3,
        categoryRates: { 'cat-medical': 3, 'cat-housing': 2.5 },
      },
      // 50% of taxable withdrawals assumed cost basis for the LTCG/QDI proxy.
      assumedCostBasisFractionOfTaxableWithdrawal: 0.5,
      // Seeds the IRMAA look-back for projection years 0–1 (MAGI(ret−2), MAGI(ret−1)) with the same
      // pre-retirement income stand-in.
      magiBootstrapLookbackMinus2: baseMagiBootstrap,
      magiBootstrapLookbackMinus1: baseMagiBootstrap,
      // 90% of emergency HSA withdrawals assumed qualified (tax-free), the rest ordinary income
      // plus the 20% additional tax before 65; modeled medical-qualified draws are always 100%
      // qualified. No accounts are exempt from the early-withdrawal penalty.
      hsaQualifiedMedicalExpensePct: 90,
      earlyWithdrawalPenaltyExemptAccountIds: [],
      // Working-years taxable income for the Roth conversion page's bracket-headroom math;
      // display-only.
      preRetirementTaxableIncomeDollars: 120_000,
    },
  };
  await queueLocalMutation<ScenarioPayload>({
    type: 'scenario',
    aggregateId: baseScenarioId,
    householdId: input.householdId,
    ...chooseOp('scenario', baseScenarioId),
    // Upsert rewrites name and payload over any existing base, renaming a previous "Primary" seed
    // to "Base".
    payload: scenarioPayload,
  }, batch);

  // Alternates branching off the base:
  //   Base (retire 65, SS 67/67)                              ← funds last to life expectancy
  //   ├── Retire early at 62 (SS primary 62 / secondary 67)   ← tighter but workable
  //   │     └── Funds Run Out (early + overspend → depletion) ← the failure case
  //   └── Delay — work to 70 (SS 70/70)                       ← the "fix": more income
  // Jane's stored ages are pre-computed from John's retirement date (early: currentYear + 13, June
  // 15, when Jane, born currentYear − 52, March 15, is 65y 3m).
  const earlyRetirementPayload: ScenarioPayload = {
    name: 'Retire early at 62',
    description:
      'What if both members retire at 62 and the primary claims Social Security as early as possible?',
    parentScenarioId: baseScenarioId,
    isPrimary: false,
    notes:
      "Anchored on John's 62nd birthday — Jane (the older spouse) retires the same calendar day at age 65 years 3 months. John claims Social Security early at 62; Jane claims at her full retirement age of 67. Pre-retirement: step the primary 401(k) deferral up to $12,000 to save harder in the run-up, and dial its planning return down to a more conservative 5.5% to stress-test the early-retirement glide path.",
    overrides: {
      retirementAge: {
        primary: { ageYears: 62, ageMonths: 0 },
        secondary: { ageYears: 65, ageMonths: 3 },
        sameDateAnchor: 'primary',
      },
      socialSecurity: {
        primary: { ageYears: 62, ageMonths: 0 },
        secondary: { ageYears: 67, ageMonths: 0 },
      },
      accountContributions: {
        perAccount: {
          // Step the primary 401(k) deferral up to $12k (split 75/25 to match its MIXED treatment)
          // and raise the annual-increase rate above the account's 4% baseline.
          'demo-account-john-401k': {
            plannedContributionPreTax: 9000,
            plannedContributionPostTax: 3000,
            contributionGrowthPct: 6,
          },
        },
      },
      accountReturns: {
        perAccount: {
          // Conservative planning rate (vs the 7.0% base); affects the Planned method only, TWR
          // stays empirical.
          'demo-account-john-401k': { planningReturnPct: 5.5 },
        },
      },
      withdrawalStrategy: { kind: 'taxEfficient' },
      // MAGI-ceiling ladder with two non-overlapping windows: Fill from retirement to John's 65
      // (the cheap pre-Medicare ACA years; leftover room under a $90k/yr IRMAA/federal MAGI ceiling
      // converts into John's Roth IRA), then Minimize from 65 to 70 under a tighter $60k ceiling,
      // converting nothing.
      magiCap: {
        windows: [
          {
            start: { kind: 'retirementStart' },
            end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
            magiCeilingAnnualDollars: 90_000,
            capMode: 'fill',
            capMagiLine: 'irmaa',
            targetRothAccountId: 'demo-account-john-roth-ira',
          },
          {
            start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
            end: { kind: 'age', memberId: 'primary', years: 70, months: 0 },
            magiCeilingAnnualDollars: 60_000,
            capMode: 'minimize',
            capMagiLine: 'irmaa',
          },
        ],
      },
      // A real ACA→Medicare transition for the month-aware health engine: retiring at 62 puts John
      // on Marketplace coverage for 62–64, then Medicare Part B and D at 65 (a mid-year split).
      // Keyed by member id; the FPL region is the 48 contiguous states + DC. Seeded so the demo
      // round-trips month-aware coverage data and shows a genuine part-year IRMAA and part-year
      // Marketplace benchmark.
      acaFplRegion: 'contiguous',
      healthCoverageMonths: {
        perMember: {
          [primaryId]: {
            // Retirement year: John retires June 15, so employer coverage covers Jan–May and
            // Marketplace only Jun–Dec (7 months); same boundary as the Medicare split.
            [firstMedicareYear - 3]: { marketplaceMonths: 7 },
            [firstMedicareYear - 2]: { marketplaceMonths: 12 },
            [firstMedicareYear - 1]: { marketplaceMonths: 12 },
            // Turns 65 mid-year: Marketplace Jan–May, Medicare Part B/D Jun–Dec.
            [firstMedicareYear]: { marketplaceMonths: 5, partBMonths: 7, partDMonths: 7 },
          },
        },
      },
    },
  };
  await queueLocalMutation<ScenarioPayload>({
    type: 'scenario',
    aggregateId: DEMO_SCENARIO_EARLY_ID,
    householdId: input.householdId,
    ...chooseOp('scenario', DEMO_SCENARIO_EARLY_ID),
    payload: earlyRetirementPayload,
  }, batch);

  // Delay — work to 70: the fix branch off the base. John retires at 70 (currentYear + 21, June
  // 15), when Jane (born currentYear − 52, March 15) is 73y 3m; both delay Social Security to 70
  // for maximum delayed credits.
  const delayPayload: ScenarioPayload = {
    name: 'Delay — work to 70',
    description:
      'The fix: work to 70 and delay Social Security to 70 for higher guaranteed lifetime income.',
    parentScenarioId: baseScenarioId,
    isPrimary: false,
    notes:
      "Both members work longer — John retires at 70 and Jane (the older spouse) retires the same calendar day at 73y 3m — and both claim Social Security at 70 to maximize delayed retirement credits. The extra working years of contributions plus the larger guaranteed benefit widen the cushion versus the base plan.",
    overrides: {
      retirementAge: {
        primary: { ageYears: 70, ageMonths: 0 },
        secondary: { ageYears: 73, ageMonths: 3 },
        sameDateAnchor: 'primary',
      },
      socialSecurity: {
        primary: { ageYears: 70, ageMonths: 0 },
        secondary: { ageYears: 70, ageMonths: 0 },
      },
    },
  };
  await queueLocalMutation<ScenarioPayload>({
    type: 'scenario',
    aggregateId: DEMO_SCENARIO_DELAY_ID,
    householdId: input.householdId,
    ...chooseOp('scenario', DEMO_SCENARIO_DELAY_ID),
    payload: delayPayload,
  }, batch);

  const fundsRunOutPayload: ScenarioPayload = {
    name: 'Funds Run Out',
    description:
      `The failure case: retire early at 62, stop saving today, double discretionary spending, and carry a high lifestyle-and-care budget. The portfolio depletes before plan end under every projection method (Planned / ${TWR_METHOD_LABEL}).`,
    parentScenarioId: DEMO_SCENARIO_EARLY_ID,
    isPrimary: false,
    notes:
      `Depletion-inducing levers stacked so the cashflow chart's red shortfall ribbon and the portfolio-depleted reference line appear under every projection method (Planned / ${TWR_METHOD_LABEL}): (1) it inherits the early-at-62 retirement, so the portfolio absorbs years of pure drawdown before Social Security starts; (2) \`stopContributionsToday: true\` freezes balance growth from today, removing the remaining years of compounding on planned contributions; (3) discretionary spending doubles (\`bumpPct: 100\`) — travel, dining out, charity, and gifts all run at double the base-plan rate; (4) a high lifestyle-and-care budget (patched onto the long-term-care line) drives larger withdrawals every year — enough that even the more generous historical returns (the ${TWR_METHOD_LABEL} method) cannot outrun the drawdown on this middle-class ~$515k portfolio. Life expectancy is set to 95 for the primary so the projection horizon keeps running past the depletion cliff.`,
    overrides: {
      contributions: { stopContributionsToday: true },
      discretionarySpending: { bumpPct: 100, durationYears: null },
      lifeExpectancy: { primary: 95 },
      // Base spending is modest against the ~$515k roster, so the levers above do not deplete the
      // portfolio alone; patching the long-term-care line to a high lifestyle-and-care budget makes
      // net withdrawals exceed growth under both Planned and TWR.
      expenses: {
        patches: {
          'aggregate:demo-exp-ltc-care': {
            name: 'Lifestyle & private care (stress)',
            amount: 3500,
            frequency: 'monthly',
            classification: 'essential',
            start: { kind: 'retirementStart' },
            end: { kind: 'lifetime', whose: 'last' },
          },
        },
      },
    },
  };
  await queueLocalMutation<ScenarioPayload>({
    type: 'scenario',
    aggregateId: DEMO_SCENARIO_EARLY_NO_CONTRIB_ID,
    householdId: input.householdId,
    ...chooseOp('scenario', DEMO_SCENARIO_EARLY_NO_CONTRIB_ID),
    payload: fundsRunOutPayload,
  }, batch);
  });

  const scenariosCreated = 4;

  // Mounted pages (e.g. /dashboard under the demo modal) must re-read aggregates that just landed
  // in IDB; the event is purely a render trigger.
  notifyWorkspaceChanged();

  return {
    primaryMemberId: primaryId,
    secondaryMemberId: secondaryId,
    accountsCreated,
    balancesCreated,
    socialSecurityCreated,
    scenariosCreated,
  };
}

export interface WipeWorkspaceResult {
  deletedAccounts: number;
  deletedBalances: number;
  deletedSocialSecurity: number;
  deletedMembers: number;
  deletedScenarios: number;
  deletedExpenseCategories: number;
  deletedExpenses: number;
  deletedIncomeStreams: number;
}

/**
 * Queue a `delete` for every aggregate the following `loadDemoData` will not upsert (legacy
 * random-UUID demo data, user-created accounts). Matching ids are left intact: deleting them would
 * tombstone the cloud row at v=N+1, so the loader's `create @ 0` would conflict ("Refresh needed").
 * Run it before `loadDemoData` when overwriting an existing workspace, since `clearAllStores()`
 * alone leaves orphans in the cloud that the next pull would re-deliver. The primary member is
 * skipped because the loader reuses it.
 */
export async function wipeWorkspaceForDemoReload(
  householdId: string,
): Promise<WipeWorkspaceResult> {
  const result: WipeWorkspaceResult = {
    deletedAccounts: 0,
    deletedBalances: 0,
    deletedSocialSecurity: 0,
    deletedMembers: 0,
    deletedScenarios: 0,
    deletedExpenseCategories: 0,
    deletedExpenses: 0,
    deletedIncomeStreams: 0,
  };

  // Drop pending and failed-conflict mutations before queueing the wipe's own: the overwrite
  // confirmation makes them moot, and a leftover `failed-conflict` row would keep the badge on
  // "Refresh needed". Version truth: recover each aggregate's server-acknowledged version from the
  // queue before clearing it and de-inflate local versions after, so the wipe's deletes target a
  // version the server can reach.
  const versionTruth = serverAcknowledgedVersions(await listAllMutations());
  await clearMutationQueue();
  await realignAggregateVersions(versionTruth);

  const currentYear = new Date().getUTCFullYear();
  const [members, scenarios] = await Promise.all([
    listAggregates('householdMember') as Promise<Aggregate<HouseholdMemberPayload>[]>,
    listAggregates('scenario') as Promise<Aggregate<ScenarioPayload>[]>,
  ]);
  const existingPrimary = members.find((m) => m.payload.isPrimary);
  const primaryId = existingPrimary?.id ?? PRIMARY_MEMBER_ID;
  const existingBaseScenario = scenarios.find((s) => s.payload.isPrimary);
  const baseScenarioId = existingBaseScenario?.id ?? DEMO_SCENARIO_BASE_ID;
  const demoIds = computeDemoAggregateIds(
    currentYear,
    primaryId,
    SECONDARY_MEMBER_ID,
    baseScenarioId,
  );
  const skipByType: Record<AggregateType, ReadonlySet<string>> = {
    household: new Set(),
    householdMember: demoIds.members,
    account: demoIds.accounts,
    accountBalance: demoIds.balances,
    socialSecurityBenefit: demoIds.socialSecurity,
    scenario: demoIds.scenarios,
    expenseCategory: demoIds.expenseCategories,
    expense: demoIds.expenses,
    incomeStream: demoIds.incomeStreams,
  };

  // Balances before accounts follows dependency order, and expenses before categories so a paused
  // flush never leaves an expense pointing at a tombstoned category.
  const types = [
    'accountBalance',
    'account',
    'socialSecurityBenefit',
    'householdMember',
    'scenario',
    'expense',
    'expenseCategory',
    'incomeStream',
  ] as const satisfies readonly AggregateType[];

  // Compile-time exhaustiveness: every AggregateType except `household` must appear in `types` (a
  // missing one, like `incomeStream` once, would accumulate across reloads).
  type _WipeOrderCoverage = Exclude<
    AggregateType,
    (typeof types)[number] | 'household'
  >;
  const _wipeOrderExhaustive: _WipeOrderCoverage extends never
    ? true
    : never = true;
  void _wipeOrderExhaustive;

  // One fine signal per touched store on scope exit.
  await withBatchedStoreSignals(async (batch) => {
    for (const type of types) {
      // Enumerate with local tombstones: a soft-deleted aggregate whose delete never reached the
      // server would otherwise be skipped, leaving the server's live copy to reappear on the next
      // pull. Its delete is re-queued at the version the version-truth de-inflation realigned to;
      // the demo-id skips below still protect ids the loader will upsert.
      const aggregates = await listAggregatesIncludingDeleted(type);
      for (const aggregate of aggregates) {
        if (type === 'householdMember') {
          const isPrimary =
            (aggregate.payload as HouseholdMemberPayload).isPrimary === true;
          if (isPrimary) continue;
        }
        if (type === 'scenario') {
          // The base scenario is preserved; the loader updates it in place.
          const isBase = (aggregate.payload as ScenarioPayload).isPrimary === true;
          if (isBase) continue;
        }
        if (skipByType[type].has(aggregate.id)) continue;
        await queueLocalMutation({
          type,
          aggregateId: aggregate.id,
          householdId,
          operation: 'delete',
          expectedVersion: aggregate.version,
          payload: aggregate.payload,
        }, batch);
        switch (type) {
          case 'account':
            result.deletedAccounts += 1;
            break;
          case 'accountBalance':
            result.deletedBalances += 1;
            break;
          case 'socialSecurityBenefit':
            result.deletedSocialSecurity += 1;
            break;
          case 'householdMember':
            result.deletedMembers += 1;
            break;
          case 'scenario':
            result.deletedScenarios += 1;
            break;
          case 'expenseCategory':
            result.deletedExpenseCategories += 1;
            break;
          case 'expense':
            result.deletedExpenses += 1;
            break;
          case 'incomeStream':
            result.deletedIncomeStreams += 1;
            break;
        }
      }
    }
  });

  // Mounted pages reading from IDB need to re-render after the wipe.
  notifyWorkspaceChanged();

  return result;
}
