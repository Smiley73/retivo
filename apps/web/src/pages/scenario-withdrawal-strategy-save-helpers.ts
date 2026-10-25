/** Pure builders for the override-key fragments of the withdrawal-strategy modal's Save; an empty fragment omits the key so it is inherited. */
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
export { buildNextMagiCap } from '../lib/magi-cap-persistence';
import {
  DEFAULT_COST_BASIS_PCT,
  DEFAULT_HSA_QUALIFIED_PCT,
  placeableAccountIds,
  pruneCustomOrder,
} from './scenario-withdrawal-strategy-shared';

type ScenarioOverrides = ScenarioPayload['overrides'];

/** Kept when the user changed the kind or the scenario already had a local override, so an untouched picker doesn't drop it. */
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

/** Same persistence rule as buildNextStrategy; converts the UI percent (0–100) to the storage fraction (0–1). */
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
* Tax-assumptions fragment (emergency-HSA qualified % + penalty-exempt account ids); the percentage governs only emergency HSA withdrawals.
* Persists a key when the draft differs from the effective value or the scenario already had a local override.
* Ids of deleted accounts are pruned from both sides so an inherited orphan does not materialise a child override.
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

/** ACA Marketplace opt-out member ids: same persistence rule and both-sides prune of deleted members as buildNextTaxAssumptions. */
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
* Monthly health facts, FPL region and annual benchmark overrides; same persistence rule and both-sides prune as the sibling helpers.
* Dropped: rows for deleted members, coverage rows with no month, and benchmark rows with a bad amount or year; months clamp to 0..12; later benchmark rows win a duplicated year.
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
  // Compare canonicalized maps: JSON.stringify is insertion-order sensitive, so differing orders made a region-only save materialise a healthCoverageMonths override.
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

function normalizeMonths(value: number | null): number | undefined {
  if (value === null || !Number.isFinite(value)) return undefined;
  return Math.min(12, Math.max(0, Math.floor(value)));
}

// Builds the stored perMember map from editor rows; a duplicated (memberId, taxYear) pair merges field-wise (later stated counts win per field).
// CWE-1321: both dictionaries use a null prototype and a dangerous member id is dropped, because imported bundles can carry "__proto__" as an aggregate-id value
// that on a plain {} would write onto Object.prototype.
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

// Drops unusable benchmark rows, dedupes by tax year (later wins), sorts ascending. A non-positive price is dropped: "Add a benchmark price" seeds $0,
// and engines treat a stored override verbatim, so an unfilled row would zero the premium tax credit. Validity comes from the shared storedAcaBenchmarkOverrides reader.
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

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const id of b) if (!set.has(id)) return false;
  return true;
}

/** The single pre-retirement income input writes both lookback fields; the engine-default toggle ON deletes both keys. */
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

/**
* Persists only when customOrder is the active kind (explicit undefined otherwise, so stale layouts don't linger); omitted when the draft equals the inherited layout.
* The inherited order is normalised with the same CBP/stale prune as the draft, so a CBP-only difference counts as unchanged.
*/
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
  const inheritedPruned =
    effective.customDrawdownOrder === undefined
      ? undefined
      : pruneCustomOrder(effective.customDrawdownOrder, placeableAccountIds(accounts));
  if (!hadLocal && sameCustomOrder(inheritedPruned, { tiers, excludedAccountIds })) {
    return {};
  }
  return { customDrawdownOrder: { tiers, excludedAccountIds } };
}
