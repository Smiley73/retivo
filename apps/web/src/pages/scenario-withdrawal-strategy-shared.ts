/** Constants and helpers shared by the withdrawal-strategy cards and editor. */
import type { SegmentedOption } from '../components/SegmentedRadioGroup';
import type {
  AccountPayload,
  AccountType,
  Aggregate,
  CustomDrawdownOrder,
  HealthCoverageMonthsOverride,
  IncomeStreamPayload,
  WithdrawalStrategy,
} from '../db/types';
import {
  resolveLinkedCbpIncomeStreams,
  validateCbpResolution,
} from '../lib/cbp-resolution';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import {
  storedAcaBenchmarkOverrides,
  storedCoverageMonthEntries,
} from '../lib/tax-integration-helpers';
import type { DraftMagiCapWindow } from '../lib/magi-cap-persistence';

export type StrategyKind = WithdrawalStrategy['kind'];
export type { DraftMagiCapWindow };

export const STRATEGY_OPTIONS: SegmentedOption<StrategyKind>[] = [
  {
    value: 'taxEfficient',
    label: 'Tax-efficient',
    title: 'Taxable → tax-deferred → Roth (HSA handled separately)',
  },
  {
    value: 'proportional',
    label: 'Proportional',
    title: 'Split across non-HSA classes by balance (HSA handled separately)',
  },
  {
    value: 'rothFirst',
    label: 'Roth first',
    title: 'Roth → tax-deferred → taxable (HSA handled separately)',
  },
  {
    value: 'customOrder',
    label: 'Custom order',
    title: 'User-defined per-account drawdown sequence',
  },
];

export const STRATEGY_LABELS: Record<StrategyKind, string> = {
  taxEfficient: 'Tax-efficient',
  proportional: 'Proportional',
  rothFirst: 'Roth first',
  customOrder: 'Custom order',
};

/** Plain-English description shown below the strategy picker; keep the account-ordering claims in sync with the STRATEGY_OPTIONS titles. */
export const STRATEGY_DESCRIPTIONS: Record<StrategyKind, string> = {
  taxEfficient:
    'Spends taxable brokerage accounts first, then tax-deferred accounts ' +
    '(traditional IRA/401k), then Roth. Letting your tax-free Roth ' +
    'money keep growing the longest tends to carry lower tax drag than spending ' +
    'Roth first, though the actual result depends on your tax bracket and account mix. ' +
    'HSAs are handled outside this order: HSA money first covers any modeled ' +
    'HSA-qualified medical costs (tax-free) before any other account is drawn, and ' +
    'whatever is left is held back as an emergency reserve that is tapped only after ' +
    'every non-HSA account is exhausted.',
  proportional:
    "Draws from your non-HSA account types at the same time, in proportion to each " +
    "account's balance, which keeps your mix of taxable, tax-deferred, and Roth money " +
    'roughly steady. Because tax-deferred draws add to your taxable income while Roth ' +
    'and taxable-basis draws largely do not, the tax impact can vary from year to ' +
    'year rather than staying fixed. HSAs are handled separately: HSA money first ' +
    'covers any modeled HSA-qualified medical costs (tax-free), and the rest is held ' +
    'as an emergency reserve tapped only after every non-HSA account is exhausted.',
  rothFirst:
    'Spends Roth accounts first, then tax-deferred (traditional IRA/401k), then ' +
    'taxable brokerage. The opposite of tax-efficient, it spends tax-free ' +
    'money early, which generally carries higher tax drag over retirement but can ' +
    'lower your taxable income and MAGI now (which can affect ACA subsidies) and ' +
    'leaves less tax-free growth for later. ' +
    'HSAs are handled outside this order: HSA money first covers any modeled ' +
    'HSA-qualified medical costs (tax-free), and whatever is left is held back as an ' +
    'emergency reserve tapped only after every non-HSA account is exhausted.',
  customOrder:
    'You set the exact order your accounts are drained by arranging them into tiers ' +
    'on the Custom order tab. Use this when you want full control over which accounts ' +
    'are spent first. Drawing tax-deferred tiers (traditional IRA/401k) raises your ' +
    'ordinary income and MAGI in those years, while Roth or cash-like tiers generally ' +
    'do not, so the tax impact depends on the tier order you choose.',
};

const DEFAULT_COST_BASIS_FRACTION = 0.5;
export const DEFAULT_COST_BASIS_PCT = DEFAULT_COST_BASIS_FRACTION * 100;

const DEFAULT_MAGI_CAP_END_AGE = 65;

/** Seed window for "toggle the cap on": start at retirement, end at the primary's age 65, no ceiling yet, Minimize mode, IRMAA line. */
export function defaultMagiCapWindow(): DraftMagiCapWindow {
  return {
    start: { kind: 'retirementStart' },
    end: { kind: 'age', memberId: 'primary', years: DEFAULT_MAGI_CAP_END_AGE, months: 0 },
    magiCeilingAnnualDollars: null,
    capMode: 'minimize',
    capMagiLine: 'irmaa',
  };
}

export function toDraftMagiCapWindows(
  cap: import('../db/types').MagiCapOverride | undefined,
): DraftMagiCapWindow[] {
  if (cap === undefined) return [];
  return cap.windows.map((w) => ({ ...w }));
}

/** Default share of emergency HSA withdrawals assumed qualified (see "The HSA passes" in docs/math-withdrawals.md). */
export const DEFAULT_HSA_QUALIFIED_PCT = 100;

/**
* Account types whose pre-59½ withdrawals carry the 10% §72(t) penalty and so may be marked exempt; the toggle waives only that penalty, not income tax.
* Roth 457(b) is excluded (governmental §72(t) exemption). See "Early-withdrawal penalties" in docs/math-taxes.md.
*/
export const EARLY_WITHDRAWAL_PENALTY_ELIGIBLE_TYPES: ReadonlySet<AccountType> =
  new Set<AccountType>([
    'RETIREMENT_401K',
    'RETIREMENT_IRA',
    'RETIREMENT_403B',
    'RETIREMENT_TSP',
    'RETIREMENT_CASH_BALANCE',
    'RETIREMENT_ROTH_IRA',
    'RETIREMENT_ROTH_401K',
    'RETIREMENT_ROTH_403B',
    'RETIREMENT_ROTH_TSP',
  ]);

export function isPenaltyEligibleAccount(a: Aggregate<AccountPayload>): boolean {
  return EARLY_WITHDRAWAL_PENALTY_ELIGIBLE_TYPES.has(a.payload.type);
}

/**
* Whether an account can receive Fill-mode Roth conversions: an active Roth IRA only, because Fill mode models an in-plan IRA conversion
* and employer-plan Roth accounts cannot accept a roll-in. Inherited Roth IRAs are excluded (§408A(e)): the engine would convert $0.
*/
export function isRothConversionTarget(a: Aggregate<AccountPayload>): boolean {
  if (a.payload.rmdInheritedAccount === true) return false;
  return a.payload.active && a.payload.type === 'RETIREMENT_ROTH_IRA';
}

export function rothConversionTargets(
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
): Aggregate<AccountPayload>[] {
  return accounts.filter(isRothConversionTarget);
}

export function formatMagiBootstrap(dollars: number): string {
  return `$${Math.round(dollars).toLocaleString()}`;
}

function isOrderableAccount(a: Aggregate<AccountPayload>): boolean {
  return a.payload.active && a.payload.type !== 'RETIREMENT_CASH_BALANCE';
}

export function placeableAccountIds(
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
): Set<string> {
  return new Set(accounts.filter(isOrderableAccount).map((a) => a.id));
}

/** Prunes stale and CBP-type ids from a saved order, preserving tier structure; a CBP-only difference is not a user edit. */
export function pruneCustomOrder(
  order: CustomDrawdownOrder,
  placeableIds: ReadonlySet<string>,
): { tiers: string[][]; excludedAccountIds: string[] } {
  const tiers = order.tiers.map((tier) => tier.filter((id) => placeableIds.has(id)));
  const excludedAccountIds = order.excludedAccountIds.filter((id) => placeableIds.has(id));
  return { tiers, excludedAccountIds };
}

/** Seeds customDrawdownOrder from the existing config: HSAs Excluded, everything else tier 0; Cash Balance Pension accounts are never orderable. */
export function seedTierState(
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
  existing: CustomDrawdownOrder | undefined,
): { tiers: string[][]; excludedAccountIds: string[] } {
  if (!existing) {
    const excluded: string[] = [];
    const tier0: string[] = [];
    for (const a of accounts) {
      if (!isOrderableAccount(a)) continue;
      if (a.payload.type === 'HSA') excluded.push(a.id);
      else tier0.push(a.id);
    }
    return { tiers: [tier0], excludedAccountIds: excluded };
  }
  return pruneCustomOrder(existing, placeableAccountIds(accounts));
}

/** One Cash Balance Pension account in the tier editor's read-only "not drawn down" section; `conflict` means duplicate pension streams link to it. */
export interface CbpInfoRow {
  accountId: string;
  name: string;
  kind: 'annuity' | 'lumpSum' | 'unconfigured' | 'conflict';
  targetName?: string;
}

/** One info row per Cash Balance Pension account, resolved through the shared `resolveLinkedCbpIncomeStreams` so engines and UI agree. */
export function buildCbpInfoRows(
  scenario: ScenarioAggregate,
  scenarios: ReadonlyArray<ScenarioAggregate>,
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
  incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>,
): CbpInfoRow[] {
  const elections = resolveLinkedCbpIncomeStreams({
    scenarioId: scenario.id,
    scenarios,
    accounts,
    incomeStreams,
  });
  const conflictIds = new Set(
    validateCbpResolution({
      scenarioId: scenario.id,
      scenarios,
      accounts,
      incomeStreams,
    }).annuityDuplicateStream,
  );
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const rows: CbpInfoRow[] = [];
  for (const a of accounts) {
    if (a.payload.type !== 'RETIREMENT_CASH_BALANCE') continue;
    if (conflictIds.has(a.id)) {
      rows.push({ accountId: a.id, name: a.payload.name, kind: 'conflict' });
      continue;
    }
    const election = elections.get(a.id);
    if (election?.kind === 'annuity') {
      rows.push({ accountId: a.id, name: a.payload.name, kind: 'annuity' });
    } else if (election?.kind === 'lumpSum') {
      const targetName = accountById.get(election.targetAccountId)?.payload.name;
      rows.push({ accountId: a.id, name: a.payload.name, kind: 'lumpSum', targetName });
    } else {
      rows.push({ accountId: a.id, name: a.payload.name, kind: 'unconfigured' });
    }
  }
  return rows;
}

// Kept here, not in the draft hook: the pure save helpers and the presentational editor both consume them.

/** One member's Part B / Part D / Marketplace months for one tax year; `null` leaves that field to the projection's own timing. */
export interface DraftHealthCoverageRow {
  memberId: string;
  taxYear: number;
  partBMonths: number | null;
  partDMonths: number | null;
  marketplaceMonths: number | null;
}

export interface DraftBenchmarkRow {
  taxYear: number;
  annualSlcspDollars: number;
}

/** Why Save is blocked, or `null`. An all-blank row is dropped on save, so blocking with a reason beats letting the row vanish silently. */
export function healthCoverageBlockReason(
  coverageRows: readonly DraftHealthCoverageRow[],
  benchmarkRows: readonly DraftBenchmarkRow[],
): string | null {
  const emptyCoverage = coverageRows.filter(
    (r) => r.partBMonths === null && r.partDMonths === null && r.marketplaceMonths === null,
  );
  if (emptyCoverage.length > 0) {
    const years = [...new Set(emptyCoverage.map((r) => r.taxYear))].sort((a, b) => a - b);
    return years.length === 1
      ? `The ${years[0]} coverage row does not state any months yet. Enter Part B, Part D or Marketplace months, or remove the row.`
      : `${emptyCoverage.length} coverage rows (${years.join(', ')}) do not state any months yet. Enter months for each, or remove them.`;
  }

  const unpriced = benchmarkRows.filter(
    (r) => !Number.isFinite(r.annualSlcspDollars) || r.annualSlcspDollars <= 0,
  );
  if (unpriced.length > 0) {
    const years = [...new Set(unpriced.map((r) => r.taxYear))].sort((a, b) => a - b);
    return years.length === 1
      ? `The ${years[0]} benchmark price needs an amount above $0, or remove the row.`
      : `${unpriced.length} benchmark prices (${years.join(', ')}) need an amount above $0, or remove them.`;
  }

  const dupCoverage = new Set<string>();
  for (const r of coverageRows) {
    const key = `${r.memberId}\x00${r.taxYear}`;
    if (dupCoverage.has(key)) {
      return `Two coverage rows cover the same person in ${r.taxYear}. Combine them into one row, or remove the duplicate.`;
    }
    dupCoverage.add(key);
  }

  const dupBenchmark = new Set<number>();
  for (const r of benchmarkRows) {
    if (dupBenchmark.has(r.taxYear)) {
      return `Two benchmark prices are entered for ${r.taxYear}. Keep one, or remove the duplicate.`;
    }
    dupBenchmark.add(r.taxYear);
  }

  return null;
}

/** The canonical stored-map → editor-rows transform, shared by the draft seed and the save comparison; imported scenarios can hold null entries, which read as "nothing stated". */
export function toDraftHealthRows(
  stored: HealthCoverageMonthsOverride | undefined,
): DraftHealthCoverageRow[] {
  return storedCoverageMonthEntries(stored).map(({ memberId, taxYear, months }) => ({
    memberId,
    taxYear,
    partBMonths: months.partBMonths ?? null,
    partDMonths: months.partDMonths ?? null,
    marketplaceMonths: months.marketplaceMonths ?? null,
  }));
}

/** Stored benchmark overrides as editor rows by tax year; an imported payload may be malformed, so it is read through the shared enumerator. */
export function toDraftBenchmarkRows(
  stored: ReadonlyArray<{ taxYear: number; annualSlcspDollars: number }> | undefined,
): DraftBenchmarkRow[] {
  return storedAcaBenchmarkOverrides(stored).map((o) => ({
    taxYear: o.taxYear,
    annualSlcspDollars: o.annualSlcspDollars,
  }));
}
