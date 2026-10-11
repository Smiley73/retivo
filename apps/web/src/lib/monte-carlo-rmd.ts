/**
 * Monte Carlo RMD post-pass helper.
 *
 * After the representative-run replay has populated each drawdown-phase
 * `DrawdownYear.accountBalances` map (per-account pre/post sub-bucket
 * balances + per-account withdrawals), this post-pass fills the same rows'
 * existing optional `rmdFloorCents` / `rmdShortfallCents` fields
 * (`drawdown-engine-types.ts`) — the SAME field contract the deterministic
 * `applyTaxIntegrationToDrawdownYears` populates, so the Balance Projection
 * RMD chart consumes an MC representative run with zero new view-model glue.
 *
 * Floor: for
 * simulated year Y the per-owner floor uses each qualifying tax-deferred
 * account's prior-year **`preEnd`** (the pre-tax sub-bucket of
 * `DrawdownAccountYear`; `postEnd` is the post-tax / Roth sub-bucket and is
 * NOT subject to IRS RMDs) from `years[Y-1].accountBalances`, divided by the
 * IRS Uniform Lifetime divisor for the owner's age in year Y, summed across
 * owners. The first simulated year (offset 0) uses the plan's initial
 * per-account `initialPre` balance. The math runs through the shared
 * `computeRmd` engine (the same seam the deterministic `computeRmdFloorCents`
 * uses) so the MC floor never diverges from the deterministic floor.
 *
 * Shortfall (mirrors `derivePerAccountRmdShortfallCents`): measured
 * against the IRS-aggregated POOL minimum. Each account's required minimum +
 * pre-tax withdrawal is grouped into its IRS pool (`poolKeyForRmdAccount` — all
 * of one owner's traditional IRAs pool together; all of one owner's 403(b)s pool
 * together; every employer plan is its own singleton), `required` and
 * `withdrawn` are summed per pool, then `shortfall = Σ_pools max(0, poolRequired
 * − poolWithdrawn)`. Within an aggregable pool one account's overshoot
 * legitimately covers a sibling's under-draw; across pools / owners /
 * non-aggregable plans a real miss still surfaces. Household netting (which
 * would hide a real cross-pool miss) is avoided because pooling happens within
 * IRS aggregation classes only. Strategy-path rows carry
 * `DrawdownAccountYear.preWithdrawnCents`; kernel-path rows expose only total
 * `withdrawn`, used as the pre-tax proxy for PRE_TAX accounts (accurate for
 * pure pre-tax; MIXED contributes only its `preWithdrawnCents` tranche, 0 when
 * the kernel did not surface the split — conservative).
 *
 * Lives in its own module (zero additions to the already-over-cap
 * `monte-carlo-tax.ts`).
 */
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

/** Bucket of owner birthdate + projected death year used to gate + age the
 *  per-owner RMD floor. An undefined `deathYear` means alive every year. */
interface OwnerRmdMeta {
  readonly isoBirthdate: string;
  readonly deathYear: number | undefined;
}

/** Per-account RMD metadata derived once from the ledger. `ownerId` keys the
 *  per-owner grouping; an account with no `ownerId` falls into its own bucket
 *  keyed by its account id (treated as its own owner). */
interface RmdAccountMeta {
  readonly id: string;
  readonly ownerId: string;
  readonly accountType: RmdAccountType;
  readonly taxTreatment: AccountTaxTreatment;
  readonly initialPre: number;
  /** Drawdown-entry Roth-designated (post) sub-bucket — the §325 portion a MIXED
   *  account's RMD base excludes in year 0. */
  readonly initialPost: number;
  readonly qualifies: boolean;
  /** This account's normalized RMD profile facts, threaded into the SHARED
   *  `computeRmd` engine so the MC representative floor selects the same table /
   *  exception / inherited rule as the deterministic engine. */
  readonly facts?: RmdAccountProfileFacts;
}

export interface McRmdPostPassArgs {
  /** Representative-run drawdown rows (mutated in place). Pre-retirement rows
   *  carry no `accountBalances` and are skipped. */
  readonly years: ReadonlyArray<DrawdownYear>;
  /** Per-account ledger — ownerId / accountType / taxTreatment / initialPre. */
  readonly ledger: ReadonlyArray<MonteCarloAccountLedger>;
  /** Household members (birthdate drives the SECURE 2.0 trigger age + divisor). */
  readonly members: ReadonlyArray<TaxMemberInput>;
  /** RMD divisor calibration snapshot (Uniform Lifetime). */
  readonly rmdSnapshot: CalibrationSnapshot<RmdTable>;
  /** Calendar year the primary is projected to die (RMD stops after). */
  readonly primaryDeathYear?: number;
  /** Calendar year the secondary is projected to die. */
  readonly secondaryDeathYear?: number;
  /** Per-account RMD profile facts (from `McRmdContext.rmdFactsByAccountId`).
   *  Absent → the shared engine keeps its legacy Uniform-Lifetime path, so a
   *  fact-free household's representative floor is byte-identical. */
  readonly rmdFactsByAccountId?: Readonly<Record<string, RmdAccountProfileFacts>>;
  /** Per-owner separation year for the §401(a)(9)(C) later-of rule. */
  readonly retirementYearByOwner?: Readonly<Record<string, number>>;
  /**
   * The calendar year the representative path depleted, or null when
   * it never ran out. This post-pass runs AFTER the absorbing-depletion
   * clamp, which zeroes both `DrawdownYear.balance` and the
   * per-account `accountBalances.preEnd` year-END sub-balances for the depletion
   * year and every later year. The floor for a given year reads the PRIOR year's
   * `preEnd`, so a strictly-post-depletion year would read the depletion year's
   * now-zeroed preEnd and the depletion year would read its (un-clamped) prior
   * year's preEnd — but the gate skips strictly-post-depletion rows regardless,
   * keeping the post-pass robust to clamp ordering. Skip only
   * `year.year > depletionYear` (the depletion year itself still carries a real
   * floor from its un-clamped PRIOR-year balances). Absent / null → no skip.
   */
  readonly depletionYear?: number | null;
}

/** Build the per-owner birthdate + death-year lookup. `members[0]` is the
 *  primary, `members[1]` the secondary (mirrors `McTaxContext.members`). */
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

/** Derive per-account RMD metadata from the ledger. An account whose ownerId
 *  is absent buckets under its own id. Qualification follows
 *  `isQualifyingAccount` (RMD applies to qualifying tax-deferred types only). */
function buildAccountMeta(
  ledger: ReadonlyArray<MonteCarloAccountLedger>,
  rmdFactsByAccountId?: Readonly<Record<string, RmdAccountProfileFacts>>,
): RmdAccountMeta[] {
  return ledger.map((e) => {
    const accountType = (e.accountType ?? 'OTHER') as RmdAccountType;
    const taxTreatment = (e.taxTreatment ?? 'PRE_TAX') as AccountTaxTreatment;
    const facts = rmdFactsByAccountId?.[e.id];
    // An INHERITED account is subject to BENEFICIARY RMD rules even when the
    // living-owner test rejects its type (an inherited Roth IRA owes post-death
    // distributions its living owner would not). `resolveRmdRule` inside the shared
    // engine owns the actual rule; this gate only decides admission.
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

/** One MC account's Dec-31 sub-bucket balances in integer cents.
 *
 *  `preCents` is the pre-tax pocket; `postCents` is the Roth-designated pocket —
 *  a MIXED employer plan's designated-Roth sub-account, or the WHOLE balance of a
 *  pure Roth account (SECURE 2.0 §325 — RMD-exempt either way). Every producer
 *  passes the account's real sub-buckets unconditionally; none of them zeroes
 *  `postCents` by treatment, because producers that disagreed on that would
 *  gross a fully-Roth inherited balance up as ordinary income. */
export interface McRmdBalanceCents {
  readonly preCents: number;
  readonly postCents: number;
}

/**
 * Build the shared `RmdAccountInput` for one MC account — the ONE place
 * both MC surfaces (the representative floor and the FUNDED per-path floor)
 * assemble an RMD base, so they cannot diverge from each other or from the
 * deterministic engine.
 *
 * Both bases follow the deterministic convention exactly: the FULL balance
 * (`pre + post`) goes in, and any account WITH a Roth-designated pocket also
 * supplies that pocket as its Roth portion, which the engine's shared
 * `rmdBaseBalanceCents` / `rmdTwoYearsPriorBaseCents` resolvers net out (§325).
 * That covers all three shapes with one rule:
 *  - PRE_TAX → `postCents` is 0, so the base is the whole pre-tax balance;
 *  - MIXED → the base is the pre-tax slice only;
 *  - pure Roth (POST_TAX / ROTH — an inherited Roth IRA or a pure
 *    designated-Roth employer plan, whose whole balance sits in `post`) → the
 *    base nets to zero, so its Roth dollars are never grossed up as ordinary
 *    income by the funded path's `max(withdrawal, floor)`.
 */
export function buildMcRmdAccountInput(args: {
  readonly id: string;
  readonly accountType: RmdAccountType;
  readonly taxTreatment: AccountTaxTreatment;
  readonly prior: McRmdBalanceCents;
  /** Dec-31 balances TWO years before the tax year, when known — sizes a
   *  first-year-deferral catch-up; absent → the engine reports the catch-up as a
   *  blocker rather than guessing. */
  readonly twoYearsPrior?: McRmdBalanceCents;
  readonly facts?: RmdAccountProfileFacts;
}): RmdAccountInput {
  // The §325 pocket to DECLARE comes from the engine's own shared
  // `rmdDeclaredRothPortionCents`, so this producer cannot drift from the resolver
  // that consumes what it emits: MIXED declares its measured `post` slice, a pure
  // Roth account declares its whole balance (it holds no pre-tax dollars), and
  // PRE_TAX / HSA declare nothing (the engine rejects a portion on those).
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
 * The FUNDED per-path fact-based required-withdrawal total per owner, in
 * integer cents, indexed by `ownerIds` position.
 *
 * This runs the SAME shared `computeRmd` engine the deterministic
 * engine and the representative floor run, per owner, over exactly the accounts
 * that carry facts — so the numbers that actually fund the simulation keep
 * every inherited beneficiary schedule, Table I/II selection, deferral and
 * catch-up, a withheld account contributes $0 (never a guessed owner
 * divisor), a still-working account contributes $0 only while employment
 * continues, and an inherited account contributes its real beneficiary minimum.
 *
 * Accounts WITHOUT facts are deliberately absent here: they stay in the pooled
 * per-owner Uniform-Lifetime basis (`buildPreTaxCentsByOwnerIdx`), keeping a
 * fact-free household's funded numbers byte-identical.
 */
export function buildMcFactRmdRequiredCentsByOwnerIdx(args: {
  readonly ledger: ReadonlyArray<MonteCarloAccountLedger>;
  readonly ownerIds: ReadonlyArray<string>;
  readonly members: ReadonlyArray<TaxMemberInput>;
  readonly rmdSnapshot: CalibrationSnapshot<RmdTable>;
  /** The tax year the required withdrawal applies to. */
  readonly taxYear: number;
  /** Per-account Dec-31 balances of the year BEFORE `taxYear` (the RMD base). */
  readonly priorBalancesCents: ReadonlyMap<string, McRmdBalanceCents>;
  /** Per-account Dec-31 balances TWO years before `taxYear`, when available. */
  readonly twoYearsPriorBalancesCents?: ReadonlyMap<string, McRmdBalanceCents>;
  readonly rmdFactsByAccountId: Readonly<Record<string, RmdAccountProfileFacts>>;
  readonly retirementYearByOwner?: Readonly<Record<string, number>>;
}): number[] {
  const idx = args.ownerIds.map(() => 0);
  const slotByOwner = new Map<string, number>();
  args.ownerIds.forEach((id, i) => slotByOwner.set(id, i));
  const birthdateByOwner = new Map<string, string>();
  for (const member of args.members) birthdateByOwner.set(member.memberId, member.isoBirthdate);
  // Group the fact-carrying, RMD-admissible accounts per owner.
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

/** Prior-year Dec 31 pre-tax sub-bucket balance for one account.
 *  - `yIdx === 0`: the ledger's `initialPre`.
 *  - `yIdx > 0` with a DRAWDOWN prior row (carries `accountBalances`): that
 *    row's per-account `preEnd`.
 *  - `yIdx > 0` with a PRE-RETIREMENT accumulation prior row (no
 *    `accountBalances`): the current row's `priorPreEnd` field — captured
 *    during representative-run build as `accPre[a][endStep-12]`, which equals
 *    Dec 31 of the last accumulation year (the correct RMD base for the first
 *    drawdown year). Falls back to the current row's `preEnd` for legacy
 *    captures that predate this field. */
function priorPreEndDollars(
  years: ReadonlyArray<DrawdownYear>,
  yIdx: number,
  meta: RmdAccountMeta,
): number {
  if (yIdx === 0) return meta.initialPre;
  const priorRow = years[yIdx - 1];
  if (priorRow?.accountBalances !== undefined) {
    // Normal case: prior row is a drawdown row with per-account balances.
    return priorRow.accountBalances.get(meta.id)?.preEnd ?? 0;
  }
  // Prior row is a pre-retirement accumulation row (no accountBalances map).
  // `priorPreEnd` = `accPre[a][endStep-12]` = Dec 31 of the last accumulation
  // year = the correct RMD base for this first drawdown year.
  const currentAcct = years[yIdx]?.accountBalances?.get(meta.id);
  return currentAcct?.priorPreEnd ?? currentAcct?.preEnd ?? 0;
}

/** Prior-year Dec 31 Roth-designated (post) sub-bucket balance for one account —
 *  the §325 portion the RMD base excludes (a MIXED plan's designated-Roth
 *  sub-account, or a pure Roth account's whole balance). Mirrors
 *  `priorPreEndDollars` row-for-row; 0 when no split is captured (then the whole
 *  balance is the base, the conservative over-estimate). */
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

/** The account's prior-year Dec-31 sub-buckets in integer cents, for the shared
 *  `buildMcRmdAccountInput` base assembly.
 *
 *  Both sub-buckets are passed through UNCONDITIONALLY, exactly like the funded
 *  path's producers in `monte-carlo.ts`. Zeroing `postCents` for non-MIXED
 *  accounts here would make the two MC surfaces disagree about the same
 *  account's base: a pure-Roth inherited balance would read $0 here (no base at
 *  all) and its FULL balance there (grossed up as ordinary income). The §325
 *  netting belongs to the shared engine resolver alone. */
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

/** Per-account withdrawn cents that COUNT TOWARD the requirement, for the
 *  shortfall derivation. Delegates to the shared
 *  `rmdEligibleWithdrawnCents` helper (drawdown-engine-types.ts) so this surface,
 *  `hasRmdShortfall` (withdrawal-guidance-data.ts) and the deterministic engine's
 *  `derivePerAccountRmdShortfallCents` apply one identical rule. */
function preTaxWithdrawnCents(row: DrawdownAccountYear, meta: RmdAccountMeta): number {
  return rmdEligibleWithdrawnCents(row, meta.taxTreatment);
}

/** Compute `{ rmdFloorCents, rmdShortfallCents, iraPoolRmdFloorCents }` for one
 *  drawdown-phase year by grouping qualifying accounts per owner, running the
 *  shared RMD engine on the prior-year pre-tax balances, and deriving the
 *  per-account shortfall. `iraPoolRmdFloorCents` is the IRA-pool-only slice of
 *  the gross floor (Σ of the `::pool:IRA` `poolRequired` entries) — the base the
 *  display-only `netTaxableRmdCents` is scoped to (a QCD offsets only the
 *  traditional-IRA RMD, never a 401(k)/403(b)/457(b)/TSP RMD). It is the
 *  IRA-aggregation-pool sum, NOT the all-plan `rmdFloorCents`. */
function rmdForYear(
  args: McRmdPostPassArgs,
  ownerMeta: Map<string, OwnerRmdMeta>,
  accountMeta: RmdAccountMeta[],
  yIdx: number,
): { rmdFloorCents: number; rmdShortfallCents: number; iraPoolRmdFloorCents: number } {
  const year = args.years[yIdx];
  const accountBalances = year.accountBalances;
  // Group qualifying accounts by owner.
  const byOwner = new Map<string, RmdAccountMeta[]>();
  for (const meta of accountMeta) {
    if (!meta.qualifies) continue;
    const owner = ownerMeta.get(meta.ownerId);
    // Skip after the owner's projected death year (deterministic parity); an
    // account whose owner has no member metadata is skipped (no age to age it).
    if (!owner) continue;
    if (owner.deathYear !== undefined && year.year > owner.deathYear) continue;
    const list = byOwner.get(meta.ownerId) ?? [];
    list.push(meta);
    byOwner.set(meta.ownerId, list);
  }

  let rmdFloorCents = 0;
  // Pool required + withdrawn by IRS aggregation pool; take the positive part
  // per pool — IRA/403(b) siblings cross-cover, employer plans and cross-owner do not.
  const poolRequired = new Map<string, number>();
  const poolWithdrawn = new Map<string, number>();
  for (const [ownerId, metas] of byOwner) {
    const owner = ownerMeta.get(ownerId)!;
    const accounts: RmdAccountInput[] = metas.map((meta) =>
      // Assembled by the SHARED `buildMcRmdAccountInput` (full balance +
      // the §325 Roth-designated portion), so the representative floor, the
      // funded per-path floor, and the deterministic engine all resolve the same
      // base from the same resolver.
      buildMcRmdAccountInput({
        id: meta.id,
        accountType: meta.accountType,
        taxTreatment: meta.taxTreatment,
        prior: priorBalanceCents(args.years, yIdx, meta),
        ...(meta.facts !== undefined ? { facts: meta.facts } : {}),
        // The year TWO before this one sizes a first-year-deferral catch-up
        // ("two RMDs in one year"); absent in the first two rows, where the
        // shared engine reports a blocker instead of guessing a base.
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
      // An INHERITED account never aggregates with the beneficiary's own
      // accounts (nor with another decedent's) — it gets a singleton pool key.
      const poolKey = poolKeyForRmdAccount(
        meta.ownerId,
        meta.accountType,
        meta.id,
        meta.facts?.inheritedAccount === true,
      );
      const row = accountBalances?.get(meta.id);
      // Shared satisfying-withdrawal rule: MIXED counts only the pre-tax tranche
      // (preWithdrawnCents), 0 when the kernel did not surface the split (so
      // Roth/post dollars can't mask a pre-tax miss); a pure Roth account counts
      // its whole distribution (an inherited-Roth beneficiary draw satisfies
      // §401(a)(9)(B) even though it is untaxed).
      const withdrawnCents = row ? preTaxWithdrawnCents(row, meta) : 0;
      poolRequired.set(poolKey, (poolRequired.get(poolKey) ?? 0) + requiredCents);
      poolWithdrawn.set(
        poolKey,
        (poolWithdrawn.get(poolKey) ?? 0) + withdrawnCents,
      );
    }
  }
  // Credit each owner's QCD offset toward that owner's IRA POOL (IRC
  // §408(d)(8)). The QCD is debited STRUCTURALLY (the gift leaves the IRA but is
  // NOT recorded as a `preWithdrawnCents` draw), so a QCD-satisfied IRA pool
  // would show a PHANTOM shortfall (`required − withdrawn` with the QCD-satisfied
  // dollars missing from `withdrawn`). The deterministic engine credits the same
  // offset (`applyQcdPrePass` debits `rmdFloorByAccountDollars` in place, then
  // credits `qcdOffsetCents` toward the floor). Mirror it here cent-for-cent: the
  // offset is scoped to ONLY the source owner's `pool:IRA` key (never an
  // employer-plan pool, never cross-owner), so a genuine cross-pool /
  // cross-owner miss still surfaces. Crediting the POOL's `withdrawn` is
  // algebraically identical to the deterministic floor debit:
  // `max(0, required − withdrawn − offset)`.
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
  // IRA-pool-only gross floor: Σ of the `poolRequired` entries whose key is the
  // IRA-aggregation pool (`${ownerId}::pool:IRA`, per `poolKeyForRmdAccount`).
  // The display-only `netTaxableRmdCents` is scoped to this so a QCD (which
  // offsets only the traditional-IRA RMD) never nets against an employer-plan RMD.
  let iraPoolRmdFloorCents = 0;
  for (const [poolKey, requiredCents] of poolRequired) {
    if (poolKey.endsWith('::pool:IRA')) iraPoolRmdFloorCents += requiredCents;
  }
  return { rmdFloorCents, rmdShortfallCents, iraPoolRmdFloorCents };
}

/**
 * Populate `rmdFloorCents` / `rmdShortfallCents` on each drawdown-phase year of
 * a representative run, in place. Pre-retirement rows (no `accountBalances`)
 * are left untouched. A year with a $0 floor leaves both fields at 0 (the RMD
 * chart hides $0-floor years anyway).
 *
 * No-ops when no member metadata or no RMD snapshot is available — the rows
 * keep their absent RMD fields, exactly like a deterministic run with no
 * RMD-eligible accounts.
 */
export function applyMcRmdToRepresentativeYears(args: McRmdPostPassArgs): void {
  if (args.members.length === 0) return;
  const ownerMeta = buildOwnerMeta(args);
  const accountMeta = buildAccountMeta(args.ledger, args.rmdFactsByAccountId);
  if (!accountMeta.some((m) => m.qualifies)) return;
  // A STRICTLY-post-depletion row would read its PRIOR row's `preEnd`
  // to compute the floor; that prior row is itself at/after depletion (the
  // clamp zeroes its `preEnd`), and stamping any RMD floor on a $0 post-depletion
  // portfolio is a phantom anyway. Skip them; the depletion year itself still
  // carries a real floor from its un-clamped PRIOR-year balances.
  const depletionYear = args.depletionYear ?? null;
  for (let yIdx = 0; yIdx < args.years.length; yIdx += 1) {
    const year = args.years[yIdx];
    // Only drawdown-phase rows carry per-account balances; skip the rest.
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
    // DISPLAY-only. The strategy replay already stamped
    // `qcdCents` / `qcdRmdOffsetCentsByOwner` on this row (the per-path math).
    // Re-derive the DISPLAYED `netTaxableRmdCents` from the IRA-POOL-ONLY gross
    // floor (`iraPoolRmdFloorCents`), matching the field's doc ("gross IRA-pool
    // RMD − offset") and the deterministic engine
    // (`drawdown-engine-per-account-strategy.ts` stamps it from
    // `grossIraPoolRmdCents`). A QCD offsets only the traditional-IRA RMD, so the
    // still-taxable IRA RMD is `iraPoolFloor − Σ_owner offset`, clamped ≥ 0 —
    // employer-plan RMDs (401(k)/403(b)/457(b)/TSP) are NOT included. This
    // is display-only; `rmdFloorCents`/`rmdShortfallCents` (the RMD chart) stay
    // all-plan and unchanged. No-op when no QCD applied (`qcdCents` absent / 0 →
    // tiles hidden).
    if ((year.qcdCents ?? 0) > 0) {
      const offsetTotalCents = Object.values(year.qcdRmdOffsetCentsByOwner ?? {}).reduce(
        (sum, c) => sum + c,
        0,
      );
      year.netTaxableRmdCents = Math.max(0, iraPoolRmdFloorCents - offsetTotalCents);
    }
  }
}
