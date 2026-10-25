/** Draft state hooks for the withdrawal-strategy editor, the Tax assumptions modal and the Health coverage modal. */
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

function localMagiBootstrap(localOverrides: ScenarioOverrides): number | undefined {
  return (
    localOverrides.magiBootstrapLookbackMinus2 ??
    localOverrides.magiBootstrapLookbackMinus1
  );
}

function effectiveMagiBootstrap(effective: ScenarioOverrides): number | undefined {
  return effective.magiBootstrapLookbackMinus2 ?? effective.magiBootstrapLookbackMinus1;
}

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

function buildBaselineSnapshot(args: {
  effective: ScenarioOverrides;
  localOverrides: ScenarioOverrides;
  effectiveCap: MagiCapOverride | undefined;
  parentCap: MagiCapOverride | undefined;
  initTiers: string[][];
  initExcluded: string[];
}): string {
  const { effective, localOverrides, effectiveCap, parentCap, initTiers, initExcluded } = args;
  // Seeded from the same source as useMagiCap so a no-edit session stays non-dirty; an explicitly-disabled child falls back to the parent cap's values for re-enable.
  const seedCap = effectiveCap ?? parentCap;
  return JSON.stringify({
    strategyKind: effective.withdrawalStrategy?.kind ?? 'taxEfficient',
    costBasisPct:
      effective.assumedCostBasisFractionOfTaxableWithdrawal !== undefined
        ? effective.assumedCostBasisFractionOfTaxableWithdrawal * 100
        : DEFAULT_COST_BASIS_PCT,
    useEngineDefault: localMagiBootstrap(localOverrides) === undefined,
    magiDraft: effectiveMagiBootstrap(effective) ?? 0,
    // Raw saved tiers (pre-prune), so pruning counts as dirty.
    tiers: localOverrides.customDrawdownOrder?.tiers ?? initTiers,
    excludedAccountIds:
      localOverrides.customDrawdownOrder?.excludedAccountIds ?? initExcluded,
    magiCapEnabled: effectiveCap !== undefined,
    magiCapWindows: toDraftMagiCapWindows(seedCap),
  });
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

export interface DraftState {
  strategyKind: StrategyKind;
  costBasisPct: number;
  useEngineDefault: boolean;
  magiDraft: number;
  tiers: string[][];
  excludedAccountIds: string[];
  magiCapEnabled: boolean;
  magiCapWindows: DraftMagiCapWindow[];
}

interface ResolutionContext {
  localOverrides: ScenarioOverrides;
  effective: ScenarioOverrides;
  effectiveCap: MagiCapOverride | undefined;
  /** From the parent chain only, sentinel coerced to undefined; drives the save matrix and seeds fields when the child has no real local cap. */
  parentCap: MagiCapOverride | undefined;
  magiCapInheritedFromName: string | null;
  initTiers: string[][];
  initExcluded: string[];
}

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
  // Coerce the explicit-disable sentinel to undefined: a disabled child resolves to "no cap" for display and dirty tracking.
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
  // From local-override presence only, never from effective.
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
  acaOptOutMemberIds: string[];
  setHsaQualifiedPct: (v: number) => void;
  setPenaltyExemptIds: (v: string[]) => void;
  setAcaOptOutMemberIds: (v: string[]) => void;
}

function useTaxAssumptions(effective: ResolutionContext['effective']): TaxAssumptionsBag {
  // Seed from effective so an inherited assumption shows in the modal.
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

/** Seeds the modal draft: values from the resolved parent-chain effective overrides, the "Use engine default" toggle from local-override presence only. */
export function useWithdrawalStrategyDraft(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
): {
  draft: DraftState;
  localOverrides: ScenarioAggregate['payload']['overrides'];
  effective: ScenarioAggregate['payload']['overrides'];
  magiCapInheritedFromName: string | null;
  /** From the parent chain only; lets the save helper tell "off but parent imposes a cap" (write the disable sentinel) from "off, no cap anywhere". */
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
  // Toggling ON seeds one default window when the ladder is empty, so it is never enabled-but-empty; toggling OFF leaves the windows for re-enable.
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

/** Draft for the standalone Tax assumptions modal, seeded from the parent-chain effective overrides; Save reuses buildNextTaxAssumptions (prune-on-save). */
export function useTaxAssumptionsDraft(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
): {
  draft: { hsaQualifiedPct: number; penaltyExemptIds: string[] };
  localOverrides: ScenarioOverrides;
  effective: ScenarioOverrides;
  setHsaQualifiedPct: (v: number) => void;
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


/** Draft for the standalone Health coverage modal (opt-out, coverage months, FPL region, benchmark overrides), seeded from the effective overrides; Save reuses buildNextAcaCoverage and buildNextHealthCoverage. */
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
