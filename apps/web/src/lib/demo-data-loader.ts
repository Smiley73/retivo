/**
 * Client-side demo data loader.
 *
 * Replaces the legacy server-side `apps/api/src/auth/demo-data-loader.service.ts`.
 * Materializes the single-household demo dataset for a realistic
 * middle-class family of two — primary + secondary members, 14 accounts
 * (eleven active + three inactive, including a taxable joint brokerage, an active
 * cash balance plan, a designated-Roth 401(k), an inherited Roth IRA, and a closed
 * Roth IRA consolidated into its sibling),
 * 10 years of balances, Social Security PIAs,
 * one CBP-payout income stream, and four scenarios (Base, Retire early at
 * 62, Delay — work to 70, Funds Run Out) — but writes everything into
 * IndexedDB and queues each aggregate as a `create` mutation. The
 * SyncProvider's subsequent flush pushes the whole batch in one round-trip.
 *
 * Refuses to run if the household already has any account or any
 * non-primary household-member aggregate (mirrors the server's
 * `DEMO_DATA_EXISTS` precondition).
 *
 * SHAPE-LIMIT EXCEPTION (recorded justification; CODING_STANDARDS ≤ 800 lines):
 * this file is over the 800-line limit. Why it cannot be split:
 * `loadDemoData` is a single transactional orchestration — empty-workspace
 * preconditions → per-aggregate payload builders → a local mutation queue →
 * snapshot/sync-event wiring — whose pieces all share the same id-computation
 * (`computeDemoAggregateIds`), version-lookup (`chooseOp`), and queue context.
 * The pure data the loader materializes (the account roster, the per-year
 * balance generator, the canonical expense set, the CBP-payout income stream,
 * and the return sequences) lives in `demo-data-defs.ts`,
 * which is what `loadDemoData`, `computeDemoAggregateIds`, and
 * `wipeWorkspaceForDemoReload` import. The remaining loader is the
 * orchestration plus its sibling demo-reload teardown flow
 * (`wipeWorkspaceForDemoReload`), which shares the same id
 * sets, queue, and exhaustiveness guards as the loader.
 * Recorded future split path: when this file is next touched,
 * factor the per-aggregate payload builders (members / accounts+balances /
 * social-security / categories+expenses / income / scenarios) into per-aggregate
 * builder modules driven by the defs, landing the loader back under 800. Trigger: a
 * change adding 5 or more lines here must either refactor the file back under the
 * limit or re-justify this exception in this note.
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
// The demo scenario copy NAMES the deterministic projection method, so it reads
// the label from its one canonical owner rather than repeating the string —
// a future rename must not leave the seeded demo describing a method by a name
// no surface renders any more.
import { TWR_METHOD_LABEL } from './projection-method-labels';
// Pure demo-dataset definitions, extracted to demo-data-defs.ts.
// Data + pure helpers only — the loader below does all the
// transactional orchestration over them.
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

/**
 * RMD profile facts (both engines read them) seeded per demo
 * account slug. Returns
 * an empty object for accounts that use the owner Uniform-Lifetime default.
 *
 * `john-ira` records John's sole spouse beneficiary (Jane) honestly: Jane is born
 * `currentYear-52`, THREE YEARS OLDER than John (`currentYear-49`), so she is NOT
 * more than ten years younger — the Uniform Lifetime Table (III) applies and the
 * `rmdSoleSpouseBeneficiary` >10-years-younger flag is intentionally ABSENT
 * (seeding it would be the legally-impossible, internally-inconsistent household
 * fact). This demo household has no realistic >10-year gap, so every
 * OWNER account resolves to the Uniform Lifetime rule.
 *
 * `jane-inherited-roth-ira` is the household's one genuinely INHERITED account:
 * Jane inherited it from her mother, who died after 2019 (post-SECURE-Act,
 * the only regime this engine models). Its beneficiary rule is seeded COMPLETE —
 * category, death date, died-on/after-RBD and the original owner's birthdate — so
 * `rmdBlockerMessages` returns empty and the account never reads as `blocked`. That
 * matters beyond tidiness: `blocked` SUPPRESSES the account's inherited-Roth
 * required-withdrawal disclosure in `report-data.ts`, and an incomplete seed would
 * silently remove a paragraph from the demo report. A child of the owner is a
 * NON-eligible designated beneficiary, so the ten-year rule applies with no
 * election to record (an eligible designated beneficiary would need one).
 */
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
      // Jane's mother was 81 at death, well past her required beginning date. On a
      // Roth account the engine forces the pre-RBD regime anyway (a Roth owner has
      // no lifetime RBD); the fact is recorded honestly rather than left blank.
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
  /** The signed-in user's display name. Retained for API compatibility,
   * but the demo dataset now hard-codes the primary member's first/last
   * name to "John Doe" so the seeded household always reads the same. */
  displayName: string;
  /**
   * Override the "current year" the loader uses for dynamic birth dates
   * and balance-window offsets. Defaults to `new Date().getUTCFullYear()`.
   * Pass `fixture.anchor.todayYear` in parity tests so the seeded
   * demographic data stays aligned with the pinned fixture year.
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

/**
 * Credit an INBOUND rollover of `amountDollars` to `balances[arrivalIdx]` and
 * carry it forward: the arrival row takes the money at YEAR END (so that row's
 * recorded gain is unchanged), and every later year both starts from and
 * compounds the raised figure — the account never "loses" the rolled-in money.
 *
 * Both demo rollovers go through here so the two legs of a movement are shaped
 * identically: the designated-Roth in-plan rollover into `john-roth-401k`, and
 * the receiving leg of the Roth-IRA consolidation into `john-roth-ira`. Mutates
 * `balances` in place. Non-MIXED accounts only — the demo records no rollover
 * into a plan with split pre/post-tax balances, where the same event is a
 * within-row bucket shift rather than money arriving.
 */
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

/** Set of every aggregate ID a fresh `loadDemoData(currentYear)` call
 *  will write, given the resolved primary/secondary member IDs and
 *  base-scenario ID. The reload flow uses this twice: the wipe helper
 *  consults it to *skip* IDs that the loader is about to upsert, and
 *  the loader consults it to filter "non-demo extraneous data" out of
 *  its precondition check. */
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

  // Reuse the existing primary member if one is on file, else create
  // the canonical "John Doe" demo primary. The displayName argument is
  // intentionally ignored here so freshly-seeded demo workspaces always
  // present the same recognizable sample data, regardless of who's
  // signed in.
  const existingPrimary = members.find((m) => m.payload.isPrimary);
  const primaryId = existingPrimary?.id ?? PRIMARY_MEMBER_ID;
  const secondaryId = SECONDARY_MEMBER_ID;

  // Reuse the existing base scenario if one is on file (auto-created
  // on first sign-in by `ensureBaseScenario`); else create a demo base
  // at the deterministic demo id. The demo loader rewrites the
  // payload either way to plant the "different ages" warning case.
  const existingBaseScenario = scenarios.find((s) => s.payload.isPrimary);
  const baseScenarioId = existingBaseScenario?.id ?? DEMO_SCENARIO_BASE_ID;

  // Precondition: existing data is only OK if it's all matching demo
  // IDs (the upsert path). Non-matching aggregates — user-created
  // accounts, legacy random-UUID demo data, etc. — must be cleared
  // first via `wipeWorkspaceForDemoReload`. Otherwise we'd silently
  // leave them alongside the freshly-seeded demo set.
  const demoIds = computeDemoAggregateIds(currentYear, primaryId, secondaryId, baseScenarioId);
  const nonDemoAccounts = accounts.filter((a) => !demoIds.accounts.has(a.id));
  const nonDemoMembers = members.filter(
    (m) => !m.payload.isPrimary && !demoIds.members.has(m.id),
  );
  if (nonDemoAccounts.length > 0 || nonDemoMembers.length > 0) {
    throw new DemoDataExistsError();
  }

  // Per-(type,id) version lookup so the upsert path can queue
  // `update @ expectedVersion=current` instead of `create @ 0`. A
  // create against a version-bumped cloud row would conflict and the
  // user would see "Refresh needed" right after a successful demo
  // load — which is exactly the bug this function exists to avoid.
  //
  // **Includes tombstones.** When the user previously hit the legacy
  // wipe-then-create-at-0 collision bug, the server-side
  // `AggregateVersion` rows for matching demo IDs ended up tombstoned
  // at v=N+1 (and never get reaped — tombstones are forever in this
  // schema). Bootstrap wrote those tombstones into local IDB. Reading
  // only live aggregates would miss them, so we'd queue `create @ 0`
  // again and hit the same conflict. Reading *with* tombstones lets
  // us queue `update @ tombstone_version`, which the API accepts and
  // clears `deletedAt` on (push.service.ts: deletedAt = null on
  // non-delete operations).
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

  // Batch the whole demo seed's per-row fine signals into one per touched
  // store on scope exit so a mounted page re-reads once per affected type
  // instead of once per row written (the coarse `notifyWorkspaceChanged()`
  // tail below is unchanged). `batch` threads through every
  // `queueLocalMutation` in the loaders below.
  let accountsCreated = 0;
  let balancesCreated = 0;
  let socialSecurityCreated = 0;
  await withBatchedStoreSignals(async (batch) => {
  // Primary: always seed/overwrite the demo "John Doe" identity so a
  // demo reload puts the workspace into a known recognizable state
  // — including name + birthdate, which the previous reuse-only path
  // left untouched. Email is preserved when a primary already exists
  // (the user's own contact email, which the auth flow set on first
  // signup); fresh creates fall back to `input.email`. The id is
  // reused so existing `Account.ownerId` and similar references stay
  // valid. `chooseOp` handles create-at-0 vs update-at-version (and
  // the tombstone case).
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
      // Dynamic birth year so the couple stays ~10 years from early
      // retirement no matter which calendar year the demo loads in.
      // John is always ~49.
      birthdate: `${currentYear - 49}-06-15`,
    },
  }, batch);

  // Secondary: always part of the demo dataset; upsert if already
  // present (re-load case).
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
      // Jane is always ~52 — slightly older than John, mirroring the
      // real export's spousal age structure.
      birthdate: `${currentYear - 52}-03-15`,
    },
  }, batch);

  const ownerByKey: Record<AccountDef['ownerKey'], string> = {
    primary: primaryId,
    secondary: secondaryId,
  };

  // For the current-year row, cap `lastUpdated` at today rather than
  // Dec 31. Otherwise a mid-year demo load plants an "as-of" date in
  // the future, which the balance form rejects and the user reads as
  // a bug.
  const todayIso = new Date().toISOString();
  const currentYearLastUpdated = (year: number): string =>
    year === currentYear ? todayIso : `${year}-12-31T23:59:59Z`;

  // Every account's balance history is generated BEFORE any account is queued:
  // a consolidation moves money BETWEEN two accounts, so the receiving account's
  // rows cannot be finalized until the closing account's are, whatever order the
  // two appear in `accountDefs()`.
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

    // The demo's one recorded designated-Roth IN-PLAN ROLLOVER
    // (§402A(c)(4)), and the ONLY thing that gives the plan any designated-Roth
    // basis now that the recorded principal IS that basis. Modelled as a
    // separate pure-Roth account the money genuinely ARRIVES, so the dated fact
    // is seeded together with a matching inbound `rollover` leg on the same row
    // — which is what makes it reconcilable against the account's own balance
    // history.
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

  // The CONSOLIDATION's RECEIVING leg. A closure rollover-OUT on its own
  // takes the money out of the household, which is only harmless when nothing
  // downstream still counts it: `john-old-401k` gets away with it because it is
  // PRE_TAX and no basis is derived from it. A closed ROTH IRA does not — its
  // recorded contributions stay §408A basis in the owner's pool, justified
  // in three places by the money having followed a rollover into a sibling the
  // pool still holds. So the sibling has to receive it: same year, same amount,
  // opposite sign.
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

    // Roth tax facts — only the two first-year anchors are stored on the
    // payload (schema v7 dropped both stored basis totals). Neither engine
    // has read a stored basis total since the §408A basis cutover: a Roth IRA
    // pool's basis is derived from the recorded contribution/withdrawal history
    // above, and an employer plan's designated-Roth basis is its recorded
    // in-plan-rollover principal alone. First-year anchors start at the
    // demo history's `startYear`.
    //
    // The invariant that still binds is pool-wide, because
    // §408A basis is pool-level: every basis dollar must be backed by a
    // balance dollar in the OWNER'S POOL, not merely in the account that recorded
    // it. Per-account reconciliation is no longer sufficient on its own — a
    // closed Roth IRA keeps contributing basis to the pool after its own balance
    // is zero. Two consequences above: the in-plan rollover seeds a matching
    // inbound `rollover` leg on the same row, and the consolidation's closure
    // rollover-OUT is matched by an inbound leg on the sibling that received it,
    // so the pool still holds the money its DERIVED basis is claimed against.
    // Same reason no §408A CONVERSION is seeded anywhere: a conversion with no
    // matching inflow would be unsupported basis, understating demo earnings.
    // Seed one alongside its inflow if the demo history ever gains a real
    // conversion year.
    const rothFacts: Partial<AccountPayload> = {};
    if (def.type === 'RETIREMENT_ROTH_IRA') {
      rothFacts.rothIraFirstContributionTaxYear = startYear;
    } else if (isPureRothEmployerType(def.type)) {
      rothFacts.designatedRothFirstParticipationTaxYear = startYear;
    }

    // RMD profile facts — illustrative, per-slug facts
    // that stay internally consistent with the demo household's demographics
    // without altering any balance/projection semantics for a fact-free account.
    // `john-ira` records John's sole spouse beneficiary (Jane, older than John →
    // Uniform Lifetime, not Joint Life); `jane-inherited-roth-ira` records a
    // complete, resolvable inherited-beneficiary rule. Every other demo account
    // leaves the facts absent (owner Uniform Lifetime default). See
    // `rmdFactsForSlug`.
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
        // Sparse-optional: the key is OMITTED on every year that recorded no
        // in-plan rollover, because absent is a weaker claim than a stored 0.
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

  // Social Security PIAs — illustrative monthly primary-insurance
  // amounts (today's dollars; the engine inflates them forward). Sized
  // for a realistic middle-class dual-earner household where both
  // members worked full careers: $2,900/mo for John, $1,800/mo for Jane
  // (combined ~$4,700/mo ≈ $56k/yr — the backbone of this plan's
  // retirement income). The base scenario stays clear of the
  // inflation-extrapolated MFJ IRMAA tier-1 threshold in its first
  // Medicare years (no surcharge).
  for (const [memberId, pia] of [
    [primaryId, 2900],
    [secondaryId, 1800],
  ] as const) {
    // A statement can't be dated in the future (the UI now rejects a
    // future date on save, and its year is the COLA anchor). Derive
    // the date from `currentYear` alone — Jan 1 of the loader's current year
    // is never a future date (today is always on or after Jan 1 of the
    // running year), so no wall-clock clamp is needed and the seeded value
    // stays fully deterministic under a caller-pinned `todayYear` (parity
    // tests). The COLA anchor (the date's year) is unchanged.
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

  // Expense categories — seed the same eight defaults the auto-bootstrap
  // would create on first sign-in, but with deterministic ids so demo
  // expenses can reference them. chooseOp handles the upsert path on
  // demo-reload.
  for (const [name, catId] of Object.entries(DEMO_CATEGORY_BY_NAME)) {
    // The demo Medical category carries the generic medical flag so the
    // `categoryRates` `cat-medical` pin below + the +2pp default follow the
    // persisted flag, not a hard-coded id.
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

  // Canonical expenses — representative set covering every timepoint
  // kind so the projection chart band has something meaningful to draw
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

  // IRMAA threshold extrapolation. The CMS Rev. Proc. 2025-55
  // Table 4 MFJ tier-1 threshold is anchored to its source year (2026);
  // inflating it forward to the household's first Medicare year keeps the
  // IRMAA / no-IRMAA contrast sharp whichever calendar year the demo
  // loads in. John always retires at currentYear + 16 (born currentYear −
  // 49, retires at 65), and his first Medicare year is the same.
  const IRMAA_2026_MFJ_TIER1 = 218_000; // CMS Rev. Proc. 2025-55 Table 4, source year 2026
  const firstMedicareYear = currentYear + 16;
  const inflatedThreshold = Math.round(
    IRMAA_2026_MFJ_TIER1 * Math.pow(1.03, firstMedicareYear - 2026),
  );
  // Seed the IRMAA look-back with a realistic final-working-years MAGI
  // for this middle-class household (~45% of the inflated tier-1
  // threshold ≈ the couple's ~$150k working income inflated forward).
  // Comfortably below the threshold → no surcharge for the base scenario.
  const baseMagiBootstrap = Math.round(inflatedThreshold * 0.45);

  // Base scenario — primary retires at 65, both spouses claim Social
  // Security at their full retirement age of 67. Same-date mode anchored
  // on primary so a freshly-seeded demo workspace lands on the calm,
  // supported case (no "different ages" warning shown by default; the
  // user can flip the toggle off to explore the alternate flow). The
  // "Delay — work to 70" scenario is the deliberate contrast that claims
  // at 70 to show the delayed-credit upside.
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
        // Same-date mode anchored on primary — Jane retires on the same
        // calendar day as John. Jane's stored age (68y 3m) is
        // pre-computed from John's retirement date (currentYear + 16,
        // June 15) minus Jane's birthdate (currentYear − 52, March 15);
        // Jane is the older spouse. UI's modal recomputes this on every
        // anchor edit; calculations read both ages directly. Flip to
        // "Each retires independently" to explore the warning flow.
        secondary: { ageYears: 68, ageMonths: 3 },
        sameDateAnchor: 'primary',
      },
      socialSecurity: {
        primary: { ageYears: 67, ageMonths: 0 },
        secondary: { ageYears: 67, ageMonths: 0 },
        // Survivor claim ages — the SEPARATE age at which each member,
        // if widowed, would start the survivor benefit. Seeded at each
        // member's FRA (no widow(er) early-claim reduction) so the demo
        // exercises the survivor rules instead of the withheld state.
        survivor: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        // COLA tracks the scenario inflation rate (default-on), so the
        // benefit holds its value in today's dollars across the projection.
        colaTracksInflation: true,
      },
      withdrawalStrategy: { kind: 'taxEfficient' },
      // Married-couple filing plan: John and Jane are
      // spouses, so the base scenario files jointly while both are alive
      // (death-year joint), then Single afterward. No relationship metadata is
      // stored on the household members — the joint plan is the couple-level
      // fact. The engines read it to pick each year's filing status; seeded so the demo
      // workspace round-trips a real filing plan through push/pull.
      taxFilingPlan: { kind: 'joint' },
      // Per-category inflation: 3% general. The seeded Medical category
      // would default to general + 2pp (5%), but the curated demo dataset
      // is tuned so the base scenario funds to life expectancy; we keep
      // that narrative by pinning Medical back to the general rate via an
      // explicit override (which still round-trips a real `categoryRates`
      // map through push/pull), and exercise a genuinely different
      // per-category rate on Housing (a slightly slower-inflating cost) so
      // the field is demonstrated, not just neutralised.
      inflation: {
        ratePct: 3,
        categoryRates: { 'cat-medical': 3, 'cat-housing': 2.5 },
      },
      // Default cost-basis fraction for LTCG/QDI proxy: 50% of
      // taxable withdrawal assumed to be cost basis (gain fraction = 0.5).
      assumedCostBasisFractionOfTaxableWithdrawal: 0.5,
      // Seed the IRMAA look-back for projection years 0–1 (the first two
      // projection years, before the rolling 2-yr MAGI buffer is
      // populated). 45% of the inflation-extrapolated MFJ IRMAA tier-1
      // threshold for the household's first Medicare year — comfortably
      // below it, so the base scenario shows NO IRMAA surcharge in its
      // first Medicare years.
      // Two lookback fields (year 0 = MAGI(ret−2), year 1 = MAGI(ret−1)).
      // The demo seeds both with the same pre-retirement income stand-in.
      magiBootstrapLookbackMinus2: baseMagiBootstrap,
      magiBootstrapLookbackMinus1: baseMagiBootstrap,
      // Tax assumptions (IRS/CMS/SSA compliance pass). 90% of EMERGENCY HSA
      // withdrawals assumed qualified (tax-free) — modeled medical-qualified
      // draws are always 100% qualified; the remaining 10% of emergency draws
      // is ordinary income + the 20% additional tax before 65. No accounts
      // are marked exempt from the early-withdrawal penalty in the demo.
      hsaQualifiedMedicalExpensePct: 90,
      earlyWithdrawalPenaltyExemptAccountIds: [],
      // Working-years taxable income (post-deduction) for the Roth conversion
      // comparison page's bracket-headroom math — a realistic MFJ figure for this
      // dual-income couple at peak earning years. Display-only on that page;
      // drives no projection math.
      preRetirementTaxableIncomeDollars: 120_000,
    },
  };
  await queueLocalMutation<ScenarioPayload>({
    type: 'scenario',
    aggregateId: baseScenarioId,
    householdId: input.householdId,
    ...chooseOp('scenario', baseScenarioId),
    // Note: the `name` above seeds the deterministic demo id; the
    // upsert path (chooseOp = 'update') rewrites name/payload on top
    // of any existing base, so a previous "Primary"-named demo seed
    // gets renamed to "Base" on the next demo reload.
    payload: scenarioPayload,
  }, batch);

  // Three alternates a DIY planner would actually explore, branching off
  // the base:
  //
  //   Base (retire 65, SS 67/67)                              ← funds last to life expectancy
  //   ├── Retire early at 62 (SS primary 62 / secondary 67)   ← tighter but workable
  //   │     └── Funds Run Out (early + overspend → depletion) ← the failure case
  //   └── Delay — work to 70 (SS 70/70)                       ← the "fix": more income
  //
  // Jane's stored age on each parent is pre-computed from John's
  // retirement date so calculations downstream read both ages directly
  // (no birthdate lookup at calc time). For the early-at-62 parent: John
  // retires at 62 → currentYear + 13, June 15 → Jane (older spouse,
  // born currentYear − 52, March 15) is 65y 3m on that date.
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
        // John claims early at 62; Jane claims at her full retirement age.
        primary: { ageYears: 62, ageMonths: 0 },
        secondary: { ageYears: 67, ageMonths: 0 },
      },
      accountContributions: {
        perAccount: {
          // Step the primary 401(k) deferral up from the $8k base to
          // $12k ahead of the early retirement date. Split 75/25
          // pre/post-tax to match the account's MIXED treatment. Override
          // the annual-increase rate above the account's 4% baseline —
          // aggressive raises in the final accumulation years.
          'demo-account-john-401k': {
            plannedContributionPreTax: 9000,
            plannedContributionPostTax: 3000,
            contributionGrowthPct: 6,
          },
        },
      },
      accountReturns: {
        perAccount: {
          // Conservative planning rate on the primary 401(k) — assume
          // markets soften over the next decade (vs the 7.0% base).
          // Affects the Planned method only; TWR remains empirical.
          'demo-account-john-401k': { planningReturnPct: 5.5 },
        },
      },
      // Tax-efficient drawdown so the MAGI ceiling has a strategy to overlay.
      withdrawalStrategy: { kind: 'taxEfficient' },
      // MAGI-ceiling LADDER. Two non-overlapping windows
      // exercise the full schedule:
      //  - Fill window (retirement → John's 65): retiring early at 62 lands the
      //    household on ACA marketplace coverage until Medicare at 65, so the
      //    cheap pre-Medicare years are the textbook window to fill the income
      //    headroom with Roth conversions. The ceiling targets the IRMAA/federal
      //    MAGI line at $90k/yr; leftover room below it auto-converts pre-tax
      //    dollars into John's Roth IRA.
      //  - Minimize window (John's 65 → 70): once on Medicare, keep income low
      //    under a tighter $60k ACA/IRMAA-style ceiling, converting nothing.
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
      // A real ACA→Medicare transition
      // (the month-aware health engine reads it). Retiring at 62 puts
      // John on Marketplace coverage for ages 62–64, then he enrolls in Medicare
      // Part B and Part D at 65 (`firstMedicareYear`, a mid-year split). Seeded
      // per member id (same ids as `acaMarketplaceOptOutMemberIds`); FPL region
      // is the 48 contiguous states + DC. Seeded so the demo round-trips real
      // month-aware coverage data through push/pull AND so the demo projection
      // shows a genuine part-year IRMAA / part-year Marketplace benchmark.
      acaFplRegion: 'contiguous',
      healthCoverageMonths: {
        perMember: {
          [primaryId]: {
            // Retirement year: John retires (turns 62) June 15, so he is on
            // employer coverage Jan–May and only picks up Marketplace coverage
            // Jun–Dec — 7 months, NOT the full year (Jan–May predates his
            // Marketplace enrolment). Same Jun boundary as the Medicare split.
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

  // Delay — work to 70: the "fix" branch off the base. Primary works five
  // more years (retire 70) and both members delay Social Security to 70
  // for maximum delayed retirement credits. Jane's stored age is
  // pre-computed from John's retirement date: John retires at 70 →
  // currentYear + 21, June 15 → Jane (born currentYear − 52, March 15)
  // is 73y 3m on that date.
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
      // Keep the horizon running past the depletion cliff so the
      // portfolio-depleted reference line is visible on the chart.
      lifeExpectancy: { primary: 95 },
      // The three levers above don't deplete the portfolio on their own
      // (base spending is modest against the ~$515k roster). Patch the
      // long-term-care line up to a high lifestyle-and-care budget so net
      // annual withdrawals exceed portfolio growth under both Planned and
      // TWR, producing the depletion cliff before plan end. Tuned at impl
      // time against the seeded roster.
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

  // Mounted pages (e.g. /dashboard if the demo modal opened over it)
  // need to re-read aggregates that just landed in IDB. The mutation
  // queue's optimistic writes have already committed by the time this
  // returns — the event is purely a render trigger.
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
 * Queues a `delete` mutation for every workspace aggregate that the
 * subsequent `loadDemoData` call will *not* upsert — i.e. legacy
 * random-UUID demo accounts, user-created accounts, anything whose ID
 * doesn't match the new demo ID set. IDs that *do* match are left
 * intact so the loader can update them in place; queueing a delete
 * for those IDs would tombstone the cloud row at v=N+1, after which
 * the loader's `create @ expectedVersion=0` would always conflict
 * (push is rejected → "Refresh needed" badge).
 *
 * Use *before* {@link loadDemoData} when overwriting an existing
 * workspace. A plain `clearAllStores()` only wipes IndexedDB and
 * leaves orphan aggregates in the cloud that the next bootstrap pull
 * would re-deliver alongside the freshly-seeded demo set.
 *
 * Skips the primary member because the demo loader reuses it by
 * design.
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

  // Drop any prior pending or failed-conflict mutations before queueing
  // the wipe's own. The user's overwrite confirmation makes anything
  // already in the queue moot, and a leftover `failed-conflict` row
  // (e.g. from a previous broken demo-reload attempt before this fix
  // landed) would keep the badge stuck on "Refresh needed" even after
  // the new flush finishes cleanly.
  //
  // Version-truth restoration: recover
  // each aggregate's server-acknowledged version from the queue BEFORE clearing
  // it, then de-inflate the local aggregate versions AFTER the clear, so the
  // wipe's delete mutations target a version the server can reach instead of an
  // optimistically-inflated one. Runs inside the caller's destructive fence.
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

  // Order is irrelevant on the cloud (each mutation is its own
  // transaction) but balances-then-accounts matches the natural
  // dependency order, which keeps the UI sensible if a flush pauses
  // mid-batch. Expenses before categories so a paused flush never
  // leaves an expense pointing at a tombstoned category.
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

  // Compile-time exhaustiveness: every AggregateType (except
  // `household`, which carries no payload-bearing aggregates today)
  // must appear in `types`. Adding a new AggregateType without
  // including it here surfaces a TS error — the conditional resolves
  // to a non-`never` type and the assignment fails. Prevents a repeat
  // of the bug where `incomeStream` was missing from the wipe loop
  // and accumulated across demo reloads.
  type _WipeOrderCoverage = Exclude<
    AggregateType,
    (typeof types)[number] | 'household'
  >;
  const _wipeOrderExhaustive: _WipeOrderCoverage extends never
    ? true
    : never = true;
  void _wipeOrderExhaustive;

  // Batch the wipe's per-row fine signals into one per touched store on scope
  // exit (the coarse `notifyWorkspaceChanged()` tail below is unchanged).
  await withBatchedStoreSignals(async (batch) => {
    for (const type of types) {
      // Enumerate WITH local tombstones (`listAggregatesIncludingDeleted`, not
      // `listAggregates`). A locally soft-deleted aggregate whose delete never
      // landed on the server — an un-synced / server-ahead local delete, the
      // exact un-synced-edit class this flow exists to repair — is filtered out
      // by `listAggregates` (`.filter((a) => !a.deletedAt)`). Skipping it would
      // (re-)queue no delete for it, so the server's still-live copy survives
      // the wipe and reappears on the next pull alongside the freshly-seeded
      // demo set. Including tombstones re-queues its delete (at the version the
      // version-truth de-inflation above realigned to, so it can actually
      // land). The demo-ID skip rules below still preserve any id the loader is
      // about to upsert.
      const aggregates = await listAggregatesIncludingDeleted(type);
      for (const aggregate of aggregates) {
        if (type === 'householdMember') {
          const isPrimary =
            (aggregate.payload as HouseholdMemberPayload).isPrimary === true;
          if (isPrimary) continue;
        }
        if (type === 'scenario') {
          // The base scenario is preserved (the loader updates it in
          // place). The storage flag is still `isPrimary`.
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
