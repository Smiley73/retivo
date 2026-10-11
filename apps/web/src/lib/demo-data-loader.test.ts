/**
 * Tests for the client-side demo data loader. Uses fake-indexeddb so
 * the real IDB code paths run end-to-end.
 *
 * The loader is the single source of truth for the demo dataset; we
 * assert (a) refusal when the workspace already has data, and (b) the
 * expected mutation counts so a regression in the per-account or
 * per-year fanout is caught.
 */
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  listAggregates,
  listFailedConflicts,
  listPendingMutations,
  putAggregate,
  queueMutation,
} from '../db/store';
import {
  DemoDataExistsError,
  loadDemoData,
  wipeWorkspaceForDemoReload,
} from '../lib/demo-data-loader';
import {
  readTaxProfileDraft,
  rmdBlockerMessages,
  taxProfileCompleteness,
} from './account-tax-profile';
import { ensureDefaultExpenseCategories } from './expense-categories-bootstrap';
import { glideMultiplierFor } from './expense-glide';
import { resolveExpensesForScenario } from './expense-resolution';
import { runBalanceProjection } from './balance-projection-runner';
import { buildRothDistributionFacts } from './balance-projection-runner-tax-helpers';
import { buildSsContext } from './ss-context-builder';
import type { ScenarioAggregate } from './scenario-resolution';
import { monthIndex, type ScheduleResolveContext } from './schedule-resolution';
import type {
  Aggregate,
  AccountBalancePayload,
  AccountPayload,
  ExpenseCategoryPayload,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';

describe('loadDemoData', () => {
  beforeEach(async () => {
    await clearAllStores();
  });
  afterEach(async () => {
    await clearAllStores();
  });

  it('refuses when the workspace already has accounts', async () => {
    // Seed an existing account so the precondition fires.
    await putAggregate('account', {
      id: 'acc-existing',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Existing',
        type: 'BROKERAGE',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'POST_TAX',
        ownerId: 'hm-1',
        institution: 'Bank',
        notes: '',
        planningReturnPct: 5,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      } satisfies AccountPayload,
    });

    await expect(
      loadDemoData({ householdId: 'hh-1', email: 'demo@x', displayName: 'Demo User' }),
    ).rejects.toBeInstanceOf(DemoDataExistsError);
  });

  it('refuses when the workspace already has a non-primary household member', async () => {
    await putAggregate('householdMember', {
      id: 'hm-secondary',
      householdId: 'hh-1',
      aggregateType: 'householdMember',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        isPrimary: false,
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@x',
        birthdate: '1988-03-15',
      } satisfies HouseholdMemberPayload,
    });

    await expect(
      loadDemoData({ householdId: 'hh-1', email: 'demo@x', displayName: 'Demo User' }),
    ).rejects.toBeInstanceOf(DemoDataExistsError);
  });

  it('overwrites an existing primary member with demo name + birthdate (preserves id and email)', async () => {
    await putAggregate('householdMember', {
      id: 'hm-primary',
      householdId: 'hh-1',
      aggregateType: 'householdMember',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        isPrimary: true,
        firstName: 'Real',
        lastName: 'User',
        email: 'real@x',
        birthdate: '1979-11-02',
      } satisfies HouseholdMemberPayload,
    });

    const result = await loadDemoData({
      householdId: 'hh-1',
      email: 'demo@x',
      displayName: 'Demo User',
    });

    // The aggregate id is reused so existing `Account.ownerId`
    // references stay valid, but the demo loader rewrites name +
    // birthdate so the workspace lands on the recognizable "John Doe"
    // demo identity. Email is preserved (the user's own contact
    // address, not the demo input.email).
    expect(result.primaryMemberId).toBe('hm-primary');
    const members = (await listAggregates('householdMember')) as Aggregate<HouseholdMemberPayload>[];
    expect(members).toHaveLength(2);
    const primary = members.find((m) => m.payload.isPrimary);
    expect(primary?.payload.firstName).toBe('John');
    expect(primary?.payload.lastName).toBe('Doe');
    // Birth year is dynamic — John is always currentYear − 49.
    const currentYear = new Date().getUTCFullYear();
    expect(primary?.payload.birthdate).toBe(`${currentYear - 49}-06-15`);
    expect(primary?.payload.email).toBe('real@x');
  });

  it('uses deterministic account IDs so re-loading produces no duplicates', async () => {
    const input = { householdId: 'hh-1', email: 'demo@x', displayName: 'Demo User' };
    await loadDemoData(input);

    const accountsFirst = (await listAggregates('account')) as Aggregate<AccountPayload>[];
    const idsFirst = accountsFirst.map((a) => a.id).sort();

    // All account IDs should be deterministic (slug-based) and unique —
    // duplicate slugs would silently collide on IDB put, so this also
    // guards against a copy-paste foot-gun in `accountDefs`.
    expect(new Set(idsFirst).size).toBe(idsFirst.length);
    for (const id of idsFirst) {
      expect(id).toMatch(/^demo-account-/);
    }

    // Balance IDs derive from account IDs.
    const balancesFirst = await listAggregates('accountBalance');
    for (const b of balancesFirst) {
      expect(b.id).toMatch(/^bal-demo-account-/);
    }

    // Re-run on a wiped workspace — same inputs must produce the same
    // account IDs so the race-condition path (loader fires twice) merges
    // via IDB `put` instead of duplicating.
    await clearAllStores();
    await loadDemoData(input);
    const accountsSecond = (await listAggregates('account')) as Aggregate<AccountPayload>[];
    const idsSecond = accountsSecond.map((a) => a.id).sort();
    expect(idsSecond).toEqual(idsFirst);
  });

  it('does not duplicate auto-bootstrapped expense categories on first demo load', async () => {
    // Reproduces the regression: the first-sign-in bootstrap creates 8
    // ExpenseCategory aggregates, then the user clicks "Load demo data"
    // in the FirstRunDemoModal. Without shared deterministic ids the
    // demo loader would create 8 *more* categories under different ids,
    // leaving 16 in the workspace.
    await ensureDefaultExpenseCategories('hh-1');
    const beforeDemo = (await listAggregates(
      'expenseCategory',
    )) as Aggregate<ExpenseCategoryPayload>[];
    expect(beforeDemo).toHaveLength(8);

    await loadDemoData({
      householdId: 'hh-1',
      email: 'demo@x',
      displayName: 'Demo User',
    });

    const afterDemo = (await listAggregates(
      'expenseCategory',
    )) as Aggregate<ExpenseCategoryPayload>[];
    expect(afterDemo).toHaveLength(8);
    const names = afterDemo.map((c) => c.payload.name).sort();
    expect(names).toEqual([
      'Entertainment',
      'Food',
      'Housing',
      'Insurance',
      'Medical',
      'Other',
      'Transportation',
      'Utilities',
    ]);
  });

  it('queues update against a tombstoned cloud aggregate so reload restores instead of conflicting', async () => {
    // Reproduces the AWS-deployment regression: previous broken loads
    // tombstoned matching demo IDs in the cloud at v=N+1. Bootstrap
    // wrote those tombstones into IDB. A naive `listAggregates()` call
    // filters tombstones, so the loader would queue `create @ 0` —
    // and the cloud-side condition `attribute_not_exists OR
    // version=:expected` would reject it (the row exists at v=N+1).
    // The loader must instead queue `update @ tombstone_version` so
    // the API clears `deletedAt` and the demo row comes back live.
    const input = { householdId: 'hh-1', email: 'demo@x', displayName: 'Demo User' };
    await putAggregate('account', {
      id: 'demo-account-john-401k',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 4,
      updatedAt: '2026-01-01T00:00:00Z',
      // Tombstoned — `listAggregates` filters this out, but the loader
      // still needs to see it to choose `update` over `create`.
      deletedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Tombstoned 401k',
        type: 'RETIREMENT_401K',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'MIXED',
        ownerId: 'demo-member-primary',
        institution: 'Northbrook Investments',
        notes: '',
        planningReturnPct: 7,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      } satisfies AccountPayload,
    });

    await loadDemoData(input);

    const pending = await listPendingMutations();
    const vanguardMuts = pending.filter(
      (m) => m.aggregateId === 'demo-account-john-401k',
    );
    expect(vanguardMuts).toHaveLength(1);
    // Tombstone at v=4 → update at expectedVersion=4. Cloud's
    // condition matches and it writes the new payload at v=5,
    // deletedAt cleared.
    expect(vanguardMuts[0].operation).toBe('update');
    expect(vanguardMuts[0].expectedVersion).toBe(4);
  });

  it('upserts existing matching demo aggregates instead of queueing create-at-v=0', async () => {
    // Simulate a workspace whose accounts already use the deterministic
    // slug IDs from a previous demo load. The cloud-side
    // AggregateVersion row would be at v>=1 for those IDs, so a fresh
    // `create @ expectedVersion=0` would fail with CONFLICT and surface
    // the "Refresh needed" badge after a successful local seed.
    const input = { householdId: 'hh-1', email: 'demo@x', displayName: 'Demo User' };
    await putAggregate('account', {
      id: 'demo-account-john-401k',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 7,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Stale demo 401k',
        type: 'RETIREMENT_401K',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'MIXED',
        ownerId: 'demo-member-primary',
        institution: 'Northbrook Investments',
        notes: '',
        planningReturnPct: 7,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      } satisfies AccountPayload,
    });

    await loadDemoData(input);

    const pending = await listPendingMutations();
    const vanguardMuts = pending.filter(
      (m) => m.aggregateId === 'demo-account-john-401k',
    );
    // Exactly one mutation per matching ID — `update` at the existing
    // version, never `create @ 0` (which would conflict on push).
    expect(vanguardMuts).toHaveLength(1);
    expect(vanguardMuts[0].operation).toBe('update');
    expect(vanguardMuts[0].expectedVersion).toBe(7);

    // Non-matching demo accounts (the other 10) still create at v=0.
    const otherCreates = pending.filter(
      (m) =>
        m.aggregateType === 'account' &&
        m.aggregateId !== 'demo-account-john-401k',
    );
    expect(otherCreates.every((m) => m.operation === 'create')).toBe(true);
    expect(otherCreates.every((m) => m.expectedVersion === 0)).toBe(true);
  });
});

describe('loadDemoData — seeded dataset (read-only checks)', () => {
  // These cases only read the dataset the loader produces, so it is seeded
  // once for the whole group rather than before every case.
  let seedResult: Awaited<ReturnType<typeof loadDemoData>>;
  let seededOn: string;
  beforeAll(async () => {
    await clearAllStores();
    seededOn = new Date().toISOString().slice(0, 10);
    seedResult = await loadDemoData({
      householdId: 'hh-1',
      email: 'demo@x',
      displayName: 'Demo User',
    });
  });
  afterAll(async () => {
    await clearAllStores();
  });

  it('populates the demo dataset on a fresh workspace', async () => {
    const result = seedResult;

    expect(result.accountsCreated).toBe(14);
    // 14 accounts × 10 years (current − 9 .. current inclusive) = 140 balances.
    expect(result.balancesCreated).toBe(140);
    expect(result.socialSecurityCreated).toBe(2);

    const members = (await listAggregates('householdMember')) as Aggregate<HouseholdMemberPayload>[];
    expect(members).toHaveLength(2);
    const primary = members.find((m) => m.payload.isPrimary);
    expect(primary).toBeTruthy();
    // Primary member is hardcoded to "John Doe" — the displayName arg
    // is intentionally ignored for fresh demo seeds.
    expect(primary?.payload.firstName).toBe('John');
    expect(primary?.payload.lastName).toBe('Doe');
    expect(members.find((m) => !m.payload.isPrimary)).toBeTruthy();

    const accounts = (await listAggregates('account')) as Aggregate<AccountPayload>[];
    expect(accounts).toHaveLength(14);
    // Three inactive accounts: John's zeroed-out old 401(k), John's
    // consolidated Roth IRA, and Jane's funded former-employer 401(k). The
    // rest are active.
    const inactive = accounts.filter((a) => !a.payload.active);
    expect(inactive).toHaveLength(3);
    expect(inactive.map((a) => a.id).sort()).toEqual([
      'demo-account-jane-401k-former',
      'demo-account-john-old-401k',
      'demo-account-john-roth-ira-old',
    ]);

    // Every aggregate we wrote should also be queued as a pending mutation
    // (loader uses queueLocalMutation which appends to the mutation queue).
    const pending = await listPendingMutations();
    // 2 members + 14 accounts + 140 balances + 2 SS + 4 scenarios (Base +
    // Retire early at 62 + Delay — work to 70 + Funds Run Out) + 8 expense
    // categories + 24 expenses + 1 income stream (CBP-payout-to-IRA lump
    // sum) = 195 mutations.
    expect(pending).toHaveLength(195);

    // A taxable brokerage account is present so the demo exercises the
    // long-term-capital-gains withdrawal path.
    const brokerage = accounts.find((a) => a.payload.type === 'BROKERAGE');
    expect(brokerage).toBeTruthy();
    expect(brokerage?.payload.taxTreatment).toBe('POST_TAX');
  });

  // The demo household's one genuinely INHERITED account. Its beneficiary
  // rule must be COMPLETE: an account with blockers reads `blocked`, and `blocked`
  // suppresses its inherited-Roth required-withdrawal disclosure in the exported
  // report — a silent removal a parity re-capture cannot flag.
  it('seeds the inherited Roth IRA with a resolvable beneficiary rule (no blockers)', async () => {
    const accounts = (await listAggregates('account')) as Aggregate<AccountPayload>[];
    const inherited = accounts.find(
      (a) => a.id === 'demo-account-jane-inherited-roth-ira',
    );
    expect(inherited).toBeTruthy();
    expect(inherited?.payload.type).toBe('RETIREMENT_ROTH_IRA');
    expect(inherited?.payload.rmdInheritedAccount).toBe(true);

    const members = (await listAggregates('householdMember')) as Aggregate<HouseholdMemberPayload>[];
    const owner = members.find((m) => m.id === inherited!.payload.ownerId);
    expect(owner).toBeTruthy();
    expect(
      rmdBlockerMessages(
        readTaxProfileDraft(inherited!.payload),
        inherited!.payload.type,
        owner!.payload.birthdate,
      ),
    ).toEqual([]);
    // `blocked` is the state that would silently drop the report disclosure; the
    // account reads `partial` only because it honestly records $0 of the original
    // owner's contribution basis (nothing in its seeded history supports more).
    expect(
      taxProfileCompleteness(inherited!.payload, owner!.payload.birthdate),
    ).not.toBe('blocked');
  });

  it('no Roth-IRA regular-contribution basis total is seeded (schema v7)', async () => {
    const accounts = (await listAggregates('account')) as Aggregate<AccountPayload>[];
    const roth = accounts.find((a) => a.id === 'demo-account-john-roth-ira');
    expect(roth).toBeTruthy();

    // The stored regular-contribution basis total is gone from the payload —
    // both engines derive it from the recorded contribution history instead.
    expect('rothIraRegularContributionBasis' in (roth?.payload ?? {})).toBe(false);
    // No unsupported conversion-lot basis is seeded.
    expect(roth?.payload.rothIraConversionLots).toBeUndefined();
  });

  it('no designated-Roth basis total is seeded for the employer-plan account (schema v7)', async () => {
    const accounts = (await listAggregates('account')) as Aggregate<AccountPayload>[];
    // The demo's designated-Roth EMPLOYER-plan fixture (a Roth 401(k)) — a
    // SEPARATE seeding branch from the Roth-IRA one checked above.
    const roth401k = accounts.find((a) => a.id === 'demo-account-john-roth-401k');
    expect(roth401k).toBeTruthy();
    expect(roth401k?.payload.type).toBe('RETIREMENT_ROTH_401K');

    const balances = (await listAggregates('accountBalance')) as Aggregate<{
      accountId: string;
      year: number;
      startingBalance?: number;
      totalContributions?: number;
    }>[];
    const own = balances.filter((b) => b.payload.accountId === 'demo-account-john-roth-401k');
    expect(own.length).toBeGreaterThan(0);
    const firstYear = Math.min(...own.map((b) => b.payload.year));

    // The stored designated-Roth basis total is gone from the payload — the
    // engine resolves it as the recorded in-plan-rollover principal alone.
    expect('designatedRothBasis' in (roth401k?.payload ?? {})).toBe(false);
    // The participation-year anchor is the demo history's first year.
    expect(roth401k?.payload.designatedRothFirstParticipationTaxYear).toBe(firstYear);
    // No designated in-plan-rollover lots are seeded (no matching rollover inflow).
    expect(roth401k?.payload.designatedRothInPlanRolloverLots).toBeUndefined();
  });

  it('seeds the in-plan-rollover pair with a matching inbound rollover on the PURE Roth plan only', async () => {
    const balances = (await listAggregates(
      'accountBalance',
    )) as Aggregate<AccountBalancePayload>[];
    const rothPlan = balances
      .filter((b) => b.payload.accountId === 'demo-account-john-roth-401k')
      .sort((a, b) => a.payload.year - b.payload.year);
    const recorded = rothPlan.filter(
      (b) => b.payload.rothInPlanRolloverTaxableAmount !== undefined,
    );
    // Exactly one year records the movement, and its principal arrives as a
    // matching inbound `rollover` on the SAME row (the fact reconciles
    // against the account's own balance history).
    expect(recorded).toHaveLength(1);
    const row = recorded[0].payload;
    expect(row.rothInPlanRolloverTaxableAmount).toBe(20_000);
    expect(row.rollover).toBe(20_000);
    // Every later year compounds from the raised figure, so the account never
    // "loses" the rolled-in money.
    const arrivalIdx = rothPlan.findIndex((b) => b.payload.year === row.year);
    for (let i = arrivalIdx + 1; i < rothPlan.length; i += 1) {
      expect(rothPlan[i].payload.startingBalance).toBe(
        rothPlan[i - 1].payload.endingBalance,
      );
    }

    // NOT on the MIXED plan: there the same event is a pre-tax → post-tax shift
    // inside the row's own split fields, which must never be recorded under
    // `rollover`.
    for (const b of balances.filter(
      (x) => x.payload.accountId === 'demo-account-john-401k',
    )) {
      expect(b.payload.rothInPlanRolloverTaxableAmount).toBeUndefined();
      expect(b.payload.rollover).toBe(0);
    }
  });

  it('the consolidated Roth IRA closes with an outbound rollover that explains its whole drop', async () => {
    const balances = (await listAggregates(
      'accountBalance',
    )) as Aggregate<AccountBalancePayload>[];
    const rows = balances
      .filter((b) => b.payload.accountId === 'demo-account-john-roth-ira-old')
      .sort((a, b) => a.payload.year - b.payload.year);
    expect(rows.length).toBeGreaterThan(1);

    const last = rows[rows.length - 1].payload;
    expect(last.endingBalance).toBe(0);
    expect(last.rollover).toBeLessThan(0);
    // The row's own residual is $0, so the consolidation imputes NO
    // withdrawal and none of John's §408A basis is consumed by the closure.
    const residual =
      last.startingBalance +
      last.totalContributions +
      last.rollover -
      last.distributions -
      last.endingBalance;
    expect(residual).toBeLessThanOrEqual(0);
    // Real recorded contribution history, which John's §408A pool includes
    // whatever the account's status.
    expect(rows.reduce((s, b) => s + b.payload.totalContributions, 0)).toBeGreaterThan(0);

    // ...and the closure is TWO-SIDED: the sibling it names receives exactly what
    // left, in the same year. Without this leg the money leaves the household
    // outright while its recorded contributions keep counting as pooled §408A
    // basis — basis with nothing behind it.
    const receiving = balances.find(
      (b) =>
        b.payload.accountId === 'demo-account-john-roth-ira' &&
        b.payload.year === last.year,
    )!.payload;
    expect(receiving.rollover).toBe(-last.rollover);
    // The receiving row's own residual is unchanged by the arrival (the money
    // lands at year end), so it imputes nothing and creates no new basis.
    expect(
      receiving.startingBalance +
        receiving.totalContributions +
        receiving.rollover -
        receiving.distributions -
        receiving.endingBalance,
    ).toBeLessThanOrEqual(0);
  });

  it('every dollar of John’s pooled §408A basis is backed by a dollar in his Roth IRA pool', async () => {
    const accounts = (await listAggregates('account')) as Aggregate<AccountPayload>[];
    const balances = (await listAggregates(
      'accountBalance',
    )) as Aggregate<AccountBalancePayload>[];
    const facts = buildRothDistributionFacts(accounts, balances);

    const johnId = accounts.find((a) => a.id === 'demo-account-john-roth-ira')!.payload.ownerId;
    const pooledBasisCents =
      facts.rothIraByPool.get(johnId)?.rothIra?.regularContributionBasisCents ?? 0;
    // The pool's assets: every non-inherited Roth IRA John owns, at its latest
    // recorded ending balance. The closed one ends at $0 by construction, so this
    // is the still-open sibling — which must therefore hold the consolidated
    // money too.
    const poolAccountIds = new Set(
      accounts
        .filter(
          (a) =>
            a.payload.type === 'RETIREMENT_ROTH_IRA' &&
            a.payload.ownerId === johnId &&
            a.payload.rmdInheritedAccount !== true,
        )
        .map((a) => a.id),
    );
    const poolBalanceDollars = [...poolAccountIds].reduce((sum, id) => {
      const rows = balances
        .filter((b) => b.payload.accountId === id)
        .sort((a, b) => a.payload.year - b.payload.year);
      return sum + (rows.length > 0 ? rows[rows.length - 1].payload.endingBalance : 0);
    }, 0);

    // Pre-fix the consolidation rolled ~$50.9k out with no receiving leg, so the
    // pool resolved $50,000 of basis against ~$43.1k of assets — the demo made
    // more of a Roth withdrawal tax-free than its own recorded history supports.
    expect(pooledBasisCents).toBeGreaterThan(0);
    expect(pooledBasisCents).toBeLessThan(Math.round(poolBalanceDollars * 100));
  });

  it('the demo resolves employer-Roth basis from the rollover and pools the closed Roth IRA', async () => {
    const accounts = (await listAggregates('account')) as Aggregate<AccountPayload>[];
    const balances = (await listAggregates(
      'accountBalance',
    )) as Aggregate<AccountBalancePayload>[];
    const facts = buildRothDistributionFacts(accounts, balances);

    // The employer plan's basis is EXACTLY its seeded in-plan-rollover
    // principal. No stored basis total exists on the payload any more (schema
    // v7) for it to disagree with.
    const plan = facts.designatedByAccount.get('demo-account-john-roth-401k');
    expect(plan?.basisCents).toBe(20_000_00);

    // John's §408A pool spans BOTH his Roth IRAs, so its derived basis
    // exceeds what the still-open one alone recorded.
    const johnId = accounts.find((a) => a.id === 'demo-account-john-roth-ira')!.payload.ownerId;
    const pooledCents = facts.rothIraByPool.get(johnId)?.rothIra?.regularContributionBasisCents ?? 0;
    const openAccountContribDollars = balances
      .filter((b) => b.payload.accountId === 'demo-account-john-roth-ira')
      .reduce((s, b) => s + b.payload.totalContributions, 0);
    expect(pooledCents).toBeGreaterThan(Math.round(openAccountContribDollars * 100));
  });

  it('seeds middle-class Social Security PIAs ($2,900 / $1,800 mo) and one CBP-payout income stream', async () => {
    const members = (await listAggregates(
      'householdMember',
    )) as Aggregate<HouseholdMemberPayload>[];
    const primary = members.find((m) => m.payload.isPrimary)!;
    const secondary = members.find((m) => !m.payload.isPrimary)!;

    const ss = (await listAggregates(
      'socialSecurityBenefit',
    )) as Aggregate<SocialSecurityBenefitPayload>[];
    const primaryPia = ss.find(
      (s) => s.payload.householdMemberId === primary.id,
    );
    const secondaryPia = ss.find(
      (s) => s.payload.householdMemberId === secondary.id,
    );
    // Today's-dollar monthly PIAs — the engine inflates them forward.
    // Middle-class dual-earner couple where both worked full careers.
    expect(primaryPia?.payload.pia).toBe(2900);
    expect(secondaryPia?.payload.pia).toBe(1800);

    const income = (await listAggregates(
      'incomeStream',
    )) as Aggregate<IncomeStreamPayload>[];
    // Exactly one income stream — the CBP-payout-to-IRA lump sum.
    expect(income).toHaveLength(1);
    const cbpPayout = income.find((i) => i.id === 'demo-income-cbp-payout');
    expect(cbpPayout).toBeTruthy();
    expect(cbpPayout?.payload.kind).toBe('pension');
    expect(cbpPayout?.payload.payoutType).toBe('lumpSum');
    expect(cbpPayout?.payload.linkedCbpAccountId).toBe(
      'demo-account-cash-balance-plan',
    );
    expect(cbpPayout?.payload.targetAccountId).toBe('demo-account-john-ira');
    expect(cbpPayout?.payload.start).toEqual({ kind: 'retirementStart' });
    // Old pension streams are fully removed.
    expect(income.find((i) => i.id === 'demo-income-pension')).toBeUndefined();
    expect(
      income.find((i) => i.id === 'demo-income-beacon-pension'),
    ).toBeUndefined();
  });

  it('sets the base MAGI bootstrap so base first-Medicare-year MAGI is below the IRMAA tier-1 threshold', async () => {
    const scenarios = (await listAggregates('scenario')) as ScenarioAggregate[];
    const base = scenarios.find((s) => s.payload.isPrimary)!;

    // T = extrapolated MFJ IRMAA tier-1 for the household's first Medicare
    // year. Birth years are dynamic (John always currentYear − 49, retires
    // at 65), so the first Medicare year is currentYear + 16: 2026 CMS MFJ
    // tier-1 ($218,000) × (1.03)^(currentYear + 16 − 2026). The base
    // bootstrap must be ≤ 0.85 × T so the base shows no IRMAA in its first
    // Medicare years.
    const currentYear = new Date().getUTCFullYear();
    const T = 218_000 * Math.pow(1.03, currentYear + 16 - 2026);
    // The demo seeds both split lookback fields with the same value.
    const bootstrapMinus2 = base.payload.overrides.magiBootstrapLookbackMinus2;
    const bootstrapMinus1 = base.payload.overrides.magiBootstrapLookbackMinus1;
    expect(bootstrapMinus2).toBeDefined();
    expect(bootstrapMinus1).toBe(bootstrapMinus2);
    expect(bootstrapMinus2!).toBeLessThanOrEqual(0.85 * T);
  });

  it('caps current-year balance "as of" at today (not Dec 31)', async () => {
    const currentYear = new Date().getUTCFullYear();
    const todayPrefix = seededOn;
    const balances = (await listAggregates(
      'accountBalance',
    )) as Aggregate<{ year: number; lastUpdated: string }>[];
    const currentYearBalances = balances.filter(
      (b) => b.payload.year === currentYear,
    );
    expect(currentYearBalances.length).toBeGreaterThan(0);
    for (const b of currentYearBalances) {
      // Current-year row caps at today; older rows still use end-of-year.
      expect(b.payload.lastUpdated.slice(0, 10)).toBe(todayPrefix);
      expect(b.payload.lastUpdated <= new Date().toISOString()).toBe(true);
    }
    const olderBalances = balances.filter((b) => b.payload.year < currentYear);
    expect(olderBalances[0].payload.lastUpdated).toMatch(/-12-31T/);
  });
});

describe('demo Social Security statement date', () => {
  beforeEach(async () => {
    await clearAllStores();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await clearAllStores();
  });

  /** Load the demo dataset and read back the seeded members + SS rows. */
  async function loadAndReadSs(todayYear?: number) {
    await loadDemoData({
      householdId: 'hh-1',
      email: 'demo@x',
      displayName: 'Demo User',
      ...(todayYear !== undefined ? { todayYear } : {}),
    });
    const members = (await listAggregates(
      'householdMember',
    )) as Aggregate<HouseholdMemberPayload>[];
    const ss = (await listAggregates(
      'socialSecurityBenefit',
    )) as Aggregate<SocialSecurityBenefitPayload>[];
    expect(ss).toHaveLength(2);
    return { members, ss };
  }

  it('never seeds a future statement date during Jan 1–14 and keeps the COLA anchor year', async () => {
    // Jan 3 — inside the window where the old `${year}-01-15` seed was a
    // future date. Fake only `Date` so fake-indexeddb's real timers
    // keep firing.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2031-01-03T08:00:00Z') });
    const { members, ss } = await loadAndReadSs();

    const todayIso = new Date().toISOString().slice(0, 10);
    for (const row of ss) {
      expect(row.payload.piaAsOfDate).toBe('2031-01-01');
      // Never a future date relative to the (frozen) clock.
      expect(row.payload.piaAsOfDate! <= todayIso).toBe(true);
    }

    // The date's year is the load-bearing COLA anchor — run the seeded rows
    // through the real extraction path (`buildSsContext` →
    // `statementAnchorYearFrom`) and assert the anchor year is unchanged, so
    // the deterministic seed cannot shift engine output.
    const ctx = buildSsContext(members, ss, {
      claimAgePrimary: { ageYears: 67, ageMonths: 0 },
      lifeExpectancyPrimary: 90,
      colaPct: 2,
      benefitReductionPct: 0,
    });
    expect(ctx?.primary.statementAnchorYear).toBe(2031);
    expect(ctx?.secondary?.statementAnchorYear).toBe(2031);
  });

  it('seeds the same deterministic Jan 1 date outside the window (mid-year)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2031-07-20T12:00:00Z') });
    const { ss } = await loadAndReadSs();
    for (const row of ss) {
      expect(row.payload.piaAsOfDate).toBe('2031-01-01');
    }
  });

  it('derives the statement date from a caller-pinned todayYear, not the wall clock', async () => {
    // No fake timers — the real clock is some other year entirely; the seed
    // must follow the pinned parameter (determinism).
    const { ss } = await loadAndReadSs(2028);
    for (const row of ss) {
      expect(row.payload.piaAsOfDate).toBe('2028-01-01');
    }
  });
});

describe('demo "Dining out" canonical expenseEnd glide-end', () => {
  beforeEach(async () => {
    await clearAllStores();
  });
  afterEach(async () => {
    await clearAllStores();
  });

  it('canonical glide-end is { kind: expenseEnd }; resolves to lifetime(last) end at 70%, flat after', async () => {
    await loadDemoData({
      householdId: 'hh-1',
      email: 'demo@x',
      displayName: 'Demo User',
    });

    const members = (await listAggregates(
      'householdMember',
    )) as Aggregate<HouseholdMemberPayload>[];
    const primary = members.find((m) => m.payload.isPrimary);
    const secondary = members.find((m) => !m.payload.isPrimary);
    expect(primary?.payload.birthdate).toBeTruthy();
    expect(secondary?.payload.birthdate).toBeTruthy();

    const expenses = (await listAggregates(
      'expense',
    )) as Aggregate<ExpensePayload>[];
    const dining = expenses.find((e) => e.payload.name === 'Dining out');
    expect(dining).toBeTruthy();
    // Canonical: the glide-end anchor is the expenseEnd kind.
    expect(dining?.payload.discretionaryGlide?.glideEnd).toEqual({
      kind: 'expenseEnd',
    });
    expect(dining?.payload.discretionaryGlide?.endMultiplierPct).toBe(70);

    const scenarios = (await listAggregates(
      'scenario',
    )) as ScenarioAggregate[];
    const base = scenarios.find((s) => s.payload.isPrimary);
    expect(base).toBeTruthy();

    // Context with the two demo birthdates and NO life-expectancy
    // override ⇒ the default age-95 life expectancy drives lifetime(last)
    // exactly as the engine sees it. retirementYear unused by these
    // age-anchored points but required by the type.
    const ctx: ScheduleResolveContext = {
      retirementYear: 2050,
      retirementMonth0: 5,
      primary: { birthdate: primary!.payload.birthdate },
      secondary: { birthdate: secondary!.payload.birthdate },
    };

    // Canonical "Dining out": glide-end tracks the expense's own
    // lifetime(last) end. Default LE 95 ⇒ later of primary/secondary.
    const canonical = resolveExpensesForScenario(
      base!.id,
      scenarios,
      expenses,
    ).find((e) => e.payload.name === 'Dining out');
    expect(canonical).toBeTruthy();

    const isoIdx = (iso: string): number => {
      const [y, m] = iso.split('-').map(Number);
      return monthIndex(y, m - 1);
    };
    const ageMonthIdx = (birthdate: string, years: number): number =>
      isoIdx(birthdate) + years * 12;
    // Death = Dec 31 of `deathYear` (`birthYear + 95`), so the `lifetime`
    // end exclusive boundary is Jan 1 of `deathYear + 1` — the month the
    // `expenseEnd` glide-end resolves to. For `whose: 'last'` it is the
    // later member's `deathYear + 1`.
    const deathYearEndIdx = (birthdate: string, age: number): number =>
      monthIndex(Number(birthdate.slice(0, 4)) + age + 1, 0);
    const lifetimeLastIdx = Math.max(
      deathYearEndIdx(primary!.payload.birthdate, 95),
      deathYearEndIdx(secondary!.payload.birthdate, 95),
    );
    const glideStartIdx = ageMonthIdx(primary!.payload.birthdate, 65);

    // At glide-start the curve is still at full real spend.
    expect(
      glideMultiplierFor(canonical!.payload, glideStartIdx, ctx),
    ).toBeCloseTo(1, 6);
    // Reaches endMultiplierPct (70%) exactly at the resolved
    // lifetime(last) end month and holds flat after.
    expect(
      glideMultiplierFor(canonical!.payload, lifetimeLastIdx, ctx),
    ).toBeCloseTo(0.7, 6);
    expect(
      glideMultiplierFor(canonical!.payload, lifetimeLastIdx + 60, ctx),
    ).toBeCloseTo(0.7, 6);
    // Strictly mid-window ⇒ between 1 and 0.7 (monotone decline).
    const mid = glideMultiplierFor(
      canonical!.payload,
      Math.floor((glideStartIdx + lifetimeLastIdx) / 2),
      ctx,
    );
    expect(mid).toBeGreaterThan(0.7);
    expect(mid).toBeLessThan(1);
  });
});

describe('wipeWorkspaceForDemoReload', () => {
  beforeEach(async () => {
    await clearAllStores();
  });
  afterEach(async () => {
    await clearAllStores();
  });

  it('queues delete mutations for accounts, balances, SS benefits, and non-primary members', async () => {
    // Seed a workspace shaped like a stale demo (legacy random-UUID IDs)
    // alongside a primary member that the loader would reuse.
    await putAggregate('householdMember', {
      id: 'hm-primary',
      householdId: 'hh-1',
      aggregateType: 'householdMember',
      schemaVersion: 1,
      version: 3,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        isPrimary: true,
        firstName: 'Real',
        lastName: 'User',
        email: 'real@x',
        birthdate: '1985-06-15',
      } satisfies HouseholdMemberPayload,
    });
    await putAggregate('householdMember', {
      id: 'hm-stale-secondary',
      householdId: 'hh-1',
      aggregateType: 'householdMember',
      schemaVersion: 1,
      version: 2,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        isPrimary: false,
        firstName: 'Old',
        lastName: 'Demo',
        email: 'old@x',
        birthdate: '1988-03-15',
      } satisfies HouseholdMemberPayload,
    });
    await putAggregate('account', {
      id: 'acc-stale',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 5,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Stale 401k',
        type: 'RETIREMENT_401K',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'PRE_TAX',
        ownerId: 'hm-primary',
        institution: 'Old',
        notes: '',
        planningReturnPct: 5,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      } satisfies AccountPayload,
    });
    await putAggregate('accountBalance', {
      id: 'bal-stale',
      householdId: 'hh-1',
      aggregateType: 'accountBalance',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        accountId: 'acc-stale',
        year: 2024,
        lastUpdated: '2024-12-31T23:59:59Z',
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
        endingBalance: 1000,
        endingBalancePreTax: null,
        endingBalancePostTax: null,
        totalContributions: 0,
        comment: null,
      },
    });
    await putAggregate('socialSecurityBenefit', {
      id: 'ss-stale',
      householdId: 'hh-1',
      aggregateType: 'socialSecurityBenefit',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        householdMemberId: 'hm-primary',
        pia: 3000,
        piaAsOfDate: '2026-01-01',
        notes: null,
      },
    });

    const result = await wipeWorkspaceForDemoReload('hh-1');

    expect(result).toEqual({
      deletedAccounts: 1,
      deletedBalances: 1,
      deletedSocialSecurity: 1,
      deletedMembers: 1,
      deletedScenarios: 0,
      deletedExpenseCategories: 0,
      deletedExpenses: 0,
      deletedIncomeStreams: 0,
    });

    // Tombstones — listAggregates filters deletedAt, so post-wipe the
    // demo loader's precondition would pass.
    expect(await listAggregates('account')).toHaveLength(0);
    expect(await listAggregates('accountBalance')).toHaveLength(0);
    expect(await listAggregates('socialSecurityBenefit')).toHaveLength(0);
    const remainingMembers = (await listAggregates(
      'householdMember',
    )) as Aggregate<HouseholdMemberPayload>[];
    expect(remainingMembers).toHaveLength(1);
    expect(remainingMembers[0].payload.isPrimary).toBe(true);

    // Mutation queue carries one delete per non-primary aggregate, each
    // at the seeded version so push won't conflict.
    const pending = await listPendingMutations();
    expect(pending).toHaveLength(4);
    expect(pending.every((m) => m.operation === 'delete')).toBe(true);
    const byId = new Map(pending.map((m) => [m.aggregateId, m] as const));
    expect(byId.get('acc-stale')?.expectedVersion).toBe(5);
    expect(byId.get('bal-stale')?.expectedVersion).toBe(1);
    expect(byId.get('ss-stale')?.expectedVersion).toBe(1);
    expect(byId.get('hm-stale-secondary')?.expectedVersion).toBe(2);
    expect(byId.has('hm-primary')).toBe(false);
  });

  it('makes a subsequent loadDemoData call succeed (precondition passes after wipe)', async () => {
    // Pre-existing stale account would normally trip
    // DemoDataExistsError. After wipe, listAggregates filters tombstones
    // so the loader proceeds.
    await putAggregate('account', {
      id: 'acc-stale',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Stale',
        type: 'BROKERAGE',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'POST_TAX',
        ownerId: 'hm-primary',
        institution: 'X',
        notes: '',
        planningReturnPct: 5,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      } satisfies AccountPayload,
    });

    await wipeWorkspaceForDemoReload('hh-1');
    await expect(
      loadDemoData({ householdId: 'hh-1', email: 'demo@x', displayName: 'Demo User' }),
    ).resolves.toBeTruthy();
  });

  it('clears stale pending and failed-conflict mutations from a previous broken load', async () => {
    // Reproduces the bug a user hit after upgrading to the upsert fix:
    // their IDB still carried `failed-conflict` mutations from earlier
    // create-at-v=0 attempts, and the SyncContext's "Refresh needed"
    // badge fires whenever `listFailedConflicts()` is non-empty — even
    // if the new flush itself completes cleanly.
    await queueMutation({
      id: 'mut-stale-pending',
      aggregateId: 'demo-account-john-401k',
      aggregateType: 'account',
      operation: 'create',
      expectedVersion: 0,
      schemaVersion: 1,
      payload: { name: 'stale-pending' },
      timestamp: Date.now(),
      deviceId: 'dev-1',
      status: 'pending',
    });
    await queueMutation({
      id: 'mut-stale-conflict',
      aggregateId: 'demo-account-john-401k',
      aggregateType: 'account',
      operation: 'create',
      expectedVersion: 0,
      schemaVersion: 1,
      payload: { name: 'stale-conflict' },
      timestamp: Date.now(),
      deviceId: 'dev-1',
      status: 'failed-conflict',
    });

    await wipeWorkspaceForDemoReload('hh-1');

    // Both stale entries are gone — only the wipe's own pending entries
    // (none here, since nothing was seeded to wipe) remain.
    const pendingAfter = await listPendingMutations();
    const conflictsAfter = await listFailedConflicts();
    expect(pendingAfter).toEqual([]);
    expect(conflictsAfter).toEqual([]);
  });

  it('skips matching demo IDs so the loader can update them in place', async () => {
    // Seed a workspace whose secondary member + one demo account use
    // the deterministic IDs from a previous demo load. Wipe must NOT
    // tombstone these — otherwise loadDemoData's `update` would race
    // against the delete on push and the cloud-side `create-or-update`
    // condition would fail.
    await putAggregate('householdMember', {
      id: 'demo-member-secondary',
      householdId: 'hh-1',
      aggregateType: 'householdMember',
      schemaVersion: 1,
      version: 4,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        isPrimary: false,
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane-doe@local.test',
        birthdate: '1988-03-15',
      } satisfies HouseholdMemberPayload,
    });
    await putAggregate('account', {
      id: 'demo-account-john-401k',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 9,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Old 401k',
        type: 'RETIREMENT_401K',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'MIXED',
        ownerId: 'demo-member-primary',
        institution: 'Northbrook Investments',
        notes: '',
        planningReturnPct: 7,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      } satisfies AccountPayload,
    });
    // Also a non-matching legacy account that *should* get deleted.
    await putAggregate('account', {
      id: 'acc-legacy-uuid',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 2,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Legacy random-UUID demo account',
        type: 'RETIREMENT_IRA',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'PRE_TAX',
        ownerId: 'demo-member-primary',
        institution: 'X',
        notes: '',
        planningReturnPct: 5,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      } satisfies AccountPayload,
    });

    const result = await wipeWorkspaceForDemoReload('hh-1');
    // Only the legacy random-UUID account is queued for deletion.
    expect(result.deletedAccounts).toBe(1);
    expect(result.deletedMembers).toBe(0);

    const pending = await listPendingMutations();
    const deletedIds = pending.filter((m) => m.operation === 'delete').map((m) => m.aggregateId);
    expect(deletedIds).toContain('acc-legacy-uuid');
    expect(deletedIds).not.toContain('demo-account-john-401k');
    expect(deletedIds).not.toContain('demo-member-secondary');

    // Matching IDs survive as live aggregates so loadDemoData can
    // upsert them.
    const surviving = (await listAggregates('account')) as Aggregate<AccountPayload>[];
    expect(surviving.find((a) => a.id === 'demo-account-john-401k')).toBeDefined();
  });

  it('queues a delete for a locally-tombstoned-but-unsynced non-demo aggregate so its server copy is cleared', async () => {
    // The un-synced-delete class this flow repairs: the user soft-deleted a
    // legacy (non-demo-id) account locally, but the delete never landed on the
    // server (parked as a failed-conflict). The local row is tombstoned
    // (deletedAt set) and inflated to v3, while the failed-conflict row records
    // the server-acknowledged base v2. `listAggregates` filters tombstones, so
    // a naive wipe would SKIP this row — no delete re-queued, and the server's
    // still-live copy reappears alongside the freshly-seeded demo set. The wipe
    // must enumerate WITH tombstones and re-queue the delete at the de-inflated
    // reachable version.
    await putAggregate('account', {
      id: 'acc-legacy-tombstoned',
      householdId: 'hh-1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 3,
      updatedAt: '2026-07-02T00:00:00.000Z',
      deletedAt: '2026-07-02T00:00:00.000Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Legacy soft-deleted account',
        type: 'BROKERAGE',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'POST_TAX',
        ownerId: 'demo-member-primary',
        institution: 'X',
        notes: '',
        planningReturnPct: 5,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      } satisfies AccountPayload,
    });
    await queueMutation({
      id: 'mut-legacy-unsynced-delete',
      aggregateId: 'acc-legacy-tombstoned',
      aggregateType: 'account',
      operation: 'delete',
      expectedVersion: 2,
      schemaVersion: 1,
      payload: { name: 'Legacy soft-deleted account' },
      timestamp: 1000,
      deviceId: 'dev-1',
      status: 'failed-conflict',
    });

    const result = await wipeWorkspaceForDemoReload('hh-1');
    // The tombstoned legacy account is counted and (re-)queued for deletion —
    // not silently skipped.
    expect(result.deletedAccounts).toBe(1);

    const pending = await listPendingMutations();
    const del = pending.filter((m) => m.aggregateId === 'acc-legacy-tombstoned');
    expect(del).toHaveLength(1);
    // De-inflated to the server-acknowledged base (2), not the inflated local
    // version (3), so the delete can actually land.
    expect(del[0]).toMatchObject({ operation: 'delete', expectedVersion: 2 });
  });
});

describe('demo scenarios — tax / IRMAA / solvency outcomes', () => {
  // The dataset is loaded once for the whole group and every projection is
  // run once per (scenario, method) and shared — all cases only read them.
  let data: Awaited<ReturnType<typeof loadAndReadAggregates>>;
  beforeAll(async () => {
    await clearAllStores();
    data = await loadAndReadAggregates();
  });
  afterAll(async () => {
    await clearAllStores();
  });

  const projections = new Map<string, ReturnType<typeof runBalanceProjection>>();
  function projectionFor(scenarioId: string, method: 'planned' | 'twr') {
    const key = `${scenarioId}:${method}`;
    let result = projections.get(key);
    if (!result) {
      result = runBalanceProjection({
        scenarioId,
        scenarios: data.scenarios,
        accounts: data.accounts,
        balances: data.balances,
        members: data.members,
        ssBenefits: data.ssBenefits,
        expenses: data.expenses,
        incomeStreams: data.incomeStreams,
        todayYear: CURRENT_YEAR,
        todayMonthIndex: 4,
        method,
      });
      projections.set(key, result);
    }
    return result;
  }

  // Birth years are dynamic: John is always currentYear − 49, so he
  // reaches Medicare age 65 in currentYear + 16. `todayYear` passed to the
  // projection runner must match the loader's clock (same currentYear) for
  // the MAGI / IRMAA assertions to line up.
  const CURRENT_YEAR = new Date().getUTCFullYear();
  const FIRST_MEDICARE_YEAR = CURRENT_YEAR + 16;
  // Extrapolated MFJ IRMAA tier-1 threshold for that year (3% inflation,
  // matching the demo's default): 2026 CMS MFJ tier-1 × (1.03)^(year−2026).
  const tierOneThresholdFor = (year: number): number =>
    218_000 * Math.pow(1.03, year - 2026);

  /** Load the demo dataset and return every aggregate array the balance
   *  projection runner needs, plus the resolved scenario list. */
  async function loadAndReadAggregates(): Promise<{
    accounts: Aggregate<AccountPayload>[];
    balances: Aggregate<AccountBalancePayload>[];
    members: Aggregate<HouseholdMemberPayload>[];
    ssBenefits: Aggregate<SocialSecurityBenefitPayload>[];
    expenses: Aggregate<ExpensePayload>[];
    incomeStreams: Aggregate<IncomeStreamPayload>[];
    scenarios: ScenarioAggregate[];
  }> {
    await loadDemoData({ householdId: 'hh-1', email: 'demo@x', displayName: 'D' });
    return {
      accounts: (await listAggregates('account')) as Aggregate<AccountPayload>[],
      balances: (await listAggregates(
        'accountBalance',
      )) as Aggregate<AccountBalancePayload>[],
      members: (await listAggregates(
        'householdMember',
      )) as Aggregate<HouseholdMemberPayload>[],
      ssBenefits: (await listAggregates(
        'socialSecurityBenefit',
      )) as Aggregate<SocialSecurityBenefitPayload>[],
      expenses: (await listAggregates('expense')) as Aggregate<ExpensePayload>[],
      incomeStreams: (await listAggregates(
        'incomeStream',
      )) as Aggregate<IncomeStreamPayload>[],
      scenarios: (await listAggregates('scenario')) as ScenarioAggregate[],
    };
  }

  it('base scenario shows no IRMAA surcharge in its first Medicare years', async () => {
    const base = data.scenarios.find((s) => s.payload.isPrimary)!;
    const result = projectionFor(base.id, 'planned');
    // First five Medicare years: no surcharge tier.
    const firstMedicareYears = result.drawdownYears.filter(
      (y) => y.year >= FIRST_MEDICARE_YEAR && y.year < FIRST_MEDICARE_YEAR + 5,
    );
    expect(firstMedicareYears.length).toBeGreaterThan(0);
    for (const y of firstMedicareYears) {
      expect(y.irmaaTier ?? 'none').toBe('none');
    }
  });

  it('base scenario stays solvent through the horizon and keeps first-Medicare-year MAGI at or below 0.85×T under both Planned and TWR', async () => {
    // The "middle-class plausible" base contract has two halves the
    // bootstrap-value check (above) does not pin: (1) the plan funds the
    // whole horizon — no nominal depletion before plan end — and (2) the
    // *computed* first-Medicare-year MAGI (not just the seeded bootstrap)
    // lands at or below 0.85 × T, the inflation-extrapolated MFJ IRMAA
    // tier-1 threshold for that year. Both must hold under Planned and TWR.
    const base = data.scenarios.find((s) => s.payload.isPrimary)!;
    for (const method of ['planned', 'twr'] as const) {
      const result = projectionFor(base.id, method);

      // (1) Solvent through plan end: no row hits zero before the horizon.
      const insolventBeforeHorizon = result.drawdownYears.filter(
        (y) => y.year < result.horizonYear && y.nominalBalance <= 0,
      );
      expect(insolventBeforeHorizon).toEqual([]);

      // (2) Computed first-Medicare-year MAGI ≤ 0.85 × T.
      const firstMedicare = result.drawdownYears.find(
        (y) => y.year === FIRST_MEDICARE_YEAR,
      );
      expect(firstMedicare).toBeTruthy();
      expect((firstMedicare!.magiCents ?? 0) / 100).toBeLessThanOrEqual(
        0.85 * tierOneThresholdFor(FIRST_MEDICARE_YEAR),
      );
    }
  });

  it('depletion scenario reaches zero before plan end under both Planned and TWR', async () => {
    const depletion = data.scenarios.find(
      (s) => s.payload.name === 'Funds Run Out',
    )!;
    for (const method of ['planned', 'twr'] as const) {
      const result = projectionFor(depletion.id, method);
      const depletedYear = result.drawdownYears.find(
        (y) => y.nominalBalance <= 0,
      )?.year;
      expect(depletedYear).toBeDefined();
      expect(depletedYear!).toBeLessThan(result.horizonYear);
    }
  });

  it('seeds the "Retire early at 62" scenario claiming Social Security early at 62', async () => {
    const early = data.scenarios.find(
      (s) => s.payload.name === 'Retire early at 62',
    )!;
    expect(early).toBeTruthy();
    expect(early.payload.overrides.retirementAge?.primary).toEqual({
      ageYears: 62,
      ageMonths: 0,
    });
    expect(early.payload.overrides.socialSecurity?.primary).toEqual({
      ageYears: 62,
      ageMonths: 0,
    });
  });

  it('"Delay — work to 70" scenario stays solvent through the horizon under both Planned and TWR', async () => {
    const delay = data.scenarios.find(
      (s) => s.payload.name === 'Delay — work to 70',
    )!;
    expect(delay).toBeTruthy();
    for (const method of ['planned', 'twr'] as const) {
      const result = projectionFor(delay.id, method);
      const insolventBeforeHorizon = result.drawdownYears.filter(
        (y) => y.year < result.horizonYear && y.nominalBalance <= 0,
      );
      expect(insolventBeforeHorizon).toEqual([]);
    }
  });

  it('"Delay — work to 70" reports no required-withdrawal shortfall while pre-tax savings remain (TWR)', async () => {
    // Regression for the Delayed-demo phantom RMD shortfall. Pre-fix, the
    // required-minimum-distribution floor counted John's IRA after-tax bucket
    // (which held the CBP rollover routed to `post`) and the floor exceeded the
    // drawable pre-tax pocket — reporting a ~$20k shortfall that could never be
    // satisfied even with hundreds of thousands of pre-tax dollars available.
    const delay = data.scenarios.find(
      (s) => s.payload.name === 'Delay — work to 70',
    )!;
    const result = projectionFor(delay.id, 'twr');

    // The whole post-retirement projection: no year may report a forced-
    // withdrawal shortfall while the household still holds drawable pre-tax
    // savings (the floor can only require what `pre` can supply).
    const yearsWithShortfall = result.drawdownYears.filter(
      (y) => (y.rmdShortfallCents ?? 0) > 0,
    );
    const totalShortfallCents = result.drawdownYears.reduce(
      (sum, y) => sum + (y.rmdShortfallCents ?? 0),
      0,
    );
    // No year reports a forced-withdrawal shortfall: the cash-balance rollover
    // is now held as PRE-TAX principal in John's IRA, so the RMD floor never
    // exceeds the drawable pre-tax pocket while savings remain. (Pre-fix this
    // summed to ~$20,636 of phantom shortfall at the demo's first RMD years.)
    // The positive control — that a GENUINE shortfall still surfaces when the
    // pre-tax pocket is truly depleted — is pinned at the engine level in
    // drawdown-engine-per-account.test.ts (no stock demo scenario depletes a
    // qualifying account below its owed floor, so it cannot be exercised here).
    expect(yearsWithShortfall).toEqual([]);
    expect(totalShortfallCents).toBe(0);
  });
});

// Regression: linked-CBP rollover-year RMD split.
// Previously the full CBP balance rolled into the target regardless of the
// owner's RMD trigger age. Now a CBP lump-sum rolling at/after the
// trigger age carves the current-year RMD out first (taxable ordinary
// income, NOT rolled) and only the excess rolls tax-free into the target.
//
// Dataset is test-local — no loadDemoData call. The shipped demo has
// John's CBP rolling pre-retirement (∼age 60s, before the trigger), so
// the at/after-trigger shape must be constructed in-test.
describe('RMD-in-rollover-year split — linked-CBP at/after trigger age', () => {
  const TODAY_YEAR = 2026; // fixed — retirement year (2029) is always in the future
  const TODAY_MONTH = 5; // June

  function mkMbr(id: string, birthYear: number): Aggregate<HouseholdMemberPayload> {
    return {
      id,
      householdId: 'h-rmd',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'householdMember',
      payload: {
        isPrimary: true,
        firstName: 'Rmd',
        lastName: 'Tester',
        email: `${id}@test.local`,
        birthdate: `${birthYear}-01-01`,
      },
    };
  }

  function mkSs(memberId: string): Aggregate<SocialSecurityBenefitPayload> {
    return {
      id: `ss-${memberId}`,
      householdId: 'h-rmd',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'socialSecurityBenefit',
      payload: { householdMemberId: memberId, pia: null, piaAsOfDate: '2026-01-01', notes: null },
    };
  }

  function mkCbp(ownerId: string): Aggregate<AccountPayload> {
    return {
      id: 'cbp-rmd',
      householdId: 'h-rmd',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'account',
      payload: {
        name: 'CBP Source',
        type: 'RETIREMENT_CASH_BALANCE',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'PRE_TAX',
        ownerId,
        institution: 'Plan',
        notes: '',
        planningReturnPct: 0, // stable balance for determinism
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
      },
    };
  }

  function mkIra(ownerId: string): Aggregate<AccountPayload> {
    return {
      id: 'ira-tgt',
      householdId: 'h-rmd',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'account',
      payload: {
        name: 'IRA Target',
        type: 'RETIREMENT_IRA',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'PRE_TAX',
        ownerId,
        institution: 'Brokerage',
        notes: '',
        planningReturnPct: 0, // stable balance → rollover amount = balance at year-end
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
      },
    };
  }

  function mkBal(
    accountId: string,
    year: number,
    endingBalance: number,
  ): Aggregate<AccountBalancePayload> {
    return {
      id: `bal-${accountId}-${year}`,
      householdId: 'h-rmd',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'accountBalance',
      payload: {
        accountId,
        year,
        lastUpdated: `${year}-12-31`,
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
        endingBalance,
        endingBalancePreTax: null,
        endingBalancePostTax: null,
        totalContributions: 0,
        comment: null,
      },
    };
  }

  function mkPension(memberId: string): Aggregate<IncomeStreamPayload> {
    return {
      id: 'pen-cbp',
      householdId: 'h-rmd',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'incomeStream',
      payload: {
        name: 'CBP Lump-Sum Rollover',
        memberId,
        kind: 'pension',
        payoutType: 'lumpSum',
        lumpSumAmount: 0,
        linkedCbpAccountId: 'cbp-rmd',
        targetAccountId: 'ira-tgt',
        start: { kind: 'year', year: 2029 }, // retirement year
      },
    };
  }

  function mkScenario(retirementAgeYears: number): ScenarioAggregate {
    return {
      id: 'sc-rmd',
      householdId: 'h-rmd',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'scenario',
      payload: {
        name: 'RMD Split Test',
        description: '',
        parentScenarioId: null,
        isPrimary: true,
        notes: '',
        overrides: {
          socialSecurity: {
            primary: { ageYears: 70, ageMonths: 0 },
            secondary: { ageYears: 70, ageMonths: 0 },
          },
          retirementAge: {
            primary: { ageYears: retirementAgeYears, ageMonths: 0 },
            secondary: { ageYears: 67, ageMonths: 0 },
          },
          inflation: { ratePct: 0 },
          lifeExpectancy: { primary: 90, secondary: 90 },
          // the rollover-year RMD split runs for every named strategy
          withdrawalStrategy: { kind: 'taxEfficient' },
        },
      },
    };
  }

  it('carves the rollover-year RMD when the CBP owner is at/after trigger age', () => {
    // Owner born 1951 → SECURE 2.0 trigger age 73 → trigger year 2024.
    // Retires at 78 in 2029 (well past trigger). RMD at age 78 per the Uniform
    // Lifetime Table (IRS Pub. 590-B, Table III): divisor 20.3.
    //   RMD = $300,000 / 20.3 ≈ $14,778 (carved, distributed as ordinary income)
    //   Rollover excess = $300,000 − $14,778 ≈ $285,222 (lands in IRA)
    // With planningReturnPct = 0 on both accounts and no expenses, the IRA
    // end-of-year balance equals the rollover excess — well below $300k.
    const memberId = 'mbr-at';
    const result = runBalanceProjection({
      scenarioId: 'sc-rmd',
      scenarios: [mkScenario(78)],
      accounts: [mkCbp(memberId), mkIra(memberId)],
      balances: [mkBal('cbp-rmd', 2025, 300_000), mkBal('ira-tgt', 2025, 0)],
      members: [mkMbr(memberId, 1951)],
      ssBenefits: [mkSs(memberId)],
      expenses: [],
      incomeStreams: [mkPension(memberId)],
      todayYear: TODAY_YEAR,
      todayMonthIndex: TODAY_MONTH,
    });

    const rolloverYear = result.drawdownYears.find((y) => y.year === 2029);
    expect(rolloverYear).toBeDefined();
    // IRA received only the rollover excess (≈$285,222), not the full $300k.
    expect(rolloverYear!.nominalBalance).toBeLessThan(295_000);
    // The rollover excess did land in the IRA (not everything was RMD'd).
    expect(rolloverYear!.nominalBalance).toBeGreaterThan(275_000);
  });

  it('rolls the full CBP balance when the owner is before trigger age (no RMD carve)', () => {
    // Owner born 1965 → SECURE 2.0 trigger age 75 (born ≥1960) → trigger year 2040.
    // Retires at 64 in 2029, well before the trigger. No RMD → full $300k rolls.
    // With planningReturnPct = 0 and no expenses, IRA end-of-year balance = $300k.
    const memberId = 'mbr-before';
    const result = runBalanceProjection({
      scenarioId: 'sc-rmd',
      scenarios: [mkScenario(64)],
      accounts: [mkCbp(memberId), mkIra(memberId)],
      balances: [mkBal('cbp-rmd', 2025, 300_000), mkBal('ira-tgt', 2025, 0)],
      members: [mkMbr(memberId, 1965)],
      ssBenefits: [mkSs(memberId)],
      expenses: [],
      incomeStreams: [mkPension(memberId)],
      todayYear: TODAY_YEAR,
      todayMonthIndex: TODAY_MONTH,
    });

    const rolloverYear = result.drawdownYears.find((y) => y.year === 2029);
    expect(rolloverYear).toBeDefined();
    // Full $300k rolled — no RMD carve.
    expect(rolloverYear!.nominalBalance).toBeGreaterThan(295_000);
  });
});
