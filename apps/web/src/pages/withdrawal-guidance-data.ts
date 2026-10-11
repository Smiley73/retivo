/**
 * Projected withdrawals page — pure data mapping. Turns the deterministic
 * `runBalanceProjectionForPage` per-method output into the page's per-year /
 * per-account guidance rows + the selected-year hero figures.
 *
 * READ-ONLY presentation: every dollar field comes straight off the engine's
 * `DrawdownYear` (nominal); the page deflates at the display boundary via
 * `realDeflatorAt`. No new engine math.
 */
import type { DrawdownYear } from '../lib/drawdown-engine-types';
import { rmdEligibleWithdrawnCents } from '../lib/drawdown-engine-types';
import { isRothDesignatedPostBucket } from '../lib/balance-calc';
import type { AccountPayload } from '../db/types';
import {
  buildRmdAggregationGroups,
  type RmdAggregationGroup,
  type RmdGroupingAccount,
} from '../lib/rmd-aggregation-groups';

/**
 * Extended account metadata for the Projected withdrawals page. Carries
 * `taxTreatment` in addition to the RMD-grouping fields so the data layer can
 * gate the MIXED sub-bucket split on the correct account type.
 *
 * Structural subtyping: `ReadonlyMap<string, GuidanceAccountMeta>` satisfies
 * `ReadonlyMap<string, RmdGroupingAccount>` wherever the RMD helpers expect it.
 */
export interface GuidanceAccountMeta extends RmdGroupingAccount {
  readonly taxTreatment: AccountPayload['taxTreatment'];
}

/** One account's withdrawal line within a guidance year (nominal cents/dollars). */
export interface GuidanceAccountRow {
  readonly accountId: string;
  readonly accountName: string;
  /** Gross withdrawal pulled from the account this year (nominal dollars). */
  readonly withdrawnDollars: number;
  /** Ending balance after the withdrawal (nominal dollars). */
  readonly endingBalanceDollars: number;
  /** Required RMD attributed to this account this year (nominal dollars); 0
   *  when the account carries no RMD (or below trigger age). */
  readonly rmdDollars: number;
  /** HSA accounts only: the medical-qualified portion of this year's HSA
   *  withdrawal (nominal dollars) — funded against modeled medical costs,
   *  tax-free. `undefined` for non-HSA accounts. */
  readonly hsaMedicalQualifiedDollars?: number;
  /** HSA accounts only: the emergency-reserve portion of this year's HSA
   *  withdrawal (nominal dollars) — the residual `withdrawn − medicalQualified`,
   *  tapped only after every non-HSA account is exhausted. `undefined` for
   *  non-HSA accounts. */
  readonly hsaEmergencyReserveDollars?: number;
  /** True for MIXED accounts. Enables the MixedSplitNote. */
  readonly isMixed?: boolean;
  /** MIXED accounts only, named strategy: the pre-tax portion of this
   *  year's withdrawal (nominal dollars). Gated on `preWithdrawnCents !==
   *  undefined` — i.e. field presence, NOT truthiness. `undefined` when no
   *  per-sub-account split data is available. */
  readonly preTaxWithdrawnDollars?: number;
  /** MIXED accounts only, named strategy: the post-tax / Roth portion of
   *  this year's withdrawal (nominal dollars). Residual rule: `postWithdrawnDollars
   *  = withdrawnDollars − preTaxWithdrawnDollars`, guaranteeing pre + post ===
   *  total (the same pattern as HSA). `undefined` when no split data is available. */
  readonly postWithdrawnDollars?: number;
  /** MIXED accounts only, named strategy: label for the post-tax bucket.
   *  `'Roth'` for Roth-designated MIXED types (401K/403B/457B/TSP);
   *  `'after-tax contributions (gains taxable)'` for OTHER MIXED. `undefined`
   *  when no split data is available. */
  readonly postLabel?: string;
}

/** Per-year guidance row — totals + per-account lines + RMD groups + tax pair. */
export interface GuidanceYearRow {
  readonly year: number;
  /** Total gross portfolio withdrawal this year (nominal dollars). */
  readonly totalWithdrawnDollars: number;
  /** Income tax + Medicare for the year, nominal dollars:
   *  `federalTaxCents + irmaaSurchargeCents`. */
  readonly taxAndMedicareDollars: number;
  /** After-tax spendable for the year, nominal dollars. */
  readonly spendableDollars: number;
  /** True when the household has any portfolio withdrawal this year. */
  readonly hasWithdrawal: boolean;
  /** RMD presented by legal aggregation group; `[]` below trigger age
   *  or when no account carries a qualifying-balance RMD. */
  readonly rmdGroups: ReadonlyArray<RmdAggregationGroup>;
  /** True when any legal aggregation group's combined withdrawals fall short of
   *  its required minimum. Derived from the IRS-aggregation-aware groups,
   *  NOT the per-account engine `rmdShortfallCents`, so a compliant uneven draw
   *  within an aggregatable group (e.g. one IRA covering the group) is not a
   *  false shortfall. */
  readonly hasRmdShortfall: boolean;
  /**
   * Plain-English notes built from the ENGINE's own required-withdrawal
   * disclosures for the year (`DrawdownYear.rmdWithheldAccountIds` /
   * `rmdStillWorkingDeferredAccountIds` / `rmdFirstYearDeferredAccountIds` /
   * `rmdDeferredCatchUpCents`). Empty for a year with nothing to disclose, which
   * is every year of a household that records no inherited / still-working /
   * deferral facts.
   */
  readonly rmdDisclosures: ReadonlyArray<string>;
  readonly accounts: ReadonlyArray<GuidanceAccountRow>;
}

/** cents → dollars. */
function c2d(cents: number | undefined): number {
  return (cents ?? 0) / 100;
}

/**
 * After-tax spendable (nominal dollars). Of the gross dollars pulled from
 * the portfolio (`withdrawn`, which INCLUDES Roth), what's left after the
 * taxes/Medicare funded FROM the portfolio and after any forced-RMD surplus the
 * engine immediately reinvested / held as cash (NOT spent this year), with the
 * ACA credit added back. Withheld IRMAA is NOT subtracted (it comes out of
 * Social Security, not the portfolio). `rmdReinvestedCents` /
 * `rmdOverflowToCashCents` are 0 on the bucket-allocation path, so the formula
 * degrades.
 */
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

/**
 * Turn one year's ENGINE required-withdrawal disclosures into plain
 * English, naming the accounts. This is the user-facing consumer of the shared
 * RMD engine's authoritative withheld / deferred truth: the page never re-derives
 * its own looser version of "is this account ready", it states what the engine
 * actually did. Returns `[]` when the year has nothing to disclose.
 */
function buildRmdDisclosures(
  year: DrawdownYear,
  accountsById: ReadonlyMap<string, GuidanceAccountMeta>,
): string[] {
  const nameOf = (id: string): string => accountsById.get(id)?.name ?? id;
  const list = (ids: readonly string[]): string => ids.map(nameOf).sort().join(', ');
  const out: string[] = [];
  const withheld = year.rmdWithheldAccountIds ?? [];
  if (withheld.length > 0) {
    // Reason-agnostic on purpose: the engine withholds for owner-path reasons too (an
    // unknown separation year, a first-year catch-up whose base predates the
    // projection) and for two rules it does not model at all, where nothing is
    // "missing". The account editor names the exact ask per account; this line only
    // states that the year's figure was withheld rather than guessed.
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

/** Build the per-year guidance rows from one method's raw drawdown `years`. */
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
        // Skip accounts that neither paid out nor carry an RMD this year — the
        // guidance lines should show only accounts the retiree acts on.
        if (withdrawnDollars <= 0 && rmdDollars <= 0) continue;
        // HSA: split an HSA withdrawal into its medical-qualified portion
        // (funded against modeled medical costs, tax-free) and the
        // emergency-reserve residual (`withdrawn − medicalQualified`). The
        // residual rule keeps the two summing to the committed withdrawal. Only
        // HSA accounts surface the split — non-HSA rows leave both undefined.
        const meta = accountsById.get(accountId);
        const isHsa = meta?.type === 'HSA';
        const medicalQualifiedDollars = isHsa ? c2d(row.medicalQualifiedWithdrawnCents) : 0;

        // MIXED: gate the pre/post split on field PRESENCE, not
        // truthiness — `preWithdrawnCents: 0` is a valid named-strategy year
        // where the entire draw is from the post (Roth/after-tax) bucket and
        // must render the split note, not the unavailable note.
        const isMixed = meta?.taxTreatment === 'MIXED';
        const hasSplitData = isMixed && row.preWithdrawnCents !== undefined;
        let mixedFields: Partial<GuidanceAccountRow> = {};
        if (isMixed) {
          mixedFields = { isMixed: true };
          if (hasSplitData) {
            const preTaxWithdrawnDollars = c2d(row.preWithdrawnCents);
            // Residual rule: derive post from total to guarantee
            // preTax + post === withdrawnDollars (matches HSA pattern).
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
          // For per-plan groups the withdrawal must come from the one specific
          // account, so only that account's withdrawal counts. For aggregatable
          // groups (IRA / 403(b)) the RMD may be satisfied by ANY same-type /
          // same-owner account — including ones with zero individual required
          // share that are therefore absent from `group.accounts`. Sum
          // withdrawals from ALL matching accounts in accountsById.
          let withdrawnCents: number;
          if (group.kind === 'per-plan') {
            const accId = group.accounts[0]?.id ?? '';
            const row = year.accountBalances?.get(accId);
            // Count the withdrawn cents that actually satisfy this
            // account's requirement — the shared `rmdEligibleWithdrawnCents` rule
            // (full `withdrawn` for PRE_TAX and for a pure Roth account whose
            // beneficiary distribution satisfies §401(a)(9)(B) untaxed; the
            // pre-tax tranche only for MIXED; 0 for HSA). When
            // `accountsById.get(...)` is undefined (stale cache) treat as
            // PRE_TAX — full `withdrawn` is conservative (never hides a shortfall
            // for a PRE_TAX account). `row` undefined → 0 withdrawn.
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
                  // Same shared satisfying-withdrawal rule as above.
                  withdrawnCents += rmdEligibleWithdrawnCents(row, meta.taxTreatment);
                }
              }
            }
          }
          // QCD offset (§408(d)(8)): a QCD satisfies the directing owner's
          // IRA-pool RMD. `qcdRmdOffsetCentsByOwner` is the per-owner IRA-pool
          // offset, so credit it as withdrawn-equivalent ONLY toward that owner's
          // traditional-IRA aggregation group (`RETIREMENT_IRA`) — never a 403(b)
          // aggregatable group nor any per-plan 401(k)/457/TSP/CBP group (those
          // keep the unchanged gross comparison). One IRA aggregation group per
          // owner, so no double-credit. Mirrors balance-projection-runner-tax.ts.
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

/**
 * Scale every dollar field of a set of nominal `GuidanceYearRow`s into a
 * DISPLAY-basis copy, multiplying each year's figures by `deflate(year)` (the
 * caller's `basisDeflator`). Pure — returns a fresh array; the input is never
 * mutated. The PDF builder (`buildWithdrawalGuidanceTableSpec`) consumes the
 * result and only formats, never deflates (the PDF "never deflate in the table
 * adapter" invariant).
 *
 * Scaled fields: the summary (`totalWithdrawnDollars` / `taxAndMedicareDollars`
 * / `spendableDollars`), every per-account withdrawn / ending / RMD / HSA-split
 * / MIXED-split dollar field, and each `rmdGroups` group + account
 * `requiredCents` (cents scale by the same factor). Presence-gated optional
 * fields (HSA / MIXED splits) are scaled only when present, so an absent field
 * stays absent (the builder reads the same presence gate). Booleans, ids,
 * names, labels, and the residual-rule structure are preserved verbatim.
 */
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

/**
 * Index of the row matching `year`, or the nearest in range. Returns `-1` both
 * when `rows` is empty AND when `year` is before the first row's year (so the
 * caller can render a distinct "before the projected range" state rather than
 * silently labelling the first drawdown year as the selected year).
 */
export function indexForYear(
  rows: ReadonlyArray<GuidanceYearRow>,
  year: number,
): number {
  if (rows.length === 0) return -1;
  const exact = rows.findIndex((r) => r.year === year);
  if (exact >= 0) return exact;
  // Before the first projected year → -1 (caller handles "before range");
  // after the last → clamp to the last row. (The stepper never lands here.)
  if (year < rows[0].year) return -1;
  return rows.length - 1;
}
