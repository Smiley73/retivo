/**
 * §408A Roth-IRA basis derived from recorded balance history — one pool, pure math.
 *
 * Given the accounts of ONE §408A pool (one person's own Roth IRAs) and the
 * household's annual `accountBalance` rows, this module returns that pool's
 * remaining regular-contribution basis and its remaining conversion lots, both in
 * integer cents. **This is the basis both engines run on.** Its ONE production
 * caller is `buildRothDistributionFacts`
 * (`balance-projection-runner-tax-helpers.ts`), the single seam where account data
 * becomes Roth basis; everything downstream — `PipelineContext.rothBasisCentsByOwner`,
 * the deterministic carriers, the Monte Carlo ordered profile — reads that adapter's
 * output, which is what makes the two engines agree structurally. A second, direct
 * call from either engine is how they would drift; do not add one.
 *
 * What this module returns is what SURVIVES the recorded history. The engine
 * carriers then consume those remainders against PROJECTED future withdrawals, so
 * the historical outflows charged here are never re-applied downstream.
 *
 * **Scoping is the caller's job.** No Roth-IRA type test, no `active` test, no
 * inherited test, no owner grouping happens here — the module is pure math over
 * whatever account set it is handed. Rows whose `accountId` is outside that set are
 * ignored, the same convention `buildRothDistributionFacts` uses.
 *
 * The rules:
 *
 *  - **Pooling is pool-level, never per-account-then-sum**, and only the
 *    PERSONAL share of a row's contributions is §408A basis:
 *    `totalContributions − companyContributions`, floored at 0. On a flat row that
 *    is one subtraction on the flat fields; on a MIXED row both terms resolve from
 *    the four splits — the two personal splits are credited, the two company
 *    splits excluded, and the flat `companyContributions` never subtracted again
 *    on top of them. A Roth IRA cannot lawfully receive employer money, but the
 *    company inputs are reachable all the same: an on-device retype of an
 *    account with real history is now blocked, so
 *    this branch is reached by imports, sync from another device, and legacy
 *    rows written before that block shipped — a MIXED employer-plan account
 *    that reached a Roth IRA by one of those routes keeps its MIXED rows,
 *    splits and all. This is a DIFFERENT contribution term from the FULL
 *    recorded total the balance arithmetic below uses; the two never collapse.
 *  - **Chronological across years, annually aggregated within a year.** One
 *    walk over the union of the pool's years, ascending. Within a year the year's
 *    contributions are credited BEFORE the year's combined outflow, and an
 *    imputed shortfall is charged against the year it lands in — the reading that
 *    consumes more, chosen deliberately because a shortfall is a net
 *    residual of unknown timing. `(accountId, year)` is unique by construction
 *    (`bal-{accountId}-{year}`); an import bundle replaying a foreign aggregate id
 *    is the one path that can still produce a duplicate, and the FIRST row in
 *    input order wins — never a sum, which would inflate basis and understate tax.
 *    That is the rule `buildDatedRothAmountsByAccount` already applies to the same
 *    rows, and it is the row both seed-balance reducers keep on their strict-`>` tie.
 *  - **A recorded `rollover` never moves contribution basis in either
 *    direction.** Inbound creates none (a §408A conversion's basis arrives as a
 *    dated lot); outbound consumes none. `rollover` is read ONLY as balance
 *    arithmetic, inside the row residual and the boundary netting, and it is ONE
 *    SIGNED TERM (positive inbound, negative outbound).
 *    One inbound shape this UNDER-credits rather than settles — a designated-Roth
 *    rollover into a Roth IRA — is disclosed below.
 *  - **Beyond contributions, lots come next.** An outflow exceeding available
 *    contribution basis consumes conversion lots by tax year ascending,
 *    taxable-converted principal before nontaxable within a year
 *    (§408A(d)(4)(B)), mirroring `applyFactBasedRothIraOrdering` so the remaining
 *    lots equal what the engine would have left. A lot is available to an outflow
 *    in its OWN year and later. Anything beyond the lots is earnings and is not
 *    tracked; nothing goes negative.
 *  - **An unexplained drop is an imputed distribution of exactly its size.**
 *    Two falsifiable shapes, and only two:
 *      1. *Row residual.* A row whose `startingBalance` is positive and
 *         whose `endingBalance` is exactly $0 imputes `max(0, starting +
 *         totalContributions + rollover − distributions − ending)`, dated in its
 *         own year — precisely `−gainLoss(payload)` for such a row. A row that
 *         fully explains its own zero-out imputes nothing; a partially-explained
 *         one imputes only the remainder. It keys on values in the row being read
 *         ALONE, so it is identical on an active and an inactive account,
 *         indifferent to which row is chronologically last, and unaffected by a
 *         neighbouring row being edited or deleted.
 *      2. *Boundary chain.* A row is SKIPPED iff its
 *         `startingBalance` is exactly $0 — the app manufactures those zeros, and
 *         nothing distinguishes an app-supplied $0 from a real one — but its
 *         recorded flows are not discarded. Walking ascending, the nearest
 *         not-skipped row is the NEAR side (its ending, whatever it is, including
 *         $0) and the next row recording a positive starting balance is the FAR
 *         side; the span imputes `max(0, nearEnding + Σskipped totalContributions
 *         + Σskipped rollover(signed) − Σskipped distributions − farStarting)`,
 *         dated in the far side's year. There is no limit on consecutive skipped
 *         rows. A gap year is not a skipped row — there is nothing to net, and
 *         gaps are compared exactly like adjacencies. A net increase imputes
 *         nothing and reduces nothing. An account's first not-skipped row is
 *         compared against nothing, and an account with no positive-starting row
 *         anywhere is never compared at all, at any balance.
 *    The two compose without double-charging: a zero-out row's positive start is
 *    an ordinary far side for the boundary before it, and its $0 ending is an
 *    ordinary near side for the boundary after it, so each not-skipped row is the
 *    near side for exactly one later row.
 *
 * **Disclosed limitation, accepted knowingly.** A
 * recharacterised regular contribution (§408A(d)(6)), an excess contribution
 * returned before the filing deadline, and a Roth IRA transferred to a former
 * spouse incident to divorce are real NON-distribution outflows that genuinely do
 * reduce §408A basis. None of them fits the `distributions` field, this derivation
 * cannot tell them from an ordinary internal transfer, and it does not try — so
 * basis can be overstated (tax understated) in those three shapes. Also disclosed:
 * a real withdrawal partly or wholly offset by untracked growth before the next
 * recorded balance reads as a net increase and is under-imputed, and a
 * shallow ledger under-credits basis.
 *
 * **Disclosed limitation — a designated-Roth rollover into a Roth IRA.** Rolling a
 * Roth 401(k)/403(b)/457(b)/TSP into a Roth IRA moves the participant's own
 * already-taxed designated-Roth contributions, and Treas. Reg. §1.408A-10, Q&A-3
 * treats that portion as a REGULAR CONTRIBUTION to the receiving Roth IRA for the
 * §1.408A-6 Q&A-8 ordering. Recorded as one signed `rollover` on the Roth IRA's
 * balance row, with no conversion pair because that pair is for §408A
 * conversions, the row does not say how much of the amount was contribution, so
 * none of it is credited and that money is ordered as earnings.
 * The direction OVER-taxes rather than understating tax, and splitting the amount
 * needs an input the app does not collect (the taxed portion of an inbound
 * rollover), so it is not arithmetic this module can add. It is also a real gap
 * rather than a hypothetical one: a household that had typed those
 * rolled-in contributions into the account's regular-contribution basis field (now
 * removed from the payload, schema v7) no longer gets credit for them, because
 * nothing reads that field.
 *
 * Comparisons are EXACT on the stored figures with no tolerance band, which
 * is why every figure here is integer cents: money on a row is dollars with cents,
 * converted per field at read and never compared as a float. Cross-row totals
 * accumulate in `bigint` and are read back with `safeRothCentsFromBigInt`, whose
 * 0-collapse is the max-tax conservative direction for a basis value — except that
 * a merged conversion lot is read back as ONE unit, because collapsing one half of
 * a lot's taxable/nontaxable pair alone would reorder the other half ahead of it
 * (§408A(d)(4)(B)) and understate tax instead.
 */
import {
  isValidRothMoney,
  isValidRothTaxYear,
  rothFactDollarsToCents,
  safeRothCentsFromBigInt,
} from '../db/roth-fact-validation';
import type { AccountBalancePayload } from '../db/types';
import type { RothConversionLotCents } from './roth-distribution-tax';

/** What one §408A pool has left after the whole recorded history is walked. */
export interface DerivedRothPoolBasisCents {
  /** Remaining regular-contribution basis (integer cents). */
  readonly regularContributionBasisCents: number;
  /** Remaining conversion lots, one merged lot per tax year, ascending. A lot
   *  consumed to nothing is omitted — these are the lots that REMAIN. Shaped as
   *  `RothConversionLotCents` so a later phase can hand them straight to the fact
   *  builder. */
  readonly conversionLots: readonly RothConversionLotCents[];
}

/** One balance row, validated and converted to integer cents. */
interface PoolRowCents {
  readonly year: number;
  readonly startingCents: bigint;
  readonly endingCents: bigint;
  /** The row's FULL recorded contribution total (personal + company) — the term
   *  the balance arithmetic uses, never the term credited as basis. */
  readonly totalContributionCents: bigint;
  /** Only the personal share (`totalContributions − companyContributions`,
   *  floored at 0) — the sole term credited as §408A basis. */
  readonly personalContributionCents: bigint;
  /** ONE SIGNED term: positive inbound, negative outbound. */
  readonly rolloverCents: bigint;
  readonly distributionCents: bigint;
  readonly conversionTaxableCents: bigint;
  readonly conversionNontaxableCents: bigint;
}

/** A conversion lot mid-consumption. */
interface MutableLotCents {
  readonly taxYear: number;
  taxableCents: bigint;
  nontaxableCents: bigint;
}

/** The pool's history, aggregated to one entry per year. */
interface AnnualPoolTotals {
  /** Every year the pool records a row for, ascending. Imputed outflows are always
   *  dated in a row's own year, so this covers them too. */
  readonly years: readonly number[];
  readonly contributionByYear: ReadonlyMap<number, bigint>;
  readonly outflowByYear: ReadonlyMap<number, bigint>;
  readonly lotByYear: ReadonlyMap<number, MutableLotCents>;
}

/**
 * Derive one §408A pool's remaining contribution basis and conversion lots from
 * `balances`, counting only rows belonging to `accounts`.
 *
 * Pure: neither argument is mutated, and the result depends on the CONTENT of the
 * inputs, not their order — except for the one documented tie-break, where a
 * duplicate `(accountId, year)` resolves to the first row in input order.
 */
export function deriveRothPoolBasisCents(
  accounts: ReadonlyArray<{ id: string }>,
  balances: ReadonlyArray<{ payload: AccountBalancePayload }>,
): DerivedRothPoolBasisCents {
  const poolAccountIds = new Set(accounts.map((account) => account.id));
  const rowsByAccount = readPoolRows(poolAccountIds, balances);
  return consumePoolChronologically(collectAnnualTotals(rowsByAccount));
}

/**
 * Whole dollars → NONNEGATIVE integer cents, for every nonnegative money field.
 * `rothFactDollarsToCents` alone accepts a magnitude just past `isValidRothMoney`'s
 * bound whose ×100 is still a safe integer, so an out-of-range imported amount
 * would survive as an enormous figure; the bound is re-applied here first,
 * exactly as it is for the signed `rollover` below.
 */
function nonnegativeRothDollarsToCents(dollars: unknown): number {
  return isValidRothMoney(dollars) ? rothFactDollarsToCents(dollars) : 0;
}

/**
 * Whole dollars → SIGNED integer cents, for `rollover` alone. The shared
 * `rothFactDollarsToCents` zeroes a negative, which would silently discard an
 * outbound rollover — the leg that EXPLAINS a drop. Magnitude is re-validated with
 * the same `isValidRothMoney` bound the nonnegative fields get, so an
 * out-of-magnitude or non-finite value still reads as 0.
 */
function signedRothDollarsToCents(dollars: unknown): number {
  if (typeof dollars !== 'number' || !isValidRothMoney(Math.abs(dollars))) return 0;
  const cents = Math.round(dollars * 100);
  return Number.isSafeInteger(cents) ? cents : 0;
}

/**
 * The row's recorded contributions in cents — the FULL total the balance arithmetic
 * uses, and the PERSONAL share credited as basis.
 *
 * The TOTAL is resolved exactly the way `totalContributions` (`balance-calc.ts`)
 * resolves it, which is what keeps a zeroed-out row's imputed residual equal to
 * `−gainLoss`. The BASIS term is `totalContributions − companyContributions`,
 * floored at 0, resolved on the same fields the total came from: on a flat row one
 * subtraction on the flat fields; on a MIXED row the two personal splits summed —
 * the same subtraction, because the four splits drive the total and the company
 * splits are what is excluded. On a MIXED row the flat `companyContributions` is
 * therefore never subtracted — the splits already separate employer money out, and
 * subtracting it again would charge the same dollars twice.
 *
 * Every stored field is validated and converted on its OWN magnitude and the integer
 * cents are summed in `bigint`, never validated as one dollar aggregate:
 * `isValidRothMoney` bounds a SINGLE stored field, so a MIXED row whose four splits
 * are each in range can still sum past that bound, and rejecting the aggregate would
 * read a real contribution as $0 — dropping its basis and letting the year's outflow
 * fall straight through to the conversion lots. That is why the shared
 * `totalContributions` is mirrored rather than called: it resolves in dollars, and it
 * is the dollar aggregate that overflows. The two are pinned against each other by
 * the closure cases, which assert the imputed residual equals `−gainLoss` — itself
 * computed from `totalContributions` — on a MIXED row as well as a flat one.
 *
 * Exported for exactly one outside consumer: the universal retype-block rule
 * (`lib/account-retype-block.ts`'s `hasRetypeBlockingHistory`) reads
 * `personalCents` so the rule that decides whether a row is real history and
 * the derivation that credits it as Roth basis cannot disagree — a
 * hand-maintained copy of this term drifted from it once.
 */
export function contributionCentsOf(payload: AccountBalancePayload): {
  readonly totalCents: bigint;
  readonly personalCents: bigint;
} {
  if (payload.contributionsPreTax !== null || payload.contributionsPostTax !== null) {
    // MIXED — the four splits drive the total, as in `totalContributions`, and the
    // two PERSONAL splits are the basis credit: `totalContributions − company
    // contributions` resolved on the same splits the total came from, needing no
    // floor because every term is nonnegative.
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
    // Floored at 0: a row recording more company money than total contributions must
    // credit nothing, never a negative — a negative basis is drawn as `fromBasis` and
    // would GROW the year's outflow, over-consuming the conversion lots as well.
    personalCents: totalCents > companyCents ? totalCents - companyCents : 0n,
  };
}

function toPoolRow(payload: AccountBalancePayload): PoolRowCents {
  // An invalid magnitude reads as 0 at the conversion, the same
  // re-validation the runtime fact adapter applies because a current-schema row from
  // an import bundle bypasses the migrations that sanitise these keys.
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

/** Group the pool's rows by account, one row per `(accountId, year)`, ascending. */
function readPoolRows(
  poolAccountIds: ReadonlySet<string>,
  balances: ReadonlyArray<{ payload: AccountBalancePayload }>,
): Map<string, PoolRowCents[]> {
  const byAccount = new Map<string, Map<number, PoolRowCents>>();
  for (const { payload } of balances) {
    if (!poolAccountIds.has(payload.accountId)) continue;
    // The year is this row's position in the chronology AND its lot's tax year, so
    // a row without a usable one can neither be ordered nor dated and is dropped
    // wholesale — the same reading `buildDatedRothAmountsByAccount` takes. It
    // claims no `(accountId, year)` slot either.
    if (!isValidRothTaxYear(payload.year)) continue;
    let byYear = byAccount.get(payload.accountId);
    if (!byYear) {
      byYear = new Map<number, PoolRowCents>();
      byAccount.set(payload.accountId, byYear);
    }
    // Tie-break: the FIRST row in input order wins, never a sum.
    if (byYear.has(payload.year)) continue;
    byYear.set(payload.year, toPoolRow(payload));
  }
  const rowsByAccount = new Map<string, PoolRowCents[]>();
  for (const [accountId, byYear] of byAccount.entries()) {
    rowsByAccount.set(accountId, [...byYear.values()].sort((a, b) => a.year - b.year));
  }
  return rowsByAccount;
}

/** The row's own unexplained residual, $0 when it explains itself. */
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

/**
 * Walk ONE account's rows ascending and date every imputed
 * outflow into `outflowByYear`: each row's own residual, plus the shortfall across
 * the span from the nearest not-skipped row to the next positive-starting one.
 */
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
      // Skipped: never either side of a comparison, but its recorded flows net
      // into the span so a withdrawal honestly recorded here is not charged twice.
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
    // The far side becomes the new near side — read as its ending balance,
    // whatever that is, including $0 — and the skipped accumulators reset.
    nearEndingCents = row.endingCents;
    skippedContributionCents = 0n;
    skippedRolloverCents = 0n;
    skippedDistributionCents = 0n;
  }
}

/** Aggregate the pool to one contribution credit, one outflow and one lot per year. */
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
      // A row's dated conversion fact is an independent input, read whether or not
      // that row's balance fields take part in any comparison.
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

/**
 * Read one REMAINING lot back to `Number` cents as a single unit, or drop it.
 *
 * `safeRothCentsFromBigInt` collapses an unrepresentable aggregate to 0 field by
 * field, which is the conservative direction for a lone basis figure but NOT for
 * this pair: a lot whose merged taxable principal collapses while its nontaxable
 * principal survives is shaped taxable=$0 / nontaxable=whatever, and the carrier
 * then draws the nontaxable component FIRST — reversing §408A(d)(4)(B) and taking
 * a pre-59½ distribution inside the five-year window out of the §72(t) recapture
 * base entirely. So an unrepresentable component drops the WHOLE lot: the outflow
 * falls past it into untracked earnings, which is taxed at least as heavily as any
 * converted principal. A lot consumed to nothing is dropped by the same test.
 */
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

/** Draw `outflowCents` from one lot, taxable principal before nontaxable
 *  (§408A(d)(4)(B)); returns what is still unmet. Mutates the lot. */
function consumeLot(lot: MutableLotCents, outflowCents: bigint): bigint {
  const taxableDrawn = outflowCents < lot.taxableCents ? outflowCents : lot.taxableCents;
  lot.taxableCents -= taxableDrawn;
  let remaining = outflowCents - taxableDrawn;
  const nontaxableDrawn = remaining < lot.nontaxableCents ? remaining : lot.nontaxableCents;
  lot.nontaxableCents -= nontaxableDrawn;
  remaining -= nontaxableDrawn;
  return remaining;
}

/**
 * One chronological walk over the pool, years ascending: credit the year's
 * contributions, make the year's lot available, then consume the year's combined
 * outflow (recorded plus imputed) as one ordered stream — contribution basis first,
 * then lots by tax year ascending. Anything beyond the lots is earnings.
 */
function consumePoolChronologically(annual: AnnualPoolTotals): DerivedRothPoolBasisCents {
  let basisCents = 0n;
  // Ascending, because `annual.years` is: a lot is available to an outflow in its
  // own year and later, matching `applyFactBasedRothIraOrdering`, which skips only
  // a lot dated AFTER the distribution year.
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
