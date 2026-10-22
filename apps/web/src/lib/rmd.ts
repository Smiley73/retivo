/**
 * US Required Minimum Distribution engine (pure): SECURE 2.0 trigger ages (73 born 1951–1959, 75 born 1960+), the IRS Pub 590-B
 * Appendix B tables chosen per account by `selectRmdTableDivisor`, proportional allocation and the Roth-portion subtraction (SECURE 2.0 §325).
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

export { UnsupportedTaxYearError, RmdInvalidInputError } from './rmd-errors';
export { hasRothDesignatedPocket } from './rmd-validation';

/** Account types accepted by the RMD engine; mirrors db/types.ts, which this DB-free module does not import. */
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

export type { RmdTable } from './rmd-divisors';

/**
 * Per-account RMD input; balances are integer cents. `rothPortionCents` is the Roth-designated part, which carries no RMD
 * (SECURE 2.0 §325): valid only where a Roth-designated pocket exists (`MIXED`, or pure Roth `POST_TAX` / `ROTH`;
 * `PRE_TAX` / `HSA` throw `RmdInvalidInputError`), within [0, balance]. When omitted, MIXED is 0 (the whole balance is the
 * base, a conservative over-estimate) and a pure Roth account is its whole balance, so every producer of an RMD base
 * lands on the same base.
 */
export interface RmdAccountInput {
  readonly id: string;
  readonly balanceDec31PriorYearCents: number;
  readonly accountType: RmdAccountType;
  readonly taxTreatment: AccountTaxTreatment;
  readonly rothPortionCents?: number;
  /**
   * Stored RMD profile facts. Absent on every account in the call, the legacy owner/Uniform-Lifetime path runs unchanged;
   * present on any, the whole call uses fact-based per-account rule resolution (`resolveRmdRule`), each absent field at its
   * one-sided conservative default.
   */
  readonly facts?: RmdAccountProfileFacts;
  /**
   * Dec 31 balance two years before the tax year, used only to size a first-year-deferral catch-up (the deferred trigger-year
   * RMD is based on that year's own base). Absent, the catch-up is reported as a blocker rather than guessed. Same units and
   * §325 treatment as `balanceDec31PriorYearCents`: both engines pass the full balance plus `rothPortionTwoYearsPriorCents`.
   */
  readonly balanceDec31TwoYearsPriorCents?: number;
  /** Roth-designated portion of `balanceDec31TwoYearsPriorCents` (SECURE 2.0 §325); valid and defaulted like `rothPortionCents`. */
  readonly rothPortionTwoYearsPriorCents?: number;
}

/** Top-level RMD input for one owner. Age is the calendar-year Dec-31 age (IRC §401(a)(9)), not the SSA first-day-of-month shift; `taxYear` is >= 2024. */
export interface RmdInput {
  readonly isoBirthdate: string;
  readonly taxYear: number;
  readonly accounts: readonly RmdAccountInput[];
  /** Pinned Table I/II/III bundle for the fact-based path (ignored without `facts`); absent uses `snapshot` for Table III and the frozen module bundle for I/II. Both production engines pin all three so Monte Carlo never reads live calibration. */
  readonly lifeExpectancyTables?: RmdLifeExpectancyTables;
  /** Calendar year the owner separated from service, needed for the §401(a)(9)(C) "later of statutory age or retirement" first year when the still-working exception applied; absent then withholds that account. */
  readonly retirementYear?: number;
}

/**
 * RMD result for one owner. Below the trigger age (`applicable` false) all numbers are zero. `perAccountRmdCents` holds
 * proportional shares for qualifying accounts only and sums exactly to `ownerRmdCents`; `divisor` is the Table III divisor
 * (null when not applicable); `qualifyingBalanceCents` is the pre-tax balance after the Roth-portion subtraction.
 */
export interface RmdResult {
  readonly applicable: boolean;
  readonly ownerRmdCents: number;
  readonly perAccountRmdCents: Record<string, number>;
  readonly divisor: number | null;
  readonly qualifyingBalanceCents: number;
  /**
   * Accounts whose RMD could not be computed, each contributing $0 and absent from `perAccountRmdCents` (withheld, never
   * guessed): a missing inherited fact, a missing owner-path input (unknown `retirementYear` when the still-working
   * preconditions are met, absent `balanceDec31TwoYearsPriorCents` for a deferred catch-up), or a fact combination not
   * modeled (pre-2020 death, non-person ghost-life schedule, invalid ten-year election). Absent (not `[]`) on the no-facts path.
   */
  readonly withheldAccounts?: readonly RmdWithheldAccount[];
  /** Accounts deferred this year by the §401(a)(9)(C) still-working exception; $0 and not blockers. */
  readonly stillWorkingDeferredAccountIds?: readonly string[];
  /** Accounts whose trigger-year RMD moves to April 1 of the next year by election, with the deferred cents; excluded from this year's `ownerRmdCents` and added back next year from `balanceDec31TwoYearsPriorCents`. */
  readonly firstYearDeferrals?: readonly RmdFirstYearDeferralDetail[];
  /** Deferred catch-up cents from the prior year folded into `ownerRmdCents` (two RMDs in one year). */
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
  readonly dueInYear: number;
}

/** RMD trigger age by birth year (SECURE 2.0 §107): 75 for 1960+, else 73 (earlier births are past trigger at any supported year). */
export function rmdTriggerAge(birthYear: number): 73 | 75 {
  return birthYear >= 1960 ? 75 : 73;
}

/**
 * Historical applicable age for a deceased owner, used only for the surviving-spouse delayed-start year (the year the
 * deceased would have reached their RBD): born 1949 or earlier 70 (the 70½ era, by its integer floor), 1950 72 (SECURE Act
 * 2019), 1951–1959 73 and 1960+ 75 (SECURE 2.0 §107). Year granularity: the sub-year July-1949 cutover is not split.
 */
export function deceasedOwnerApplicableRmdAge(birthYear: number): 70 | 72 | 73 | 75 {
  if (birthYear >= 1960) return 75;
  if (birthYear >= 1951) return 73;
  if (birthYear >= 1950) return 72;
  return 70;
}

/**
 * True when the account type and tax treatment qualify for RMD (IRC §401(a)(9), SECURE 2.0 §325): `RETIREMENT_IRA` only when
 * PRE_TAX (Roth IRAs are a separate type); 401K / 403B / 457B / TSP / CASH_BALANCE when PRE_TAX or MIXED (Roth 401(k)/403(b)
 * POST_TAX is exempt from 2024); Roth IRAs and every other type never.
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
 * IRS aggregation pool key for one RMD account (Pub 590-B; §403(b); §401(a)(9)): an owner's traditional IRAs share one pool,
 * their §403(b) plans another, and every other account is its own pool. Inherited accounts never aggregate (Pub 590-B forbids
 * pooling with the beneficiary's own IRAs or another decedent's, and the app records no decedent identity), so each is a
 * singleton. Keys are namespaced (`pool:` / `acct:`) and prefixed by `ownerId`; an empty `ownerId` falls back to a singleton
 * keyed by the account id so the account is never dropped.
 */
export function poolKeyForRmdAccount(
  ownerId: string,
  accountType: RmdAccountType,
  accountId: string,
  inherited = false,
): string {
  const owner = ownerId === '' ? accountId : ownerId;
  if (inherited) return `${owner}::inherited-acct:${accountId}`;
  if (accountType === 'RETIREMENT_IRA') return `${owner}::pool:IRA`;
  if (accountType === 'RETIREMENT_403B') return `${owner}::pool:403B`;
  return `${owner}::acct:${accountId}`;
}

/** Sums the positive-part shortfall across aggregation pools, `max(0, required − withdrawn)` each, with no cross-pool offset. */
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

// Birth year per ISO birthdate, cached only after full validation (invalid dates throw identically every time); FIFO-bounded to 128 entries.
const BIRTH_YEAR_MEMO = new Map<string, number>();
const BIRTH_YEAR_MEMO_MAX_ENTRIES = 128;

/**
 * Age attained by Dec 31 of the tax year (calendar-year subtraction, Dec-31 age per IRC §401(a)(9), no SSA shift).
 *
 * @throws {RmdInvalidInputError} when `isoBirthdate` is not a valid YYYY-MM-DD calendar date (e.g. Feb 30, non-leap Feb 29).
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
  if (birthMonth < 1 || birthMonth > 12 || birthDay < 1 || birthDay > 31) {
    throw new RmdInvalidInputError(
      `isoBirthdate "${isoBirthdate}" contains an out-of-range month or day`,
    );
  }
  // The round-trip catches impossible dates like Feb 30 and non-leap Feb 29.
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
    const oldestKey = BIRTH_YEAR_MEMO.keys().next().value;
    if (oldestKey !== undefined) BIRTH_YEAR_MEMO.delete(oldestKey);
  }
  BIRTH_YEAR_MEMO.set(isoBirthdate, birthYear);
  return taxYear - birthYear;
}

// Clamp-to-latest, unlike federal-tax.ts's strict lookup: the Uniform Lifetime Table is statutory and changes rarely
// (last revision TD 9930, effective 2022-01-01). Throws UnsupportedTaxYearError below every key.
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

function collectQualifyingBalances(
  accounts: readonly RmdAccountInput[],
): Array<{ id: string; balanceCents: number }> {
  const qualifying: Array<{ id: string; balanceCents: number }> = [];
  for (const acct of accounts) {
    if (!isQualifyingAccount(acct.accountType, acct.taxTreatment)) continue;
    // The same `rothDesignatedSliceCents` rule as the fact-based resolvers, so the legacy and fact-based paths agree on one account's base (only PRE_TAX and MIXED reach here).
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

function lookupUniformLifetimeDivisor(table: RmdTable, clampedAge: number): number {
  const divisor = table.uniformLifetime[clampedAge];
  if (divisor === undefined || !Number.isFinite(divisor) || divisor <= 0) {
    throw new RmdInvalidInputError(
      `uniformLifetime table missing or invalid entry for age ${clampedAge}`,
    );
  }
  return divisor;
}

function applicableFalseResult(): RmdResult {
  return {
    applicable: false,
    ownerRmdCents: 0,
    perAccountRmdCents: {},
    divisor: null,
    qualifyingBalanceCents: 0,
  };
}

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

/**
 * Computes the RMD for one owner in one tax year: validates input, resolves the snapshot, parses the age, applies the
 * trigger-age gate, then looks up the divisor and allocates. `snapshot` is a parameter, never read directly, for MC-path
 * determinism.
 *
 * @throws {UnsupportedTaxYearError} when `taxYear` is below the snapshot's minimum key.
 * @throws {RmdInvalidInputError} on malformed input or a missing or invalid divisor entry.
 */
export function computeRmd(
  input: RmdInput,
  snapshot: CalibrationSnapshot<RmdTable>,
): RmdResult {
  // Validate first, so a non-integer taxYear throws RmdInvalidInputError before resolveSnapshot can raise a misleading
  // UnsupportedTaxYearError or clamp to the wrong year, and before the trigger-age gate so bad account inputs always throw.
  validateRmdInput(input);

  const table = resolveSnapshot(snapshot, input.taxYear);

  const age = ageInTaxYear(input.isoBirthdate, input.taxYear);
  const birthYear = input.taxYear - age; // back-derived after validation
  const triggerAge = rmdTriggerAge(birthYear);

  // Any account with stored facts switches the call to the fact-based path; a call without facts runs the legacy branch below with byte-identical output.
  if (input.accounts.some((acct) => acct.facts !== undefined)) {
    return computeFactBasedRmd(input, snapshot, age, triggerAge);
  }

  if (age < triggerAge) return applicableFalseResult();

  const clampedAge = clampAge(age, 73);
  const divisor = lookupUniformLifetimeDivisor(table, clampedAge);
  const qualifying = collectQualifyingBalances(input.accounts);
  return applicableTrueResult(qualifying, divisor);
}

// The SECURE 2.0 §325 Roth-designated slice of a balance field, netted out of the RMD base, as the one rule for every base
// resolver: no Roth pocket (`PRE_TAX` / `HSA`) nets nothing; `MIXED` nets the explicit portion, defaulting to 0 (the
// conservative over-estimate); pure Roth (`POST_TAX` / `ROTH`) nets the explicit portion, defaulting to the whole balance,
// since it holds no pre-tax dollars (otherwise an inherited Roth IRA would be grossed up as ordinary income on the funded
// Monte Carlo path).
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
 * The §325 Roth-designated portion a producer should declare on the base it passes, so every `RmdAccountInput` assembler
 * declares it identically. No Roth pocket (`PRE_TAX` / `HSA`) gives `undefined` (declaring one throws); `MIXED` gives the
 * measured pocket clamped into `[0, baseCents]`; pure Roth gives the whole base, not the measured pocket, since it holds
 * no pre-tax dollars and a mis-derived sub-bucket would put untaxed Roth dollars back into a pre-tax base.
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

function rmdBaseBalanceCents(acct: RmdAccountInput): number {
  const roth = rothDesignatedSliceCents(
    acct.taxTreatment,
    acct.balanceDec31PriorYearCents,
    acct.rothPortionCents,
  );
  return Math.max(0, acct.balanceDec31PriorYearCents - roth);
}

/**
 * The §325-correct Dec-31 base two years before the tax year, the one resolver both engines use to size a first-year-deferral
 * catch-up (same `rothDesignatedSliceCents` rule as `rmdBaseBalanceCents`). `undefined` when the balance is absent or
 * unusable, so the caller reports a blocker rather than guessing.
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

interface FactRmdAccumulator {
  readonly byDivisor: Map<number, { id: string; balanceCents: number }[]>;
  readonly withheldAccounts: RmdWithheldAccount[];
  readonly stillWorkingDeferredAccountIds: string[];
  readonly firstYearDeferrals: RmdFirstYearDeferralDetail[];
  readonly catchUpByAccountId: Map<string, number>;
  applicable: boolean;
}

// The caller's Table III `snapshot` is used as `uniformLifetime` (a pinned custom Table III stays); Tables I and II fall back to the frozen module bundle only when the caller pinned nothing.
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

// Owner-path first-year April-1 deferral for one account: `'deferred'` moves the trigger-year amount into next year (the
// caller must not add it), `'withheld'` when the first year or catch-up base cannot be resolved, else `'due'`. A catch-up year
// records the deferred amount against the same account so the per-account map still sums to the owner total.
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
  // Catch-up year: the deferred trigger-year RMD is due alongside this year's own, sized from the trigger year's base (Dec 31
  // two years before, §325-net via `rmdTwoYearsPriorBaseCents`) at the trigger year's divisor.
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
  // Owner-path accounts keep the trigger-age gate per account; an inherited account is a beneficiary obligation and is never gated by the beneficiary's own trigger age.
  if (!inherited && age < triggerAge) return;
  const resolution = resolveRmdRule({
    facts,
    accountType: acct.accountType,
    taxTreatment: acct.taxTreatment,
    ages: { ownerAge: age },
    taxYear: input.taxYear,
    tables,
    ownerBirthdate: input.isoBirthdate,
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
  // The 5-year rule and a delayed surviving-spouse start set a deadline, not an annual minimum: $0 this year.
  if (
    resolution.kind === 'inheritedFiveYearRule' ||
    resolution.kind === 'inheritedSpousalDelayed'
  ) {
    return;
  }
  const selection = resolution.selection;
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
      // An account whose still-working preconditions are met had distributions deferred while employed, so its first RMD year is
      // the later of the trigger-age year and the separation year; reaching here means the exception no longer defers it.
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
 * Computes one owner's RMD from per-account facts. Each account resolves independently through `resolveRmdRule` (the selector
 * the oracle tests compare against), so a still-working-deferred 401(k), a Table II IRA and an inherited account can coexist.
 * Accounts on the same divisor are pooled with the legacy sum-then-divide-then-allocate arithmetic, so an
 * all-Uniform-Lifetime household reproduces the legacy cents. A `withheld` resolution contributes $0 and is reported in
 * `withheldAccounts` (never a guessed divisor); an elected first-year deferral moves the trigger-year amount into the next year.
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
    // A single shared divisor is reported for display parity with the legacy path; a mixed-rule year reports null.
    divisor: divisors.length === 1 ? divisors[0] : null,
    qualifyingBalanceCents,
    withheldAccounts: acc.withheldAccounts,
    stillWorkingDeferredAccountIds: acc.stillWorkingDeferredAccountIds,
    firstYearDeferrals: acc.firstYearDeferrals,
    deferredCatchUpCents,
  };
}

// Mirrors the DB `RmdBeneficiaryType` (db/rmd-fact-validation.ts), kept DB-free like the account unions above.
type RmdBeneficiaryType =
  | 'SPOUSE'
  | 'MINOR_CHILD_OF_OWNER'
  | 'DISABLED_OR_CHRONICALLY_ILL'
  | 'NOT_MORE_THAN_10_YEARS_YOUNGER'
  | 'OTHER_DESIGNATED'
  | 'NON_PERSON';

type RmdBeneficiaryElection = 'LIFE_EXPECTANCY' | 'TEN_YEAR';

/** Per-account RMD profile facts mirroring the `rmd*` fields on `AccountPayload`; every field is optional and an absent one takes its one-sided conservative default. */
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
  /** The original owner's ISO birthdate, needed for the decedent's-remaining-life "longer-of" comparison when the owner died on/after their RBD and for the surviving-spouse delayed-start year; withheld when a result depends on it. */
  readonly originalOwnerBirthdate?: string;
  /** Eligible-designated-beneficiary post-death election; absent on an EDB inherited account withholds the RMD (never invented). */
  readonly beneficiaryElection?: RmdBeneficiaryElection;
}

/** Attained ages (by Dec 31 of the RMD year) the rule resolver needs; the beneficiary's age is derived from the stored `beneficiaryBirthdate`, never a separate input that could contradict it. */
export interface RmdRuleAges {
  readonly ownerAge?: number;
}

/** Resolved RMD rule for one account in one tax year. */
export type RmdRuleResolution =
  /** Non-inherited account owing no living-owner RMD (Roth IRA, designated-Roth plans, HSA, non-retirement accounts); only inherited versions are subject to RMD rules, handled earlier. */
  | { readonly kind: 'notRequired' }
  /** Employer-plan still-working exception applies — no RMD from this plan this year. */
  | { readonly kind: 'stillWorkingDeferred' }
  /** Living owner, Uniform Lifetime Table III. */
  | { readonly kind: 'ownerUniformLifetime'; readonly selection: RmdTableSelection }
  /** Living owner whose sole spouse beneficiary is >10 yrs younger — Joint Life Table II. */
  | { readonly kind: 'ownerJointLife'; readonly selection: RmdTableSelection }
  /** Inherited account, eligible-designated-beneficiary life-expectancy stretch — Single Life Table I. */
  | { readonly kind: 'inheritedLifeExpectancy'; readonly selection: RmdTableSelection }
  /** Inherited account under the 10-year rule: annual distributions are required only in window years 1–9 when the owner died on/after their RBD; `fullLiquidationByYear` is the year by whose end the account must be emptied (10th year after the window start). */
  | {
      readonly kind: 'inheritedTenYearRule';
      readonly annualDistributionRequired: boolean;
      readonly selection: RmdTableSelection | null;
      readonly fullLiquidationByYear: number;
    }
  /** Inherited account subject to the 5-year rule (non-person beneficiary, owner died before RBD). */
  | { readonly kind: 'inheritedFiveYearRule' }
  /** Surviving-spouse beneficiary (owner died before RBD) may delay until the year the owner would have reached their RBD (`firstDistributionYear`); nothing is required before it. */
  | { readonly kind: 'inheritedSpousalDelayed'; readonly firstDistributionYear: number }
  /** Required facts are incomplete — the result is withheld and the missing facts listed. */
  | { readonly kind: 'withheld'; readonly missingFacts: readonly string[] };

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
 * True when the §401(a)(9)(C) still-working preconditions are met (fact test only, no year): an employer-plan type, the
 * owner's current employer's plan, owner not a >5% owner, and plan terms that do not force distribution at the statutory age.
 * Each must be affirmatively met, never inferred from a missing fact: an absent `currentEmployerPlan` or `fivePercentOwner`
 * (unknown ownership counts as a 5% owner) denies it, and `planRequiresDistributionAtStatutoryAge` must be explicitly
 * `false`, since a `!== true` check would grant the favorable deferral on missing plan terms. `stillWorkingExceptionApplies`
 * adds the year test; `resolveRmdFirstYearPlan` needs this one.
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
 * True when the still-working exception defers this tax year's RMD: the preconditions above and the tax year strictly before
 * the owner's separation year. §401(a)(9)(C)(i)(II) sets the required beginning date at April 1 after the year the employee
 * retires, so the separation year is already a distribution year (the first RMD year, deferrable by the ordinary election).
 * `separationYear` is the owner's modeled retirement year (retirement is recorded per member, not per plan); unknown
 * denies the deferral, keeping the ordinary owner minimum.
 */
export function stillWorkingExceptionApplies(
  facts: RmdAccountProfileFacts,
  accountType: RmdAccountType,
  employment: {
    readonly taxYear: number;
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
  readonly isFirstRmdYear: boolean;
  readonly deferred: boolean;
  /** RMDs due the following year: 2 when deferred (the deferred first-year RMD plus that year's own), else 0. */
  readonly rmdsDueFollowingYear: 0 | 2;
}

// Deferral is granted only when this is the first RMD year and the owner affirmatively elected it; keeps the `deferred ? 2 : 0` rule in one place.
function buildFirstYearPlan(isFirstRmdYear: boolean, elected: boolean): RmdFirstYearDeferralPlan {
  const deferred = isFirstRmdYear && elected;
  return { isFirstRmdYear, deferred, rmdsDueFollowingYear: deferred ? 2 : 0 };
}

/**
 * First-year April-1 deferral in the baseline (not still-working) case: the first RMD year is the trigger-age year, and the
 * first RMD may be deferred to April 1 of the next year, giving two RMDs there. No election means no deferral. A
 * still-working employee whose first distribution year is their retirement year needs `resolveRmdFirstYearPlan`. Pure.
 */
export function rmdFirstYearDeferralPlan(
  ownerAge: number,
  triggerAge: 73 | 75,
  facts: RmdAccountProfileFacts,
): RmdFirstYearDeferralPlan {
  const isFirstRmdYear = ownerAge === triggerAge;
  return buildFirstYearPlan(isFirstRmdYear, facts.firstYearDeferralElected === true);
}

/** Resolution of the first required-distribution year, which withholds when a still-working employee's retirement year is unknown. */
export type RmdFirstYearResolution =
  | {
      readonly kind: 'plan';
      readonly firstRmdYear: number;
      readonly plan: RmdFirstYearDeferralPlan;
    }
  | { readonly kind: 'withheld'; readonly missingFacts: readonly string[] };

/**
 * First required-distribution year under the §401(a)(9)(C) "later of statutory age or retirement" rule: the later of the
 * trigger-age year and, when the still-working exception applied, the retirement year; withheld when it applied but the
 * retirement year is unknown, and the trigger-age year otherwise. `retirementYear` is a projection-time input. Pure.
 */
export function resolveRmdFirstYearPlan(args: {
  ownerAge: number;
  triggerAge: 73 | 75;
  taxYear: number;
  facts: RmdAccountProfileFacts;
  /** True when the still-working exception deferred distributions in prior years. */
  stillWorkingExceptionApplied: boolean;
  /** Year the owner separated from service; required when the exception applied. */
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

function isEligibleDesignatedBeneficiary(category: RmdBeneficiaryType): boolean {
  return (
    category === 'SPOUSE' ||
    category === 'MINOR_CHILD_OF_OWNER' ||
    category === 'DISABLED_OR_CHRONICALLY_ILL' ||
    category === 'NOT_MORE_THAN_10_YEARS_YOUNGER'
  );
}

// Year of a stored ISO date; the shared `[1900, 2200]` validator rejects malformed, calendar-impossible (Feb 30) and implausible years, so a bogus year is never extracted from an unsanitised payload.
function isoYearOf(value: string | undefined): number | undefined {
  if (!isValidRmdIsoDate(value)) return undefined;
  return Number(value.slice(0, 4));
}

// Table I request for an inherited stretch: a surviving spouse recalculates by current age each year; a non-spouse fixes the divisor in the year after the owner's death (`baseAge`) and decrements 1.0 per elapsed year.
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

// The longer remaining life expectancy (the larger usable divisor); one usable divisor wins, and when both are withheld the beneficiary's propagates.
function longerOfSelection(
  beneficiary: RmdTableSelection,
  decedent: RmdTableSelection,
): RmdTableSelection {
  if (beneficiary.kind === 'divisor' && decedent.kind === 'divisor') {
    return decedent.divisor > beneficiary.divisor ? decedent : beneficiary;
  }
  return beneficiary.kind === 'divisor' ? beneficiary : decedent;
}

// Annual single-life divisor for a designated beneficiary. When the owner died on/after their RBD, the longer of the
// beneficiary's own and the decedent's ("ghost life") remaining expectancy applies, the latter a Table I lookup at the
// decedent's death-year age decremented 1.0 per year and needing `originalOwnerBirthdate` (absent withholds); before the RBD
// only the beneficiary's own schedule applies.
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
  // A beneficiary's schedule begins the year after the owner's death; the death year is the owner's final lifetime RMD and must not produce a beneficiary or ghost-life divisor.
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

// 10-year rule: the account must be emptied by the end of the 10th year after the window start (`windowStartYear`: the death
// year, or a minor child's 21st-birthday year). Annual life-expectancy RMDs apply only in window offset years 1–9 and only
// when the owner died on/after their RBD.
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

// MINOR_CHILD_OF_OWNER takes the life-expectancy stretch until the age of majority (21, IRS final regulations), then the
// 10-year rule with its own deadline; a beneficiary already 21 or older at the owner's death is not a minor child, an invalid category that withholds.
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
  // Anniversary-safe majority test: compare the full death date to the 21st birthday (ISO strings compare chronologically); a
  // child who reached 21 on or before the death date is not a minor child and withholds.
  const twentyFirstBirthday = `${birthYear + 21}${birthdate.slice(4)}`;
  const deathDate = facts.inheritedOwnerDeathDate;
  if (isValidRmdIsoDate(deathDate) && deathDate >= twentyFirstBirthday) {
    return { kind: 'withheld', missingFacts: ['minorChildBeneficiaryNotMinorAtDeath'] };
  }
  const majorityYear = birthYear + 21;
  if (taxYear < majorityYear) {
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

// Surviving-spouse stretch. Owner died before RBD: the spouse may delay until the year the owner would have reached their RBD
// (needs the original owner's birthdate, else withheld), then recalculates by current age each year. Owner died on/after
// RBD: distributions have begun and the annual divisor is the longer-of comparison.
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
    // The year the deceased owner would have reached their RBD uses the historical applicable age for their birth year, not `rmdTriggerAge` (living owners only).
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

// Resolves the inherited rule from beneficiary facts, withholding on a missing fact or an unsupported death regime.
// `ownerAlwaysDiedBeforeRbd` (a Roth owner has no lifetime RBD) forces the pre-RBD regime and ignores a stored on/after-RBD flag.
function resolveInheritedRmdRule(args: {
  facts: RmdAccountProfileFacts;
  taxYear: number;
  tables: RmdLifeExpectancyTables;
  ownerAlwaysDiedBeforeRbd: boolean;
}): RmdRuleResolution {
  const { facts, taxYear, tables, ownerAlwaysDiedBeforeRbd } = args;
  // Baseline blockers come from `validateRmdProfileFacts`, shared with the account editor's readiness surface.
  const baseline = validateRmdProfileFacts(facts, ownerAlwaysDiedBeforeRbd);
  if (!baseline.ok) {
    return { kind: 'withheld', missingFacts: baseline.blockers.map((b) => b.field) };
  }

  // Validate the persisted category and election against the shared DB validators: the migration sanitiser runs only on
  // below-current payloads, so a current-version import arrives unsanitised, and an out-of-vocabulary value withholds rather than being coerced.
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

  // Derive the beneficiary's age from the stored birthdate, never a separately supplied age that a current-version payload
  // could set inconsistently; an absent or malformed birthdate withholds the Table I paths.
  const beneficiaryBirthYear = isoYearOf(facts.beneficiaryBirthdate);
  const beneficiaryAge =
    beneficiaryBirthYear === undefined ? undefined : taxYear - beneficiaryBirthYear;

  // A Roth owner has no lifetime RBD, so an inherited Roth is always a death before RBD, overriding any stored flag.
  const diedOnOrAfterRbd = ownerAlwaysDiedBeforeRbd
    ? false
    : facts.inheritedOwnerDiedOnOrAfterRbd === true;

  // The original owner's death date selects the rule regime: a pre-2020 death falls under the pre-SECURE-Act stretch rules
  // this engine does not model, so it withholds rather than applying post-2019 rules.
  const deathYear = isoYearOf(facts.inheritedOwnerDeathDate);
  if (deathYear === undefined) {
    return { kind: 'withheld', missingFacts: ['inheritedOwnerDeathDate'] };
  }
  if (deathYear < 2020) {
    return { kind: 'withheld', missingFacts: ['preSecureActDeathRulesUnsupported'] };
  }

  // An inherited account cannot exist before the owner's death. The death year is still the owner's final lifetime RMD,
  // enforced in `annualSingleLifeSelection`, whose schedule begins the year after death.
  if (taxYear < deathYear) {
    return { kind: 'withheld', missingFacts: ['taxYearBeforeOwnerDeath'] };
  }

  // Non-person (estate, charity, non-qualifying trust): 5-year rule when the owner died before RBD. On/after RBD the
  // decedent's ghost-life schedule would apply, which the engine does not compute, so it withholds.
  if (category === 'NON_PERSON') {
    if (!diedOnOrAfterRbd) return { kind: 'inheritedFiveYearRule' };
    return { kind: 'withheld', missingFacts: ['nonPersonGhostLifeScheduleUnsupported'] };
  }

  // An eligible designated beneficiary must have affirmatively elected the life-expectancy stretch or the 10-year rule; the engine never invents the election.
  if (isEligibleDesignatedBeneficiary(category)) {
    if (facts.beneficiaryElection === undefined) {
      return { kind: 'withheld', missingFacts: ['beneficiaryElection'] };
    }
    if (facts.beneficiaryElection === 'TEN_YEAR') {
      // The 10-year election exists only when the owner died before RBD; on/after RBD life-expectancy treatment is mandatory,
      // so a stored TEN_YEAR election is an incompatible combination that withholds.
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
    if (category === 'MINOR_CHILD_OF_OWNER') {
      return resolveMinorChildRule({ facts, beneficiaryAge, deathYear, taxYear, diedOnOrAfterRbd, tables });
    }
    if (category === 'SPOUSE') {
      return resolveSpouseStretch({ facts, beneficiaryAge, deathYear, taxYear, diedOnOrAfterRbd, tables });
    }
    // Other non-spouse eligible designated beneficiary: anchored single-life stretch, with the longer-of ghost comparison when the owner died on/after RBD.
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

/** Account types subject to beneficiary RMD rules when inherited: unlike `isQualifyingAccount` this includes Roth IRAs and designated-Roth employer accounts, and excludes HSAs and non-retirement accounts. */
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

// Roth owners have no lifetime RBD, so an inherited Roth account is always a death-before-RBD case.
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
 * True when the sole spouse beneficiary is more than ten years younger than the owner: the spouse's birthdate is strictly
 * later than the owner's shifted +10 years (ISO strings compare chronologically; year subtraction would miss the
 * exact-10-year boundary). `undefined` when either birthdate is missing or malformed, so the caller withholds rather than
 * trusting a stored boolean.
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
 * Selects the RMD rule and life-expectancy table for one account-year from explicit facts. Owner path: not-required types,
 * then the still-working exception, then Joint Life (Table II) for a sole spouse verified more than 10 years younger by
 * birthdate, else Uniform Lifetime (Table III). Inherited path: withholds on incomplete facts or an unsupported death
 * regime, else the SECURE Act post-death rule (life-expectancy stretch / 10-year / 5-year). Assumes the caller gated the
 * owner at or over their trigger age. Pure.
 */
export function resolveRmdRule(args: {
  facts: RmdAccountProfileFacts;
  accountType: RmdAccountType;
  taxTreatment: AccountTaxTreatment;
  ages: RmdRuleAges;
  taxYear: number;
  tables: RmdLifeExpectancyTables;
  /** Owner's ISO birthdate, for the birthdate-derived sole-spouse >10-years-younger test. */
  ownerBirthdate?: string;
  /** Owner's separation-from-service year; the still-working exception defers only earlier years, and absent denies it (conservative). */
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

  // Inherited retirement accounts (including Roth) are subject to beneficiary RMD rules and are evaluated before the
  // living-owner check; an inherited HSA or non-retirement account is not, so it is `notRequired`.
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

  // A living owner owes no RMD from a non-qualifying type or treatment (Roth IRA, designated-Roth plans, HSA, non-retirement accounts).
  if (!isQualifyingAccount(accountType, taxTreatment)) {
    return { kind: 'notRequired' };
  }

  // The exception defers only years strictly before separation; a separated or unknown-separation owner falls through to the ordinary tables.
  if (stillWorkingExceptionApplies(facts, accountType, { taxYear, separationYear: retirementYear })) {
    return { kind: 'stillWorkingDeferred' };
  }

  // A missing owner age withholds, never defaults to 0: that would clamp to the age-73 divisor, the most favorable one, and understate the RMD.
  const ownerAge = ages.ownerAge;
  if (ownerAge === undefined) {
    return { kind: 'withheld', missingFacts: ['ownerAge'] };
  }

  // A sole-spouse >10-years-younger claim selects Table II only when verified from the birthdates; a stored boolean is not
  // trusted alone, missing or malformed birthdates withhold, and a verified "not more than 10 younger" falls back to Table III.
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
      // Table II eligibility is established; derive the spouse's age from that same birthdate and withhold if it cannot be derived, never downgrading to Table III.
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
  }

  return {
    kind: 'ownerUniformLifetime',
    selection: selectRmdTableDivisor({ table: 'uniformLifetime', ownerAge }, tables, taxYear),
  };
}
