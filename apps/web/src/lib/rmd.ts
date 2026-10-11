/**
 * Pure-function US Required Minimum Distribution (RMD) engine.
 *
 * Covers: SECURE 2.0 trigger ages (73 for born 1951–1959, 75 for born 1960+),
 * the IRS Pub 590-B Appendix B life-expectancy tables chosen per account by
 * `selectRmdTableDivisor` (Table III Uniform Lifetime is the owner default;
 * Table II Joint Life and Last Survivor applies to an owner whose sole
 * beneficiary is a spouse more than ten years younger; Table I Single Life
 * applies to a beneficiary of an inherited account), per-account proportional
 * allocation, MIXED account Roth-portion subtraction (SECURE 2.0 §325).
 *
 * Minimum supported tax year: 2024 (post-SECURE-2.0 effective date).
 * Year-resolution: clamp-to-latest.
 *
 * Config: apps/web/src/lib/rmd-divisors.ts
 */

import type { CalibrationSnapshot } from './calibration';
import { clampAge, resolveSnapshotValueForYear, type RmdTable } from './rmd-divisors';
import { UnsupportedTaxYearError, RmdInvalidInputError } from './rmd-errors';
import {
  hasRothDesignatedPocket,
  validateRmdInput,
  validateRmdProfileFacts,
} from './rmd-validation';
import { allocateProportional } from './rmd-allocation';
// Reuse the shared stored-date validator (calendar validity + the
// `[1900, 2200]` plausible-year bounds) at this runtime
// resolver boundary too, so a current-version (v6) payload that bypassed the
// migration-time sanitiser cannot smuggle an impossible / out-of-bounds date
// into a year extraction. Not duplicated locally.
// The beneficiary-category / election validators from the same shared SSOT
// are reused at this runtime resolver boundary so an unsanitised current-version
// (v6) payload carrying an out-of-vocabulary `beneficiaryType` / election value is
// REJECTED (withheld) rather than silently coerced into a real distribution rule.
import {
  isValidRmdIsoDate,
  isValidRmdBeneficiaryType,
  isValidRmdBeneficiaryElection,
} from '../db/rmd-fact-validation';
import {
  selectRmdTableDivisor,
  RMD_LIFE_EXPECTANCY_TABLES,
  type RmdLifeExpectancyTables,
  type RmdTableRequest,
  type RmdTableSelection,
} from './rmd-life-expectancy-tables';

// Re-export error classes so existing `import { … } from './rmd'` sites keep working.
export { UnsupportedTaxYearError, RmdInvalidInputError } from './rmd-errors';
// Re-export the shared §325 Roth-pocket admission rule so every producer of an
// `RmdAccountInput` reads it from the engine's own entry point.
export { hasRothDesignatedPocket } from './rmd-validation';
// Re-export validateRmdInput for any caller that imports it directly from rmd.ts.

// ---------------------------------------------------------------------------
// Account types (kept in lockstep with db/types.ts AccountType literal union;
// not imported from there to keep this module portable / DB-free).
// ---------------------------------------------------------------------------

/** Account types accepted by the RMD engine. Mirrors db/types.ts AccountType. */
export type RmdAccountType =
  | 'RETIREMENT_IRA'
  | 'RETIREMENT_401K'
  | 'RETIREMENT_403B'
  | 'RETIREMENT_457B'
  | 'RETIREMENT_TSP'
  | 'RETIREMENT_CASH_BALANCE'
  | 'RETIREMENT_ROTH_IRA'
  | 'RETIREMENT_ROTH_401K'
  | 'RETIREMENT_ROTH_403B'
  | 'RETIREMENT_ROTH_457B'
  | 'RETIREMENT_ROTH_TSP'
  | 'HSA'
  | 'BROKERAGE'
  | 'SAVINGS'
  | 'MONEY_MARKET'
  | 'CD'
  | 'OTHER';

/** Tax treatment of an account. Mirrors db/types.ts AccountTaxTreatment. */
export type AccountTaxTreatment =
  | 'PRE_TAX'
  | 'POST_TAX'
  | 'MIXED'
  | 'HSA'
  | 'ROTH';

// ---------------------------------------------------------------------------
// RMD calibration payload
// ---------------------------------------------------------------------------

// `RmdTable` is defined in `rmd-divisors.ts` (the leaf calibration-data module)
// and re-exported here so existing `import { RmdTable } from './rmd'` sites
// keep working without pulling `rmd-life-expectancy-tables.ts` into a cycle.
export type { RmdTable } from './rmd-divisors';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/**
 * Per-account RMD input.
 *
 * @param id - Unique account identifier (caller-supplied; echoed in output map).
 * @param balanceDec31PriorYearCents - Dec 31 balance of the PRIOR year in integer cents.
 * @param accountType - Account type literal (see RmdAccountType).
 * @param taxTreatment - Tax treatment of the account.
 * @param rothPortionCents - Optional: the part of `balanceDec31PriorYearCents`
 *   that is Roth-DESIGNATED money, which carries no RMD (SECURE 2.0 §325). Valid
 *   only on an account that HAS a Roth-designated pocket — `MIXED` (a pre-tax
 *   employer plan holding a designated-Roth sub-account) or a pure Roth account
 *   (`POST_TAX` / `ROTH` treatment, whose whole balance is Roth). Supplying it on
 *   a `PRE_TAX` or `HSA` account throws `RmdInvalidInputError`. Must be in
 *   [0, balanceDec31PriorYearCents]. Defaults, when omitted:
 *   - `MIXED` → 0, i.e. the whole balance is the base (conservative over-estimate);
 *   - pure Roth (`POST_TAX` / `ROTH`) → the WHOLE balance, because such an account
 *     holds no pre-tax dollars by definition. That default is what makes the
 *     §325 netting caller-independent: every producer of an RMD base (both
 *     engines' funded passes, the MC representative pass, the deterministic
 *     snapshot builder) lands on the same base whether or not it spells the
 *     Roth pocket out (producers that spelled it differently once disagreed, and a fully
 *     Roth inherited balance was grossed up as ordinary income).
 */
export interface RmdAccountInput {
  readonly id: string;
  readonly balanceDec31PriorYearCents: number;
  readonly accountType: RmdAccountType;
  readonly taxTreatment: AccountTaxTreatment;
  readonly rothPortionCents?: number;
  /**
   * This account's stored RMD profile facts (owner vs inherited,
   * still-working preconditions, sole-spouse designation, beneficiary category,
   * first-year deferral election). **Absent on EVERY account in the call → the
   * engine runs the legacy owner/Uniform-Lifetime path verbatim** (byte-identical
   * output, so a scenario that records no facts is unaffected). Present on ≥ 1
   * account → the whole call switches to the fact-based per-account rule
   * resolution (`resolveRmdRule`); each account's ABSENT fields still resolve to
   * their one-sided conservative default.
   */
  readonly facts?: RmdAccountProfileFacts;
  /**
   * Dec 31 balance of the year TWO years before the tax year, in integer
   * cents. Consulted ONLY to size a first-year-deferral catch-up: an owner who
   * elected the April-1 deferral takes their trigger-year RMD in the FOLLOWING
   * year, and that deferred amount is computed from the trigger year's own base
   * (= Dec 31 two years before the following year). Absent → a deferral elected
   * in the prior year cannot be sized, so the catch-up is reported as a blocker
   * rather than guessed.
   *
   * Same units + same §325 treatment as `balanceDec31PriorYearCents`: BOTH
   * engines pass the account's FULL balance here and supply
   * `rothPortionTwoYearsPriorCents` when the account has a Roth-designated
   * pocket, so the one shared `rmdTwoYearsPriorBaseCents` resolver produces an
   * identical base in both.
   */
  readonly balanceDec31TwoYearsPriorCents?: number;
  /**
   * The Roth-designated portion of `balanceDec31TwoYearsPriorCents`
   * (SECURE 2.0 §325), in integer cents. Valid on exactly the treatments
   * `rothPortionCents` is valid on, and defaults the same way when absent
   * (MIXED → 0 / whole balance is the base; pure Roth → the whole
   * two-years-prior balance).
   */
  readonly rothPortionTwoYearsPriorCents?: number;
}

/**
 * Top-level RMD input for one owner.
 *
 * @param isoBirthdate - Owner's birthdate in ISO 8601 `YYYY-MM-DD` format.
 *   The engine uses the calendar year (no SSA first-day-of-month shift — IRS
 *   §401(a)(9) uses Dec-31 age, not SSA-shifted age).
 * @param taxYear - Tax year for which RMD is computed (≥ 2024).
 * @param accounts - Accounts owned by this owner; may be mixed qualifying / non-qualifying.
 */
export interface RmdInput {
  readonly isoBirthdate: string;
  readonly taxYear: number;
  readonly accounts: readonly RmdAccountInput[];
  /**
   * The pinned Table I / II / III bundle the fact-based path selects
   * divisors from. Ignored when no account carries `facts`. Absent → the
   * `snapshot` argument supplies Table III and the frozen module bundle supplies
   * Tables I/II; both production engines pin all three explicitly so a Monte
   * Carlo path never reads live calibration.
   */
  readonly lifeExpectancyTables?: RmdLifeExpectancyTables;
  /**
   * The calendar year the owner separated from service. Required to resolve
   * the §401(a)(9)(C) "later of statutory age or retirement" first-distribution
   * year for an account whose still-working exception applied; absent while it
   * applied → that account's first-year resolution is WITHHELD.
   */
  readonly retirementYear?: number;
}

/**
 * RMD computation result for one owner.
 *
 * @param applicable - `true` when the owner's age in the tax year meets or exceeds
 *   the trigger age. `false` when below trigger; all numeric fields are zeroed.
 * @param ownerRmdCents - Total RMD in integer cents across all qualifying accounts.
 *   Zero when `applicable === false`.
 * @param perAccountRmdCents - Proportional per-account shares for qualifying accounts only
 *   (non-qualifying IDs omitted). `sum(values) === ownerRmdCents` exactly.
 *   Empty when `applicable === false`.
 * @param divisor - Uniform Lifetime divisor used (IRS Pub 590-B Table III age-lookup).
 *   `null` when `applicable === false` (no lookup performed).
 * @param qualifyingBalanceCents - Sum of qualifying pre-tax balances after `rothPortionCents`
 *   subtraction. Zero when `applicable === false` (no computation performed).
 */
export interface RmdResult {
  readonly applicable: boolean;
  readonly ownerRmdCents: number;
  readonly perAccountRmdCents: Record<string, number>;
  readonly divisor: number | null;
  readonly qualifyingBalanceCents: number;
  /**
   * Accounts whose RMD could NOT be computed. Three distinct causes share this
   * list, so a consumer must NOT assume the reason is an inherited-account gap:
   *   1. a required INHERITED fact is missing (beneficiary category, death date,
   *      died-on/after-RBD, and the conditional facts a resolved rule needs),
   *   2. an OWNER-path input is missing — an unknown `retirementYear` when the
   *      still-working preconditions are met, or an absent
   *      `balanceDec31TwoYearsPriorCents` for a deferred first-year catch-up, and
   *   3. a fact COMBINATION this engine does not model (a pre-2020 death, a
   *      non-person ghost-life schedule, an invalid ten-year election), where nothing
   *      is "missing" at all.
   * Each entry contributes $0 to `ownerRmdCents` and is absent from
   * `perAccountRmdCents`: the result is WITHHELD, never guessed. Absent (not
   * `[]`) on the legacy no-facts path so existing callers see an unchanged shape.
   */
  readonly withheldAccounts?: readonly RmdWithheldAccount[];
  /**
   * Accounts whose RMD is deferred this year by the §401(a)(9)(C)
   * still-working exception. They contribute $0 and are NOT blockers.
   */
  readonly stillWorkingDeferredAccountIds?: readonly string[];
  /**
   * Accounts whose trigger-year RMD is deferred to April 1 of the following
   * year by an affirmative first-year election, with the deferred cents. The
   * deferred amount is EXCLUDED from this year's `ownerRmdCents` and is added
   * back in the following year (from `balanceDec31TwoYearsPriorCents`).
   */
  readonly firstYearDeferrals?: readonly RmdFirstYearDeferralDetail[];
  /** Total deferred-from-the-prior-year catch-up cents folded into
   *  `ownerRmdCents` this year (the "two RMDs in one year" consequence). */
  readonly deferredCatchUpCents?: number;
}

/** One account whose fact-based RMD is withheld, with the missing facts. */
export interface RmdWithheldAccount {
  readonly accountId: string;
  readonly missingFacts: readonly string[];
}

/** One account's first-year April-1 deferral and the cents it moves. */
export interface RmdFirstYearDeferralDetail {
  readonly accountId: string;
  readonly deferredCents: number;
  /** Calendar year the deferred amount becomes due (alongside that year's own). */
  readonly dueInYear: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the RMD trigger age for an owner based on birth year.
 *
 * Per SECURE 2.0 §107:
 * - Born 1960+: trigger age 75.
 * - Born 1951–1959: trigger age 73.
 * - Born ≤1950: returns 73 (the post-SECURE-2.0 current trigger; these owners
 *   are past trigger age at any supported tax year ≥ 2024).
 */
export function rmdTriggerAge(birthYear: number): 73 | 75 {
  return birthYear >= 1960 ? 75 : 73;
}

/**
 * Historical RMD applicable (required-beginning-date-triggering) age for a
 * DECEASED owner — distinct from `rmdTriggerAge`, which models only the
 * currently-supported LIVING-owner ages (73/75). A deceased owner who died before
 * reaching their RBD was subject to the applicable age in force at the time, which
 * followed a historical progression that `rmdTriggerAge`'s blanket 73 for born
 * ≤1950 does NOT capture:
 *
 *   - Born ≤1949 → 70 (pre-SECURE-Act "age 70½" era — reached 70½ before 2020).
 *   - Born 1950  → 72 (original SECURE Act (2019) "age 72").
 *   - Born 1951–1959 → 73 (SECURE 2.0 §107).
 *   - Born 1960+ → 75 (SECURE 2.0 §107).
 *
 * Used ONLY for the surviving-spouse delayed-start year (the year the deceased
 * owner WOULD HAVE reached their RBD, `resolveSpouseStretch`). Year-granularity:
 * the 70½ era is represented by its integer floor 70, and the 70½→72 boundary is
 * drawn at birth year 1950 (the sub-year July-1949 SECURE Act cutover is not split,
 * since the consumed value is itself a year-granularity distribution year).
 */
export function deceasedOwnerApplicableRmdAge(birthYear: number): 70 | 72 | 73 | 75 {
  if (birthYear >= 1960) return 75;
  if (birthYear >= 1951) return 73;
  if (birthYear >= 1950) return 72;
  return 70;
}

/**
 * Returns `true` when the account type + tax treatment combination qualifies
 * for RMD computation under IRS §401(a)(9) + SECURE 2.0 §325.
 *
 * Qualification rules:
 * - `RETIREMENT_IRA` qualifies ONLY for PRE_TAX (traditional IRA). MIXED and
 *   POST_TAX are rejected upstream by validateRmdInput (Roth IRAs use the
 *   separate RETIREMENT_ROTH_IRA type; traditional IRAs are always PRE_TAX).
 * - `RETIREMENT_401K`, `RETIREMENT_403B`, `RETIREMENT_457B`, `RETIREMENT_TSP`,
 *   `RETIREMENT_CASH_BALANCE` qualify for PRE_TAX and MIXED treatment.
 *   POST_TAX (Roth 401(k)/403(b)) is RMD-exempt for tax years 2024+ per SECURE 2.0 §325.
 * - `RETIREMENT_ROTH_IRA` never qualifies (no owner RMD for Roth IRA).
 * - All other types (HSA, BROKERAGE, SAVINGS, MONEY_MARKET, CD, OTHER) never qualify.
 */
export function isQualifyingAccount(
  type: RmdAccountType,
  taxTreatment: AccountTaxTreatment,
): boolean {
  if (type === 'RETIREMENT_IRA') return taxTreatment === 'PRE_TAX';
  if (
    type === 'RETIREMENT_401K' ||
    type === 'RETIREMENT_403B' ||
    type === 'RETIREMENT_457B' ||
    type === 'RETIREMENT_TSP' ||
    type === 'RETIREMENT_CASH_BALANCE'
  ) {
    return taxTreatment === 'PRE_TAX' || taxTreatment === 'MIXED';
  }
  return false;
}

/**
 * Returns the IRS-aggregation pool key for one RMD account.
 *
 * IRS aggregation rules (Pub 590-B; §403(b); §401(a)(9)):
 * - All traditional IRAs of one owner aggregate into a single pool — the owner
 *   may satisfy the whole IRA minimum from any one IRA.
 * - All §403(b) plans of one owner aggregate into a single pool (separately
 *   from IRAs).
 * - Employer plans (401(k), 457(b), TSP, cash-balance) and every other type do
 *   NOT aggregate — each account is its own singleton pool (the minimum must be
 *   taken from that plan itself).
 *
 * The key is namespaced (`pool:` vs `acct:`) so a fixed discriminant can never
 * collide with a raw account id, and prefixed by `ownerId` so two owners' pools
 * stay separate.
 *
 * An empty/missing `ownerId` (orphan account, no resolvable owner) falls back to
 * a singleton pool keyed by the bare account id so the account is never dropped
 * and the call never throws.
 *
 * INHERITED accounts NEVER aggregate (`inherited === true`): IRS Pub 590-B
 * forbids aggregating an inherited IRA with the beneficiary's OWN IRAs, and
 * forbids aggregating IRAs inherited from DIFFERENT decedents. The app records
 * no decedent identity that could establish a legally valid same-decedent
 * grouping, so every inherited account gets its own singleton pool — the only
 * choice that can never permit an illegal cross-cover.
 */
export function poolKeyForRmdAccount(
  ownerId: string,
  accountType: RmdAccountType,
  accountId: string,
  /** `true` for a beneficiary-held inherited account (never aggregable). */
  inherited = false,
): string {
  const owner = ownerId === '' ? accountId : ownerId;
  if (inherited) return `${owner}::inherited-acct:${accountId}`;
  if (accountType === 'RETIREMENT_IRA') return `${owner}::pool:IRA`;
  if (accountType === 'RETIREMENT_403B') return `${owner}::pool:403B`;
  return `${owner}::acct:${accountId}`;
}

/** Sums the positive-part shortfall across all IRS aggregation pools.
 * Each pool's shortfall = max(0, required − withdrawn); pools where the draw
 * exceeds the minimum contribute zero (no cross-pool offset). */
export function sumPoolShortfallCents(
  poolRequired: Map<string, number>,
  poolWithdrawn: Map<string, number>,
): number {
  let shortfall = 0;
  for (const [poolKey, required] of poolRequired) {
    const withdrawn = poolWithdrawn.get(poolKey) ?? 0;
    shortfall += Math.max(0, required - withdrawn);
  }
  return shortfall;
}

/** Birth year per ISO birthdate string, populated ONLY after
 *  the full validation below passes. Invalid dates are NEVER cached (they
 *  throw identically on every call). FIFO-bounded to 128 entries (mirrors
 *  `SNAPSHOT_RESOLUTION_MEMO` in tax-integration-helpers.ts) — a long session
 *  probing many distinct birthdates can't grow it unbounded. */
const BIRTH_YEAR_MEMO = new Map<string, number>();
const BIRTH_YEAR_MEMO_MAX_ENTRIES = 128;

/**
 * Returns the age the owner attains by December 31 of the given tax year.
 * Uses calendar-year subtraction (no SSA first-day-of-month shift — IRS
 * §401(a)(9) uses Dec-31 age, not SSA-shifted age).
 *
 * The parsed birth year is memoized per `isoBirthdate` (module
 * `BIRTH_YEAR_MEMO`) — a cache hit skips straight to the subtraction; a miss
 * runs the existing regex + range + `Date.UTC` round-trip validation verbatim
 * and caches only on success.
 *
 * @throws {RmdInvalidInputError} when `isoBirthdate` is not a valid YYYY-MM-DD date
 *   or the calendar date does not exist (e.g. Feb 30, Apr 31, non-leap Feb 29).
 */
export function ageInTaxYear(isoBirthdate: string, taxYear: number): number {
  const cachedBirthYear = BIRTH_YEAR_MEMO.get(isoBirthdate);
  if (cachedBirthYear !== undefined) {
    return taxYear - cachedBirthYear;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoBirthdate);
  if (!match) {
    throw new RmdInvalidInputError(
      `isoBirthdate "${isoBirthdate}" is not a valid YYYY-MM-DD date`,
    );
  }
  const birthYear = Number(match[1]);
  const birthMonth = Number(match[2]); // 1-based
  const birthDay = Number(match[3]);
  // Validate calendar date ranges (fast-path)
  if (birthMonth < 1 || birthMonth > 12 || birthDay < 1 || birthDay > 31) {
    throw new RmdInvalidInputError(
      `isoBirthdate "${isoBirthdate}" contains an out-of-range month or day`,
    );
  }
  // Calendar-validity check: build the date and verify the round-trip.
  // Catches impossible dates like Feb 30, Apr 31, and non-leap Feb 29.
  const d = new Date(Date.UTC(birthYear, birthMonth - 1, birthDay));
  if (
    d.getUTCFullYear() !== birthYear ||
    d.getUTCMonth() !== birthMonth - 1 ||
    d.getUTCDate() !== birthDay
  ) {
    throw new RmdInvalidInputError(
      `isoBirthdate "${isoBirthdate}" is not a valid calendar date`,
    );
  }
  if (BIRTH_YEAR_MEMO.size >= BIRTH_YEAR_MEMO_MAX_ENTRIES) {
    // FIFO eviction: Map iteration order is insertion order, so the first key
    // is the oldest-inserted one.
    const oldestKey = BIRTH_YEAR_MEMO.keys().next().value;
    if (oldestKey !== undefined) BIRTH_YEAR_MEMO.delete(oldestKey);
  }
  BIRTH_YEAR_MEMO.set(isoBirthdate, birthYear);
  // IRS: age attained by Dec 31 of the tax year = taxYear − birthYear
  return taxYear - birthYear;
}

/**
 * Resolve the calibration entry for `taxYear` using clamp-to-latest semantics
 * (the shared `resolveSnapshotValueForYear` scan in `rmd-divisors.ts`),
 * throwing on a below-every-key miss.
 *
 * Explicit divergence from `federal-tax.ts`'s strict-exact lookup:
 * the Uniform Lifetime Table is
 * statutory and does not change annually (last revision: TD 9930, effective
 * 2022-01-01). Clamping to the latest available key is correct, not a loss of
 * fidelity.
 *
 * @throws {UnsupportedTaxYearError} when `taxYear` is below every key in the snapshot.
 */
function resolveSnapshot<T>(
  snapshot: CalibrationSnapshot<T>,
  taxYear: number,
): T {
  const value = resolveSnapshotValueForYear(snapshot, taxYear);
  if (value === undefined) {
    throw new UnsupportedTaxYearError(taxYear);
  }
  return value;
}

/**
 * Collect qualifying pre-tax balances after Roth-portion subtraction.
 * Skips non-qualifying accounts and zero-balance qualifying accounts.
 */
function collectQualifyingBalances(
  accounts: readonly RmdAccountInput[],
): Array<{ id: string; balanceCents: number }> {
  const qualifying: Array<{ id: string; balanceCents: number }> = [];
  for (const acct of accounts) {
    if (!isQualifyingAccount(acct.accountType, acct.taxTreatment)) continue;
    // Subtract the Roth-designated portion (SECURE 2.0 §325) through the SAME
    // `rothDesignatedSliceCents` rule the fact-based base resolvers use, so the
    // legacy and fact-based paths cannot disagree about one account's base. Only
    // PRE_TAX and MIXED accounts reach here (`isQualifyingAccount`), for which
    // that rule is exactly the historical behaviour: no offset for PRE_TAX, the
    // explicit portion for MIXED, defaulting to the whole balance in the base
    // (conservative over-estimate).
    const rothOffset = rothDesignatedSliceCents(
      acct.taxTreatment,
      acct.balanceDec31PriorYearCents,
      acct.rothPortionCents,
    );
    const pretaxBalanceCents = acct.balanceDec31PriorYearCents - rothOffset;
    if (pretaxBalanceCents > 0) {
      qualifying.push({ id: acct.id, balanceCents: pretaxBalanceCents });
    }
  }
  return qualifying;
}

/**
 * Look up the Uniform Lifetime divisor for `clampedAge` in `table`.
 * @throws {RmdInvalidInputError} when the entry is missing, non-finite, or ≤ 0.
 */
function lookupUniformLifetimeDivisor(table: RmdTable, clampedAge: number): number {
  const divisor = table.uniformLifetime[clampedAge];
  if (divisor === undefined || !Number.isFinite(divisor) || divisor <= 0) {
    throw new RmdInvalidInputError(
      `uniformLifetime table missing or invalid entry for age ${clampedAge}`,
    );
  }
  return divisor;
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

/** Build the not-applicable (below trigger age) result. */
function applicableFalseResult(): RmdResult {
  return {
    applicable: false,
    ownerRmdCents: 0,
    perAccountRmdCents: {},
    divisor: null,
    qualifyingBalanceCents: 0,
  };
}

/** Build the applicable result given qualifying accounts and the resolved divisor. */
function applicableTrueResult(
  qualifying: Array<{ id: string; balanceCents: number }>,
  divisor: number,
): RmdResult {
  const qualifyingBalanceCents = qualifying.reduce((s, a) => s + a.balanceCents, 0);
  if (qualifyingBalanceCents === 0) {
    return {
      applicable: true,
      ownerRmdCents: 0,
      perAccountRmdCents: {},
      divisor,
      qualifyingBalanceCents: 0,
    };
  }
  const ownerRmdCents = Math.round((qualifyingBalanceCents / 100) / divisor * 100);
  return {
    applicable: true,
    ownerRmdCents,
    perAccountRmdCents: allocateProportional(qualifying, ownerRmdCents),
    divisor,
    qualifyingBalanceCents,
  };
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

/**
 * Compute the Required Minimum Distribution for one owner in one tax year.
 *
 * Execution order:
 * 1. Validate input (RmdInvalidInputError on any malformed input — taxYear checked first).
 * 2. Resolve snapshot (UnsupportedTaxYearError on miss).
 * 3. Parse age (ageInTaxYear — throws on malformed birthdate).
 * 4. Trigger gate (return not-applicable if age < triggerAge).
 * 5. Lookup divisor + allocate.
 *
 * @param input - Owner birthdate, tax year, and account list (see RmdInput).
 * @param snapshot - Calibration snapshot (`RMD_DIVISORS` from `rmd-divisors.ts`).
 *   Never read directly — passed as a parameter for MC-path determinism.
 *
 * @throws {UnsupportedTaxYearError} when `taxYear` is below the minimum key
 *   in the snapshot (default minimum: 2024).
 * @throws {RmdInvalidInputError} on malformed `isoBirthdate`, invalid
 *   `rothPortionCents` values, negative or non-integer balances, duplicate or
 *   empty account IDs, or a missing/invalid divisor entry in the snapshot.
 */
export function computeRmd(
  input: RmdInput,
  snapshot: CalibrationSnapshot<RmdTable>,
): RmdResult {
  // 1. Validate input — runs FIRST so taxYear non-finite/non-integer throws
  //    RmdInvalidInputError before resolveSnapshot can produce a misleading
  //    UnsupportedTaxYearError or silently clamp to the wrong year.
  //    Also runs BEFORE the trigger-age gate so bad account inputs always throw.
  validateRmdInput(input);

  // 2. Resolve snapshot — throws UnsupportedTaxYearError when year < min key.
  //    taxYear is guaranteed finite safe integer at this point.
  const table = resolveSnapshot(snapshot, input.taxYear);

  // 3. Parse age — throws RmdInvalidInputError on malformed / calendar-invalid birthdate.
  //    taxYear is a safe integer here so ageInTaxYear arithmetic is well-defined.
  const age = ageInTaxYear(input.isoBirthdate, input.taxYear);
  const birthYear = input.taxYear - age; // back-derived after validation
  const triggerAge = rmdTriggerAge(birthYear);

  // 4. Fact-based path when ANY account carries stored RMD profile facts.
  //    A call where every account omits `facts` runs the legacy branch below
  //    verbatim, so a scenario that records no facts keeps byte-identical output
  //    (the frozen parity fixtures prove it).
  if (input.accounts.some((acct) => acct.facts !== undefined)) {
    return computeFactBasedRmd(input, snapshot, age, triggerAge);
  }

  // 5. Trigger gate
  if (age < triggerAge) return applicableFalseResult();

  // 6. Lookup divisor + allocate
  const clampedAge = clampAge(age, 73);
  const divisor = lookupUniformLifetimeDivisor(table, clampedAge);
  const qualifying = collectQualifyingBalances(input.accounts);
  return applicableTrueResult(qualifying, divisor);
}

// ---------------------------------------------------------------------------
// Fact-based per-account RMD computation (ACTIVE in both engines)
// ---------------------------------------------------------------------------

/** Resolve the SECURE 2.0 §325 Roth-DESIGNATED slice of one of the account's two
 *  balance fields — the amount netted out of the RMD base.
 *
 *  ONE rule, applied by every base resolver in this module so no caller can move
 *  the base by choosing a different spelling of the same account:
 *   - no Roth pocket (`PRE_TAX` / `HSA`, per `hasRothDesignatedPocket`) → nothing
 *     is netted out;
 *   - `MIXED` → the caller's explicit portion, defaulting to 0 (whole balance
 *     stays in the base: the conservative over-estimate);
 *   - pure Roth (`POST_TAX` / `ROTH`) → the caller's explicit portion, defaulting
 *     to the WHOLE balance. Such an account holds no pre-tax dollars, so its base
 *     nets to zero whether or not the caller spelled the pocket out. Without this
 *     default an inherited Roth IRA (or pure designated-Roth employer plan) had
 *     its entire balance treated as a pre-tax RMD base and grossed up as ORDINARY
 *     INCOME on the funded Monte Carlo path — wrong in kind, not merely
 *     conservative. */
function rothDesignatedSliceCents(
  taxTreatment: AccountTaxTreatment,
  balanceCents: number,
  explicitPortionCents: number | undefined,
): number {
  if (!hasRothDesignatedPocket(taxTreatment)) return 0;
  if (taxTreatment === 'MIXED') return explicitPortionCents ?? 0;
  return explicitPortionCents ?? balanceCents;
}

/**
 * The §325 Roth-designated portion a PRODUCER should declare on the base it is
 * passing, given the Roth pocket it measured for the account. Exported so every
 * `RmdAccountInput` assembler — both engines' funded passes, the MC representative
 * pass, the deterministic snapshot builder — declares it identically.
 *
 * - No Roth pocket (`PRE_TAX` / `HSA`) → `undefined`; declaring one throws.
 * - `MIXED` → the measured pocket, clamped into `[0, baseCents]`.
 * - Pure Roth (`POST_TAX` / `ROTH`) → the WHOLE base, NOT the measured pocket. Such
 *   an account holds no pre-tax dollars by definition, so its base always nets to
 *   zero; deriving the figure from a sub-bucket instead would let one mis-derived /
 *   uncaptured `post` balance put the account's untaxed Roth dollars back into a
 *   pre-tax RMD base — the exact failure this convention exists to prevent.
 */
export function rmdDeclaredRothPortionCents(
  taxTreatment: AccountTaxTreatment,
  baseCents: number,
  measuredRothPocketCents: number,
): number | undefined {
  if (!hasRothDesignatedPocket(taxTreatment)) return undefined;
  const base = Math.max(0, baseCents);
  if (taxTreatment !== 'MIXED') return base;
  return Math.min(Math.max(0, measuredRothPocketCents), base);
}

/** Resolve the RMD-relevant balance for one account, applying the SECURE 2.0
 *  §325 Roth-portion subtraction exactly like `collectQualifyingBalances`. */
function rmdBaseBalanceCents(acct: RmdAccountInput): number {
  const roth = rothDesignatedSliceCents(
    acct.taxTreatment,
    acct.balanceDec31PriorYearCents,
    acct.rothPortionCents,
  );
  return Math.max(0, acct.balanceDec31PriorYearCents - roth);
}

/**
 * The §325-correct Dec-31 base TWO years before the tax year — the ONE resolver
 * both engines use to size a first-year-deferral catch-up.
 *
 * Applies the identical SECURE 2.0 §325 Roth-designated subtraction
 * `rmdBaseBalanceCents` applies to the current-year base (same
 * `rothDesignatedSliceCents` rule: an absent MIXED portion keeps the whole
 * balance — the conservative over-estimate — while a pure Roth account nets
 * to zero), so the deterministic engine and the Monte Carlo path can no longer
 * disagree about what "the trigger year's own base" means. Returns `undefined`
 * when the two-years-prior balance is absent or not a usable number — the caller
 * then reports the catch-up as a BLOCKER rather than guessing. Exported so
 * the MC path and tests consume the same resolver.
 */
export function rmdTwoYearsPriorBaseCents(acct: RmdAccountInput): number | undefined {
  const raw = acct.balanceDec31TwoYearsPriorCents;
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  const roth = rothDesignatedSliceCents(
    acct.taxTreatment,
    raw,
    acct.rothPortionTwoYearsPriorCents,
  );
  return Math.max(0, raw - roth);
}

/** Mutable accumulator threaded through the per-account fact classification so
 *  the loop body stays inside the shape cap and every branch writes to ONE
 *  place (no partially-built parallel results that can disagree). */
interface FactRmdAccumulator {
  /** Divisor → accounts sharing it (pooled with the legacy arithmetic). */
  readonly byDivisor: Map<number, { id: string; balanceCents: number }[]>;
  readonly withheldAccounts: RmdWithheldAccount[];
  readonly stillWorkingDeferredAccountIds: string[];
  readonly firstYearDeferrals: RmdFirstYearDeferralDetail[];
  /** Account id → deferred-from-the-prior-year catch-up cents. Kept per account
   *  so `sum(perAccountRmdCents) === ownerRmdCents` still holds exactly. */
  readonly catchUpByAccountId: Map<string, number>;
  applicable: boolean;
}

/** The pinned Table I/II/III bundle the fact path selects divisors from. The
 *  caller's Table III `snapshot` is reused verbatim as `uniformLifetime` (so a
 *  test / MC path that pins a custom Table III keeps it); Tables I and II fall
 *  back to the frozen module bundle only when the caller pinned nothing. */
function resolveFactTables(
  input: RmdInput,
  snapshot: CalibrationSnapshot<RmdTable>,
): RmdLifeExpectancyTables {
  return (
    input.lifeExpectancyTables ?? {
      uniformLifetime: snapshot,
      singleLife: RMD_LIFE_EXPECTANCY_TABLES.singleLife,
      jointLastSurvivor: RMD_LIFE_EXPECTANCY_TABLES.jointLastSurvivor,
    }
  );
}

/**
 * Apply the owner-path first-year April-1 deferral to ONE account.
 *
 * Returns `'deferred'` when this account's trigger-year amount moves into the
 * following year (so the caller must NOT add it to this year), `'withheld'` when
 * the first year (or the catch-up base) cannot be resolved, and `'due'`
 * otherwise. A catch-up year records the deferred trigger-year amount against
 * the SAME account so the per-account map keeps summing to the owner total.
 */
function applyFirstYearDeferral(
  acct: RmdAccountInput,
  args: {
    readonly acc: FactRmdAccumulator;
    readonly input: RmdInput;
    readonly tables: RmdLifeExpectancyTables;
    readonly age: number;
    readonly triggerAge: 73 | 75;
    readonly baseCents: number;
    readonly divisor: number;
    /** True when this account's §401(a)(9)(C) still-working preconditions are
     *  met, i.e. the exception DID defer distributions while employment
     *  continued. The first RMD year is then the LATER of the trigger-age year
     *  and the separation year — the account reaches this helper only in
     *  a year the exception no longer defers it (separation has happened), so
     *  the later-of branch is genuinely live. */
    readonly stillWorkingExceptionApplied: boolean;
  },
): 'deferred' | 'withheld' | 'due' {
  const {
    acc,
    input,
    tables,
    age,
    triggerAge,
    baseCents,
    divisor,
    stillWorkingExceptionApplied,
  } = args;
  const firstYear = resolveRmdFirstYearPlan({
    ownerAge: age,
    triggerAge,
    taxYear: input.taxYear,
    facts: acct.facts ?? {},
    stillWorkingExceptionApplied,
    retirementYear: input.retirementYear,
  });
  if (firstYear.kind === 'withheld') {
    acc.withheldAccounts.push({ accountId: acct.id, missingFacts: firstYear.missingFacts });
    return 'withheld';
  }
  if (firstYear.plan.deferred) {
    acc.firstYearDeferrals.push({
      accountId: acct.id,
      deferredCents: Math.round(baseCents / divisor),
      dueInYear: input.taxYear + 1,
    });
    return 'deferred';
  }
  if (input.taxYear !== firstYear.firstRmdYear + 1) return 'due';
  // Catch-up year: the deferred trigger-year RMD is due ALONGSIDE this year's
  // own ("two RMDs in one year"). Size it from the trigger year's own base
  // (Dec 31 two years before this year, §325-net — `rmdTwoYearsPriorBaseCents`,
  // the SAME resolver both engines feed) at the trigger year's divisor.
  const catchUpBase = rmdTwoYearsPriorBaseCents(acct);
  const priorSelection = selectRmdTableDivisor(
    { table: 'uniformLifetime', ownerAge: age - 1 },
    tables,
    input.taxYear - 1,
  );
  if (catchUpBase === undefined || priorSelection.kind !== 'divisor') {
    acc.withheldAccounts.push({
      accountId: acct.id,
      missingFacts: ['deferredFirstYearRmdBase'],
    });
    return 'due';
  }
  acc.catchUpByAccountId.set(
    acct.id,
    Math.round(Math.max(0, catchUpBase) / priorSelection.divisor),
  );
  return 'due';
}

/** Classify ONE account on the fact-based path, writing every outcome into
 *  `acc`. Extracted so `computeFactBasedRmd` stays inside the shape cap. */
function classifyFactRmdAccount(
  acct: RmdAccountInput,
  args: {
    readonly acc: FactRmdAccumulator;
    readonly input: RmdInput;
    readonly tables: RmdLifeExpectancyTables;
    readonly age: number;
    readonly triggerAge: 73 | 75;
  },
): void {
  const { acc, input, tables, age, triggerAge } = args;
  const facts = acct.facts ?? {};
  const inherited = facts.inheritedAccount === true;
  // Owner-path accounts keep the legacy trigger-age gate (now applied per
  // account). An INHERITED account is a BENEFICIARY obligation and is never
  // gated by the beneficiary's own trigger age.
  if (!inherited && age < triggerAge) return;
  const resolution = resolveRmdRule({
    facts,
    accountType: acct.accountType,
    taxTreatment: acct.taxTreatment,
    ages: { ownerAge: age },
    taxYear: input.taxYear,
    tables,
    ownerBirthdate: input.isoBirthdate,
    // The still-working exception is a deferral WHILE EMPLOYED, so it
    // needs the separation year to know when it stops applying.
    retirementYear: input.retirementYear,
  });
  if (resolution.kind === 'notRequired') return;
  acc.applicable = true;
  if (resolution.kind === 'withheld') {
    acc.withheldAccounts.push({ accountId: acct.id, missingFacts: resolution.missingFacts });
    return;
  }
  if (resolution.kind === 'stillWorkingDeferred') {
    acc.stillWorkingDeferredAccountIds.push(acct.id);
    return;
  }
  // The 5-year rule and a delayed surviving-spouse start impose a deadline, not
  // an ANNUAL minimum — $0 this year, disclosed through the report surface.
  if (
    resolution.kind === 'inheritedFiveYearRule' ||
    resolution.kind === 'inheritedSpousalDelayed'
  ) {
    return;
  }
  const selection = resolution.selection;
  // A 10-year window year with no annual life-expectancy requirement.
  if (selection === null) return;
  if (selection.kind === 'withheld') {
    acc.withheldAccounts.push({ accountId: acct.id, missingFacts: [selection.reason] });
    return;
  }
  const baseCents = rmdBaseBalanceCents(acct);
  if (!inherited && facts.firstYearDeferralElected === true) {
    const outcome = applyFirstYearDeferral(acct, {
      acc,
      input,
      tables,
      age,
      triggerAge,
      baseCents,
      divisor: selection.divisor,
      // An account whose still-working preconditions are met had its
      // distributions deferred while employment continued, so its first RMD year
      // is the LATER of the trigger-age year and the separation year. Reaching
      // this line means the exception no longer defers it (post-separation year),
      // which is exactly when the later-of resolution matters.
      stillWorkingExceptionApplied: stillWorkingExceptionEligible(
        facts,
        acct.accountType,
      ),
    });
    if (outcome !== 'due') return;
  }
  if (baseCents <= 0) return;
  const list = acc.byDivisor.get(selection.divisor) ?? [];
  list.push({ id: acct.id, balanceCents: baseCents });
  acc.byDivisor.set(selection.divisor, list);
}

/**
 * Compute one owner's RMD from explicit per-account facts.
 *
 * Each account is resolved INDEPENDENTLY through `resolveRmdRule` — the same
 * shared selector the oracle tests compare against, and the same one the Monte
 * Carlo path reaches through this very function — so an owner can hold a
 * still-working-deferred 401(k), a Table II IRA, and an inherited account in the
 * same year without any of them borrowing another's rule. Accounts that resolve
 * to the SAME divisor are pooled and allocated with the identical
 * sum-then-divide-then-allocate arithmetic the legacy path uses, so a household
 * whose accounts all land on Uniform Lifetime reproduces the legacy cents exactly.
 *
 * Conservative posture: a `withheld` resolution contributes $0 and is
 * reported in `withheldAccounts` (never a guessed divisor); `stillWorkingDeferred`
 * and `notRequired` contribute $0; an elected first-year deferral MOVES the
 * trigger-year amount into the following year rather than dropping it.
 */
function computeFactBasedRmd(
  input: RmdInput,
  snapshot: CalibrationSnapshot<RmdTable>,
  age: number,
  triggerAge: 73 | 75,
): RmdResult {
  const tables = resolveFactTables(input, snapshot);
  const acc: FactRmdAccumulator = {
    byDivisor: new Map(),
    withheldAccounts: [],
    stillWorkingDeferredAccountIds: [],
    firstYearDeferrals: [],
    catchUpByAccountId: new Map(),
    applicable: false,
  };
  for (const acct of input.accounts) {
    classifyFactRmdAccount(acct, { acc, input, tables, age, triggerAge });
  }
  if (!acc.applicable) return applicableFalseResult();

  let ownerRmdCents = 0;
  let qualifyingBalanceCents = 0;
  const perAccountRmdCents: Record<string, number> = {};
  for (const [divisor, accounts] of acc.byDivisor) {
    const groupResult = applicableTrueResult(accounts, divisor);
    ownerRmdCents += groupResult.ownerRmdCents;
    qualifyingBalanceCents += groupResult.qualifyingBalanceCents;
    for (const [id, cents] of Object.entries(groupResult.perAccountRmdCents)) {
      perAccountRmdCents[id] = (perAccountRmdCents[id] ?? 0) + cents;
    }
  }
  let deferredCatchUpCents = 0;
  for (const [id, cents] of acc.catchUpByAccountId) {
    deferredCatchUpCents += cents;
    ownerRmdCents += cents;
    perAccountRmdCents[id] = (perAccountRmdCents[id] ?? 0) + cents;
  }
  const divisors = [...acc.byDivisor.keys()];
  return {
    applicable: true,
    ownerRmdCents,
    perAccountRmdCents,
    // A single shared divisor is reported for display parity with the legacy
    // path; a genuinely mixed-rule year has no one divisor, so it reports null.
    divisor: divisors.length === 1 ? divisors[0] : null,
    qualifyingBalanceCents,
    withheldAccounts: acc.withheldAccounts,
    stillWorkingDeferredAccountIds: acc.stillWorkingDeferredAccountIds,
    firstYearDeferrals: acc.firstYearDeferrals,
    deferredCatchUpCents,
  };
}

// ===========================================================================
// Fact-based rule selection, still-working exception, and first-year deferral.
//
// `computeRmd` above routes through these whenever any account
// in a call carries `facts`. A call where NO account carries facts still runs the
// legacy Uniform-Lifetime branch verbatim, so a fact-free household's output stays
// byte-identical (the frozen parity fixtures prove it).
// ===========================================================================

/**
 * Beneficiary category for an INHERITED account, mirroring the DB SSOT
 * (`db/rmd-fact-validation.ts` `RmdBeneficiaryType`). Mirrored here — not
 * imported — to keep this engine module DB-free/portable, matching how the
 * `RmdAccountType` / `AccountTaxTreatment` unions above mirror `db/types.ts` and
 * so keeping the mirrored union's own name.
 */
type RmdBeneficiaryType =
  | 'SPOUSE'
  | 'MINOR_CHILD_OF_OWNER'
  | 'DISABLED_OR_CHRONICALLY_ILL'
  | 'NOT_MORE_THAN_10_YEARS_YOUNGER'
  | 'OTHER_DESIGNATED'
  | 'NON_PERSON';

/**
 * Post-death distribution election an eligible designated beneficiary made,
 * mirroring the DB SSOT (`db/rmd-fact-validation.ts` `RmdBeneficiaryElection`).
 * Mirrored — not imported — to keep this engine DB-free.
 */
type RmdBeneficiaryElection = 'LIFE_EXPECTANCY' | 'TEN_YEAR';

/**
 * Resolved per-account RMD profile facts. Mirrors the `rmd*` fields on
 * `AccountPayload`. Every field is optional; the
 * resolver applies each field's one-sided conservative default when absent.
 */
export interface RmdAccountProfileFacts {
  readonly inheritedAccount?: boolean;
  readonly currentEmployerPlan?: boolean;
  readonly fivePercentOwner?: boolean;
  readonly planRequiresDistributionAtStatutoryAge?: boolean;
  readonly firstYearDeferralElected?: boolean;
  readonly soleSpouseBeneficiaryMoreThan10YrsYounger?: boolean;
  readonly spouseBeneficiaryBirthdate?: string;
  readonly beneficiaryType?: RmdBeneficiaryType;
  readonly inheritedOwnerDeathDate?: string;
  readonly inheritedOwnerDiedOnOrAfterRbd?: boolean;
  readonly beneficiaryBirthdate?: string;
  /** The ORIGINAL account owner's ISO `YYYY-MM-DD` birthdate. Needed for
   *  the decedent's-remaining-life "longer-of" comparison when the owner died
   *  on/after their RBD, and for the surviving-spouse delayed-start year. Absent
   *  when a result depends on it → WITHHELD. */
  readonly originalOwnerBirthdate?: string;
  /** The eligible-designated-beneficiary post-death election. Absent on an
   *  EDB inherited account → the inherited RMD is WITHHELD (never invented). */
  readonly beneficiaryElection?: RmdBeneficiaryElection;
}

/** Attained ages (by Dec 31 of the RMD tax year) the rule resolver may need.
 *
 * The inheriting beneficiary's age is NOT accepted here: every individual
 * (person) inherited Table I path DERIVES the beneficiary's attained tax-year age
 * from the stored `beneficiaryBirthdate` fact (`resolveInheritedRmdRule`), never a
 * separately-supplied age input that a current-version payload could set
 * inconsistent with (or omit alongside) the birthdate. */
export interface RmdRuleAges {
  /** Living account owner's attained age (owner path). */
  readonly ownerAge?: number;
}

/** Resolved RMD rule for one account in one tax year. */
export type RmdRuleResolution =
  /** Non-inherited account whose type / tax treatment owes NO living-owner RMD —
   *  Roth IRA, designated-Roth employer accounts (Roth 401(k)/403(b)/457(b)/TSP),
   *  HSA, and every non-retirement account (brokerage, savings, money-market, CD,
   *  other). Only an INHERITED version of these is ever subject to RMD rules
   *  (handled on the inherited path, before this check). */
  | { readonly kind: 'notRequired' }
  /** Employer-plan still-working exception applies — no RMD from this plan this year. */
  | { readonly kind: 'stillWorkingDeferred' }
  /** Living owner, Uniform Lifetime Table III. */
  | { readonly kind: 'ownerUniformLifetime'; readonly selection: RmdTableSelection }
  /** Living owner whose sole spouse beneficiary is >10 yrs younger — Joint Life Table II. */
  | { readonly kind: 'ownerJointLife'; readonly selection: RmdTableSelection }
  /** Inherited account, eligible-designated-beneficiary life-expectancy stretch — Single Life Table I. */
  | { readonly kind: 'inheritedLifeExpectancy'; readonly selection: RmdTableSelection }
  /** Inherited account subject to the 10-year rule. `annualDistributionRequired`
   *  is `true` ONLY in window years 1–9 when the original owner died on/after
   *  their RBD (never the death/window-start year itself, never year ≥10);
   *  `fullLiquidationByYear` is the calendar year by whose END the account must
   *  be fully emptied (the 10th year after the window start), independent
   *  of the annual-distribution question. */
  | {
      readonly kind: 'inheritedTenYearRule';
      readonly annualDistributionRequired: boolean;
      readonly selection: RmdTableSelection | null;
      readonly fullLiquidationByYear: number;
    }
  /** Inherited account subject to the 5-year rule (non-person beneficiary, owner died before RBD). */
  | { readonly kind: 'inheritedFiveYearRule' }
  /** Surviving-spouse beneficiary (owner died BEFORE RBD) whose required
   *  distributions have not yet begun: the spouse may DELAY until the year the
   *  original owner WOULD HAVE reached their RBD (`firstDistributionYear`).
   *  No distribution is required before that year. */
  | { readonly kind: 'inheritedSpousalDelayed'; readonly firstDistributionYear: number }
  /** Required facts are incomplete — the result is withheld and the missing facts listed. */
  | { readonly kind: 'withheld'; readonly missingFacts: readonly string[] };

/** Employer-plan account types the §401(a)(9)(C) still-working exception can
 *  reach (never IRAs). */
function isEmployerPlanType(type: RmdAccountType): boolean {
  return (
    type === 'RETIREMENT_401K' ||
    type === 'RETIREMENT_403B' ||
    type === 'RETIREMENT_457B' ||
    type === 'RETIREMENT_TSP' ||
    type === 'RETIREMENT_CASH_BALANCE'
  );
}

/**
 * True when the account's §401(a)(9)(C) still-working PRECONDITIONS are met —
 * the FACT test only, with no year in it. Requires ALL of: an employer-plan
 * account type, the plan is the owner's CURRENT employer's plan, the owner is NOT
 * a >5% owner, and the plan's own terms do not force distributions at the
 * statutory age.
 *
 * Absence is conservative: the deferral (an optimistic, could-understate
 * direction) is granted only when EVERY precondition is AFFIRMATIVELY met, never
 * merely on the absence of a contrary fact —
 *   - an absent `currentEmployerPlan` (must be `true`) denies it,
 *   - an absent `fivePercentOwner` (must be explicitly `false` — an unknown
 *     ownership share is treated as a 5% owner) denies it, and
 *   - `planRequiresDistributionAtStatutoryAge` must be explicitly `false` — an
 *     ABSENT/unknown plan term denies the exception too. A `!== true`
 *     check would have granted the favorable deferral on missing plan terms,
 *     contradicting the conservative default; the exception requires an affirmative "this plan does
 *     not force distribution at the statutory age".
 *
 * Eligibility alone does NOT defer a year's RMD — the statute defers only WHILE
 * the owner is still working. `stillWorkingExceptionApplies` adds that year test;
 * this predicate answers the separate question "did the exception apply during
 * the employment years", which is what the §401(a)(9)(C) later-of first-RMD-year
 * resolution needs (`resolveRmdFirstYearPlan`).
 */
export function stillWorkingExceptionEligible(
  facts: RmdAccountProfileFacts,
  accountType: RmdAccountType,
): boolean {
  return (
    isEmployerPlanType(accountType) &&
    facts.currentEmployerPlan === true &&
    facts.fivePercentOwner === false &&
    facts.planRequiresDistributionAtStatutoryAge === false
  );
}

/**
 * True when the §401(a)(9)(C) still-working exception defers THIS tax year's RMD
 * for the account: the fact preconditions above AND the tax year is strictly
 * BEFORE the owner's separation year.
 *
 * The year test is the whole point: the exception suspends
 * distributions only while employment continues. §401(a)(9)(C)(i)(II) makes the
 * required beginning date April 1 following the calendar year the employee
 * RETIRES, so the separation year itself is already a distribution year — it is
 * the first RMD year (deferrable to April 1 of the next year through the
 * ordinary first-year election), never another exempt year. Without the test a
 * qualifying account stayed RMD-exempt in EVERY projected year, including
 * decades after the modeled retirement date.
 *
 * `separationYear` is the owner's modeled retirement year (the app records
 * retirement per household member, not per plan; a plan-specific separation date
 * is not captured). An UNKNOWN separation year denies the deferral — the
 * conservative direction: the account keeps its ordinary owner minimum
 * rather than being silently exempted forever.
 */
export function stillWorkingExceptionApplies(
  facts: RmdAccountProfileFacts,
  accountType: RmdAccountType,
  employment: {
    readonly taxYear: number;
    /** The owner's separation-from-service (retirement) year, when known. */
    readonly separationYear: number | undefined;
  },
): boolean {
  if (!stillWorkingExceptionEligible(facts, accountType)) return false;
  const { taxYear, separationYear } = employment;
  if (separationYear === undefined || !Number.isFinite(separationYear)) return false;
  return taxYear < separationYear;
}

/** First-year (required-beginning-date) April-1 deferral plan for one owner. */
export interface RmdFirstYearDeferralPlan {
  /** This tax year IS the owner's first RMD year (attained age === trigger age). */
  readonly isFirstRmdYear: boolean;
  /** The owner elected the deferral AND it is the first RMD year. */
  readonly deferred: boolean;
  /** Number of RMDs due in the FOLLOWING year: `2` when deferred (the deferred
   *  first-year RMD plus that year's own), else `0` from this deferral. */
  readonly rmdsDueFollowingYear: 0 | 2;
}

/** Assemble the first-year deferral plan from its two governing facts, keeping the
 *  `deferred ? 2 : 0` following-year rule in exactly ONE place (shared by both the
 *  baseline `rmdFirstYearDeferralPlan` and the later-of `resolveRmdFirstYearPlan`).
 *  The deferral is granted only when this IS the first RMD year AND the owner
 *  affirmatively elected it. */
function buildFirstYearPlan(isFirstRmdYear: boolean, elected: boolean): RmdFirstYearDeferralPlan {
  const deferred = isFirstRmdYear && elected;
  return { isFirstRmdYear, deferred, rmdsDueFollowingYear: deferred ? 2 : 0 };
}

/**
 * Resolve the first-year April-1 deferral for one owner in the BASELINE (not
 * still-working) case: the first RMD year is the year the owner attains the
 * trigger age (`ownerAge === triggerAge`). The required beginning date is April 1
 * of the FOLLOWING year, so the first RMD may be deferred into that year —
 * producing TWO RMDs there (the deferred one plus that year's own). Absent
 * election → no deferral (calendar-year RMD in the first year).
 *
 * This trigger-age-year assumption holds ONLY when the §401(a)(9)(C) still-working
 * exception did NOT defer the first distribution. A still-working employee whose
 * first distribution year is their RETIREMENT year (later than the trigger year)
 * must use `resolveRmdFirstYearPlan`, which resolves the later-of rule and
 * withholds when the retirement year is unknown. Pure.
 */
export function rmdFirstYearDeferralPlan(
  ownerAge: number,
  triggerAge: 73 | 75,
  facts: RmdAccountProfileFacts,
): RmdFirstYearDeferralPlan {
  const isFirstRmdYear = ownerAge === triggerAge;
  return buildFirstYearPlan(isFirstRmdYear, facts.firstYearDeferralElected === true);
}

/** Resolution of the first required-distribution year, which may WITHHOLD
 *  when a still-working employee's retirement year is unknown. */
export type RmdFirstYearResolution =
  | {
      readonly kind: 'plan';
      /** The resolved first required-distribution calendar year. */
      readonly firstRmdYear: number;
      readonly plan: RmdFirstYearDeferralPlan;
    }
  | { readonly kind: 'withheld'; readonly missingFacts: readonly string[] };

/**
 * Resolve the first required-distribution year for one owner, honouring the
 * §401(a)(9)(C) "later of statutory age or retirement" rule.
 *
 * The first RMD year is the LATER of the trigger-age year and — when the
 * still-working exception genuinely applied in the prior years — the
 * retirement/separation year. When the exception applied but the retirement year
 * is unknown, the first year cannot be resolved, so the result is WITHHELD rather
 * than guessed. When the exception did not apply, the first year is the
 * trigger-age year (matching `rmdFirstYearDeferralPlan`).
 *
 * `retirementYear` is a projection-time input (the app already models each
 * member's retirement year), not a new stored per-account fact. Pure.
 */
export function resolveRmdFirstYearPlan(args: {
  ownerAge: number;
  triggerAge: 73 | 75;
  taxYear: number;
  facts: RmdAccountProfileFacts;
  /** True when this account's §401(a)(9)(C) still-working exception deferred the
   *  owner's distributions in the prior years. */
  stillWorkingExceptionApplied: boolean;
  /** Year the owner separated from service / retired from this plan. Required to
   *  resolve the first year when the still-working exception applied. */
  retirementYear?: number;
}): RmdFirstYearResolution {
  const { ownerAge, triggerAge, taxYear, facts, stillWorkingExceptionApplied, retirementYear } = args;
  const triggerYear = taxYear - ownerAge + triggerAge;
  let firstRmdYear: number;
  if (stillWorkingExceptionApplied) {
    if (retirementYear === undefined) {
      return { kind: 'withheld', missingFacts: ['retirementYear'] };
    }
    firstRmdYear = Math.max(triggerYear, retirementYear);
  } else {
    firstRmdYear = triggerYear;
  }
  const isFirstRmdYear = taxYear === firstRmdYear;
  return {
    kind: 'plan',
    firstRmdYear,
    plan: buildFirstYearPlan(isFirstRmdYear, facts.firstYearDeferralElected === true),
  };
}

/** Eligible designated beneficiaries take a Single Life stretch (or may elect the
 *  10-year rule); the two other designated/non-designated categories follow the
 *  10-year / 5-year rules. */
function isEligibleDesignatedBeneficiary(category: RmdBeneficiaryType): boolean {
  return (
    category === 'SPOUSE' ||
    category === 'MINOR_CHILD_OF_OWNER' ||
    category === 'DISABLED_OR_CHRONICALLY_ILL' ||
    category === 'NOT_MORE_THAN_10_YEARS_YOUNGER'
  );
}

/** Numeric year of a stored ISO date, else undefined. Rejects malformed strings,
 *  calendar-impossible dates (Feb 30, non-leap Feb 29), AND implausible out-of-
 *  bounds years via the shared `[1900, 2200]` validator — so a bogus year
 *  is never extracted from an unsanitised current-version payload. */
function isoYearOf(value: string | undefined): number | undefined {
  if (!isValidRmdIsoDate(value)) return undefined;
  return Number(value.slice(0, 4));
}

/**
 * Build the Single Life (Table I) request for an inherited stretch, encoding the
 * correct recalculation mode by beneficiary kind:
 *   - a surviving SPOUSE recalculates by their CURRENT age every year;
 *   - a NON-SPOUSE beneficiary FIXES the divisor in the year following the owner's
 *     death (`baseAge`) and decrements 1.0 per elapsed year, never re-looking-up.
 */
function singleLifeStretchRequest(
  category: RmdBeneficiaryType,
  beneficiaryAge: number,
  deathYear: number,
  taxYear: number,
): RmdTableRequest {
  if (category === 'SPOUSE') {
    return { table: 'singleLife', mode: 'recalculate', age: beneficiaryAge };
  }
  const baseYear = deathYear + 1;
  const elapsedYears = taxYear - baseYear;
  return {
    table: 'singleLife',
    mode: 'anchoredDecrement',
    baseAge: beneficiaryAge - elapsedYears,
    elapsedYears,
  };
}

/** Pick the LONGER remaining life expectancy (the LARGER usable divisor = slower
 *  distribution). When only one is a usable divisor, that one wins; when both are
 *  withheld, the beneficiary's withheld selection propagates. */
function longerOfSelection(
  beneficiary: RmdTableSelection,
  decedent: RmdTableSelection,
): RmdTableSelection {
  if (beneficiary.kind === 'divisor' && decedent.kind === 'divisor') {
    return decedent.divisor > beneficiary.divisor ? decedent : beneficiary;
  }
  return beneficiary.kind === 'divisor' ? beneficiary : decedent;
}

/**
 * Annual single-life divisor for a designated beneficiary. When the owner died
 * ON/AFTER their RBD, IRS rules require the LONGER of the beneficiary's own
 * remaining single life expectancy OR the DECEDENT's remaining single life
 * expectancy ("ghost life") had they lived — the latter a second Table I lookup
 * anchored at the decedent's age in the death year, decremented 1.0 per elapsed
 * year. The decedent lookup needs the original owner's birthdate;
 * absent → WITHHOLD. When the owner died BEFORE their RBD, only the
 * beneficiary's own schedule applies (no ghost-life comparison).
 */
function annualSingleLifeSelection(args: {
  category: RmdBeneficiaryType;
  beneficiaryAge: number;
  deathYear: number;
  taxYear: number;
  diedOnOrAfterRbd: boolean;
  originalOwnerBirthdate: string | undefined;
  tables: RmdLifeExpectancyTables;
}):
  | { readonly kind: 'selection'; readonly selection: RmdTableSelection }
  | { readonly kind: 'withheld'; readonly missingFacts: readonly string[] } {
  const { category, beneficiaryAge, deathYear, taxYear, diedOnOrAfterRbd, originalOwnerBirthdate, tables } = args;
  // An inherited beneficiary's own single-life SCHEDULE begins the year
  // AFTER the owner's death. The death year itself (and any earlier year) is still
  // the DECEASED OWNER's final lifetime RMD (owner rules), not a beneficiary year,
  // so it must NOT produce a beneficiary / ghost-life Table I divisor. (The 10-year
  // rule's death-year window-start shell never reaches here — it only calls this in
  // annual-window offset years ≥ 1, which are strictly after the window start.)
  if (taxYear <= deathYear) {
    return { kind: 'withheld', missingFacts: ['deathYearIsOwnersFinalRmdYear'] };
  }
  const beneficiarySelection = selectRmdTableDivisor(
    singleLifeStretchRequest(category, beneficiaryAge, deathYear, taxYear),
    tables,
    taxYear,
  );
  if (!diedOnOrAfterRbd) {
    return { kind: 'selection', selection: beneficiarySelection };
  }
  const ownerBirthYear = isoYearOf(originalOwnerBirthdate);
  if (ownerBirthYear === undefined) {
    return { kind: 'withheld', missingFacts: ['originalOwnerBirthdate'] };
  }
  const decedentSelection = selectRmdTableDivisor(
    {
      table: 'singleLife',
      mode: 'anchoredDecrement',
      baseAge: deathYear - ownerBirthYear,
      elapsedYears: taxYear - deathYear,
    },
    tables,
    taxYear,
  );
  return { kind: 'selection', selection: longerOfSelection(beneficiarySelection, decedentSelection) };
}

/** 10-year-rule resolution. The account must be fully emptied by the END of
 *  the 10th year after the window start (`fullLiquidationByYear`). Annual life-
 *  expectancy RMDs apply ONLY in window offset years 1–9 AND only when the owner
 *  died on/after their RBD — never the window-start year (offset 0) nor year ≥10.
 *  `windowStartYear` defaults to the death year; a minor child who reaches majority
 *  starts the window at their 21st-birthday year. */
function resolveTenYearRule(args: {
  category: RmdBeneficiaryType;
  diedOnOrAfterRbd: boolean;
  beneficiaryAge: number | undefined;
  deathYear: number;
  taxYear: number;
  tables: RmdLifeExpectancyTables;
  originalOwnerBirthdate: string | undefined;
  windowStartYear?: number;
}): RmdRuleResolution {
  const { category, diedOnOrAfterRbd, beneficiaryAge, deathYear, taxYear, tables, originalOwnerBirthdate } = args;
  const windowStartYear = args.windowStartYear ?? deathYear;
  const fullLiquidationByYear = windowStartYear + 10;
  const offsetYears = taxYear - windowStartYear;
  const withinAnnualWindow = offsetYears >= 1 && offsetYears <= 9;
  if (!diedOnOrAfterRbd || !withinAnnualWindow) {
    return { kind: 'inheritedTenYearRule', annualDistributionRequired: false, selection: null, fullLiquidationByYear };
  }
  if (beneficiaryAge === undefined) {
    return { kind: 'withheld', missingFacts: ['beneficiaryBirthdate'] };
  }
  const annual = annualSingleLifeSelection({
    category,
    beneficiaryAge,
    deathYear,
    taxYear,
    diedOnOrAfterRbd,
    originalOwnerBirthdate,
    tables,
  });
  if (annual.kind === 'withheld') {
    return { kind: 'withheld', missingFacts: annual.missingFacts };
  }
  return {
    kind: 'inheritedTenYearRule',
    annualDistributionRequired: true,
    selection: annual.selection,
    fullLiquidationByYear,
  };
}

/** Resolve a MINOR_CHILD_OF_OWNER inherited account. The minor child takes
 *  the life-expectancy stretch until they reach the age of majority (21, per IRS
 *  final regulations), then transitions to the 10-year rule (its own year-10
 *  liquidation deadline). A beneficiary who was already ≥21 at the owner's death is
 *  NOT a minor child — an invalid category assignment that WITHHOLDS. */
function resolveMinorChildRule(args: {
  facts: RmdAccountProfileFacts;
  beneficiaryAge: number | undefined;
  deathYear: number;
  taxYear: number;
  diedOnOrAfterRbd: boolean;
  tables: RmdLifeExpectancyTables;
}): RmdRuleResolution {
  const { facts, beneficiaryAge, deathYear, taxYear, diedOnOrAfterRbd, tables } = args;
  const birthdate = facts.beneficiaryBirthdate;
  if (!isValidRmdIsoDate(birthdate) || beneficiaryAge === undefined) {
    return { kind: 'withheld', missingFacts: ['beneficiaryBirthdate'] };
  }
  const birthYear = Number(birthdate.slice(0, 4));
  // Anniversary-safe majority test: compare the FULL death date against the
  // beneficiary's 21st birthday (birthdate + 21 years, day-for-day) rather than
  // year-only subtraction. A child still 20 ON the death date (turning 21 LATER the
  // same calendar year) is a genuine minor; one who reached 21 ON or before the
  // death date is NOT a minor child (an invalid category assignment → WITHHOLD).
  // ISO `YYYY-MM-DD` strings compare chronologically. The death date's presence /
  // validity is already guaranteed by the caller's `deathYear` resolution.
  const twentyFirstBirthday = `${birthYear + 21}${birthdate.slice(4)}`;
  const deathDate = facts.inheritedOwnerDeathDate;
  if (isValidRmdIsoDate(deathDate) && deathDate >= twentyFirstBirthday) {
    return { kind: 'withheld', missingFacts: ['minorChildBeneficiaryNotMinorAtDeath'] };
  }
  const majorityYear = birthYear + 21;
  if (taxYear < majorityYear) {
    // Before majority: eligible-designated life-expectancy stretch (annual).
    const annual = annualSingleLifeSelection({
      category: 'MINOR_CHILD_OF_OWNER',
      beneficiaryAge,
      deathYear,
      taxYear,
      diedOnOrAfterRbd,
      originalOwnerBirthdate: facts.originalOwnerBirthdate,
      tables,
    });
    if (annual.kind === 'withheld') {
      return { kind: 'withheld', missingFacts: annual.missingFacts };
    }
    return { kind: 'inheritedLifeExpectancy', selection: annual.selection };
  }
  // At/after majority: the 10-year rule begins, its window anchored at majority.
  return resolveTenYearRule({
    category: 'MINOR_CHILD_OF_OWNER',
    diedOnOrAfterRbd,
    beneficiaryAge,
    deathYear,
    taxYear,
    tables,
    originalOwnerBirthdate: facts.originalOwnerBirthdate,
    windowStartYear: majorityYear,
  });
}

/** Resolve a surviving-SPOUSE life-expectancy stretch. When the owner
 *  died BEFORE their RBD, the spouse may DELAY required distributions until the
 *  year the owner WOULD HAVE reached their RBD — that year needs the original
 *  owner's birthdate; absent → WITHHOLD. Before that year no distribution is
 *  required; from it, the spouse recalculates by current age each year. When the
 *  owner died ON/AFTER their RBD, distributions have already begun and the annual
 *  divisor is the longer-of comparison. */
function resolveSpouseStretch(args: {
  facts: RmdAccountProfileFacts;
  beneficiaryAge: number | undefined;
  deathYear: number;
  taxYear: number;
  diedOnOrAfterRbd: boolean;
  tables: RmdLifeExpectancyTables;
}): RmdRuleResolution {
  const { facts, beneficiaryAge, deathYear, taxYear, diedOnOrAfterRbd, tables } = args;
  if (beneficiaryAge === undefined) {
    return { kind: 'withheld', missingFacts: ['beneficiaryBirthdate'] };
  }
  if (!diedOnOrAfterRbd) {
    const ownerBirthYear = isoYearOf(facts.originalOwnerBirthdate);
    if (ownerBirthYear === undefined) {
      return { kind: 'withheld', missingFacts: ['originalOwnerBirthdate'] };
    }
    // The year the DECEASED owner would have reached their RBD uses the
    // HISTORICAL applicable age in force for their birth year (70½ / 72 / 73 / 75),
    // NOT `rmdTriggerAge` (which models only currently-living owners at 73/75).
    const firstDistributionYear =
      ownerBirthYear + deceasedOwnerApplicableRmdAge(ownerBirthYear);
    if (taxYear < firstDistributionYear) {
      return { kind: 'inheritedSpousalDelayed', firstDistributionYear };
    }
    return {
      kind: 'inheritedLifeExpectancy',
      selection: selectRmdTableDivisor(
        singleLifeStretchRequest('SPOUSE', beneficiaryAge, deathYear, taxYear),
        tables,
        taxYear,
      ),
    };
  }
  const annual = annualSingleLifeSelection({
    category: 'SPOUSE',
    beneficiaryAge,
    deathYear,
    taxYear,
    diedOnOrAfterRbd,
    originalOwnerBirthdate: facts.originalOwnerBirthdate,
    tables,
  });
  if (annual.kind === 'withheld') {
    return { kind: 'withheld', missingFacts: annual.missingFacts };
  }
  return { kind: 'inheritedLifeExpectancy', selection: annual.selection };
}

/** Resolve the inherited-account rule from beneficiary facts, withholding when
 *  any required fact is missing or the death regime is unsupported.
 *  `ownerAlwaysDiedBeforeRbd` forces the pre-RBD regime for a Roth account
 *  — a Roth owner has no lifetime RBD, so any stored on/after-RBD flag is ignored. */
function resolveInheritedRmdRule(args: {
  facts: RmdAccountProfileFacts;
  taxYear: number;
  tables: RmdLifeExpectancyTables;
  ownerAlwaysDiedBeforeRbd: boolean;
}): RmdRuleResolution {
  const { facts, taxYear, tables, ownerAlwaysDiedBeforeRbd } = args;
  // Baseline required-fact blockers are owned by `validateRmdProfileFacts`
  // (single source of truth shared with the account editor's readiness surface).
  const baseline = validateRmdProfileFacts(facts, ownerAlwaysDiedBeforeRbd);
  if (!baseline.ok) {
    return { kind: 'withheld', missingFacts: baseline.blockers.map((b) => b.field) };
  }

  // Validate the persisted beneficiary category + election against the
  // shared DB validators (the migration sanitiser only runs on below-current
  // payloads, so a current-version v6 import reaches here unsanitised). An
  // out-of-vocabulary value WITHHOLDS rather than being coerced into a real rule.
  if (!isValidRmdBeneficiaryType(facts.beneficiaryType)) {
    return { kind: 'withheld', missingFacts: ['beneficiaryType'] };
  }
  if (
    facts.beneficiaryElection !== undefined &&
    !isValidRmdBeneficiaryElection(facts.beneficiaryElection)
  ) {
    return { kind: 'withheld', missingFacts: ['beneficiaryElection'] };
  }
  const category: RmdBeneficiaryType = facts.beneficiaryType;

  // DERIVE the beneficiary's attained tax-year age from the stored
  // birthdate (never a separately-supplied age input): a current-version payload
  // could otherwise smuggle an age inconsistent with (or absent alongside) the
  // birthdate. Absent/malformed birthdate → the individual Table I paths WITHHOLD.
  const beneficiaryBirthYear = isoYearOf(facts.beneficiaryBirthdate);
  const beneficiaryAge =
    beneficiaryBirthYear === undefined ? undefined : taxYear - beneficiaryBirthYear;

  // A Roth account's owner has no Required Beginning Date during their
  // lifetime, so an inherited Roth is ALWAYS treated as a death BEFORE RBD,
  // overriding any (contradictory) stored `inheritedOwnerDiedOnOrAfterRbd` flag.
  const diedOnOrAfterRbd = ownerAlwaysDiedBeforeRbd
    ? false
    : facts.inheritedOwnerDiedOnOrAfterRbd === true;

  // The ORIGINAL owner's death date selects the applicable rule REGIME. A
  // pre-2020 death falls under the pre-SECURE-Act stretch rules, which this engine
  // does NOT model: withhold rather than silently apply the post-2019 SECURE Act
  // rules to it. (`validateRmdProfileFacts` already required the date's presence;
  // a malformed value that survived to here also withholds.)
  const deathYear = isoYearOf(facts.inheritedOwnerDeathDate);
  if (deathYear === undefined) {
    return { kind: 'withheld', missingFacts: ['inheritedOwnerDeathDate'] };
  }
  if (deathYear < 2020) {
    return { kind: 'withheld', missingFacts: ['preSecureActDeathRulesUnsupported'] };
  }

  // An inherited account cannot exist before the owner's death. (The DEATH
  // YEAR itself is still the owner's FINAL lifetime RMD, not a beneficiary year;
  // that boundary is enforced where each individual Table I schedule is computed —
  // `annualSingleLifeSelection`, whose schedule begins the year AFTER death — so
  // the 10-year rule's death-year window-start shell stays intact.)
  if (taxYear < deathYear) {
    return { kind: 'withheld', missingFacts: ['taxYearBeforeOwnerDeath'] };
  }

  // Non-person (estate/charity/non-qualifying trust): 5-year rule when the owner
  // died BEFORE their RBD. When the owner died on/after their RBD the
  // decedent's remaining-single-life ("ghost life") schedule applies, but that
  // decedent-only schedule is deliberately OUT OF SCOPE —
  // the required birthdate IS captured (`facts.originalOwnerBirthdate`), the
  // engine just does not yet compute the NON_PERSON ghost-life schedule — so
  // withhold rather than guess.
  if (category === 'NON_PERSON') {
    if (!diedOnOrAfterRbd) return { kind: 'inheritedFiveYearRule' };
    return { kind: 'withheld', missingFacts: ['nonPersonGhostLifeScheduleUnsupported'] };
  }

  // Eligible designated beneficiary → the beneficiary must have AFFIRMATIVELY
  // elected between the life-expectancy stretch and the 10-year rule; the engine
  // never invents that election. Absent → withhold.
  if (isEligibleDesignatedBeneficiary(category)) {
    if (facts.beneficiaryElection === undefined) {
      return { kind: 'withheld', missingFacts: ['beneficiaryElection'] };
    }
    if (facts.beneficiaryElection === 'TEN_YEAR') {
      // The 10-year-rule election is available to an eligible designated
      // beneficiary ONLY when the owner died BEFORE their RBD. When the owner died
      // ON/AFTER their RBD there is no 10-year election — life-expectancy (annual)
      // treatment is mandatory ("at least as rapidly") — so a stored TEN_YEAR
      // election combined with an on/after-RBD death is an incompatible fact
      // combination that WITHHOLDS rather than silently applying the wrong rule.
      if (diedOnOrAfterRbd) {
        return {
          kind: 'withheld',
          missingFacts: ['tenYearElectionInvalidWhenOwnerDiedOnOrAfterRbd'],
        };
      }
      return resolveTenYearRule({
        category,
        diedOnOrAfterRbd,
        beneficiaryAge,
        deathYear,
        taxYear,
        tables,
        originalOwnerBirthdate: facts.originalOwnerBirthdate,
      });
    }
    // LIFE_EXPECTANCY stretch — per-category schedule.
    if (category === 'MINOR_CHILD_OF_OWNER') {
      return resolveMinorChildRule({ facts, beneficiaryAge, deathYear, taxYear, diedOnOrAfterRbd, tables });
    }
    if (category === 'SPOUSE') {
      return resolveSpouseStretch({ facts, beneficiaryAge, deathYear, taxYear, diedOnOrAfterRbd, tables });
    }
    // Other non-spouse eligible designated beneficiary (disabled/chronically ill,
    // not-more-than-10-years-younger): anchored single-life stretch with the
    // longer-of ghost comparison when the owner died on/after RBD.
    if (beneficiaryAge === undefined) {
      return { kind: 'withheld', missingFacts: ['beneficiaryBirthdate'] };
    }
    const annual = annualSingleLifeSelection({
      category,
      beneficiaryAge,
      deathYear,
      taxYear,
      diedOnOrAfterRbd,
      originalOwnerBirthdate: facts.originalOwnerBirthdate,
      tables,
    });
    if (annual.kind === 'withheld') {
      return { kind: 'withheld', missingFacts: annual.missingFacts };
    }
    return { kind: 'inheritedLifeExpectancy', selection: annual.selection };
  }

  // Non-eligible designated beneficiary → 10-year rule (no election choice).
  return resolveTenYearRule({
    category,
    diedOnOrAfterRbd,
    beneficiaryAge,
    deathYear,
    taxYear,
    tables,
    originalOwnerBirthdate: facts.originalOwnerBirthdate,
  });
}

/** Account types subject to beneficiary RMD rules when INHERITED. Unlike
 *  the living-owner `isQualifyingAccount` test this INCLUDES Roth IRAs and the
 *  designated-Roth employer accounts (a living Roth owner has no RMD, but a
 *  BENEFICIARY of an inherited Roth account IS subject to post-death RMD rules). It
 *  EXCLUDES HSAs and every non-retirement account (brokerage, savings, money-
 *  market, CD, other), which are NOT subject to IRS RMD rules even when inherited. */
export function isInheritedRmdSubjectType(type: RmdAccountType): boolean {
  return (
    type === 'RETIREMENT_IRA' ||
    type === 'RETIREMENT_401K' ||
    type === 'RETIREMENT_403B' ||
    type === 'RETIREMENT_457B' ||
    type === 'RETIREMENT_TSP' ||
    type === 'RETIREMENT_CASH_BALANCE' ||
    type === 'RETIREMENT_ROTH_IRA' ||
    type === 'RETIREMENT_ROTH_401K' ||
    type === 'RETIREMENT_ROTH_403B' ||
    type === 'RETIREMENT_ROTH_457B' ||
    type === 'RETIREMENT_ROTH_TSP'
  );
}

/** Roth account types — their owner has no lifetime Required Beginning Date, so an
 *  inherited Roth account is always a death-before-RBD case. */
function isRothAccountType(type: RmdAccountType): boolean {
  return (
    type === 'RETIREMENT_ROTH_IRA' ||
    type === 'RETIREMENT_ROTH_401K' ||
    type === 'RETIREMENT_ROTH_403B' ||
    type === 'RETIREMENT_ROTH_457B' ||
    type === 'RETIREMENT_ROTH_TSP'
  );
}

/**
 * Anniversary-safe test that the sole spouse beneficiary is MORE THAN ten years
 * younger than the owner, derived from their birthdates — NOT year-of-birth
 * subtraction, since day/month matters at the exact-10-year boundary. The spouse
 * qualifies iff their birthdate is strictly later than the owner's birthdate
 * shifted +10 years (lexicographic compare on `YYYY-MM-DD` is chronological).
 * Returns `undefined` when either birthdate is missing or malformed (shared
 * calendar + `[1900, 2200]` validation), so the caller WITHHOLDS rather
 * than trusting a stored boolean.
 */
export function spouseMoreThan10YearsYounger(
  ownerBirthdate: string | undefined,
  spouseBirthdate: string | undefined,
): boolean | undefined {
  if (!isValidRmdIsoDate(ownerBirthdate) || !isValidRmdIsoDate(spouseBirthdate)) return undefined;
  const ownerYear = Number(ownerBirthdate.slice(0, 4));
  const tenYearsAfterOwner = `${ownerYear + 10}${ownerBirthdate.slice(4)}`;
  return spouseBirthdate > tenYearsAfterOwner;
}

/**
 * Select the applicable RMD rule + life-expectancy table for one account in one
 * tax year from explicit facts. Owner path: accounts owing no living-owner RMD →
 * not-required → still-working exception → Joint Life (Table II) for a sole
 * spouse verified MORE THAN 10 yrs younger by birthdate → Uniform Lifetime
 * (Table III) default. Inherited path: withholds on incomplete facts or an
 * unsupported death regime, else selects the SECURE-Act post-death rule
 * (life-expectancy stretch / 10-year / 5-year).
 *
 * Assumes the caller has already gated the owner to at/over their trigger age
 * (the still-working exception is evaluated independently of that gate, but IS
 * year-scoped — it needs `retirementYear`). Pure.
 */
export function resolveRmdRule(args: {
  facts: RmdAccountProfileFacts;
  accountType: RmdAccountType;
  taxTreatment: AccountTaxTreatment;
  ages: RmdRuleAges;
  taxYear: number;
  tables: RmdLifeExpectancyTables;
  /** Owner's ISO `YYYY-MM-DD` birthdate — needed for the birthdate-derived
   *  sole-spouse >10-years-younger test. */
  ownerBirthdate?: string;
  /** The owner's separation-from-service (retirement) year. The §401(a)(9)(C)
   *  still-working exception defers only the years BEFORE it; absent → the
   *  exception is not granted at all (conservative). */
  retirementYear?: number;
}): RmdRuleResolution {
  const {
    facts,
    accountType,
    taxTreatment,
    ages,
    taxYear,
    tables,
    ownerBirthdate,
    retirementYear,
  } = args;

  // Inherited RETIREMENT accounts (including inherited Roth IRAs / Roth employer
  // accounts) ARE subject to beneficiary RMD rules — evaluated FIRST, before the
  // not-required living-owner check. An inherited HSA or non-retirement
  // account (brokerage, savings, money-market, CD, other) is NOT subject to IRS
  // RMD rules at all, so it routes to `notRequired`.
  if (facts.inheritedAccount === true) {
    if (!isInheritedRmdSubjectType(accountType)) {
      return { kind: 'notRequired' };
    }
    return resolveInheritedRmdRule({
      facts,
      taxYear,
      tables,
      ownerAlwaysDiedBeforeRbd: isRothAccountType(accountType),
    });
  }

  // Owner path.
  // A living owner owes NO RMD from an account whose type/tax-treatment is
  // non-qualifying (Roth IRA, designated-Roth employer accounts, HSA, and every
  // non-retirement account). Resolve that BEFORE any Table III fall-through.
  if (!isQualifyingAccount(accountType, taxTreatment)) {
    return { kind: 'notRequired' };
  }

  // The exception defers only the years strictly BEFORE separation; an already-
  // separated (or unknown-separation) owner falls through to the ordinary
  // owner-path tables below.
  if (stillWorkingExceptionApplies(facts, accountType, { taxYear, separationYear: retirementYear })) {
    return { kind: 'stillWorkingDeferred' };
  }

  // A missing owner age must WITHHOLD, never default to 0: a `?? 0` would
  // clamp to the trigger-age (age-73) divisor — the most favorable, largest
  // divisor — and silently UNDERSTATE the RMD, contradicting the withhold-on-
  // missing-fact posture this module enforces everywhere else. The real owner age
  // is required for both the Joint Life (Table II) and Uniform Lifetime (Table III)
  // divisor lookups below.
  const ownerAge = ages.ownerAge;
  if (ownerAge === undefined) {
    return { kind: 'withheld', missingFacts: ['ownerAge'] };
  }

  // A claimed sole-spouse >10-years-younger designation selects Table II
  // ONLY when independently VERIFIED from the owner + spouse birthdates. A stored
  // boolean is never trusted alone: missing/malformed birthdates WITHHOLD, and a
  // birthdate-derived "not more than 10 years younger" falls back to Table III.
  if (facts.soleSpouseBeneficiaryMoreThan10YrsYounger === true) {
    const verified = spouseMoreThan10YearsYounger(ownerBirthdate, facts.spouseBeneficiaryBirthdate);
    if (verified === undefined) {
      const missingFacts: string[] = [];
      if (!isValidRmdIsoDate(ownerBirthdate)) {
        missingFacts.push('ownerBirthdate');
      }
      if (!isValidRmdIsoDate(facts.spouseBeneficiaryBirthdate)) {
        missingFacts.push('spouseBeneficiaryBirthdate');
      }
      return { kind: 'withheld', missingFacts };
    }
    if (verified) {
      // Table II eligibility is now established from the validated
      // birthdates; derive the spouse's attained age from THAT SAME validated
      // birthdate + taxYear rather than a separate redundant age fact. If the age
      // still cannot be derived, WITHHOLD — never silently downgrade to the
      // less-favorable-to-correctness Table III once Table II is established.
      const spouseBirthYear = isoYearOf(facts.spouseBeneficiaryBirthdate);
      if (spouseBirthYear === undefined) {
        return { kind: 'withheld', missingFacts: ['spouseBeneficiaryBirthdate'] };
      }
      return {
        kind: 'ownerJointLife',
        selection: selectRmdTableDivisor(
          { table: 'jointLastSurvivor', ownerAge, beneficiaryAge: taxYear - spouseBirthYear },
          tables,
          taxYear,
        ),
      };
    }
    // Birthdate-verified NOT >10 younger → Uniform Lifetime (conservative).
  }

  return {
    kind: 'ownerUniformLifetime',
    selection: selectRmdTableDivisor({ table: 'uniformLifetime', ownerAge }, tables, taxYear),
  };
}
