/**
 * Draft state hook for the withdrawal strategy configure editor.
 *
 * Extracted from scenario-withdrawal-strategy-editor.tsx to keep each file
 * under the 400-line cap. The hook body itself stays near the
 * shape cap by delegating to pure helpers: resolution + inherited-
 * name lookup, baseline JSON, draft-vs-baseline equality.
 */
import { useMemo, useState } from 'react';
import { resolveScenario, scenarioChain } from '../lib/scenario-resolution';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { isMagiCapDisabled } from '../db/types';
import type {
  AccountPayload,
  Aggregate,
  MagiCapOverride,
} from '../db/types';
import type { AcaFplRegion } from '../lib/aca-ptc';
import {
  DEFAULT_COST_BASIS_PCT,
  DEFAULT_HSA_QUALIFIED_PCT,
  defaultMagiCapWindow,
  toDraftMagiCapWindows,
  toDraftHealthRows,
  toDraftBenchmarkRows,
  seedTierState,
} from './scenario-withdrawal-strategy-shared';
import type {
  DraftBenchmarkRow,
  DraftHealthCoverageRow,
  DraftMagiCapWindow,
  StrategyKind,
} from './scenario-withdrawal-strategy-shared';

type ScenarioOverrides = ScenarioAggregate['payload']['overrides'];

/** Local MAGI-bootstrap presence: the single UI field is "set locally"
 *  when EITHER split lookback field is present in this scenario's own
 *  overrides. Returns the year-0 (minus2) value when set, else the year-1
 *  (minus1) value, else undefined. Drives the "Use engine default" toggle seed
 *  (local-presence only). */
function localMagiBootstrap(localOverrides: ScenarioOverrides): number | undefined {
  return (
    localOverrides.magiBootstrapLookbackMinus2 ??
    localOverrides.magiBootstrapLookbackMinus1
  );
}

/** Effective MAGI-bootstrap value (parent-chain resolved): year-0
 *  (minus2) value when set, else year-1 (minus1). The two fields are written
 *  together by the UI, so they normally agree; the fallback keeps a migrated
 *  single-value scenario showing its value. */
function effectiveMagiBootstrap(effective: ScenarioOverrides): number | undefined {
  return effective.magiBootstrapLookbackMinus2 ?? effective.magiBootstrapLookbackMinus1;
}

/** Pure: resolve the parent-chain effective overrides for the scenario.
 *  Falls back to local overrides if resolution throws (kept consistent
 *  with the previous inline behavior). */
function resolveEffectiveOverrides(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
  localOverrides: ScenarioOverrides,
): ScenarioOverrides {
  if (!scenario.payload.parentScenarioId) return localOverrides;
  try {
    return resolveScenario(scenario.id, scenarios);
  } catch (error) {
    console.warn('[withdrawal-strategy] resolveScenario failed', {
      scenarioId: scenario.id,
      error,
    });
    return localOverrides;
  }
}

/** Pure: the real MAGI cap resolved from this scenario's parent chain,
 *  with the explicit-disable sentinel coerced to undefined. Drives the
 *  save matrix's "does an ancestor impose a cap?" decision and the
 *  inherited-cap seed values when the child has no real local cap.
 *  Returns undefined for the base scenario or on a resolution failure. */
function resolveParentCap(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
): MagiCapOverride | undefined {
  if (!scenario.payload.parentScenarioId) return undefined;
  try {
    const parent = resolveScenario(scenario.payload.parentScenarioId, scenarios);
    const cap = parent.magiCap;
    return isMagiCapDisabled(cap) ? undefined : cap;
  } catch (error) {
    console.warn('[withdrawal-strategy] resolveScenario (parentCap) failed', {
      scenarioId: scenario.id,
      error,
    });
    return undefined;
  }
}

/** Pure: nearest ancestor that actually sets a real `magiCap`, or null when
 *  the local scenario has its own override (real cap or explicit-disable
 *  sentinel) or no ancestor sets one. Drives the "Inherited from <name>"
 *  override-hint copy in MagiCapSection. Driven by `parentCap` (the resolved
 *  real cap) so an inherited cap that the child has not yet touched is
 *  detected, regardless of the local sentinel state. */
function resolveMagiCapInheritedName(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
  localOverrides: ScenarioOverrides,
  parentCap: MagiCapOverride | undefined,
): string | null {
  if (localOverrides.magiCap !== undefined) return null;
  if (parentCap === undefined) return null;
  try {
    const chain = scenarioChain(scenario.id, scenarios);
    // Skip the current scenario (index 0) — start from its parent. Find the
    // nearest ancestor whose override is a real cap (not the disable sentinel).
    for (let i = 1; i < chain.length; i += 1) {
      const cap = chain[i].payload.overrides.magiCap;
      if (cap !== undefined && !isMagiCapDisabled(cap)) {
        return chain[i].payload.name;
      }
    }
  } catch (error) {
    console.warn('[withdrawal-strategy] scenarioChain failed', {
      scenarioId: scenario.id,
      error,
    });
  }
  return null;
}

/** Pure: baseline snapshot of every dirty-tracked field. JSON-serialised
 *  so a single string-equality check in the hook decides `isDirty`. */
function buildBaselineSnapshot(args: {
  effective: ScenarioOverrides;
  localOverrides: ScenarioOverrides;
  effectiveCap: MagiCapOverride | undefined;
  parentCap: MagiCapOverride | undefined;
  initTiers: string[][];
  initExcluded: string[];
}): string {
  const { effective, localOverrides, effectiveCap, parentCap, initTiers, initExcluded } = args;
  // Seed the field values from the same source as `useMagiCap` so a no-edit
  // session stays non-dirty. The toggle reflects the resolved real cap
  // (`effectiveCap`, sentinel coerced away); the dollar/member/age fields
  // fall back to the inherited parent cap so an explicitly-disabled child
  // still shows sensible numbers when the user re-enables the toggle.
  const seedCap = effectiveCap ?? parentCap;
  return JSON.stringify({
    strategyKind: effective.withdrawalStrategy?.kind ?? 'taxEfficient',
    costBasisPct:
      effective.assumedCostBasisFractionOfTaxableWithdrawal !== undefined
        ? effective.assumedCostBasisFractionOfTaxableWithdrawal * 100
        : DEFAULT_COST_BASIS_PCT,
    useEngineDefault: localMagiBootstrap(localOverrides) === undefined,
    magiDraft: effectiveMagiBootstrap(effective) ?? 0,
    // Baseline uses raw saved tiers (pre-prune) so pruning appears
    // as dirty; fall back to inherited / default tier state.
    tiers: localOverrides.customDrawdownOrder?.tiers ?? initTiers,
    excludedAccountIds:
      localOverrides.customDrawdownOrder?.excludedAccountIds ?? initExcluded,
    // Baseline mirrors the seeding so a no-edit session leaves
    // `isDirty` false, matching the displayed values. The
    // whole window ladder is the dirty-tracked unit.
    magiCapEnabled: effectiveCap !== undefined,
    magiCapWindows: toDraftMagiCapWindows(seedCap),
  });
}

/** Stable-ordered copy of an id list so dirty comparison ignores order. */
function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

export interface DraftState {
  strategyKind: StrategyKind;
  costBasisPct: number;
  useEngineDefault: boolean;
  magiDraft: number;
  // Custom order — only used when strategyKind === 'customOrder'.
  tiers: string[][];
  excludedAccountIds: string[];
  // MAGI-cap — orthogonal overlay; the ladder of
  // non-overlapping windows. `magiCapEnabled` is the toggle; an enabled
  // ladder always carries ≥ 1 window, each with its own
  // start/end/ceiling/mode/line/target Roth. A draft ceiling may be `null`
  // until entered (save blocked).
  magiCapEnabled: boolean;
  magiCapWindows: DraftMagiCapWindow[];
}

interface ResolutionContext {
  localOverrides: ScenarioOverrides;
  effective: ScenarioOverrides;
  /** Resolved real cap for this scenario (parent chain), sentinel coerced
   *  to undefined. Seeds the toggle's enabled state. */
  effectiveCap: MagiCapOverride | undefined;
  /** Resolved real cap from the PARENT chain only (excludes this scenario's
   *  own override), sentinel coerced to undefined. Drives the save matrix +
   *  seeds field values when the child has no real local cap. */
  parentCap: MagiCapOverride | undefined;
  magiCapInheritedFromName: string | null;
  initTiers: string[][];
  initExcluded: string[];
}

/** Sub-hook: resolves effective overrides + inherited cap name +
 *  initial tier seed. Every `useMemo` is empty-dep (frozen at mount). */
function useEffectiveResolution(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
): ResolutionContext {
  const localOverrides = scenario.payload.overrides;
  const effective = useMemo(
    () => resolveEffectiveOverrides(scenario, scenarios, localOverrides),
    [], // frozen at mount
  );
  // Coerce the explicit-disable sentinel to undefined: a disabled child
  // resolves to "no cap" for display + dirty tracking.
  const effectiveCap = useMemo<MagiCapOverride | undefined>(
    () => (isMagiCapDisabled(effective.magiCap) ? undefined : effective.magiCap),
    [], // frozen at mount
  );
  const parentCap = useMemo<MagiCapOverride | undefined>(
    () => resolveParentCap(scenario, scenarios),
    [], // frozen at mount
  );
  const magiCapInheritedFromName = useMemo<string | null>(
    () => resolveMagiCapInheritedName(scenario, scenarios, localOverrides, parentCap),
    [], // frozen at mount
  );
  // Seed from effective `customDrawdownOrder` (parent-chain resolved)
  // so inherited layouts are honoured; fall back to local.
  const initTierState = useMemo(
    () => seedTierState(accounts, effective.customDrawdownOrder ?? localOverrides.customDrawdownOrder),
    [], // frozen at mount
  );
  return {
    localOverrides,
    effective,
    effectiveCap,
    parentCap,
    magiCapInheritedFromName,
    initTiers: initTierState.tiers,
    initExcluded: initTierState.excludedAccountIds,
  };
}

interface DraftStateBag {
  state: DraftState;
  setStrategyKindRaw: (v: StrategyKind) => void;
  setCostBasisPct: (v: number) => void;
  setUseEngineDefault: (v: boolean) => void;
  setMagiDraft: (v: number) => void;
  setTiers: (v: string[][]) => void;
  setExcluded: (v: string[]) => void;
  setMagiCapEnabled: (v: boolean) => void;
  setMagiCapWindows: (v: DraftMagiCapWindow[]) => void;
}

interface StrategyAndCostBasisBag {
  strategyKind: StrategyKind;
  costBasisPct: number;
  setStrategyKindRaw: (v: StrategyKind) => void;
  setCostBasisPct: (v: number) => void;
}

function useStrategyAndCostBasis(effective: ResolutionContext['effective']): StrategyAndCostBasisBag {
  const [strategyKind, setStrategyKindRaw] = useState<StrategyKind>(
    effective.withdrawalStrategy?.kind ?? 'taxEfficient',
  );
  const [costBasisPct, setCostBasisPct] = useState<number>(
    effective.assumedCostBasisFractionOfTaxableWithdrawal !== undefined
      ? effective.assumedCostBasisFractionOfTaxableWithdrawal * 100
      : DEFAULT_COST_BASIS_PCT,
  );
  return { strategyKind, costBasisPct, setStrategyKindRaw, setCostBasisPct };
}

interface MagiBootstrapBag {
  useEngineDefault: boolean;
  magiDraft: number;
  setUseEngineDefault: (v: boolean) => void;
  setMagiDraft: (v: number) => void;
}

function useMagiBootstrap(
  effective: ResolutionContext['effective'],
  localOverrides: ResolutionContext['localOverrides'],
): MagiBootstrapBag {
  // Toggle from LOCAL-override presence only — never from `effective`.
  const [useEngineDefault, setUseEngineDefault] = useState<boolean>(
    localMagiBootstrap(localOverrides) === undefined,
  );
  const [magiDraft, setMagiDraft] = useState<number>(
    effectiveMagiBootstrap(effective) ?? 0,
  );
  return { useEngineDefault, magiDraft, setUseEngineDefault, setMagiDraft };
}

interface MagiCapBag {
  magiCapEnabled: boolean;
  magiCapWindows: DraftMagiCapWindow[];
  setMagiCapEnabled: (v: boolean) => void;
  setMagiCapWindows: (v: DraftMagiCapWindow[]) => void;
}

function useMagiCap(
  effectiveCap: ResolutionContext['effectiveCap'],
  parentCap: ResolutionContext['parentCap'],
): MagiCapBag {
  // Seed the toggle from the resolved REAL cap (sentinel coerced away) so
  // an inherited cap shows as enabled while an explicitly-disabled child shows
  // as off. The ladder seeds from the inherited cap so a re-enable after disable
  // starts from sensible windows.
  const seedCap = effectiveCap ?? parentCap;
  const [magiCapEnabled, setMagiCapEnabled] = useState<boolean>(
    effectiveCap !== undefined,
  );
  const [magiCapWindows, setMagiCapWindows] = useState<DraftMagiCapWindow[]>(
    () => toDraftMagiCapWindows(seedCap),
  );
  return {
    magiCapEnabled, magiCapWindows,
    setMagiCapEnabled, setMagiCapWindows,
  };
}

interface TaxAssumptionsBag {
  hsaQualifiedPct: number;
  penaltyExemptIds: string[];
  /** ACA opt-out: member ids treated as NOT on the ACA Marketplace. */
  acaOptOutMemberIds: string[];
  setHsaQualifiedPct: (v: number) => void;
  setPenaltyExemptIds: (v: string[]) => void;
  setAcaOptOutMemberIds: (v: string[]) => void;
}

function useTaxAssumptions(effective: ResolutionContext['effective']): TaxAssumptionsBag {
  // Seed from EFFECTIVE so an inherited assumption shows in the modal.
  const [hsaQualifiedPct, setHsaQualifiedPct] = useState<number>(
    effective.hsaQualifiedMedicalExpensePct ?? DEFAULT_HSA_QUALIFIED_PCT,
  );
  const [penaltyExemptIds, setPenaltyExemptIds] = useState<string[]>(
    () => [...(effective.earlyWithdrawalPenaltyExemptAccountIds ?? [])],
  );
  const [acaOptOutMemberIds, setAcaOptOutMemberIds] = useState<string[]>(
    () => [...(effective.acaMarketplaceOptOutMemberIds ?? [])],
  );
  return {
    hsaQualifiedPct,
    penaltyExemptIds,
    acaOptOutMemberIds,
    setHsaQualifiedPct,
    setPenaltyExemptIds,
    setAcaOptOutMemberIds,
  };
}

/** Bundles every `useState` for the draft into one bag. Split across
 *  sub-hooks (strategy+cost-basis, magi-bootstrap, custom-order tiers,
 *  magi-cap) so each piece is ≤40 lines. Hook call order is stable
 *  per React's rules. Each initial value derives from the parent-chain
 *  `effective` so the modal reflects inherited values from first paint.
 *  Tax assumptions live in their OWN modal/hook (`useTaxAssumptionsDraft`),
 *  decoupled from the withdrawal-strategy draft. */
function useStrategyDraftState(ctx: ResolutionContext): DraftStateBag {
  const { effective, localOverrides, effectiveCap, parentCap, initTiers, initExcluded } = ctx;
  const sk = useStrategyAndCostBasis(effective);
  const mb = useMagiBootstrap(effective, localOverrides);
  const [tiers, setTiers] = useState<string[][]>(initTiers);
  const [excludedAccountIds, setExcluded] = useState<string[]>(initExcluded);
  const mc = useMagiCap(effectiveCap, parentCap);
  return {
    state: {
      strategyKind: sk.strategyKind, costBasisPct: sk.costBasisPct,
      useEngineDefault: mb.useEngineDefault, magiDraft: mb.magiDraft,
      tiers, excludedAccountIds,
      magiCapEnabled: mc.magiCapEnabled, magiCapWindows: mc.magiCapWindows,
    },
    setStrategyKindRaw: sk.setStrategyKindRaw,
    setCostBasisPct: sk.setCostBasisPct,
    setUseEngineDefault: mb.setUseEngineDefault,
    setMagiDraft: mb.setMagiDraft,
    setTiers,
    setExcluded,
    setMagiCapEnabled: mc.setMagiCapEnabled,
    setMagiCapWindows: mc.setMagiCapWindows,
  };
}

/**
 * Seeds modal draft. Visual seed from the resolved parent-chain effective
 * value; "Use engine default" toggle from LOCAL-override presence only.
 */
export function useWithdrawalStrategyDraft(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
): {
  draft: DraftState;
  localOverrides: ScenarioAggregate['payload']['overrides'];
  effective: ScenarioAggregate['payload']['overrides'];
  /**
   * Name of the nearest ancestor that sets `magiCap`, when the
   * local scenario has no `magiCap` override (so the displayed cap value
   * is inherited rather than locally set). `null` when not inherited.
   */
  magiCapInheritedFromName: string | null;
  /**
   * Resolved real cap from the PARENT chain only (sentinel coerced away).
   * Threaded to the save helper so it can tell "off but parent imposes a
   * cap" (write the disable sentinel) from "off, no cap anywhere".
   */
  parentCap: MagiCapOverride | undefined;
  setStrategyKind: (v: StrategyKind) => void;
  setCostBasisPct: (v: number) => void;
  handleToggleEngineDefault: (v: boolean) => void;
  setMagiDraft: (v: number) => void;
  setTierState: (tiers: string[][], excluded: string[]) => void;
  setMagiCapEnabled: (v: boolean) => void;
  setMagiCapWindows: (v: DraftMagiCapWindow[]) => void;
  isDirty: boolean;
} {
  const ctx = useEffectiveResolution(scenario, scenarios, accounts);
  const bag = useStrategyDraftState(ctx);
  const { state } = bag;
  const baseline = useMemo(
    () =>
      buildBaselineSnapshot({
        effective: ctx.effective,
        localOverrides: ctx.localOverrides,
        effectiveCap: ctx.effectiveCap,
        parentCap: ctx.parentCap,
        initTiers: ctx.initTiers,
        initExcluded: ctx.initExcluded,
      }),
    [], // frozen at mount
  );
  const isDirty = useMemo(
    () => buildDraftSnapshot(state) !== baseline,
    [state, baseline],
  );
  const setStrategyKind = (v: StrategyKind): void => {
    bag.setStrategyKindRaw(v);
  };
  // Toggling the cap ON seeds one default window when the ladder is empty
  // so it is never "enabled but empty"; toggling OFF leaves the windows intact
  // (re-enabling restores them).
  const setMagiCapEnabled = (v: boolean): void => {
    bag.setMagiCapEnabled(v);
    if (v && state.magiCapWindows.length === 0) {
      bag.setMagiCapWindows([defaultMagiCapWindow()]);
    }
  };
  const setTierState = (nextTiers: string[][], nextExcluded: string[]): void => {
    bag.setTiers(nextTiers);
    bag.setExcluded(nextExcluded);
  };
  const handleToggleEngineDefault = (next: boolean): void => {
    bag.setUseEngineDefault(next);
    if (next) bag.setMagiDraft(0);
  };
  return {
    draft: state,
    localOverrides: ctx.localOverrides,
    effective: ctx.effective,
    magiCapInheritedFromName: ctx.magiCapInheritedFromName,
    parentCap: ctx.parentCap,
    setStrategyKind,
    setCostBasisPct: bag.setCostBasisPct,
    handleToggleEngineDefault,
    setMagiDraft: bag.setMagiDraft,
    setTierState,
    setMagiCapEnabled,
    setMagiCapWindows: bag.setMagiCapWindows,
    isDirty,
  };
}

/** Pure: snapshot the dirty-tracked fields out of the draft state. Symmetric
 *  with `buildBaselineSnapshot`; both feed the `isDirty` string equality. */
function buildDraftSnapshot(state: DraftState): string {
  return JSON.stringify({
    strategyKind: state.strategyKind,
    costBasisPct: state.costBasisPct,
    useEngineDefault: state.useEngineDefault,
    magiDraft: state.magiDraft,
    tiers: state.tiers,
    excludedAccountIds: state.excludedAccountIds,
    magiCapEnabled: state.magiCapEnabled,
    magiCapWindows: state.magiCapWindows,
  });
}

/**
 * Draft state for the standalone Tax Assumptions modal — decoupled from the
 * withdrawal-strategy draft above. Seeds the emergency-HSA qualified % (the
 * share of EMERGENCY HSA withdrawals treated as qualified — modeled
 * medical-qualified withdrawals are always 100% qualified) + per-account
 * early-withdrawal penalty exemptions from the parent-chain `effective`
 * overrides (so inherited values show), tracks its own `isDirty`, and exposes
 * the per-account toggle helper. The modal's Save reuses `buildNextTaxAssumptions`
 * (prune-on-save included). No `accounts` arg: the seed comes from `effective`,
 * the live-account filter + prune live in the modal / save helper.
 */
export function useTaxAssumptionsDraft(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
): {
  draft: { hsaQualifiedPct: number; penaltyExemptIds: string[] };
  localOverrides: ScenarioOverrides;
  effective: ScenarioOverrides;
  setHsaQualifiedPct: (v: number) => void;
  /** Flip one account's early-withdrawal penalty-exempt flag. */
  togglePenaltyExempt: (accountId: string, exempt: boolean) => void;
  isDirty: boolean;
} {
  const localOverrides = scenario.payload.overrides;
  const effective = useMemo(
    () => resolveEffectiveOverrides(scenario, scenarios, localOverrides),
    [], // frozen at mount
  );
  const ta = useTaxAssumptions(effective);
  const baseline = useMemo(
    () =>
      JSON.stringify({
        hsaQualifiedPct:
          effective.hsaQualifiedMedicalExpensePct ?? DEFAULT_HSA_QUALIFIED_PCT,
        penaltyExemptIds: sortedIds(
          effective.earlyWithdrawalPenaltyExemptAccountIds ?? [],
        ),
      }),
    [], // frozen at mount
  );
  const isDirty = useMemo(
    () =>
      JSON.stringify({
        hsaQualifiedPct: ta.hsaQualifiedPct,
        penaltyExemptIds: sortedIds(ta.penaltyExemptIds),
      }) !== baseline,
    [ta.hsaQualifiedPct, ta.penaltyExemptIds, baseline],
  );
  const togglePenaltyExempt = (accountId: string, exempt: boolean): void => {
    const current = new Set(ta.penaltyExemptIds);
    if (exempt) current.add(accountId);
    else current.delete(accountId);
    ta.setPenaltyExemptIds([...current]);
  };
  return {
    draft: {
      hsaQualifiedPct: ta.hsaQualifiedPct,
      penaltyExemptIds: ta.penaltyExemptIds,
    },
    localOverrides,
    effective,
    setHsaQualifiedPct: ta.setHsaQualifiedPct,
    togglePenaltyExempt,
    isDirty,
  };
}


/**
 * Draft state for the standalone health-coverage modal. Owns four concerns, all
 * seeded from the parent-chain `effective` overrides so inherited values show:
 *   - the per-member Marketplace opt-out (`acaMarketplaceOptOutMemberIds`);
 *   - the per-member/per-year Medicare Part B / Part D + Marketplace MONTHS
 *     (`healthCoverageMonths`);
 *   - the federal-poverty-level region (`acaFplRegion`);
 *   - the per-year annual benchmark-premium override (`acaPtcBenchmark`).
 * Tracks its own `isDirty` across all four. Save reuses `buildNextAcaCoverage` +
 * `buildNextHealthCoverage` (prune-on-save against the live member-id set).
 */
export function useAcaCoverageDraft(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
): {
  draft: {
    acaOptOutMemberIds: string[];
    fplRegion: AcaFplRegion;
    coverageRows: DraftHealthCoverageRow[];
    benchmarkRows: DraftBenchmarkRow[];
  };
  localOverrides: ScenarioOverrides;
  effective: ScenarioOverrides;
  /** Flip one member's "on Marketplace" / "other coverage" flag (true = opt out). */
  toggleAcaOptOut: (memberId: string, optOut: boolean) => void;
  setFplRegion: (v: AcaFplRegion) => void;
  setCoverageRows: (v: DraftHealthCoverageRow[]) => void;
  setBenchmarkRows: (v: DraftBenchmarkRow[]) => void;
  isDirty: boolean;
} {
  const localOverrides = scenario.payload.overrides;
  const effective = useMemo(
    () => resolveEffectiveOverrides(scenario, scenarios, localOverrides),
    [], // frozen at mount
  );
  const ta = useTaxAssumptions(effective);
  const [fplRegion, setFplRegion] = useState<AcaFplRegion>(
    effective.acaFplRegion ?? 'contiguous',
  );
  const [coverageRows, setCoverageRows] = useState<DraftHealthCoverageRow[]>(() =>
    toDraftHealthRows(effective.healthCoverageMonths),
  );
  const [benchmarkRows, setBenchmarkRows] = useState<DraftBenchmarkRow[]>(() =>
    toDraftBenchmarkRows(effective.acaPtcBenchmark),
  );
  const baseline = useMemo(
    () =>
      JSON.stringify({
        acaOptOutMemberIds: sortedIds(effective.acaMarketplaceOptOutMemberIds ?? []),
        fplRegion: effective.acaFplRegion ?? 'contiguous',
        coverageRows: toDraftHealthRows(effective.healthCoverageMonths),
        benchmarkRows: toDraftBenchmarkRows(effective.acaPtcBenchmark),
      }),
    [], // frozen at mount
  );
  const isDirty = useMemo(
    () =>
      JSON.stringify({
        acaOptOutMemberIds: sortedIds(ta.acaOptOutMemberIds),
        fplRegion,
        coverageRows,
        benchmarkRows,
      }) !== baseline,
    [ta.acaOptOutMemberIds, fplRegion, coverageRows, benchmarkRows, baseline],
  );
  const toggleAcaOptOut = (memberId: string, optOut: boolean): void => {
    const current = new Set(ta.acaOptOutMemberIds);
    if (optOut) current.add(memberId);
    else current.delete(memberId);
    ta.setAcaOptOutMemberIds([...current]);
  };
  return {
    draft: {
      acaOptOutMemberIds: ta.acaOptOutMemberIds,
      fplRegion,
      coverageRows,
      benchmarkRows,
    },
    localOverrides,
    effective,
    toggleAcaOptOut,
    setFplRegion,
    setCoverageRows,
    setBenchmarkRows,
    isDirty,
  };
}
