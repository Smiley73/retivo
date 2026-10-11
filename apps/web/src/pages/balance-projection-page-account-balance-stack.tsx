/**
 * Balance Projection page — "Account balances over time" band.
 *
 * Stacked-area chart over a UNIFIED, continuous timeline: historical actuals
 * (from the earliest recorded balance year) → accumulation projection →
 * retirement drawdown. The caller assembles + deflates the rows (historical
 * stays nominal, the projected region deflates through the active path); this
 * band only groups (per-tier when `customOrder` is active, per-AccountType
 * otherwise, or per-individual-account) and renders.
 *
 * The projected region (after the last actual year) is distinguished by a
 * dashed vertical boundary marker at the last actual year + a lower fill
 * opacity across accumulation + drawdown. Per-account carried-forward
 * spans (years held flat from a prior entry) render with a dashed top-edge +
 * more muted fill.
 *
 * The same band serves the Account Balances page as a historical-only surface
 * (`methodLabel` omitted → bare title, no boundary, no projected zone;
 * `showExcludedToggle={false}` → the Show-excluded toggle is suppressed).
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  AccountBalanceStackChart,
  type AccountBalanceStackRow,
  type AccountBalanceStackSeries,
} from '../components/AccountBalanceStackChart';
import type { SeriesZone } from '../components/charts';
import type { CashflowChartMarker } from '../components/CashflowProjectionChart';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { Muted } from '../components/Muted';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import { useChartColors } from '../lib/use-chart-tokens';
import { useChartZoom } from '../lib/use-chart-zoom';
import { ChartZoomReset } from '../components/ChartZoomReset';
import type { AccountTaxTreatment, AccountType } from '../db/types';
import { isRothDesignatedRetirementType } from '../lib/balance-calc';
import type { TooltipMember } from '../components/tooltip-member';
import type {
  StackBandYear,
} from '../lib/account-balance-stack-timeline';
import { bandSectionH2Class } from './accounts-page-chrome';

export type {  StackBandYear };

// ---- AccountType → bucket mapping -------------------------------------------

/** Pre-tax retirement account types (401k / IRA / 403b / 457b / TSP / CBP). */
const PRE_TAX_TYPES = new Set<AccountType>([
  'RETIREMENT_401K',
  'RETIREMENT_IRA',
  'RETIREMENT_403B',
  'RETIREMENT_457B',
  'RETIREMENT_TSP',
  'RETIREMENT_CASH_BALANCE',
]);

/** Roth account types. */
const ROTH_TYPES = new Set<AccountType>([
  'RETIREMENT_ROTH_IRA',
  'RETIREMENT_ROTH_401K',
  'RETIREMENT_ROTH_403B',
  'RETIREMENT_ROTH_457B',
  'RETIREMENT_ROTH_TSP',
]);

/** Taxable brokerage account types. */
const TAXABLE_TYPES = new Set<AccountType>(['BROKERAGE']);

/** HSA. */
const HSA_TYPES = new Set<AccountType>(['HSA']);

/** Cash savings account types (non-retirement liquid). */
const CASH_TYPES = new Set<AccountType>([
  'SAVINGS',
  'MONEY_MARKET',
  'CD',
  'OTHER',
]);

// ---- Types ------------------------------------------------------------------

interface AccountMeta {
  /** Account ID (used as key into the per-year account map). */
  readonly id: string;
  readonly name: string;
  readonly type: AccountType;
  /**
   * Account tax treatment. Optional: callers that don't supply it (and
   * existing test fixtures) are treated as non-MIXED/non-Roth-designated, so
   * a missing value routes the full balance through the by-`type` buckets as
   * before.
   */
  readonly taxTreatment?: AccountTaxTreatment;
}

type GroupByMode = 'tier' | 'account';

export interface AccountBalanceStackBandProps {
  /** Resolved accounts for the active household (name + type + id). */
  readonly accounts: ReadonlyArray<AccountMeta>;
  /** Unified continuous-timeline rows (historical + accumulation + drawdown),
   *  already in display dollars. */
  readonly rows: ReadonlyArray<StackBandYear>;
  /** The last actual (historical) year — the dashed boundary sits here and the
   *  projected region begins after it. Null/undefined on the
   *  historical-only accounts surface (no boundary, no projected zone). */
  readonly boundaryYear?: number | null;
  /**
   * When the active strategy is `customOrder`, the ordered tiers and
   * excluded IDs. Null/undefined → fall back to per-AccountType grouping.
   */
  readonly customTiers?: ReadonlyArray<ReadonlyArray<string>> | null;
  readonly excludedAccountIds?: ReadonlyArray<string> | null;
  /** Retirement + death markers rendered as dashed reference lines. */
  readonly markers?: ReadonlyArray<CashflowChartMarker>;
  /** Household members shown in tooltip header — "<First> (age N)". */
  readonly members?: ReadonlyArray<TooltipMember>;
  /** Basis label suffixed onto the band title (the MC tier under an MC basis,
   *  else the deterministic method). OMITTED on the accounts-page surface →
   *  the bare title "Account balances over time" (no method suffix). */
  readonly methodLabel?: string;
  /** Optional small note rendered below the band title (shown only under an MC
   *  basis: "Based on one example simulated path."). */
  readonly subLabel?: string;
  /** When false, the "Show excluded accounts" toggle + its machinery are
   *  suppressed (the historical accounts surface). Default true. */
  readonly showExcludedToggle?: boolean;
  /** Initial Tier/Type-vs-Account grouping. Defaults to `'tier'` (the
   *  on-screen default). The PDF render host renders one band per grouping by
   *  passing `'tier'` and `'account'` so the export captures both views. */
  readonly initialGroupBy?: GroupByMode;
}

// ---- Component --------------------------------------------------------------

export const AccountBalanceStackBand: React.FC<AccountBalanceStackBandProps> = ({
  accounts,
  rows: timeline,
  boundaryYear,
  customTiers,
  excludedAccountIds,
  markers,
  members,
  methodLabel,
  subLabel,
  showExcludedToggle = true,
  initialGroupBy = 'tier',
}) => {
  const colors = useChartColors();

  const [groupBy, setGroupBy] = useState<GroupByMode>(initialGroupBy);
  const [showExcluded, setShowExcluded] = useState(false);

  const hasTiers = customTiers != null && customTiers.length > 0;

  // ---- Build series definition -----------------------------------------------

  const series = useMemo((): AccountBalanceStackSeries[] => {
    if (groupBy === 'account') {
      // Per-account view: one series per account; excluded accounts optionally shown.
      const excludedSet = new Set(excludedAccountIds ?? []);
      const tierColors = [
        colors.acctPreTax,
        colors.acctRoth,
        colors.acctTaxable,
        colors.acctHsa,
        colors.acctCash,
      ];
      const result: AccountBalanceStackSeries[] = [];
      accounts.forEach((acct, idx) => {
        const isExcluded = excludedSet.has(acct.id);
        if (isExcluded && !showExcluded) return;
        result.push({
          dataKey: acct.id,
          name: acct.name,
          color: isExcluded
            ? colors.acctExcluded
            : tierColors[idx % tierColors.length],
        });
      });
      return result;
    }

    if (hasTiers) {
      // Per-tier grouping (customOrder strategy active).
      const tierPalette = [
        colors.acctPreTax,
        colors.acctRoth,
        colors.acctTaxable,
        colors.acctHsa,
        colors.acctCash,
      ];
      const excludedSet = new Set(excludedAccountIds ?? []);
      const result: AccountBalanceStackSeries[] = customTiers!.map(
        (_tier, idx) => ({
          dataKey: `tier_${idx}`,
          name: `Tier ${idx + 1}`,
          color: tierPalette[idx % tierPalette.length],
        }),
      );
      if (showExcluded && excludedSet.size > 0) {
        result.push({
          dataKey: 'tier_excluded',
          name: 'Excluded',
          color: colors.acctExcluded,
        });
      }
      return result;
    }

    // Per-AccountType fallback for other strategies.
    const result: AccountBalanceStackSeries[] = [
      {
        dataKey: 'acct_preTax',
        name: 'Tax-deferred',
        color: colors.acctPreTax,
      },
      { dataKey: 'acct_roth', name: 'Tax-free (Roth)', color: colors.acctRoth },
      {
        dataKey: 'acct_taxable',
        name: 'Taxable',
        color: colors.acctTaxable,
      },
      { dataKey: 'acct_hsa', name: 'Tax-free (HSA)', color: colors.acctHsa },
      {
        dataKey: 'acct_cash',
        name: 'Cash',
        color: colors.acctCash,
      },
    ];
    return result;
  }, [
    groupBy,
    hasTiers,
    customTiers,
    excludedAccountIds,
    showExcluded,
    accounts,
    colors,
  ]);

  // ---- Build rows ------------------------------------------------------------

  /** For each band row, the per-series `carriedForward` signal: a series is
   *  carried-forward in a year when every account contributing a non-zero
   *  balance to it that year is itself carried-forward. Keyed
   *  series.dataKey → boolean[] aligned with `timeline`. */
  const carriedBySeries = useMemo((): Map<string, boolean[]> => {
    const out = new Map<string, boolean[]>();
    const excludedSet = new Set(excludedAccountIds ?? []);
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    const seriesAccounts = (dataKey: string): string[] => {
      if (groupBy === 'account') return [dataKey];
      if (hasTiers) {
        if (dataKey === 'tier_excluded') return [...excludedSet];
        const idx = Number(dataKey.slice('tier_'.length));
        return [...(customTiers?.[idx] ?? [])];
      }
      // Type buckets: map every account into its bucket key.
      return accounts
        .filter((a) => bucketKeyForAccount(a) === dataKey)
        .map((a) => a.id);
    };

    for (const s of series) {
      const ids = seriesAccounts(s.dataKey).filter((id) => accountById.has(id));
      const flags = timeline.map((yr) => {
        let anyContribution = false;
        let allCarried = true;
        for (const id of ids) {
          const ay = yr.accountBalances.get(id);
          if (!ay || ay.balance === 0) continue;
          anyContribution = true;
          if (!ay.carriedForward) allCarried = false;
        }
        return anyContribution && allCarried;
      });
      out.set(s.dataKey, flags);
    }
    return out;
  }, [series, timeline, accounts, groupBy, hasTiers, customTiers, excludedAccountIds]);

  const rows = useMemo((): AccountBalanceStackRow[] => {
    const excludedSet = new Set(excludedAccountIds ?? []);

    return timeline.map((yr) => {
      // Mutable builder; cast to readonly AccountBalanceStackRow at return.
      const row: Record<string, number> = { year: yr.year };
      const balMap = yr.accountBalances;

      if (groupBy === 'account') {
        accounts.forEach((acct) => {
          const isExcluded = excludedSet.has(acct.id);
          if (isExcluded && !showExcluded) return;
          row[acct.id] = balMap.get(acct.id)?.balance ?? 0;
        });
      } else if (hasTiers) {
        customTiers!.forEach((tier, idx) => {
          const key = `tier_${idx}`;
          row[key] = tier.reduce(
            (sum, id) => sum + (balMap.get(id)?.balance ?? 0),
            0,
          );
        });
        if (showExcluded) {
          row['tier_excluded'] = Array.from(excludedSet).reduce(
            (sum, id) => sum + (balMap.get(id)?.balance ?? 0),
            0,
          );
        }
      } else {
        // Per-AccountType aggregation (canonical routing).
        const buckets = stackTypeBucketsForYear(accounts, yr);
        row['acct_preTax'] = buckets.preTax;
        row['acct_roth'] = buckets.roth;
        row['acct_taxable'] = buckets.taxable;
        row['acct_hsa'] = buckets.hsa;
        row['acct_cash'] = buckets.cash;
      }
      return row as AccountBalanceStackRow;
    });
  }, [
    timeline,
    groupBy,
    hasTiers,
    customTiers,
    excludedAccountIds,
    showExcluded,
    accounts,
  ]);

  // ---- Per-series style zones (projected region + carried-forward) ----

  const seriesWithZones = useMemo((): AccountBalanceStackSeries[] => {
    if (timeline.length === 0) return series;
    return series.map((s) => {
      const zones = buildSeriesZones({
        timeline,
        boundaryYear: boundaryYear ?? null,
        carried: carriedBySeries.get(s.dataKey) ?? [],
      });
      return zones.length > 1 ? { ...s, zones } : s;
    });
  }, [series, timeline, boundaryYear, carriedBySeries]);

  // ---- Zoom ------------------------------------------------------------------

  const xDomainFull = useMemo((): [number, number] => {
    if (rows.length === 0) return [0, 0];
    return [rows[0].year, rows[rows.length - 1].year];
  }, [rows]);

  const rowsForY = useMemo(() => rows.map((r) => ({ x: r.year })), [rows]);

  const computeY = useCallback(
    (visibleRows: readonly { x: number }[]): [number, number] | null => {
      const xs = new Set(visibleRows.map((r) => r.x));
      const visible = rows.filter((r) => xs.has(r.year));
      if (visible.length < 2) return null;
      // Use per-row stacked sum (not individual series max) so the y-domain
      // matches what the stacked chart actually renders at its tallest bar.
      const yMax = Math.max(
        0,
        ...visible.map((r) => series.reduce((sum, s) => sum + (r[s.dataKey] ?? 0), 0)),
      );
      if (yMax === 0) return null;
      return [0, yMax];
    },
    [rows, series],
  );

  const zoom = useChartZoom({ xDomainFull, rowsForY, computeY });

  // ---- Render ----------------------------------------------------------------

  const groupByLabel = hasTiers ? 'Group by: Tier | Account' : 'Group by: Type | Account';
  const title =
    methodLabel != null
      ? `Account balances over time (${methodLabel})`
      : 'Account balances over time';
  const boundary =
    boundaryYear != null
      ? {
          year: boundaryYear,
          label: 'Projected from here',
          color: colors.acctExcluded,
        }
      : null;

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <h2 id="acct-balance-stack-heading" className={bandSectionH2Class}>
              {title}
            </h2>
            <ChartInfoPopover label="About the Account balances over time chart">
              <p className="m-0">
                Stacked area shows your account balances each year, from the
                earliest year you recorded a balance through the projected
                saving and drawdown years. When the custom drawdown order is
                active, bands correspond to your defined tiers; otherwise
                accounts are grouped by type. Switch to &ldquo;Account&rdquo;
                view for per-account detail.
              </p>
              {boundaryYear != null && (
                <p className="m-0 mt-2">
                  A dashed line marks where your recorded history ends and the
                  projection begins; the projected region is drawn in a lighter
                  shade, and years carried forward from an older balance entry
                  use a dashed top edge.
                </p>
              )}
              <p className="m-0 mt-2">
                Recorded historical balances are always shown as you entered
                them (nominal dollars), regardless of the Today&rsquo;s /
                Future dollars toggle; only the projected region responds to
                that toggle.
              </p>
            </ChartInfoPopover>
          </div>
          {subLabel && (
            <Muted as="p" className="m-0 text-xs">
              {subLabel}
            </Muted>
          )}
        </div>
        <div className="report-print-hide flex flex-wrap items-center gap-3">
          <ChartZoomReset isZoomed={zoom.isZoomed} onReset={zoom.reset} />
          {/* Show-excluded toggle sits left of the Tier/Account picker so
              the user can decide what to look at before choosing how to
              group it. Suppressed on the historical accounts surface,
              where exclusions are a scenario/drawdown concept that doesn't
              apply. */}
          {showExcludedToggle && (
            <ToggleSwitch
              label="Show excluded accounts"
              checked={showExcluded}
              onChange={setShowExcluded}
            />
          )}
          <SegmentedRadioGroup<GroupByMode>
            size="sm"
            ariaLabel={groupByLabel}
            value={groupBy}
            onChange={setGroupBy}
            options={[
              {
                value: 'tier',
                label: hasTiers ? 'Tier' : 'Type',
                title: hasTiers
                  ? 'Group balances by drawdown tier'
                  : 'Group balances by account type',
              },
              {
                value: 'account',
                label: 'Account',
                title: 'One band per individual account',
              },
            ]}
          />
        </div>
      </div>
      <AccountBalanceStackChart
        rows={rows}
        series={seriesWithZones}
        members={members}
        markers={markers}
        boundary={boundary}
        xDomain={zoom.xDomain}
        yDomain={zoom.yDomain}
        dragSelection={zoom.dragSelection}
        mouseHandlers={zoom.mouseHandlers}
        isDragging={zoom.isDragging}
      />
    </>
  );
};

// ---- Helpers ----------------------------------------------------------------

/** The five tax-treatment type buckets the by-type band stacks, for one year.
 *  Exported so the PDF table builder mirrors the chart's grouping EXACTLY
 *  (no drift). */
export interface StackTypeBuckets {
  readonly preTax: number;
  readonly roth: number;
  readonly taxable: number;
  readonly hsa: number;
  readonly cash: number;
}

/** Sum each account's balance for one timeline year into the five type buckets
 *  the by-type band renders (canonical routing). Shared by the band's
 *  per-type `rows` build and the PDF account-balances-by-type table builder. */
export function stackTypeBucketsForYear(
  accounts: ReadonlyArray<AccountMeta>,
  yr: StackBandYear,
): StackTypeBuckets {
  const balMap = yr.accountBalances;
  let preTax = 0;
  let roth = 0;
  let taxable = 0;
  let hsa = 0;
  let cash = 0;
  accounts.forEach((acct) => {
    // MIXED Roth-designated retirement accounts: split pre→Pre-tax band,
    // post→Roth band. Runs BEFORE PRE_TAX_TYPES so a MIXED TSP isn't
    // double-routed.
    if (
      acct.taxTreatment === 'MIXED' &&
      isRothDesignatedRetirementType(acct.type)
    ) {
      const acctYear = balMap.get(acct.id);
      preTax += acctYear?.preEnd ?? 0;
      roth += acctYear?.postEnd ?? 0;
      return;
    }
    // Pure POST_TAX Roth-designated retirement accounts route the full
    // balance to the Roth band before the PRE_TAX_TYPES check.
    if (
      acct.taxTreatment === 'POST_TAX' &&
      isRothDesignatedRetirementType(acct.type)
    ) {
      roth += balMap.get(acct.id)?.balance ?? 0;
      return;
    }
    const bal = balMap.get(acct.id)?.balance ?? 0;
    if (PRE_TAX_TYPES.has(acct.type)) preTax += bal;
    else if (ROTH_TYPES.has(acct.type)) roth += bal;
    else if (TAXABLE_TYPES.has(acct.type)) taxable += bal;
    else if (HSA_TYPES.has(acct.type)) hsa += bal;
    else if (CASH_TYPES.has(acct.type)) cash += bal;
  });
  return { preTax, roth, taxable, hsa, cash };
}

/** The per-AccountType bucket dataKey an account routes to (Type grouping). */
function bucketKeyForAccount(acct: AccountMeta): string {
  if (acct.taxTreatment === 'MIXED' && isRothDesignatedRetirementType(acct.type)) {
    // A MIXED Roth-designated account contributes to both Pre-tax and Roth; for
    // carried-forward signalling treat it under Pre-tax (the dominant bucket).
    return 'acct_preTax';
  }
  if (acct.taxTreatment === 'POST_TAX' && isRothDesignatedRetirementType(acct.type)) {
    return 'acct_roth';
  }
  if (PRE_TAX_TYPES.has(acct.type)) return 'acct_preTax';
  if (ROTH_TYPES.has(acct.type)) return 'acct_roth';
  if (TAXABLE_TYPES.has(acct.type)) return 'acct_taxable';
  if (HSA_TYPES.has(acct.type)) return 'acct_hsa';
  if (CASH_TYPES.has(acct.type)) return 'acct_cash';
  return 'acct_cash';
}

/** Classify each row of a series into a zone kind, then collapse contiguous
 *  runs into `SeriesZone` spans covering `[fromX, toX]` (adjacent spans share
 *  their boundary year). A row is `projected` when it sits past the boundary
 *  year; otherwise `carried` when the series is held flat that year, else
 *  `actual`. Returns a single zone (no split) when the whole series is one
 *  kind. */
function buildSeriesZones({
  timeline,
  boundaryYear,
  carried,
}: {
  timeline: ReadonlyArray<StackBandYear>;
  boundaryYear: number | null;
  carried: boolean[];
}): SeriesZone[] {
  const kinds = timeline.map((yr, i): SeriesZone['kind'] => {
    if (yr.zone === 'projected') return 'projected';
    if (boundaryYear != null && yr.year > boundaryYear) return 'projected';
    return carried[i] ? 'carried' : 'actual';
  });

  const zones: SeriesZone[] = [];
  let start = 0;
  for (let i = 1; i <= kinds.length; i++) {
    if (i === kinds.length || kinds[i] !== kinds[start]) {
      const kind = kinds[start];
      // Each span extends one row BEFORE its start so the filled area visually
      // connects to the prior zone at their shared boundary row. The forward
      // end is NOT extended — only one row is shared per boundary, avoiding the
      // double-paint opacity darkening that a two-row overlap would cause.
      const fromIdx = Math.max(0, start - 1);
      const toIdx = i - 1;
      zones.push({
        kind,
        fromX: timeline[fromIdx].year,
        toX: timeline[toIdx].year,
        fillOpacity: ZONE_FILL_OPACITY[kind],
        strokeDasharray: ZONE_DASH[kind],
      });
      start = i;
    }
  }
  return zones;
}

/** Fill opacity per zone kind: actual full, carried muted, projected lighter.
 * The base series opacity is 0.55. */
const ZONE_FILL_OPACITY: Record<SeriesZone['kind'], number> = {
  actual: 0.55,
  carried: 0.3,
  projected: 0.28,
};

/** Top-edge dash per zone kind — only carried-forward spans dash. */
const ZONE_DASH: Record<SeriesZone['kind'], string | undefined> = {
  actual: undefined,
  carried: '4 3',
  projected: undefined,
};
