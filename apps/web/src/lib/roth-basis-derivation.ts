/**
 * §408A Roth-IRA basis derived from recorded balance history for one pool (one person's own Roth IRAs); pure
 * integer-cent math. Both engines read it through `buildRothDistributionFacts`; scoping (type, active, inherited, owner) is the caller's job.
 */
import {
  isValidRothMoney,
  isValidRothTaxYear,
  rothFactDollarsToCents,
  safeRothCentsFromBigInt,
} from '../db/roth-fact-validation';
import type { AccountBalancePayload } from '../db/types';
import type { RothConversionLotCents } from './roth-distribution-tax';

/** What one §408A pool has left after the recorded history is walked. */
interface DerivedRothPoolBasisCents {
  readonly regularContributionBasisCents: number;
  /** One merged lot per tax year, ascending; fully consumed lots are omitted. */
  readonly conversionLots: readonly RothConversionLotCents[];
}

interface PoolRowCents {
  readonly year: number;
  readonly startingCents: bigint;
  readonly endingCents: bigint;
  readonly totalContributionCents: bigint;
  readonly personalContributionCents: bigint;
  readonly rolloverCents: bigint;
  readonly distributionCents: bigint;
  readonly conversionTaxableCents: bigint;
  readonly conversionNontaxableCents: bigint;
}

interface MutableLotCents {
  readonly taxYear: number;
  taxableCents: bigint;
  nontaxableCents: bigint;
}

interface AnnualPoolTotals {
  readonly years: readonly number[];
  readonly contributionByYear: ReadonlyMap<number, bigint>;
  readonly outflowByYear: ReadonlyMap<number, bigint>;
  readonly lotByYear: ReadonlyMap<number, MutableLotCents>;
}

/**
 * Remaining regular-contribution basis and conversion lots of one §408A pool, counting only rows of `accounts`.
 * Pure; the result is order-independent except that a duplicate `(accountId, year)` resolves to the first row
 * (never a sum, which would inflate basis). A recorded `rollover` is read only as balance arithmetic, never as basis.
 *
 * Known limits: a recharacterised contribution (§408A(d)(6)), an excess contribution returned before the
 * deadline and a Roth IRA transferred incident to divorce reduce basis but fit no `distributions` field, so
 * basis can be overstated there. A designated-Roth rollover into a Roth IRA is ordered as earnings, though
 * Treas. Reg. §1.408A-10 Q&A-3 makes it a regular contribution for the §1.408A-6 Q&A-8 ordering; the row does
 * not say how much was contribution, so this over-taxes. A withdrawal offset by untracked growth is under-imputed.
 */
export function deriveRothPoolBasisCents(
  accounts: ReadonlyArray<{ id: string }>,
  balances: ReadonlyArray<{ payload: AccountBalancePayload }>,
): DerivedRothPoolBasisCents {
  const poolAccountIds = new Set(accounts.map((account) => account.id));
  const rowsByAccount = readPoolRows(poolAccountIds, balances);
  return consumePoolChronologically(collectAnnualTotals(rowsByAccount));
}

// Re-applies isValidRothMoney's bound: rothFactDollarsToCents alone accepts a magnitude just past it whose ×100 is still a safe integer.
function nonnegativeRothDollarsToCents(dollars: unknown): number {
  return isValidRothMoney(dollars) ? rothFactDollarsToCents(dollars) : 0;
}

// Signed, for `rollover` alone: the shared converter zeroes a negative, which would discard an outbound rollover, the leg that explains a drop.
function signedRothDollarsToCents(dollars: unknown): number {
  if (typeof dollars !== 'number' || !isValidRothMoney(Math.abs(dollars))) return 0;
  const cents = Math.round(dollars * 100);
  return Number.isSafeInteger(cents) ? cents : 0;
}

/**
 * The row's recorded contributions in cents: the full total the balance arithmetic uses, and the personal share
 * credited as §408A basis (`totalContributions − companyContributions`, floored at 0; on a MIXED row the two
 * personal splits, with the flat `companyContributions` never subtracted again). Each field is validated on its
 * own magnitude and summed in `bigint`, since a MIXED row whose splits are each in range can sum past
 * `isValidRothMoney`'s single-field bound. Mirrors `totalContributions` (`balance-calc.ts`) so a zeroed-out
 * row's imputed residual equals `−gainLoss`. Shared with `hasRetypeBlockingHistory` so the two cannot disagree.
 */
export function contributionCentsOf(payload: AccountBalancePayload): {
  readonly totalCents: bigint;
  readonly personalCents: bigint;
} {
  if (payload.contributionsPreTax !== null || payload.contributionsPostTax !== null) {
    const personalCents =
      BigInt(nonnegativeRothDollarsToCents(payload.contributionsPreTax)) +
      BigInt(nonnegativeRothDollarsToCents(payload.contributionsPostTax));
    return {
      totalCents:
        personalCents +
        BigInt(nonnegativeRothDollarsToCents(payload.companyContributionsPreTax)) +
        BigInt(nonnegativeRothDollarsToCents(payload.companyContributionsPostTax)),
      personalCents,
    };
  }
  const totalCents = BigInt(nonnegativeRothDollarsToCents(payload.totalContributions));
  const companyCents = BigInt(nonnegativeRothDollarsToCents(payload.companyContributions));
  return {
    totalCents,
    // Floored at 0: a negative basis would grow the year's outflow and over-consume the conversion lots.
    personalCents: totalCents > companyCents ? totalCents - companyCents : 0n,
  };
}

function toPoolRow(payload: AccountBalancePayload): PoolRowCents {
  // An invalid magnitude reads as 0: an import-bundle row bypasses the migrations that sanitise these keys.
  const { totalCents, personalCents } = contributionCentsOf(payload);
  return {
    year: payload.year,
    startingCents: BigInt(nonnegativeRothDollarsToCents(payload.startingBalance)),
    endingCents: BigInt(nonnegativeRothDollarsToCents(payload.endingBalance)),
    totalContributionCents: totalCents,
    personalContributionCents: personalCents,
    rolloverCents: BigInt(signedRothDollarsToCents(payload.rollover)),
    distributionCents: BigInt(nonnegativeRothDollarsToCents(payload.distributions)),
    conversionTaxableCents: BigInt(
      nonnegativeRothDollarsToCents(payload.rothConversionTaxableAmount),
    ),
    conversionNontaxableCents: BigInt(
      nonnegativeRothDollarsToCents(payload.rothConversionNontaxableAmount),
    ),
  };
}

function readPoolRows(
  poolAccountIds: ReadonlySet<string>,
  balances: ReadonlyArray<{ payload: AccountBalancePayload }>,
): Map<string, PoolRowCents[]> {
  const byAccount = new Map<string, Map<number, PoolRowCents>>();
  for (const { payload } of balances) {
    if (!poolAccountIds.has(payload.accountId)) continue;
    // A row without a usable year can be neither ordered nor dated, so it is dropped and claims no slot.
    if (!isValidRothTaxYear(payload.year)) continue;
    let byYear = byAccount.get(payload.accountId);
    if (!byYear) {
      byYear = new Map<number, PoolRowCents>();
      byAccount.set(payload.accountId, byYear);
    }
    // The first row in input order wins, never a sum.
    if (byYear.has(payload.year)) continue;
    byYear.set(payload.year, toPoolRow(payload));
  }
  const rowsByAccount = new Map<string, PoolRowCents[]>();
  for (const [accountId, byYear] of byAccount.entries()) {
    rowsByAccount.set(accountId, [...byYear.values()].sort((a, b) => a.year - b.year));
  }
  return rowsByAccount;
}

function rowResidualCents(row: PoolRowCents): bigint {
  if (row.startingCents <= 0n || row.endingCents !== 0n) return 0n;
  const residual =
    row.startingCents +
    row.totalContributionCents +
    row.rolloverCents -
    row.distributionCents -
    row.endingCents;
  return residual > 0n ? residual : 0n;
}

function addCents(into: Map<number, bigint>, year: number, cents: bigint): void {
  if (cents === 0n) return;
  into.set(year, (into.get(year) ?? 0n) + cents);
}

// Two imputed shapes. Row residual: a positive start with exactly $0 end imputes max(0, starting + contributions
// + rollover − distributions − ending) in its own year. Boundary chain: a row starting at exactly $0 is skipped
// (the app manufactures those zeros) but its flows net into the span from the nearest not-skipped row's ending
// to the next positive start, imputing max(0, nearEnding + Σcontributions + Σrollover − Σdistributions − farStarting)
// in the far side's year. A net increase imputes nothing.
function imputeAccountOutflows(
  rows: readonly PoolRowCents[],
  outflowByYear: Map<number, bigint>,
): void {
  let nearEndingCents: bigint | undefined;
  let skippedContributionCents = 0n;
  let skippedRolloverCents = 0n;
  let skippedDistributionCents = 0n;
  for (const row of rows) {
    addCents(outflowByYear, row.year, rowResidualCents(row));
    if (row.startingCents === 0n) {
      skippedContributionCents += row.totalContributionCents;
      skippedRolloverCents += row.rolloverCents;
      skippedDistributionCents += row.distributionCents;
      continue;
    }
    if (nearEndingCents !== undefined) {
      const shortfall =
        nearEndingCents +
        skippedContributionCents +
        skippedRolloverCents -
        skippedDistributionCents -
        row.startingCents;
      addCents(outflowByYear, row.year, shortfall > 0n ? shortfall : 0n);
    }
    nearEndingCents = row.endingCents;
    skippedContributionCents = 0n;
    skippedRolloverCents = 0n;
    skippedDistributionCents = 0n;
  }
}

function collectAnnualTotals(
  rowsByAccount: ReadonlyMap<string, readonly PoolRowCents[]>,
): AnnualPoolTotals {
  const contributionByYear = new Map<number, bigint>();
  const outflowByYear = new Map<number, bigint>();
  const lotByYear = new Map<number, MutableLotCents>();
  const years = new Set<number>();
  for (const rows of rowsByAccount.values()) {
    for (const row of rows) {
      years.add(row.year);
      addCents(contributionByYear, row.year, row.personalContributionCents);
      addCents(outflowByYear, row.year, row.distributionCents);
      if (row.conversionTaxableCents > 0n || row.conversionNontaxableCents > 0n) {
        const lot = lotByYear.get(row.year) ?? {
          taxYear: row.year,
          taxableCents: 0n,
          nontaxableCents: 0n,
        };
        lot.taxableCents += row.conversionTaxableCents;
        lot.nontaxableCents += row.conversionNontaxableCents;
        lotByYear.set(row.year, lot);
      }
    }
    imputeAccountOutflows(rows, outflowByYear);
  }
  return {
    years: [...years].sort((a, b) => a - b),
    contributionByYear,
    outflowByYear,
    lotByYear,
  };
}

// A lot is read back as one unit: collapsing only its taxable half would draw the nontaxable half first, reversing
// §408A(d)(4)(B) and removing a pre-59½ in-window distribution from the §72(t) recapture base. An unrepresentable
// component drops the whole lot, so the outflow falls to earnings, taxed at least as heavily.
function remainingLotCents(lot: MutableLotCents): RothConversionLotCents | undefined {
  const taxableCents = safeRothCentsFromBigInt(lot.taxableCents);
  const nontaxableCents = safeRothCentsFromBigInt(lot.nontaxableCents);
  const collapsed =
    (lot.taxableCents > 0n && taxableCents === 0) ||
    (lot.nontaxableCents > 0n && nontaxableCents === 0);
  if (collapsed || (taxableCents === 0 && nontaxableCents === 0)) return undefined;
  return {
    taxYear: lot.taxYear,
    taxableConvertedPrincipalCents: taxableCents,
    nontaxableConvertedPrincipalCents: nontaxableCents,
  };
}

function consumeLot(lot: MutableLotCents, outflowCents: bigint): bigint {
  const taxableDrawn = outflowCents < lot.taxableCents ? outflowCents : lot.taxableCents;
  lot.taxableCents -= taxableDrawn;
  let remaining = outflowCents - taxableDrawn;
  const nontaxableDrawn = remaining < lot.nontaxableCents ? remaining : lot.nontaxableCents;
  lot.nontaxableCents -= nontaxableDrawn;
  remaining -= nontaxableDrawn;
  return remaining;
}

// Years ascending: credit contributions, make the year's lot available, then consume the combined outflow
// (recorded plus imputed): contribution basis first, then lots by tax year ascending (§408A(d)(4)(B): taxable before nontaxable).
function consumePoolChronologically(annual: AnnualPoolTotals): DerivedRothPoolBasisCents {
  let basisCents = 0n;
  // A lot is available to an outflow in its own year and later, matching `applyFactBasedRothIraOrdering`.
  const availableLots: MutableLotCents[] = [];
  for (const year of annual.years) {
    basisCents += annual.contributionByYear.get(year) ?? 0n;
    const lot = annual.lotByYear.get(year);
    if (lot !== undefined) availableLots.push(lot);
    let outflowCents = annual.outflowByYear.get(year) ?? 0n;
    if (outflowCents <= 0n) continue;
    const fromBasis = outflowCents < basisCents ? outflowCents : basisCents;
    basisCents -= fromBasis;
    outflowCents -= fromBasis;
    for (const availableLot of availableLots) {
      if (outflowCents <= 0n) break;
      outflowCents = consumeLot(availableLot, outflowCents);
    }
  }
  return {
    regularContributionBasisCents: safeRothCentsFromBigInt(basisCents),
    conversionLots: availableLots
      .map(remainingLotCents)
      .filter((lot): lot is RothConversionLotCents => lot !== undefined),
  };
}
