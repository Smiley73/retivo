/** Scenario detail page summary cards for the withdrawal strategy (Configure opens its page), the tax assumptions and the health coverage; each Save touches only its own override keys. */
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

interface TaxAssumptionsCardProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  /** Opens the standalone Tax assumptions modal. */
  onConfigure: () => void;
  /** Clears both tax-assumption overrides back to inherited (non-base only). */
  onResetToInherited?: () => void;
}

/** Summary of the resolved HSA qualified % (emergency-reserve draws only; modeled medical-qualified spending is always 100%) and the count of penalty-exempt accounts. */
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

const FPL_REGION_SUMMARY: Readonly<Record<Exclude<AcaFplRegion, 'contiguous'>, string>> = {
  alaska: 'Alaska poverty guidelines',
  hawaii: 'Hawaii poverty guidelines',
};

// Own-property lookup (CWE-1321): a stored acaFplRegion of "constructor" would otherwise return an inherited function from Object.prototype and be stringified into the summary.
function fplRegionSummaryLabel(region: string | undefined): string | undefined {
  return region !== undefined && Object.hasOwn(FPL_REGION_SUMMARY, region)
    ? FPL_REGION_SUMMARY[region as Exclude<AcaFplRegion, 'contiguous'>]
    : undefined;
}

/** Summary of the modeled health coverage resolved through the parent chain: Marketplace vs other coverage, years with stated months, a non-default FPL region and benchmark overrides. */
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

    // Counted through the shape-checking reader, so an imported { perMember: { id: null } } reads as "nothing stated" instead of throwing.
    const monthYears = toDraftHealthRows(
      overrides.healthCoverageMonths ?? inherited?.healthCoverageMonths,
    ).length;
    if (monthYears > 0) {
      parts.push(`${monthYears} coverage year${monthYears === 1 ? '' : 's'} set`);
    }

    // Counted through the shape-checking enumerator, so an imported non-array or malformed row reads as "none entered".
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
