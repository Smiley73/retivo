/** Monte Carlo RMD post-pass: fills `rmdFloorCents` / `rmdShortfallCents` on representative-run drawdown rows through the shared `computeRmd` engine, so the floor matches the deterministic one.
 * Shortfall is measured against IRS aggregation-pool minimums (per-owner IRAs pool, per-owner 403(b)s pool, employer plans stand alone). */
import type { CalibrationSnapshot } from './calibration.js';
import {
  computeRmd,
  rmdDeclaredRothPortionCents,
  isQualifyingAccount,
  isInheritedRmdSubjectType,
  poolKeyForRmdAccount,
  sumPoolShortfallCents,
  type AccountTaxTreatment,
  type RmdAccountInput,
  type RmdAccountProfileFacts,
  type RmdAccountType,
  type RmdTable,
} from './rmd.js';
import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types.js';
import { rmdEligibleWithdrawnCents } from './drawdown-engine-types.js';
import type { MonteCarloAccountLedger } from './monte-carlo-types.js';
import type { TaxMemberInput } from './tax-integration-helpers.js';
import { dollarsToCents } from './tax-integration-helpers.js';

interface OwnerRmdMeta {
  readonly isoBirthdate: string;
  readonly deathYear: number | undefined;
}

interface RmdAccountMeta {
  readonly id: string;
  readonly ownerId: string;
  readonly accountType: RmdAccountType;
  readonly taxTreatment: AccountTaxTreatment;
  readonly initialPre: number;
  readonly initialPost: number;
  readonly qualifies: boolean;
  readonly facts?: RmdAccountProfileFacts;
}

export interface McRmdPostPassArgs {
  readonly years: ReadonlyArray<DrawdownYear>;
  readonly ledger: ReadonlyArray<MonteCarloAccountLedger>;
  readonly members: ReadonlyArray<TaxMemberInput>;
  readonly rmdSnapshot: CalibrationSnapshot<RmdTable>;
  readonly primaryDeathYear?: number;
  readonly secondaryDeathYear?: number;
  /** Absent keeps the Uniform-Lifetime path, so a fact-free household's floor is byte-identical. */
  readonly rmdFactsByAccountId?: Readonly<Record<string, RmdAccountProfileFacts>>;
  /** Per-owner separation year for the §401(a)(9)(C) later-of rule. */
  readonly retirementYearByOwner?: Readonly<Record<string, number>>;
  /**
   * Calendar year the representative path depleted, or null. The absorbing-depletion clamp zeroes `preEnd` from that year on;
   * skip only `year.year > depletionYear`, since the depletion year's floor reads its un-clamped prior-year balances.
   */
  readonly depletionYear?: number | null;
}

function buildOwnerMeta(args: McRmdPostPassArgs): Map<string, OwnerRmdMeta> {
  const byOwner = new Map<string, OwnerRmdMeta>();
  args.members.forEach((m, idx) => {
    byOwner.set(m.memberId, {
      isoBirthdate: m.isoBirthdate,
      deathYear: idx === 0 ? args.primaryDeathYear : args.secondaryDeathYear,
    });
  });
  return byOwner;
}

function buildAccountMeta(
  ledger: ReadonlyArray<MonteCarloAccountLedger>,
  rmdFactsByAccountId?: Readonly<Record<string, RmdAccountProfileFacts>>,
): RmdAccountMeta[] {
  return ledger.map((e) => {
    const accountType = (e.accountType ?? 'OTHER') as RmdAccountType;
    const taxTreatment = (e.taxTreatment ?? 'PRE_TAX') as AccountTaxTreatment;
    const facts = rmdFactsByAccountId?.[e.id];
    // An inherited account follows beneficiary RMD rules even when the living-owner test rejects its type (an inherited Roth IRA owes post-death distributions); `resolveRmdRule` owns the rule, this gate only admits.
    const qualifies =
      facts?.inheritedAccount === true
        ? isInheritedRmdSubjectType(accountType)
        : isQualifyingAccount(accountType, taxTreatment);
    return {
      id: e.id,
      ownerId: e.ownerId ?? e.id,
      accountType,
      taxTreatment,
      initialPre: e.initialPre,
      initialPost: e.initialPost,
      qualifies,
      ...(facts !== undefined ? { facts } : {}),
    };
  });
}

/**
 * One MC account's Dec-31 sub-bucket balances in integer cents. `preCents` is the pre-tax pocket; `postCents` the Roth-designated pocket
 * (a MIXED plan's designated-Roth sub-account, or a pure Roth account's whole balance). Producers pass real sub-buckets unconditionally:
 * disagreeing on that would gross a fully-Roth inherited balance up as ordinary income.
 */
export interface McRmdBalanceCents {
  readonly preCents: number;
  readonly postCents: number;
}

/**
 * Builds the shared `RmdAccountInput` for one MC account; the one place the representative floor and the funded per-path floor assemble an RMD base.
 * The full balance goes in plus any Roth-designated pocket as its Roth portion, which the engine nets out (SECURE 2.0 §325): PRE_TAX bases the whole
 * balance, MIXED the pre-tax slice, and pure Roth nets to zero (never grossed up as ordinary income).
 */
export function buildMcRmdAccountInput(args: {
  readonly id: string;
  readonly accountType: RmdAccountType;
  readonly taxTreatment: AccountTaxTreatment;
  readonly prior: McRmdBalanceCents;
  /** Dec-31 balances two years before the tax year; sizes a first-year-deferral catch-up, absent reports a blocker, not a guess. */
  readonly twoYearsPrior?: McRmdBalanceCents;
  readonly facts?: RmdAccountProfileFacts;
}): RmdAccountInput {
  // The declared Roth portion comes from the engine's `rmdDeclaredRothPortionCents` so this producer cannot drift from its resolver:
  // MIXED declares its post slice, pure Roth its whole balance, PRE_TAX / HSA nothing (the engine rejects a portion there).
  const priorCents = args.prior.preCents + args.prior.postCents;
  const rothPortionCents = rmdDeclaredRothPortionCents(
    args.taxTreatment,
    priorCents,
    args.prior.postCents,
  );
  const twoYearsPriorCents =
    args.twoYearsPrior === undefined
      ? undefined
      : args.twoYearsPrior.preCents + args.twoYearsPrior.postCents;
  const rothPortionTwoYearsPriorCents =
    twoYearsPriorCents === undefined
      ? undefined
      : rmdDeclaredRothPortionCents(
          args.taxTreatment,
          twoYearsPriorCents,
          args.twoYearsPrior!.postCents,
        );
  return {
    id: args.id,
    balanceDec31PriorYearCents: priorCents,
    accountType: args.accountType,
    taxTreatment: args.taxTreatment,
    ...(rothPortionCents !== undefined ? { rothPortionCents } : {}),
    ...(args.facts !== undefined ? { facts: args.facts } : {}),
    ...(twoYearsPriorCents !== undefined
      ? {
          balanceDec31TwoYearsPriorCents: twoYearsPriorCents,
          ...(rothPortionTwoYearsPriorCents !== undefined
            ? { rothPortionTwoYearsPriorCents }
            : {}),
        }
      : {}),
  };
}

/**
 * Funded per-path fact-based required-withdrawal total per owner in integer cents, indexed by `ownerIds` position. Runs the shared `computeRmd`
 * engine over accounts that carry facts (beneficiary schedules, Table I/II, deferral, catch-up); accounts without facts stay in the pooled
 * Uniform-Lifetime basis (`buildPreTaxCentsByOwnerIdx`), keeping a fact-free household byte-identical.
 */
export function buildMcFactRmdRequiredCentsByOwnerIdx(args: {
  readonly ledger: ReadonlyArray<MonteCarloAccountLedger>;
  readonly ownerIds: ReadonlyArray<string>;
  readonly members: ReadonlyArray<TaxMemberInput>;
  readonly rmdSnapshot: CalibrationSnapshot<RmdTable>;
  readonly taxYear: number;
  readonly priorBalancesCents: ReadonlyMap<string, McRmdBalanceCents>;
  readonly twoYearsPriorBalancesCents?: ReadonlyMap<string, McRmdBalanceCents>;
  readonly rmdFactsByAccountId: Readonly<Record<string, RmdAccountProfileFacts>>;
  readonly retirementYearByOwner?: Readonly<Record<string, number>>;
}): number[] {
  const idx = args.ownerIds.map(() => 0);
  const slotByOwner = new Map<string, number>();
  args.ownerIds.forEach((id, i) => slotByOwner.set(id, i));
  const birthdateByOwner = new Map<string, string>();
  for (const member of args.members) birthdateByOwner.set(member.memberId, member.isoBirthdate);
  const byOwner = new Map<string, RmdAccountInput[]>();
  for (const entry of args.ledger) {
    const facts = args.rmdFactsByAccountId[entry.id];
    if (facts === undefined) continue;
    const accountType = (entry.accountType ?? 'OTHER') as RmdAccountType;
    const taxTreatment = (entry.taxTreatment ?? 'PRE_TAX') as AccountTaxTreatment;
    const admitted =
      facts.inheritedAccount === true
        ? isInheritedRmdSubjectType(accountType)
        : isQualifyingAccount(accountType, taxTreatment);
    if (!admitted) continue;
    const ownerId = entry.ownerId ?? entry.id;
    if (slotByOwner.get(ownerId) === undefined) continue;
    if (birthdateByOwner.get(ownerId) === undefined) continue;
    const prior = args.priorBalancesCents.get(entry.id);
    if (prior === undefined) continue;
    const list = byOwner.get(ownerId) ?? [];
    list.push(
      buildMcRmdAccountInput({
        id: entry.id,
        accountType,
        taxTreatment,
        prior,
        facts,
        ...(args.twoYearsPriorBalancesCents?.get(entry.id) !== undefined
          ? { twoYearsPrior: args.twoYearsPriorBalancesCents.get(entry.id)! }
          : {}),
      }),
    );
    byOwner.set(ownerId, list);
  }
  for (const [ownerId, accounts] of byOwner) {
    const slot = slotByOwner.get(ownerId)!;
    const retirementYear = args.retirementYearByOwner?.[ownerId];
    const result = computeRmd(
      {
        isoBirthdate: birthdateByOwner.get(ownerId)!,
        taxYear: args.taxYear,
        accounts,
        ...(retirementYear !== undefined ? { retirementYear } : {}),
      },
      args.rmdSnapshot,
    );
    idx[slot] += result.ownerRmdCents;
  }
  return idx;
}

// Prior-year Dec 31 pre-tax balance: year 0 uses the ledger `initialPre`, a drawdown prior row its `preEnd`, and a pre-retirement prior row the
// current row's `priorPreEnd` (Dec 31 of the last accumulation year). `postEnd` is the Roth bucket and not subject to RMDs.
function priorPreEndDollars(
  years: ReadonlyArray<DrawdownYear>,
  yIdx: number,
  meta: RmdAccountMeta,
): number {
  if (yIdx === 0) return meta.initialPre;
  const priorRow = years[yIdx - 1];
  if (priorRow?.accountBalances !== undefined) {
    return priorRow.accountBalances.get(meta.id)?.preEnd ?? 0;
  }
  const currentAcct = years[yIdx]?.accountBalances?.get(meta.id);
  return currentAcct?.priorPreEnd ?? currentAcct?.preEnd ?? 0;
}

function priorPostEndDollars(
  years: ReadonlyArray<DrawdownYear>,
  yIdx: number,
  meta: RmdAccountMeta,
): number {
  if (yIdx === 0) return meta.initialPost;
  const priorRow = years[yIdx - 1];
  if (priorRow?.accountBalances !== undefined) {
    return priorRow.accountBalances.get(meta.id)?.postEnd ?? 0;
  }
  return years[yIdx]?.accountBalances?.get(meta.id)?.postEnd ?? 0;
}

// Both sub-buckets pass through unconditionally, like the funded path's producers: zeroing `postCents` for non-MIXED accounts would make the two MC surfaces disagree on a pure-Roth inherited base.
function priorBalanceCents(
  years: ReadonlyArray<DrawdownYear>,
  yIdx: number,
  meta: RmdAccountMeta,
): McRmdBalanceCents {
  return {
    preCents: dollarsToCents(priorPreEndDollars(years, yIdx, meta)),
    postCents: dollarsToCents(priorPostEndDollars(years, yIdx, meta)),
  };
}

function preTaxWithdrawnCents(row: DrawdownAccountYear, meta: RmdAccountMeta): number {
  return rmdEligibleWithdrawnCents(row, meta.taxTreatment);
}

// `iraPoolRmdFloorCents` is the IRA-aggregation-pool slice of the gross floor, the base for the display-only `netTaxableRmdCents` (a QCD offsets only the traditional-IRA RMD).
function rmdForYear(
  args: McRmdPostPassArgs,
  ownerMeta: Map<string, OwnerRmdMeta>,
  accountMeta: RmdAccountMeta[],
  yIdx: number,
): { rmdFloorCents: number; rmdShortfallCents: number; iraPoolRmdFloorCents: number } {
  const year = args.years[yIdx];
  const accountBalances = year.accountBalances;
  const byOwner = new Map<string, RmdAccountMeta[]>();
  for (const meta of accountMeta) {
    if (!meta.qualifies) continue;
    const owner = ownerMeta.get(meta.ownerId);
    // Skip after the owner's projected death year, and owners without member metadata (no age).
    if (!owner) continue;
    if (owner.deathYear !== undefined && year.year > owner.deathYear) continue;
    const list = byOwner.get(meta.ownerId) ?? [];
    list.push(meta);
    byOwner.set(meta.ownerId, list);
  }

  let rmdFloorCents = 0;
  // Required and withdrawn are summed per IRS aggregation pool and clamped at 0 per pool: IRA/403(b) siblings cross-cover, employer plans and other owners do not.
  const poolRequired = new Map<string, number>();
  const poolWithdrawn = new Map<string, number>();
  for (const [ownerId, metas] of byOwner) {
    const owner = ownerMeta.get(ownerId)!;
    const accounts: RmdAccountInput[] = metas.map((meta) =>
      buildMcRmdAccountInput({
        id: meta.id,
        accountType: meta.accountType,
        taxTreatment: meta.taxTreatment,
        prior: priorBalanceCents(args.years, yIdx, meta),
        ...(meta.facts !== undefined ? { facts: meta.facts } : {}),
        // The year two before sizes a first-year-deferral catch-up; absent in the first two rows, where the engine reports a blocker.
        ...(yIdx > 1
          ? { twoYearsPrior: priorBalanceCents(args.years, yIdx - 1, meta) }
          : {}),
      }),
    );
    const retirementYear = args.retirementYearByOwner?.[ownerId];
    const result = computeRmd(
      {
        isoBirthdate: owner.isoBirthdate,
        taxYear: year.year,
        accounts,
        ...(retirementYear !== undefined ? { retirementYear } : {}),
      },
      args.rmdSnapshot,
    );
    rmdFloorCents += result.ownerRmdCents;
    for (const meta of metas) {
      const requiredCents = result.perAccountRmdCents[meta.id] ?? 0;
      if (requiredCents <= 0) continue;
      // An inherited account never aggregates with the beneficiary's own accounts or another decedent's: singleton pool key.
      const poolKey = poolKeyForRmdAccount(
        meta.ownerId,
        meta.accountType,
        meta.id,
        meta.facts?.inheritedAccount === true,
      );
      const row = accountBalances?.get(meta.id);
      // MIXED counts only its pre-tax tranche (0 when the kernel gave no split) so Roth dollars cannot mask a pre-tax miss;
      // a pure Roth account counts its whole distribution (an inherited-Roth draw satisfies §401(a)(9)(B)).
      const withdrawnCents = row ? preTaxWithdrawnCents(row, meta) : 0;
      poolRequired.set(poolKey, (poolRequired.get(poolKey) ?? 0) + requiredCents);
      poolWithdrawn.set(
        poolKey,
        (poolWithdrawn.get(poolKey) ?? 0) + withdrawnCents,
      );
    }
  }
  // QCD offset (§408(d)(8)): the replay debits the gift from the IRA without recording a `preWithdrawnCents` draw, so a QCD-satisfied IRA pool would show a phantom shortfall.
  // Credit it to the source owner's `pool:IRA` withdrawn only (never an employer plan or another owner), matching the deterministic `max(0, required - withdrawn - offset)`.
  for (const [ownerId, offsetCents] of Object.entries(
    year.qcdRmdOffsetCentsByOwner ?? {},
  )) {
    const credit = Math.max(0, offsetCents);
    if (credit === 0) continue;
    const poolKey = `${ownerId}::pool:IRA`;
    if (!poolRequired.has(poolKey)) continue; // offset only ever lands on a required IRA pool
    poolWithdrawn.set(poolKey, (poolWithdrawn.get(poolKey) ?? 0) + credit);
  }
  const rmdShortfallCents = sumPoolShortfallCents(poolRequired, poolWithdrawn);
  let iraPoolRmdFloorCents = 0;
  for (const [poolKey, requiredCents] of poolRequired) {
    if (poolKey.endsWith('::pool:IRA')) iraPoolRmdFloorCents += requiredCents;
  }
  return { rmdFloorCents, rmdShortfallCents, iraPoolRmdFloorCents };
}

/** Populates `rmdFloorCents` / `rmdShortfallCents` in place on each drawdown-phase year of a representative run; pre-retirement rows are untouched. No-ops without member metadata or an RMD snapshot. */
export function applyMcRmdToRepresentativeYears(args: McRmdPostPassArgs): void {
  if (args.members.length === 0) return;
  const ownerMeta = buildOwnerMeta(args);
  const accountMeta = buildAccountMeta(args.ledger, args.rmdFactsByAccountId);
  if (!accountMeta.some((m) => m.qualifies)) return;
  const depletionYear = args.depletionYear ?? null;
  for (let yIdx = 0; yIdx < args.years.length; yIdx += 1) {
    const year = args.years[yIdx];
    if (!year.accountBalances) continue;
    if (depletionYear !== null && year.year > depletionYear) continue;
    const { rmdFloorCents, rmdShortfallCents, iraPoolRmdFloorCents } = rmdForYear(
      args,
      ownerMeta,
      accountMeta,
      yIdx,
    );
    year.rmdFloorCents = rmdFloorCents;
    year.rmdShortfallCents = rmdShortfallCents;
    // Display-only: re-derives `netTaxableRmdCents` from the IRA-pool-only gross floor, `iraPoolFloor - Σ owner offset` clamped at 0, matching the deterministic engine;
    // employer-plan RMDs are excluded and `rmdFloorCents` / `rmdShortfallCents` stay all-plan.
    if ((year.qcdCents ?? 0) > 0) {
      const offsetTotalCents = Object.values(year.qcdRmdOffsetCentsByOwner ?? {}).reduce(
        (sum, c) => sum + c,
        0,
      );
      year.netTaxableRmdCents = Math.max(0, iraPoolRmdFloorCents - offsetTotalCents);
    }
  }
}
