/**
 * Scenario detail page subsection: two sibling summary cards. The withdrawal-
 * strategy card's Configure navigates to a dedicated page
 * (/scenarios/:id/withdrawal-strategy); the tax-assumptions card's Configure
 * opens its own modal.
 *
 * Withdrawal strategy editor — drawdown *mechanics* (five override fields):
 *   - `overrides.withdrawalStrategy` — four-option picker (taxEfficient /
 *     proportional / rothFirst / customOrder).
 *   - `overrides.customDrawdownOrder` — tier editor; active only
 *     when `withdrawalStrategy.kind === 'customOrder'`.
 *   - `overrides.magiCap` — MAGI-cap overlay.
 *   - `overrides.assumedCostBasisFractionOfTaxableWithdrawal` — percent.
 *   - `overrides.magiBootstrapLookbackMinus2` / `magiBootstrapLookbackMinus1`
 *     — pre-retirement income (whole dollars) gated by a "Use engine
 *     default" ToggleSwitch (ON = omit both keys). The single UI input writes
 *     both lookback fields to the same value (year 0 = MAGI(ret−2), year 1 =
 *     MAGI(ret−1)).
 *
 * Tax assumptions modal — user-asserted tax treatment (two override fields):
 *   - `overrides.hsaQualifiedMedicalExpensePct` — percentage of EMERGENCY HSA
 *     withdrawals still assumed backed by qualified medical receipts (0–100,
 *     default 100); modeled medical-qualified draws are always 100% qualified.
 *   - `overrides.earlyWithdrawalPenaltyExemptAccountIds` — account IDs the
 *     user has marked as penalty-exempt.
 *
 * Each surface's Save calls `saveScenario` directly (one queued mutation,
 * touching only its own keys). The tax-assumptions modal reloads its parent on
 * `onClose(true)` with a `useDirtyModalClose` guard; the withdrawal-strategy
 * editor lives on its own page with a `useUnsavedChangesGuard` + post-save
 * in-place reload.
 *
 * Extraction map:
 *   - scenario-withdrawal-strategy-shared.ts       — constants + helpers
 *   - scenario-withdrawal-strategy-tier-editor.tsx — TierList + TierEditor
 *   - scenario-withdrawal-strategy-magi-cap.tsx    — MagiCapSection
 *   - scenario-withdrawal-strategy-draft-hook.ts   — both draft hooks
 *   - scenario-withdrawal-strategy-editor.tsx      — withdrawal-strategy editor
 *   - ScenarioWithdrawalStrategyPage.tsx           — withdrawal-strategy page chrome
 *   - scenario-tax-assumptions-sections.tsx        — tax-assumptions tab sections
 *   - scenario-tax-assumptions-modal.tsx           — tax-assumptions modal (tabs)
 */
import React, { useMemo } from 'react';
import { formatPercent } from '../components/PercentInput';
import { resolveScenario } from '../lib/scenario-resolution';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';
import { memberDisplayName } from '../lib/income-format';
import type { AcaFplRegion } from '../lib/aca-ptc';
import {
  SummarySectionCard,
  SummaryCardBody,
  ConfigureResetActions,
} from './scenarios-page-chrome';
import {
  STRATEGY_LABELS,
  DEFAULT_HSA_QUALIFIED_PCT,
  formatMagiBootstrap,
  toDraftBenchmarkRows,
  toDraftHealthRows,
} from './scenario-withdrawal-strategy-shared';

export { TaxAssumptionsModal, AcaCoverageModal } from './scenario-tax-assumptions-modal';

// ——— card ————————————————————————————————————————————————

interface CardProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  onConfigure: () => void;
  onResetToInherited?: () => void;
}

export const WithdrawalStrategyCard: React.FC<CardProps> = ({
  scenario,
  scenarios,
  onConfigure,
  onResetToInherited,
}) => {
  const overrides = scenario.payload.overrides;
  const isOverriddenLocally =
    overrides.withdrawalStrategy !== undefined ||
    overrides.assumedCostBasisFractionOfTaxableWithdrawal !== undefined ||
    overrides.magiBootstrapLookbackMinus2 !== undefined ||
    overrides.magiBootstrapLookbackMinus1 !== undefined ||
    overrides.customDrawdownOrder !== undefined ||
    overrides.magiCap !== undefined;
  const canResetToInherited = isOverriddenLocally && !scenario.payload.isPrimary;

  const parentName = useMemo(() => {
    if (!scenario.payload.parentScenarioId) return null;
    return scenarios.find((s) => s.id === scenario.payload.parentScenarioId)?.payload.name ?? null;
  }, [scenario, scenarios]);

  const inherited = useMemo(() => {
    if (!scenario.payload.parentScenarioId) return null;
    try {
      return resolveScenario(scenario.payload.parentScenarioId, scenarios);
    } catch (error) {
      console.warn('[withdrawal-strategy] resolveScenario failed', { scenarioId: scenario.id, error });
      return null;
    }
  }, [scenario, scenarios]);

  const summary = useMemo((): string => {
    const strategy = overrides.withdrawalStrategy ?? inherited?.withdrawalStrategy;
    const costBasisFraction =
      overrides.assumedCostBasisFractionOfTaxableWithdrawal ??
      inherited?.assumedCostBasisFractionOfTaxableWithdrawal;
    // Read the year-0 (minus2) lookback, falling back to year-1 (minus1);
    // the two fields are written together, so they normally agree.
    const magi =
      overrides.magiBootstrapLookbackMinus2 ??
      overrides.magiBootstrapLookbackMinus1 ??
      inherited?.magiBootstrapLookbackMinus2 ??
      inherited?.magiBootstrapLookbackMinus1;

    const isFullyDefault = !strategy && costBasisFraction === undefined && magi === undefined;
    if (isFullyDefault) return 'Tax-efficient (default)';

    const strategyLabel = strategy ? STRATEGY_LABELS[strategy.kind] : 'Tax-efficient (default)';
    const parts: string[] = [strategyLabel];
    if (costBasisFraction !== undefined)
      parts.push(`Return of principal: ${formatPercent(costBasisFraction * 100)}`);
    if (magi !== undefined) parts.push(`Pre-retirement income: ${formatMagiBootstrap(magi)}`);
    const base = parts.join(' · ');

    if (!isOverriddenLocally && parentName) return `${base} (inherited from ${parentName})`;
    return base;
  }, [overrides, inherited, isOverriddenLocally, parentName]);

  return (
    <SummarySectionCard
      title="Withdrawal strategy"
      headingId="withdrawal-strategy-heading"
      overridden={scenario.payload.isPrimary ? undefined : isOverriddenLocally}
      actions={
        <ConfigureResetActions
          subject="withdrawal strategy"
          onConfigure={onConfigure}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>{summary}</SummaryCardBody>
    </SummarySectionCard>
  );
};

// ——— Tax assumptions card —————————————————————————————————

interface TaxAssumptionsCardProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  /** Opens the standalone Tax assumptions modal. */
  onConfigure: () => void;
  /** Clears both tax-assumption overrides back to inherited (non-base only). */
  onResetToInherited?: () => void;
}

/**
 * Compact summary of the scenario's tax assumptions (resolved through the
 * parent chain, same as the engine reads them): the share of emergency-reserve
 * HSA withdrawals treated as qualified (modeled medical-qualified HSA spending
 * is always 100% qualified — this percentage governs only the emergency-reserve
 * draws taken after every non-HSA account is exhausted) and the count of
 * accounts marked exempt from the early-withdrawal penalty. Configure opens the
 * standalone Tax assumptions modal where these
 * are edited; Reset (non-base scenarios with a local override) clears both
 * tax-assumption keys back to inherited — symmetric with the Withdrawal
 * strategy card.
 */
export const TaxAssumptionsCard: React.FC<TaxAssumptionsCardProps> = ({
  scenario,
  scenarios,
  onConfigure,
  onResetToInherited,
}) => {
  const overrides = scenario.payload.overrides;
  const isOverriddenLocally =
    overrides.hsaQualifiedMedicalExpensePct !== undefined ||
    overrides.earlyWithdrawalPenaltyExemptAccountIds !== undefined;
  const canResetToInherited = isOverriddenLocally && !scenario.payload.isPrimary;

  const inherited = useMemo(() => {
    if (!scenario.payload.parentScenarioId) return null;
    try {
      return resolveScenario(scenario.payload.parentScenarioId, scenarios);
    } catch (error) {
      console.warn('[tax-assumptions] resolveScenario failed', {
        scenarioId: scenario.id,
        error,
      });
      return null;
    }
  }, [scenario, scenarios]);

  const hsaPct =
    overrides.hsaQualifiedMedicalExpensePct ??
    inherited?.hsaQualifiedMedicalExpensePct ??
    DEFAULT_HSA_QUALIFIED_PCT;
  const exemptCount = (
    overrides.earlyWithdrawalPenaltyExemptAccountIds ??
    inherited?.earlyWithdrawalPenaltyExemptAccountIds ??
    []
  ).length;

  const exemptText =
    exemptCount === 0
      ? 'no penalty exemptions'
      : `${exemptCount} account${exemptCount === 1 ? '' : 's'} penalty-exempt`;
  const summary = `Emergency HSA withdrawals treated as qualified: ${formatPercent(hsaPct)} · ${exemptText}`;

  return (
    <SummarySectionCard
      title="Tax assumptions"
      headingId="tax-assumptions-heading"
      overridden={scenario.payload.isPrimary ? undefined : isOverriddenLocally}
      actions={
        <ConfigureResetActions
          subject="tax assumptions"
          onConfigure={onConfigure}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>
        {isOverriddenLocally ? summary : 'No scenario overrides.'}
      </SummaryCardBody>
    </SummarySectionCard>
  );
};

// ——— ACA Marketplace coverage card —————————————————————————

interface AcaCoverageCardProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  /** Every household member — drives the on-Marketplace / other-coverage split. */
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Opens the standalone ACA Marketplace coverage modal. */
  onConfigure: () => void;
  /** Clears the opt-out override back to inherited (non-base only). */
  onResetToInherited?: () => void;
}

/** The plain-English region labels the card echoes. `contiguous` is the
 *  default and is left unsaid so the summary stays short. */
const FPL_REGION_SUMMARY: Readonly<Record<Exclude<AcaFplRegion, 'contiguous'>, string>> = {
  alaska: 'Alaska poverty guidelines',
  hawaii: 'Hawaii poverty guidelines',
};

/** Own-property lookup (CWE-1321) for a STORED region value. The plain
 *  object literal inherits `constructor` / `toString` from `Object.prototype`,
 *  and import hardening rejects those names only in KEY position, so a stored
 *  `acaFplRegion: "constructor"` would otherwise return an inherited FUNCTION
 *  and get stringified into the card summary. */
function fplRegionSummaryLabel(region: string | undefined): string | undefined {
  return region !== undefined && Object.hasOwn(FPL_REGION_SUMMARY, region)
    ? FPL_REGION_SUMMARY[region as Exclude<AcaFplRegion, 'contiguous'>]
    : undefined;
}

/**
 * Compact summary of the household's modeled health coverage (resolved through
 * the parent chain, same as the engine reads it): who buys ACA Marketplace
 * coverage in early retirement vs has "other coverage", how many years carry
 * stated Medicare/Marketplace months, whether a non-default poverty-guideline
 * region applies, and how many years carry a benchmark-price override. Defaults
 * = everyone on the Marketplace, automatic coverage timing, mainland guidelines,
 * and the rough estimated benchmark. Configure opens the standalone modal; Reset
 * (non-base scenarios with a local override) clears the health keys back to
 * inherited.
 */
export const AcaCoverageCard: React.FC<AcaCoverageCardProps> = ({
  scenario,
  scenarios,
  members,
  onConfigure,
  onResetToInherited,
}) => {
  const overrides = scenario.payload.overrides;
  const isOverriddenLocally =
    overrides.acaMarketplaceOptOutMemberIds !== undefined ||
    overrides.healthCoverageMonths !== undefined ||
    overrides.acaFplRegion !== undefined ||
    overrides.acaPtcBenchmark !== undefined;
  const canResetToInherited = isOverriddenLocally && !scenario.payload.isPrimary;

  const inherited = useMemo(() => {
    if (!scenario.payload.parentScenarioId) return null;
    try {
      return resolveScenario(scenario.payload.parentScenarioId, scenarios);
    } catch (error) {
      console.warn('[aca-coverage] resolveScenario failed', { scenarioId: scenario.id, error });
      return null;
    }
  }, [scenario, scenarios]);

  const summary = useMemo((): string => {
    const optedOut = new Set(
      overrides.acaMarketplaceOptOutMemberIds ??
        inherited?.acaMarketplaceOptOutMemberIds ??
        [],
    );
    const onMarketplace = members
      .filter((m) => !optedOut.has(m.id))
      .map((m) => memberDisplayName(m));
    const otherCoverage = members
      .filter((m) => optedOut.has(m.id))
      .map((m) => memberDisplayName(m));
    const parts: string[] = [];
    if (onMarketplace.length) parts.push(`On Marketplace: ${onMarketplace.join(', ')}`);
    if (otherCoverage.length) parts.push(`Other coverage: ${otherCoverage.join(', ')}`);

    const region = overrides.acaFplRegion ?? inherited?.acaFplRegion;
    const regionLabel = fplRegionSummaryLabel(region);
    if (regionLabel) parts.push(regionLabel);

    // Counted through the ONE shape-checking reader (each row is one
    // stated member/year), so an imported `{ perMember: { id: null } }` renders
    // as "nothing stated" instead of throwing out of this card.
    const monthYears = toDraftHealthRows(
      overrides.healthCoverageMonths ?? inherited?.healthCoverageMonths,
    ).length;
    if (monthYears > 0) {
      parts.push(`${monthYears} coverage year${monthYears === 1 ? '' : 's'} set`);
    }

    // Counted through the ONE shape-checking benchmark enumerator, so an
    // imported non-array (or a malformed row) reads as "none entered" instead of
    // throwing out of this card.
    const benchmarkCount = toDraftBenchmarkRows(
      overrides.acaPtcBenchmark ?? inherited?.acaPtcBenchmark,
    ).length;
    if (benchmarkCount > 0) {
      parts.push(
        `${benchmarkCount} benchmark price${benchmarkCount === 1 ? '' : 's'} entered`,
      );
    }
    return parts.join(' · ') || 'No household members';
  }, [overrides, inherited, members]);

  return (
    <SummarySectionCard
      title="Health coverage"
      headingId="aca-coverage-heading"
      overridden={scenario.payload.isPrimary ? undefined : isOverriddenLocally}
      actions={
        <ConfigureResetActions
          subject="health coverage"
          onConfigure={onConfigure}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>{summary}</SummaryCardBody>
    </SummarySectionCard>
  );
};
