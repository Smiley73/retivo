/**
 * Shared constants and helpers for the withdrawal strategy subsection.
 *
 * Extracted from ScenarioWithdrawalStrategyCards to keep each file under
 * the 400-line cap. Imported by:
 *   - ScenarioWithdrawalStrategyCards.tsx  (card component)
 *   - scenario-withdrawal-strategy-editor.tsx  (editor + draft hook)
 */
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
// `DraftMagiCapWindow` lives in the shared lib layer (definition + TSDoc there);
// imported for this module's signatures and re-exported below for callers.
import type { DraftMagiCapWindow } from '../lib/magi-cap-persistence';

export type StrategyKind = WithdrawalStrategy['kind'];
export type { DraftMagiCapWindow };

export const STRATEGY_OPTIONS: SegmentedOption<StrategyKind>[] = [
  {
    value: 'taxEfficient',
    // Picker and card/report summary both use 'Tax-efficient' (STRATEGY_LABELS
    // below matches).
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
  // Matches the picker option (STRATEGY_OPTIONS above) — both say
  // 'Tax-efficient'.
  taxEfficient: 'Tax-efficient',
  proportional: 'Proportional',
  rothFirst: 'Roth first',
  customOrder: 'Custom order',
};

/**
 * Plain-English description of each withdrawal strategy, shown below the
 * picker on the Strategy tab so the user understands what they selected.
 * Stays consistent with the short `STRATEGY_OPTIONS[].title` tooltips — keep
 * the account-ordering claims in sync if either changes.
 */
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

/** Default cost-basis fraction (50%) used by the engine when not set. */
const DEFAULT_COST_BASIS_FRACTION = 0.5;
/** UI representation of the cost-basis fraction default (50%). */
export const DEFAULT_COST_BASIS_PCT = DEFAULT_COST_BASIS_FRACTION * 100;

/** Default MAGI-cap window end-age (Medicare-eligible). */
const DEFAULT_MAGI_CAP_END_AGE = 65;

/** `DraftMagiCapWindow` is re-exported above (definition lives in the lib layer). */

/**
 * Seed window for "toggle the cap on" — a single default window
 * reproducing today's behavior: start at retirement, end at the primary's
 * age 65 (Medicare), no ceiling entered yet (null draft), Minimize mode, IRMAA
 * line, no target Roth. Never an "enabled but empty" ladder.
 */
export function defaultMagiCapWindow(): DraftMagiCapWindow {
  return {
    start: { kind: 'retirementStart' },
    end: { kind: 'age', memberId: 'primary', years: DEFAULT_MAGI_CAP_END_AGE, months: 0 },
    magiCeilingAnnualDollars: null,
    capMode: 'minimize',
    capMagiLine: 'irmaa',
  };
}

/** Widen a persisted / inherited `MagiCapOverride` into the draft-window list
 *  (ceilings are real numbers from storage, so they are non-null). */
export function toDraftMagiCapWindows(
  cap: import('../db/types').MagiCapOverride | undefined,
): DraftMagiCapWindow[] {
  if (cap === undefined) return [];
  return cap.windows.map((w) => ({ ...w }));
}

/**
 * Default share of EMERGENCY HSA withdrawals assumed to be qualified
 * (tax-free) medical spending when `hsaQualifiedMedicalExpensePct` is unset:
 * 100% — modeled medical-qualified withdrawals are always 100% qualified, the
 * engine's own default (see "The HSA passes" in docs/math-withdrawals.md).
 */
export const DEFAULT_HSA_QUALIFIED_PCT = 100;

/**
 * Account types that carry an early-withdrawal additional tax before age 59½
 * (the 10% §72(t) penalty). These may be marked exempt in the Tax
 * assumptions section. `RETIREMENT_ROTH_IRA` is included: a pre-59½
 * Roth IRA withdrawal above the owner's cumulative §408A contribution basis is
 * an **earnings-tranche** draw that now incurs the 10% penalty, so a user must
 * be able to mark it exempt (qualifying §72(t)/disability exception). The Roth
 * IRA **contribution** tranche stays penalty-free regardless of the toggle, and
 * the exempt toggle waives only the earnings-tranche 10% penalty — the
 * ordinary-income tax on the earnings still applies (see
 * `early-withdrawal-penalty.ts`). Similarly, `RETIREMENT_ROTH_401K`,
 * `RETIREMENT_ROTH_403B`, and `RETIREMENT_ROTH_TSP` carry 10% §72(t) on their
 * pre-59½ earnings tranche. `RETIREMENT_ROTH_457B` is deliberately
 * excluded — governmental §72(t) exemption (no penalty, no toggle needed).
 * 457(b), brokerage, savings, and HSA carry no 59½ penalty or a different rule,
 * so an exempt toggle on them would be meaningless. See "Early-withdrawal penalties"
 * in docs/math-taxes.md.
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

/** True when an account is subject to the early-withdrawal additional tax and
 *  can therefore be marked penalty-exempt in the Tax assumptions section. */
export function isPenaltyEligibleAccount(a: Aggregate<AccountPayload>): boolean {
  return EARLY_WITHDRAWAL_PENALTY_ELIGIBLE_TYPES.has(a.payload.type);
}

/**
 * True when an account can receive Fill-mode Roth conversions. Narrowed
 * to `RETIREMENT_ROTH_IRA` only: employer-plan Roth accounts
 * (`RETIREMENT_ROTH_401K` / `403B` / `457B` / `TSP`) hold designated-Roth
 * plan money that cannot accept a roll-in conversion from a pre-tax account via
 * the Fill-mode mechanism, which models an in-plan IRA conversion only. The
 * account must also be active. The single source of the picker's eligibility so
 * the UI list matches what the engine will accept.
 *
 * An INHERITED Roth IRA is excluded for the same reason the working-years
 * picker excludes it (`isWorkingYearsRothConversionTarget`) — a beneficiary
 * cannot roll into an inherited IRA (§408A(e)). The engine's Fill-mode target
 * lookup (`findTargetRothIndex`) refuses one and degrades to withdrawal-only
 * fill, so listing it here would offer a target that converts $0.
 */
export function isRothConversionTarget(a: Aggregate<AccountPayload>): boolean {
  if (a.payload.rmdInheritedAccount === true) return false;
  return a.payload.active && a.payload.type === 'RETIREMENT_ROTH_IRA';
}

/** Active Roth accounts eligible as a Fill-mode conversion target. */
export function rothConversionTargets(
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
): Aggregate<AccountPayload>[] {
  return accounts.filter(isRothConversionTarget);
}

export function formatMagiBootstrap(dollars: number): string {
  return `$${Math.round(dollars).toLocaleString()}`;
}

/** True when an account can sit in the drawdown order — active and not a
 *  Cash Balance Pension (CBP accounts are never orderable). The single
 *  source of the orderability predicate, reused by `seedTierState` and the
 *  inherited-order pruning in `buildNextCustomOrder`. */
function isOrderableAccount(a: Aggregate<AccountPayload>): boolean {
  return a.payload.active && a.payload.type !== 'RETIREMENT_CASH_BALANCE';
}

/** Set of account ids that may appear in the drawdown order. */
export function placeableAccountIds(
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
): Set<string> {
  return new Set(accounts.filter(isOrderableAccount).map((a) => a.id));
}

/** Prunes ids that are no longer placeable (stale or CBP-type) from a saved
 *  order while preserving tier structure. Shared by `seedTierState` (seeding
 *  the draft) and `buildNextCustomOrder` (normalising the inherited order
 *  before the "unchanged" comparison, so a CBP-only difference is not
 *  mistaken for a user edit). */
export function pruneCustomOrder(
  order: CustomDrawdownOrder,
  placeableIds: ReadonlySet<string>,
): { tiers: string[][]; excludedAccountIds: string[] } {
  const tiers = order.tiers.map((tier) => tier.filter((id) => placeableIds.has(id)));
  const excludedAccountIds = order.excludedAccountIds.filter((id) => placeableIds.has(id));
  return { tiers, excludedAccountIds };
}

/**
 * Seeds the initial customDrawdownOrder from existing config + active accounts.
 * HSAs default to Excluded; everything else to tier 0. Prunes stale IDs.
 *
 * Cash Balance Pension accounts (`RETIREMENT_CASH_BALANCE`) are never
 * orderable — they pay out as monthly income (annuity) or roll into a
 * target account (lump sum), so the engine never draws them down. They are
 * skipped when seeding tier 0 / Excluded (via `isOrderableAccount`), and an
 * active CBP id surviving in a previously-saved order is pruned by
 * `pruneCustomOrder`. They render in a read-only info section instead — see
 * `buildCbpInfoRows`.
 */
export function seedTierState(
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
  existing: CustomDrawdownOrder | undefined,
): { tiers: string[][]; excludedAccountIds: string[] } {
  if (!existing) {
    // Default — HSAs to Excluded, everything else to tier 0. CBP skipped.
    const excluded: string[] = [];
    const tier0: string[] = [];
    for (const a of accounts) {
      if (!isOrderableAccount(a)) continue;
      if (a.payload.type === 'HSA') excluded.push(a.id);
      else tier0.push(a.id);
    }
    return { tiers: [tier0], excludedAccountIds: excluded };
  }
  // Prune IDs no longer placeable (stale or CBP-type); preserve structure.
  return pruneCustomOrder(existing, placeableAccountIds(accounts));
}

/**
 * Read-only descriptor for one Cash Balance Pension account shown in the
 * tier editor's "not drawn down" info section. The resolved election only
 * chooses the label; orderability is decided by account TYPE alone.
 *
 * - `annuity` — paid as monthly income.
 * - `lumpSum` — rolls into `targetName` at retirement.
 * - `unconfigured` — no linked pension stream at all; the row carries an
 *   "Elect a payout" deep-link (via `incomeAddPath`) to add one.
 * - `conflict` — more than one pension stream links to this CBP, so the
 *   election can't be resolved (same state as
 *   `validateCbpResolution().annuityDuplicateStream`). The remediation is to
 *   REVIEW/remove the duplicate streams on the Income page — never to add
 *   another, which would deepen the duplication. Mirrors the duplicate row in
 *   `CbpRemediationBanner`.
 */
export interface CbpInfoRow {
  accountId: string;
  name: string;
  kind: 'annuity' | 'lumpSum' | 'unconfigured' | 'conflict';
  targetName?: string;
}

/**
 * Builds the CBP info-row descriptors for the active scenario, one per
 * Cash Balance Pension account in the household. Resolves the payout
 * election via the shared `resolveLinkedCbpIncomeStreams` — engines
 * and UI read the same resolution — and maps it to a layman-readable
 * treatment label. Accounts without a resolved election render as
 * `unconfigured`.
 */
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

// ---------------------------------------------------------------------------
// Health-coverage editor draft rows
// ---------------------------------------------------------------------------
//
// These live here, not in the React draft hook, because the PURE save helpers
// (`scenario-withdrawal-strategy-save-helpers.ts`) and the presentational editor
// (`scenario-tax-assumptions-sections.tsx`) both consume them; a pure module
// must not type-depend on a hook.

/**
 * One editable row of the health-coverage months table: one household
 * member's Part B / Part D / Marketplace months for ONE tax year. `null` means
 * "leave it to the projection's own timing" for that field (the row stores only
 * the counts the user actually stated), matching the sparse-optional shape on
 * `ScenarioOverrides.healthCoverageMonths`.
 */
export interface DraftHealthCoverageRow {
  memberId: string;
  taxYear: number;
  partBMonths: number | null;
  partDMonths: number | null;
  marketplaceMonths: number | null;
}

/** One editable row of the annual benchmark-premium override table. */
export interface DraftBenchmarkRow {
  taxYear: number;
  annualSlcspDollars: number;
}

/**
 * Why Save is blocked, or `null` when the editor is ready to save.
 *
 * The save path already DROPS a row that states nothing (a coverage row whose
 * three month fields are all "Automatic", or a benchmark row priced at $0), so
 * no invalid value can reach the aggregate. But dropping it silently means a
 * user who adds a row, leaves it blank and saves watches their row disappear
 * with no explanation. Blocking Save with a reason is the honest behaviour:
 * state a month, price the year, or remove the row.
 */
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

/**
 * THE canonical stored-map → editor-rows transform. One
 * implementation, used by the draft hook to seed the editor AND by the save
 * comparison to normalize the stored side, so the two can never disagree about
 * what an unchanged map looks like. Ordered by year then member id, which also
 * makes the save comparison order-insensitive.
 *
 * The map itself is walked by the shared `storedCoverageMonthEntries`
 * reader, which shape-checks every level. The map can arrive from an IMPORTED
 * scenario aggregate (envelope-validated only), so a `null` member or year entry
 * is reachable and must read as "nothing stated" rather than throwing out of the
 * modal seed.
 */
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

/**
 * The stored benchmark overrides as editor rows, ordered by tax year.
 *
 * Read through the shared `storedAcaBenchmarkOverrides` enumerator. The
 * array arrives from an envelope-only-validated import, so a non-array payload
 * used to throw out of the spread and blank the whole modal, and a malformed row
 * seeded the editor with a bogus year or a negative price.
 */
export function toDraftBenchmarkRows(
  stored: ReadonlyArray<{ taxYear: number; annualSlcspDollars: number }> | undefined,
): DraftBenchmarkRow[] {
  return storedAcaBenchmarkOverrides(stored).map((o) => ({
    taxYear: o.taxYear,
    annualSlcspDollars: o.annualSlcspDollars,
  }));
}
