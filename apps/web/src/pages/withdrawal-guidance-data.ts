/** Projected withdrawals page data mapping: deterministic per-method drawdown into per-year, per-account guidance rows and hero figures. */
import type { DrawdownYear } from '../lib/drawdown-engine-types';
import { rmdEligibleWithdrawnCents } from '../lib/drawdown-engine-types';
import { isRothDesignatedPostBucket } from '../lib/balance-calc';
import type { AccountPayload } from '../db/types';
import {
  buildRmdAggregationGroups,
  type RmdAggregationGroup,
  type RmdGroupingAccount,
} from '../lib/rmd-aggregation-groups';

/** Account metadata with `taxTreatment`, so the MIXED sub-bucket split can gate on the account type. */
export interface GuidanceAccountMeta extends RmdGroupingAccount {
  readonly taxTreatment: AccountPayload['taxTreatment'];
}

export interface GuidanceAccountRow {
  readonly accountId: string;
  readonly accountName: string;
  readonly withdrawnDollars: number;
  readonly endingBalanceDollars: number;
  readonly rmdDollars: number;
  /** HSA only: the medical-qualified portion of the withdrawal, tax-free. */
  readonly hsaMedicalQualifiedDollars?: number;
  /** HSA only: the residual emergency-reserve portion, tapped after every non-HSA account is exhausted. */
  readonly hsaEmergencyReserveDollars?: number;
  readonly isMixed?: boolean;
  /** MIXED, named strategy: pre-tax portion. Gated on field presence (preWithdrawnCents !== undefined), not truthiness. */
  readonly preTaxWithdrawnDollars?: number;
  /** MIXED, named strategy: the residual (withdrawn minus pre-tax), so pre + post equals the total. */
  readonly postWithdrawnDollars?: number;
  /** MIXED, named strategy: label of the post-tax bucket ('Roth' for Roth-designated types). */
  readonly postLabel?: string;
}

export interface GuidanceYearRow {
  readonly year: number;
  readonly totalWithdrawnDollars: number;
  /** federalTaxCents + irmaaSurchargeCents. */
  readonly taxAndMedicareDollars: number;
  readonly spendableDollars: number;
  readonly hasWithdrawal: boolean;
  readonly rmdGroups: ReadonlyArray<RmdAggregationGroup>;
  /** From the IRS-aggregation-aware groups, not per-account rmdShortfallCents, so a compliant uneven draw within a group is not a false shortfall. */
  readonly hasRmdShortfall: boolean;
  /** Plain-English notes from the engine's own required-withdrawal disclosures; empty when there is nothing to disclose. */
  readonly rmdDisclosures: ReadonlyArray<string>;
  readonly accounts: ReadonlyArray<GuidanceAccountRow>;
}

function c2d(cents: number | undefined): number {
  return (cents ?? 0) / 100;
}

// Gross withdrawn (includes Roth) less portfolio-funded tax/Medicare and the reinvested or cash-held RMD surplus, plus the ACA credit.
// Withheld IRMAA comes out of Social Security, so it is not subtracted.
function spendableDollars(year: DrawdownYear): number {
  const cents =
    Math.round(year.withdrawn * 100) -
    (year.federalTaxCashNeedCents ?? 0) -
    (year.irmaaCashNeedCents ?? 0) +
    (year.acaPtcCashflowOffsetCents ?? 0) -
    (year.rmdReinvestedCents ?? 0) -
    (year.rmdOverflowToCashCents ?? 0);
  return Math.max(0, cents) / 100;
}

function buildRmdDisclosures(
  year: DrawdownYear,
  accountsById: ReadonlyMap<string, GuidanceAccountMeta>,
): string[] {
  const nameOf = (id: string): string => accountsById.get(id)?.name ?? id;
  const list = (ids: readonly string[]): string => ids.map(nameOf).sort().join(', ');
  const out: string[] = [];
  const withheld = year.rmdWithheldAccountIds ?? [];
  if (withheld.length > 0) {
    // Reason-agnostic: the engine also withholds for owner-path reasons and for rules it does not model, so this line states only that the figure was withheld rather than guessed.
    out.push(
      `No required withdrawal is included for ${list(withheld)} — the details this account's rule needs are not all available, so the estimate is on hold rather than guessed. Open the account to see exactly what is needed.`,
    );
  }
  const stillWorking = year.rmdStillWorkingDeferredAccountIds ?? [];
  if (stillWorking.length > 0) {
    out.push(
      `${list(stillWorking)}: no withdrawal is required yet because you are still working for the employer that holds the plan.`,
    );
  }
  const firstYearDeferred = year.rmdFirstYearDeferredAccountIds ?? [];
  if (firstYearDeferred.length > 0) {
    out.push(
      `${list(firstYearDeferred)}: the first required withdrawal is deferred to April 1 of next year, so next year carries two.`,
    );
  }
  const catchUpCents = year.rmdDeferredCatchUpCents ?? 0;
  if (catchUpCents > 0) {
    out.push(
      `Includes ${(catchUpCents / 100).toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      })} deferred from last year, so two required withdrawals fall in this year.`,
    );
  }
  return out;
}

export function buildGuidanceYearRows(
  years: ReadonlyArray<DrawdownYear>,
  accountsById: ReadonlyMap<string, GuidanceAccountMeta>,
): ReadonlyArray<GuidanceYearRow> {
  return years.map((year) => {
    const perAccountRmd = year.perAccountRmdCents ?? {};
    const accounts: GuidanceAccountRow[] = [];
    if (year.accountBalances) {
      for (const [accountId, row] of year.accountBalances) {
        const withdrawnDollars = row.withdrawn;
        const rmdDollars = c2d(perAccountRmd[accountId]);
        if (withdrawnDollars <= 0 && rmdDollars <= 0) continue;
        const meta = accountsById.get(accountId);
        const isHsa = meta?.type === 'HSA';
        const medicalQualifiedDollars = isHsa ? c2d(row.medicalQualifiedWithdrawnCents) : 0;

        // Gate on field presence, not truthiness: preWithdrawnCents 0 is a valid year whose whole draw is from the post-tax bucket.
        const isMixed = meta?.taxTreatment === 'MIXED';
        const hasSplitData = isMixed && row.preWithdrawnCents !== undefined;
        let mixedFields: Partial<GuidanceAccountRow> = {};
        if (isMixed) {
          mixedFields = { isMixed: true };
          if (hasSplitData) {
            const preTaxWithdrawnDollars = c2d(row.preWithdrawnCents);
            const postWithdrawnDollars = withdrawnDollars - preTaxWithdrawnDollars;
            const isRothPost = isRothDesignatedPostBucket(
              meta!.taxTreatment,
              meta!.type,
            );
            mixedFields = {
              isMixed: true,
              preTaxWithdrawnDollars,
              postWithdrawnDollars,
              postLabel: isRothPost
                ? 'Roth'
                : 'after-tax contributions (gains taxable)',
            };
          }
        }

        accounts.push({
          accountId,
          accountName: meta?.name ?? accountId,
          withdrawnDollars,
          endingBalanceDollars: row.balance,
          rmdDollars,
          ...(isHsa
            ? {
                hsaMedicalQualifiedDollars: medicalQualifiedDollars,
                hsaEmergencyReserveDollars: Math.max(0, withdrawnDollars - medicalQualifiedDollars),
              }
            : {}),
          ...mixedFields,
        });
      }
    }
    accounts.sort((a, b) => a.accountName.localeCompare(b.accountName));

    const { groups } = year.perAccountRmdCents
      ? buildRmdAggregationGroups(perAccountRmd, accountsById)
      : { groups: [] as ReadonlyArray<RmdAggregationGroup> };

    const taxAndMedicareDollars =
      c2d(year.federalTaxCents) + c2d(year.irmaaSurchargeCents);

    return {
      year: year.year,
      totalWithdrawnDollars: year.withdrawn,
      taxAndMedicareDollars,
      spendableDollars: spendableDollars(year),
      hasWithdrawal: year.withdrawn > 0,
      rmdGroups: groups,
      rmdDisclosures: buildRmdDisclosures(year, accountsById),
      hasRmdShortfall:
        groups.length > 0 &&
        groups.some((group) => {
          // Per-plan groups count only that account's withdrawal; aggregatable groups (IRA / 403(b)) can be satisfied by any same-type, same-owner account, including ones absent from group.accounts.
          let withdrawnCents: number;
          if (group.kind === 'per-plan') {
            const accId = group.accounts[0]?.id ?? '';
            const row = year.accountBalances?.get(accId);
            // Stale cache (no meta) is treated as PRE_TAX: the full withdrawn is conservative and never hides a shortfall.
            const meta = accountsById.get(accId);
            const taxTreatment = meta?.taxTreatment ?? 'PRE_TAX';
            withdrawnCents = row
              ? rmdEligibleWithdrawnCents(row, taxTreatment)
              : 0;
          } else {
            withdrawnCents = 0;
            if (year.accountBalances) {
              for (const [accId, row] of year.accountBalances) {
                const meta = accountsById.get(accId);
                if (
                  meta &&
                  meta.ownerId === group.ownerId &&
                  meta.type === group.accountType
                ) {
                  withdrawnCents += rmdEligibleWithdrawnCents(row, meta.taxTreatment);
                }
              }
            }
          }
          // §408(d)(8): a QCD offsets only the owner's traditional-IRA aggregation group (RETIREMENT_IRA), never a 403(b) or per-plan group; one IRA group per owner, so no double-credit.
          const qcdOffsetCents =
            group.kind === 'aggregatable' && group.accountType === 'RETIREMENT_IRA'
              ? Math.max(0, year.qcdRmdOffsetCentsByOwner?.[group.ownerId] ?? 0)
              : 0;
          return withdrawnCents + qcdOffsetCents < group.requiredCents;
        }),
      accounts,
    };
  });
}

/** Scales every dollar field into a display-basis copy by `deflate(year)`; optional HSA/MIXED fields scale only when present, and the input is not mutated (the PDF adapter never deflates). */
export function deflateGuidanceRows(
  rows: ReadonlyArray<GuidanceYearRow>,
  deflate: (year: number) => number,
): ReadonlyArray<GuidanceYearRow> {
  return rows.map((row) => {
    const f = deflate(row.year);
    const accounts: GuidanceAccountRow[] = row.accounts.map((a) => ({
      ...a,
      withdrawnDollars: a.withdrawnDollars * f,
      endingBalanceDollars: a.endingBalanceDollars * f,
      rmdDollars: a.rmdDollars * f,
      ...(a.hsaMedicalQualifiedDollars !== undefined
        ? { hsaMedicalQualifiedDollars: a.hsaMedicalQualifiedDollars * f }
        : {}),
      ...(a.hsaEmergencyReserveDollars !== undefined
        ? { hsaEmergencyReserveDollars: a.hsaEmergencyReserveDollars * f }
        : {}),
      ...(a.preTaxWithdrawnDollars !== undefined
        ? { preTaxWithdrawnDollars: a.preTaxWithdrawnDollars * f }
        : {}),
      ...(a.postWithdrawnDollars !== undefined
        ? { postWithdrawnDollars: a.postWithdrawnDollars * f }
        : {}),
    }));
    const rmdGroups: ReadonlyArray<RmdAggregationGroup> = row.rmdGroups.map(
      (group) => ({
        ...group,
        requiredCents: group.requiredCents * f,
        accounts: group.accounts.map((ga) => ({
          ...ga,
          requiredCents: ga.requiredCents * f,
        })),
      }),
    );
    return {
      ...row,
      totalWithdrawnDollars: row.totalWithdrawnDollars * f,
      taxAndMedicareDollars: row.taxAndMedicareDollars * f,
      spendableDollars: row.spendableDollars * f,
      rmdGroups,
      accounts,
    };
  });
}

/** Index of the row for `year`, nearest in range; `-1` when rows are empty or the year precedes the first row, so the caller can show a "before range" state. */
export function indexForYear(
  rows: ReadonlyArray<GuidanceYearRow>,
  year: number,
): number {
  if (rows.length === 0) return -1;
  const exact = rows.findIndex((r) => r.year === year);
  if (exact >= 0) return exact;
  if (year < rows[0].year) return -1;
  return rows.length - 1;
}
