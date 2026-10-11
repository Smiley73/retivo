/**
 * Pure helpers that build the override-key fragments for the withdrawal
 * strategy modal's Save path.
 *
 * Each helper returns either the override key + value (to persist) OR an
 * empty object (to omit the key — so it's inherited / unaffected). The
 * modal's `onSave` spreads each fragment into a single `nextOverrides`
 * object and dispatches one `saveScenario` call. Splitting the four-way
 * conditional out of `onSave` keeps that orchestrator under the 40-line
 * function cap.
 */
import type {
  AccountPayload,
  Aggregate,
  CustomDrawdownOrder,
  HealthCoverageMonthsOverride,
  HouseholdMemberPayload,
  MemberCoverageMonths,
  ScenarioPayload,
} from '../db/types';
import type { AcaFplRegion } from '../lib/aca-ptc';
import {
  isDangerousDictionaryKey,
  storedAcaBenchmarkOverrides,
} from '../lib/tax-integration-helpers';
import { toDraftHealthRows } from './scenario-withdrawal-strategy-shared';
import type {
  DraftBenchmarkRow,
  DraftHealthCoverageRow,
  StrategyKind,
} from './scenario-withdrawal-strategy-shared';
// `buildNextMagiCap` lives in the lib/ layer (shared with the Roth conversion
// comparison page's Apply builder) so the rule has one home and that page
// doesn't reach up into pages/ for it. Re-exported here for this module's
// existing callers.
export { buildNextMagiCap } from '../lib/magi-cap-persistence';
import {
  DEFAULT_COST_BASIS_PCT,
  DEFAULT_HSA_QUALIFIED_PCT,
  placeableAccountIds,
  pruneCustomOrder,
} from './scenario-withdrawal-strategy-shared';

type ScenarioOverrides = ScenarioPayload['overrides'];

/** Strategy-kind override — kept when the user changed kind OR the scenario
 *  already had a local override (don't silently drop a pre-existing override
 *  just because the user didn't touch the picker). */
export function buildNextStrategy(args: {
  strategyKind: StrategyKind;
  effective: ScenarioOverrides;
  localOverrides: ScenarioOverrides;
}): { withdrawalStrategy: { kind: StrategyKind } } | Record<string, never> {
  const { strategyKind, effective, localOverrides } = args;
  const changed = strategyKind !== (effective.withdrawalStrategy?.kind ?? 'taxEfficient');
  const hadLocal = localOverrides.withdrawalStrategy !== undefined;
  return changed || hadLocal
    ? { withdrawalStrategy: { kind: strategyKind } }
    : {};
}

/** Cost-basis fraction override — same persistence rule as
 *  `buildNextStrategy` but value is converted from the UI percent
 *  (0–100, slider) to the storage fraction (0–1). */
export function buildNextCostBasis(args: {
  costBasisPct: number;
  effective: ScenarioOverrides;
  localOverrides: ScenarioOverrides;
}):
  | { assumedCostBasisFractionOfTaxableWithdrawal: number }
  | Record<string, never> {
  const { costBasisPct, effective, localOverrides } = args;
  const effectivePct =
    effective.assumedCostBasisFractionOfTaxableWithdrawal !== undefined
      ? effective.assumedCostBasisFractionOfTaxableWithdrawal * 100
      : DEFAULT_COST_BASIS_PCT;
  const changed = Math.abs(costBasisPct - effectivePct) > 1e-6;
  const hadLocal =
    localOverrides.assumedCostBasisFractionOfTaxableWithdrawal !== undefined;
  return changed || hadLocal
    ? { assumedCostBasisFractionOfTaxableWithdrawal: costBasisPct / 100 }
    : {};
}

/**
 * Tax-assumptions override fragment (emergency-HSA qualified % + penalty-exempt
 * account ids). The percentage governs only EMERGENCY HSA withdrawals — modeled
 * medical-qualified withdrawals are always 100% qualified. Same persistence rule
 * as `buildNextStrategy`: persist a key when the draft differs from the
 * inherited/effective value OR the scenario already had a local override (so an
 * unrelated save never silently drops a pre-existing one). Each key is decided
 * independently — the HSA percentage and the exempt list are separate fields on
 * `ScenarioOverrides`.
 *
 * Penalty-exempt prune-on-save: an account that gets hard-deleted leaves its
 * id orphaned in the exempt list (the engine ignores unmatched ids, but the
 * cruft rides along on every re-save). Saving drops any id that no longer
 * points to a live account. The comparison prunes BOTH the draft and the
 * effective list so a purely-inherited orphan doesn't spuriously materialise a
 * child override — only a LOCAL orphan (or a real user edit) writes the key.
 */
export function buildNextTaxAssumptions(args: {
  hsaQualifiedPct: number;
  penaltyExemptIds: string[];
  effective: ScenarioOverrides;
  localOverrides: ScenarioOverrides;
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
}): {
  hsaQualifiedMedicalExpensePct?: number;
  earlyWithdrawalPenaltyExemptAccountIds?: string[];
} {
  const { hsaQualifiedPct, penaltyExemptIds, effective, localOverrides, accounts } = args;
  const out: {
    hsaQualifiedMedicalExpensePct?: number;
    earlyWithdrawalPenaltyExemptAccountIds?: string[];
  } = {};

  const effectiveHsa =
    effective.hsaQualifiedMedicalExpensePct ?? DEFAULT_HSA_QUALIFIED_PCT;
  const hsaChanged = hsaQualifiedPct !== effectiveHsa;
  const hsaHadLocal = localOverrides.hsaQualifiedMedicalExpensePct !== undefined;
  if (hsaChanged || hsaHadLocal) {
    out.hsaQualifiedMedicalExpensePct = hsaQualifiedPct;
  }

  // Prune ids whose account no longer exists (hard-deleted). Inactive but
  // still-present accounts are kept — they are restorable.
  const existingIds = new Set(accounts.map((a) => a.id));
  const prunedDraft = penaltyExemptIds.filter((id) => existingIds.has(id));
  const prunedEffective = (
    effective.earlyWithdrawalPenaltyExemptAccountIds ?? []
  ).filter((id) => existingIds.has(id));
  const exemptChanged = !sameStringSet(prunedDraft, prunedEffective);
  const exemptHadLocal =
    localOverrides.earlyWithdrawalPenaltyExemptAccountIds !== undefined;
  if (exemptChanged || exemptHadLocal) {
    out.earlyWithdrawalPenaltyExemptAccountIds = [...prunedDraft];
  }

  return out;
}

/**
 * ACA Marketplace opt-out fragment — the member ids treated as NOT on the
 * Marketplace. Same persistence rule as `buildNextTaxAssumptions`: persist the
 * key when the pruned draft differs from the inherited/effective value OR the
 * scenario already had a local override (so an unrelated save never silently
 * drops a pre-existing one). Sparse: omitted (key absent) when neither applies.
 *
 * Prune-on-save: a member that gets hard-deleted leaves its id orphaned in
 * the opt-out list. Saving drops any id that no longer points to a live member
 * (mirrors the penalty-exempt account prune). The comparison prunes BOTH the
 * draft and the effective list so a purely-inherited orphan doesn't spuriously
 * materialise a child override — only a LOCAL orphan (or a real user edit) writes
 * the key.
 */
export function buildNextAcaCoverage(args: {
  acaOptOutMemberIds: string[];
  effective: ScenarioOverrides;
  localOverrides: ScenarioOverrides;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
}): { acaMarketplaceOptOutMemberIds?: readonly string[] } {
  const { acaOptOutMemberIds, effective, localOverrides, members } = args;
  const liveIds = new Set(members.map((m) => m.id));
  const prunedDraft = acaOptOutMemberIds.filter((id) => liveIds.has(id));
  const prunedEffective = (effective.acaMarketplaceOptOutMemberIds ?? []).filter((id) =>
    liveIds.has(id),
  );
  const changed = !sameStringSet(prunedDraft, prunedEffective);
  const hadLocal = localOverrides.acaMarketplaceOptOutMemberIds !== undefined;
  if (changed || hadLocal) {
    return { acaMarketplaceOptOutMemberIds: [...prunedDraft] };
  }
  return {};
}

/**
 * The monthly health facts + FPL region + annual benchmark override
 * fragment. Same persistence rule as the sibling helpers:
 * persist a key when the pruned draft differs from the inherited/effective value
 * OR the scenario already had a local override, so an unrelated save neither
 * invents a stored default nor silently drops a pre-existing one. Each key is
 * decided independently.
 *
 * Pruning (mirrors the opt-out prune):
 *  - a coverage row whose member no longer exists is dropped;
 *  - a coverage row that states NO month at all is dropped (an empty row carries
 *    no user intent and would otherwise persist as `{}`);
 *  - each month is clamped to a whole number in the statutory 0..12 range;
 *  - a benchmark row with a non-finite / negative amount or a non-integer year is
 *    dropped, later rows win for a duplicated year, and the result is sorted so
 *    the stored order is stable.
 * The comparison prunes BOTH sides so a purely-inherited orphan does not
 * spuriously materialise a child override.
 */
export function buildNextHealthCoverage(args: {
  fplRegion: AcaFplRegion;
  coverageRows: readonly DraftHealthCoverageRow[];
  benchmarkRows: readonly DraftBenchmarkRow[];
  effective: ScenarioOverrides;
  localOverrides: ScenarioOverrides;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
}): {
  acaFplRegion?: AcaFplRegion;
  healthCoverageMonths?: HealthCoverageMonthsOverride;
  acaPtcBenchmark?: { taxYear: number; annualSlcspDollars: number }[];
} {
  const { fplRegion, coverageRows, benchmarkRows, effective, localOverrides, members } = args;
  const out: {
    acaFplRegion?: AcaFplRegion;
    healthCoverageMonths?: HealthCoverageMonthsOverride;
    acaPtcBenchmark?: { taxYear: number; annualSlcspDollars: number }[];
  } = {};

  const effectiveRegion = effective.acaFplRegion ?? 'contiguous';
  if (fplRegion !== effectiveRegion || localOverrides.acaFplRegion !== undefined) {
    out.acaFplRegion = fplRegion;
  }

  const liveIds = new Set(members.map((m) => m.id));
  const draftMonths = buildCoverageMonths(coverageRows, liveIds);
  const effectiveMonths = buildCoverageMonths(
    toDraftHealthRows(effective.healthCoverageMonths),
    liveIds,
  );
  // Compare CANONICALIZED maps. `JSON.stringify` is key-insertion-order
  // sensitive: the draft rows arrive sorted by (taxYear, memberId) while the
  // stored map keeps its own insertion order, so a two-member household whose
  // orders differ compared unequal and a region-only save materialised a
  // `healthCoverageMonths` child override the "does not materialise" contract
  // forbids.
  const monthsChanged =
    canonicalCoverageJson(draftMonths) !== canonicalCoverageJson(effectiveMonths);
  if (monthsChanged || localOverrides.healthCoverageMonths !== undefined) {
    out.healthCoverageMonths = { perMember: draftMonths };
  }

  const draftBenchmark = pruneBenchmarkRows(benchmarkRows);
  const effectiveBenchmark = pruneBenchmarkRows(effective.acaPtcBenchmark);
  const benchmarkChanged =
    JSON.stringify(draftBenchmark) !== JSON.stringify(effectiveBenchmark);
  if (benchmarkChanged || localOverrides.acaPtcBenchmark !== undefined) {
    out.acaPtcBenchmark = draftBenchmark;
  }

  return out;
}

/** Clamp a stated month count to a whole number of months in [0, 12]; `null` /
 *  non-finite → absent (the projection's own timing governs that field). */
function normalizeMonths(value: number | null): number | undefined {
  if (value === null || !Number.isFinite(value)) return undefined;
  return Math.min(12, Math.max(0, Math.floor(value)));
}

/** Build the stored `perMember` map from editor rows, dropping dead members and
 *  rows that state no month at all.
 *
 *  A duplicated (memberId, taxYear) pair is MERGED field-wise (a later
 *  row's stated count wins for that FIELD only) rather than replacing the whole
 *  earlier row. Both Add buttons seed the same default key, so adding and
 *  filling two rows for the same member/year used to discard the first
 *  silently. Merging keeps every value the user actually typed.
 *
 *  CWE-1321 — both dictionaries are built with a NULL PROTOTYPE and the
 *  member id is rejected outright when it is a dangerous key. Household member
 *  ids come from an imported workspace bundle, whose validation rejects
 *  `"__proto__"` as a KEY but permits it as an aggregate-id VALUE. With a plain
 *  `{}` accumulator, `perMember["__proto__"]` resolved to `Object.prototype`,
 *  so saving that member's coverage row wrote the tax year onto
 *  `Object.prototype` (poisoning every object in the page) and stored no own
 *  entry for the member. A null-prototype dictionary makes the write an
 *  ordinary own property; dropping the id as well keeps a poisoned key out of
 *  the persisted map entirely. */
function buildCoverageMonths(
  rows: readonly DraftHealthCoverageRow[],
  liveIds: ReadonlySet<string>,
): Record<string, Record<number, MemberCoverageMonths>> {
  const perMember: Record<string, Record<number, MemberCoverageMonths>> = Object.create(
    null,
  ) as Record<string, Record<number, MemberCoverageMonths>>;
  for (const row of rows) {
    if (isDangerousDictionaryKey(row.memberId)) continue;
    if (!liveIds.has(row.memberId) || !Number.isInteger(row.taxYear)) continue;
    const partBMonths = normalizeMonths(row.partBMonths);
    const partDMonths = normalizeMonths(row.partDMonths);
    const marketplaceMonths = normalizeMonths(row.marketplaceMonths);
    if (partBMonths === undefined && partDMonths === undefined && marketplaceMonths === undefined) {
      continue;
    }
    const byYear =
      perMember[row.memberId] ?? (Object.create(null) as Record<number, MemberCoverageMonths>);
    byYear[row.taxYear] = {
      ...byYear[row.taxYear],
      ...(partBMonths !== undefined ? { partBMonths } : {}),
      ...(partDMonths !== undefined ? { partDMonths } : {}),
      ...(marketplaceMonths !== undefined ? { marketplaceMonths } : {}),
    };
    perMember[row.memberId] = byYear;
  }
  return perMember;
}

/** An insertion-order-INDEPENDENT serialization of a coverage map, so
 *  two semantically identical maps always compare equal. */
function canonicalCoverageJson(
  perMember: Record<string, Record<number, MemberCoverageMonths>>,
): string {
  return JSON.stringify(
    Object.keys(perMember)
      .sort()
      .map((memberId) => [
        memberId,
        Object.keys(perMember[memberId])
          .map(Number)
          .sort((a, b) => a - b)
          .map((year) => {
            const m = perMember[memberId][year];
            return [year, m.partBMonths ?? null, m.partDMonths ?? null, m.marketplaceMonths ?? null];
          }),
      ]),
  );
}

/**
 * Drop unusable benchmark rows, dedupe by tax year (later wins), sort ascending.
 *
 * A NON-POSITIVE price is dropped, not stored. "Add a benchmark price"
 * seeds `$0`, and every engine treats a stored override as a VERBATIM benchmark
 * (bypassing the rough age-priced fallback entirely), so an added-but-unfilled
 * row would price the household's benchmark plan at $0, floor its premium tax
 * credit to $0, and raise the funded withdrawal — a silent projection change
 * from a row the user never filled in. A household that genuinely pays nothing
 * for its benchmark plan has no Marketplace coverage to model.
 *
 * Row validity itself comes from the ONE shared
 * `storedAcaBenchmarkOverrides` reader every engine, report and UI surface uses,
 * so the editor cannot accept a row the engines would refuse (and the STORED
 * side of the change comparison is shape-checked before it is compared, since it
 * arrives from an envelope-only-validated import).
 */
function pruneBenchmarkRows(
  rows: unknown,
): { taxYear: number; annualSlcspDollars: number }[] {
  const byYear = new Map<number, number>();
  for (const row of storedAcaBenchmarkOverrides(rows)) {
    byYear.set(row.taxYear, row.annualSlcspDollars);
  }
  return [...byYear.entries()]
    .map(([taxYear, annualSlcspDollars]) => ({ taxYear, annualSlcspDollars }))
    .sort((a, b) => a.taxYear - b.taxYear);
}

/** Order-insensitive equality for two id lists (the exempt set has no
 *  meaningful order). */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const id of b) if (!set.has(id)) return false;
  return true;
}

/** MAGI-bootstrap override — the single "pre-retirement income" UI input
 *  writes BOTH lookback fields (year 0 = MAGI(ret−2), year 1 = MAGI(ret−1)) to
 *  the same value. Engine-
 *  default toggle ON deletes both keys (parent chain / engine default takes
 *  over). OFF persists the whole dollar amount into both fields. */
export function buildNextMagiBootstrap(args: {
  useEngineDefault: boolean;
  magiDraft: number;
}):
  | { magiBootstrapLookbackMinus2: number; magiBootstrapLookbackMinus1: number }
  | Record<string, never> {
  if (args.useEngineDefault) return {};
  const value = Math.max(0, Math.round(args.magiDraft));
  return {
    magiBootstrapLookbackMinus2: value,
    magiBootstrapLookbackMinus1: value,
  };
}

function sameCustomOrder(
  a: CustomDrawdownOrder | undefined,
  b: { tiers: string[][]; excludedAccountIds: string[] },
): boolean {
  if (a === undefined) return false;
  if (a.tiers.length !== b.tiers.length) return false;
  if (a.excludedAccountIds.length !== b.excludedAccountIds.length) return false;
  for (let i = 0; i < a.tiers.length; i++) {
    if (a.tiers[i].length !== b.tiers[i].length) return false;
    for (let j = 0; j < a.tiers[i].length; j++) {
      if (a.tiers[i][j] !== b.tiers[i][j]) return false;
    }
  }
  for (let i = 0; i < a.excludedAccountIds.length; i++) {
    if (a.excludedAccountIds[i] !== b.excludedAccountIds[i]) return false;
  }
  return true;
}

/** Custom-order override — persist only when `customOrder` is the active
 *  kind; explicit `undefined` when not, so stale layouts don't linger.
 *  When the tier layout is inherited (no local override) and the
 *  draft still deep-equals the inherited layout, omit the key entirely so
 *  saving an unrelated change doesn't freeze the inherited layout into
 *  the child override (same pattern as `buildNextStrategy` /
 *  `buildNextCostBasis`).
 *
 *  The draft tiers are already CBP-pruned by `seedTierState`, but the
 *  inherited `effective.customDrawdownOrder` can still carry a CBP id
 *  (legacy data, or a parent saved before CBP became non-orderable). So
 *  the comparison normalises the inherited order with the SAME prune
 *  predicate (`accounts` → placeable set) before comparing: a draft that
 *  differs from the inherited order ONLY by CBP pruning counts as
 *  unchanged, so the key is omitted and inheritance is preserved. */
export function buildNextCustomOrder(args: {
  strategyKind: StrategyKind;
  tiers: string[][];
  excludedAccountIds: string[];
  effective: ScenarioOverrides;
  localOverrides: ScenarioOverrides;
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
}):
  | { customDrawdownOrder: CustomDrawdownOrder }
  | { customDrawdownOrder?: undefined }
  | Record<string, never> {
  const { strategyKind, tiers, excludedAccountIds, effective, localOverrides, accounts } = args;
  if (strategyKind !== 'customOrder') {
    return { customDrawdownOrder: undefined };
  }
  const hadLocal = localOverrides.customDrawdownOrder !== undefined;
  // Normalise the inherited order with the same CBP/stale prune the draft
  // already went through (seedTierState) so a CBP-only difference is not
  // mistaken for a user edit.
  const inheritedPruned =
    effective.customDrawdownOrder === undefined
      ? undefined
      : pruneCustomOrder(effective.customDrawdownOrder, placeableAccountIds(accounts));
  if (!hadLocal && sameCustomOrder(inheritedPruned, { tiers, excludedAccountIds })) {
    return {};
  }
  return { customDrawdownOrder: { tiers, excludedAccountIds } };
}
