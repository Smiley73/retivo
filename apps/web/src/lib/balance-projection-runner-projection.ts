/** Per-account projection and targeted-deposit classification for `buildPipelineContext`. */
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import {
  DEFAULT_INFLATION_PCT,
  DEFAULT_LIFE_EXPECTANCY_AGE,
} from '../db/types';
import {
  resolveScenario,
  resolveAccountContributionsForScenario,
  resolveAccountReturnsForScenario,
  resolveContributionGrowth,
} from './scenario-resolution';
import { resolveIncomeForScenario } from './income-resolution';
import {
  buildIncomeContext,
  collectTargetedDepositEvents,
  oneOffMonth,
  type TargetedDepositEvent,
} from './income-projection';
import { project, type ProjectionOutput } from './projection';
import { accountReturns } from './balance-calc';
import type {
  AccountProjection,
  PreDepositList,
  PreWithdrawalList,
  RunBalanceProjectionArgs,
} from './balance-projection-runner-types';

export function preProjectCbpAccounts(opts: {
  readonly activeAccounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly args: RunBalanceProjectionArgs;
  readonly resolved: ReturnType<typeof resolveScenario>;
  readonly primaryRetIso: string;
  readonly retirementByMember: ReadonlyMap<string, string | null>;
}): Map<string, ProjectionOutput> {
  const out = new Map<string, ProjectionOutput>();
  const cbpAccounts = opts.activeAccounts.filter(
    (a) => a.payload.type === 'RETIREMENT_CASH_BALANCE',
  );
  if (cbpAccounts.length === 0) return out;
  const stopContributionsToday =
    opts.resolved.contributions?.stopContributionsToday ?? false;
  const todayYear = opts.args.todayYear;
  const todayMonthIndex = opts.args.todayMonthIndex;
  const balancesByAccount = groupBalancesByAccount(opts.args.balances);
  const growthByAccount = resolveContributionGrowth(
    opts.args.scenarioId,
    [...opts.args.scenarios],
    cbpAccounts,
  );
  for (const account of cbpAccounts) {
    const cbpBalances = balancesByAccount.get(account.id) ?? [];
    if (cbpBalances.length === 0) continue;
    const ownerRet = opts.retirementByMember.get(account.payload.ownerId) ?? null;
    const projOut = project({
      account,
      balances: cbpBalances,
      ratePct: account.payload.planningReturnPct,
      retirementDate: opts.primaryRetIso,
      accumulationEndDate: ownerRet ?? opts.primaryRetIso,
      stopContributionsToday,
      todayYear,
      todayMonthIndex,
      contributionGrowthPct: growthByAccount.get(account.id)?.ratePct ?? 0,
    });
    if (projOut) out.set(account.id, projOut);
  }
  return out;
}

export function groupBalancesByAccount(
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>>,
): Map<string, Aggregate<AccountBalancePayload>[]> {
  const out = new Map<string, Aggregate<AccountBalancePayload>[]>();
  for (const b of balances) {
    const list = out.get(b.payload.accountId);
    if (list) list.push(b);
    else out.set(b.payload.accountId, [b]);
  }
  return out;
}

export function classifyTargetedDeposits(opts: {
  readonly args: RunBalanceProjectionArgs;
  readonly primary: Aggregate<HouseholdMemberPayload>;
  readonly secondary: Aggregate<HouseholdMemberPayload> | undefined;
  readonly primaryRetirementAbsMonth: number;
  readonly primaryRetirementYear: number;
  readonly primaryRetirementMonth0: number;
  readonly resolved: ReturnType<typeof resolveScenario>;
  readonly retirementByMember: ReadonlyMap<string, string | null>;
  readonly cbpProjectionByAccount: ReadonlyMap<string, ProjectionOutput>;
}): {
  readonly preDepositsByAccount: ReadonlyMap<string, PreDepositList>;
  readonly cbpLumpSumEventAbsMonth: ReadonlyMap<string, number>;
} {
  const preDepositsByAccount = new Map<string, PreDepositList[number][]>();
  const cbpLumpSumEventAbsMonth = new Map<string, number>();
  if (opts.args.incomeStreams.length === 0) {
    return { preDepositsByAccount, cbpLumpSumEventAbsMonth };
  }
  const resolvedIncome = resolveIncomeForScenario(
    opts.args.scenarioId,
    [...opts.args.scenarios],
    [...opts.args.incomeStreams],
  );
  const retirementDateByMember = buildMemberRetirementMap(opts.retirementByMember);
  const todayYear = opts.args.todayYear;
  const todayMonthIndex = opts.args.todayMonthIndex;
  const lifePrimary =
    opts.resolved.lifeExpectancy?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE;
  const lifeSecondary = opts.resolved.lifeExpectancy?.secondary;
  const incomeCtx = buildIncomeContext([...opts.args.members], {
    retirementStartYear: opts.primaryRetirementYear,
    lifeExpectancyPrimary: lifePrimary,
    lifeExpectancySecondary: lifeSecondary,
    retirementDateByMember,
    todayYear,
    todayMonthIndex,
    inflationPct: opts.resolved.inflation?.ratePct ?? DEFAULT_INFLATION_PCT,
  });
  const cbpBalanceLookup = makeCbpBalanceLookup(
    opts.cbpProjectionByAccount,
    opts.primaryRetirementAbsMonth,
  );
  const events: TargetedDepositEvent[] = collectTargetedDepositEvents(
    resolvedIncome,
    {
      ...incomeCtx,
      retirementMonth0: opts.primaryRetirementMonth0,
      linkedCbpBalanceLookup: cbpBalanceLookup,
    },
  );
  const accountById = new Map(opts.args.accounts.map((a) => [a.id, a]));
  for (const ev of events) {
    const target = accountById.get(ev.targetAccountId);
    if (!target) continue;
    const eventAbsMonth = ev.year * 12 + ev.month0;
    if (ev.linkedCbpAccountId !== undefined) {
      cbpLumpSumEventAbsMonth.set(ev.linkedCbpAccountId, eventAbsMonth);
    }
    if (eventAbsMonth >= opts.primaryRetirementAbsMonth) continue;
    let preTax = 0;
    let postTax = 0;
    if (target.payload.taxTreatment === 'PRE_TAX') preTax = ev.amount;
    else postTax = ev.amount;
    const entry = { year: ev.year, month0: ev.month0, preTax, postTax };
    const list = preDepositsByAccount.get(target.id);
    if (list) list.push(entry);
    else preDepositsByAccount.set(target.id, [entry]);
  }
  // Post-primary linked-CBP lump-sum events are dropped by `collectTargetedDepositEvents`; rediscover them so
  // the ledger builder can exclude the source CBP and route the at-event balance to the target once.
  for (const item of resolvedIncome) {
    const p = item.payload;
    if (p.kind !== 'pension' || p.payoutType !== 'lumpSum') continue;
    if (typeof p.linkedCbpAccountId !== 'string' || p.linkedCbpAccountId.length === 0) {
      continue;
    }
    const eventMonth = oneOffMonth(p, incomeCtx);
    if (!eventMonth) continue;
    const eventAbsMonth = eventMonth.year * 12 + eventMonth.month0;
    if (eventAbsMonth < opts.primaryRetirementAbsMonth) continue;
    if (cbpLumpSumEventAbsMonth.has(p.linkedCbpAccountId)) continue;
    cbpLumpSumEventAbsMonth.set(p.linkedCbpAccountId, eventAbsMonth);
  }
  return { preDepositsByAccount, cbpLumpSumEventAbsMonth };
}

export function buildMemberRetirementMap(
  retirementByMember: ReadonlyMap<string, string | null>,
): Map<string, { year: number; month0?: number }> {
  const out = new Map<string, { year: number; month0?: number }>();
  retirementByMember.forEach((iso, memberId) => {
    if (!iso) return;
    const y = Number(iso.slice(0, 4));
    const m = Number(iso.slice(5, 7));
    if (!Number.isFinite(y)) return;
    out.set(memberId, {
      year: y,
      month0: Number.isFinite(m) && m >= 1 && m <= 12 ? m - 1 : undefined,
    });
  });
  return out;
}

export function makeCbpBalanceLookup(
  cbpProjectionByAccount: ReadonlyMap<string, ProjectionOutput>,
  primaryRetirementAbsMonth: number,
): (cbpAccountId: string, year: number, month0: number) => number | null {
  return (cbpAccountId, year, month0) => {
    const proj = cbpProjectionByAccount.get(cbpAccountId);
    if (!proj?.perStep) return null;
    if (year * 12 + month0 >= primaryRetirementAbsMonth) return null;
    const stepIdx = (year - proj.perStep.firstYear) * 12 + month0;
    if (stepIdx < 0 || stepIdx >= proj.perStep.preEnd.length) return null;
    const readIdx = stepIdx === 0 ? 0 : stepIdx - 1;
    return proj.perStep.preEnd[readIdx] + proj.perStep.postEnd[readIdx];
  };
}

export interface ProjectActiveAccountsResult {
  readonly projections: AccountProjection[];
  /**
   * Historical (TWR) is available unless every non-CBP account fell back to its planned rate; CBP accounts
   * never count either way.
   */
  readonly methodAvailable: boolean;
  /**
   * Non-CBP accounts without an empirical TWR rate; they project on their planned rate in the Historical
   * view. `[]` when all have history.
   */
  readonly fallbackAccounts: ReadonlyArray<{ id: string; name: string }>;
}

export function projectActiveAccounts(opts: {
  readonly activeAccounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly args: RunBalanceProjectionArgs;
  readonly resolved: ReturnType<typeof resolveScenario>;
  readonly primaryRetIso: string;
  readonly retirementByMember: ReadonlyMap<string, string | null>;
  readonly preDepositsByAccount: ReadonlyMap<string, PreDepositList>;
  /**
   * Source-leg pre-tax withdrawals for working-years Roth conversions, by source account id; passed to
   * `project()` as `preRetirementWithdrawals`.
   */
  readonly preWithdrawalsByAccount?: ReadonlyMap<string, PreWithdrawalList>;
}): ProjectActiveAccountsResult {
  // Both method outputs are built per account; `methodAvailable` gates only the requested method.
  const method = opts.args.method ?? 'planned';
  const stopContributionsToday =
    opts.resolved.contributions?.stopContributionsToday ?? false;
  const todayYear = opts.args.todayYear;
  const balancesByAccount = groupBalancesByAccount(opts.args.balances);
  const contribOverrides = resolveAccountContributionsForScenario(
    opts.args.scenarioId,
    [...opts.args.scenarios],
    opts.activeAccounts,
  );
  const returnOverrides = resolveAccountReturnsForScenario(
    opts.args.scenarioId,
    [...opts.args.scenarios],
    opts.activeAccounts,
  );
  const growthByAccount = resolveContributionGrowth(
    opts.args.scenarioId,
    [...opts.args.scenarios],
    opts.activeAccounts,
  );
  const todayMonthIndex = opts.args.todayMonthIndex;
  const projections: AccountProjection[] = [];
  let hasEmpiricalTwr = false;
  const fallbackAccounts: { id: string; name: string }[] = [];
  for (const account of opts.activeAccounts) {
    const accBalances = balancesByAccount.get(account.id) ?? [];
    if (accBalances.length === 0) {
      continue;
    }
    const latest = accBalances.reduce((best, r) =>
      r.payload.year > best.payload.year ? r : best,
    );
    const ownerRet = opts.retirementByMember.get(account.payload.ownerId) ?? null;
    const contribOverride = contribOverrides.get(account.id);
    const plannedRate =
      returnOverrides.get(account.id) ?? account.payload.planningReturnPct;
    // CBP balances accrue from the cash-balance formula, not market returns, so they never carry an empirical
    // TWR and use planned even on the TWR view.
    const isCbp = account.payload.type === 'RETIREMENT_CASH_BALANCE';
    const twrRate = isCbp ? null : accountReturns(accBalances).twr;
    if (!isCbp) {
      if (twrRate === null) {
        fallbackAccounts.push({ id: account.id, name: account.payload.name });
      } else {
        hasEmpiricalTwr = true;
      }
    }
    const effectiveAccount: Aggregate<AccountPayload> = contribOverride
      ? {
          ...account,
          payload: {
            ...account.payload,
            plannedContributionPreTax: contribOverride.plannedContributionPreTax,
            plannedContributionPostTax:
              contribOverride.plannedContributionPostTax,
          },
        }
      : account;
    // Contribution-growth rate (override, then baseline, then tracks-inflation = general inflation); MC
    // scales the tracks-inflation case per path separately.
    const growth = growthByAccount.get(account.id);
    const sharedInput = {
      account: effectiveAccount,
      balances: accBalances,
      retirementDate: opts.primaryRetIso,
      accumulationEndDate: ownerRet ?? opts.primaryRetIso,
      preRetirementDeposits: opts.preDepositsByAccount.get(account.id),
      preRetirementWithdrawals: opts.preWithdrawalsByAccount?.get(account.id),
      stopContributionsToday,
      todayYear,
      todayMonthIndex,
      contributionGrowthPct: growth?.ratePct ?? 0,
    };
    const plannedProj = project({ ...sharedInput, ratePct: plannedRate });
    // A non-CBP account with no empirical rate projects on its planned rate under Historical, so
    // `outputs.twr` is always non-null.
    const twrProj =
      isCbp || twrRate === null
        ? plannedProj
        : project({ ...sharedInput, ratePct: twrRate });
    projections.push({
      account: effectiveAccount,
      latestBalance: latest.payload.endingBalance,
      ownerRetirementDate: ownerRet,
      outputs: { planned: plannedProj, twr: twrProj },
      ratePctByMethod: {
        planned: plannedRate,
        twr: isCbp ? plannedRate : twrRate,
      },
      perMonthContribution: computePerMonthContribution({
        effectiveAccount,
        latest,
        ownerRet,
        stopContributionsToday,
      }),
    });
  }
  const methodAvailable = method === 'twr' ? hasEmpiricalTwr : true;
  return { projections, methodAvailable, fallbackAccounts };
}

/**
 * Re-derives TWR availability from an already-built projection set with the predicate `projectActiveAccounts`
 * uses: available iff some non-CBP account has an empirical TWR rate (`ratePctByMethod.twr`).
 */
export function deriveTwrAvailability(
  projections: ReadonlyArray<AccountProjection>,
): boolean {
  return projections.some(
    (proj) =>
      proj.account.payload.type !== 'RETIREMENT_CASH_BALANCE' &&
      proj.ratePctByMethod.twr !== null,
  );
}

function computePerMonthContribution(opts: {
  readonly effectiveAccount: Aggregate<AccountPayload>;
  readonly latest: Aggregate<AccountBalancePayload>;
  readonly ownerRet: string | null;
  readonly stopContributionsToday: boolean;
}): { preTax: number; postTax: number } {
  if (opts.stopContributionsToday) return { preTax: 0, postTax: 0 };
  if (!opts.ownerRet) return { preTax: 0, postTax: 0 };
  const taxTreatment = opts.effectiveAccount.payload.taxTreatment;
  // HSA is single-sided: the contribution is entered pre-tax (`plannedContributionPreTax`) but grows in the
  // post bucket, as in `contribAdds`/`seedBuckets`.
  const plannedPre =
    taxTreatment === 'HSA'
      ? 0
      : opts.effectiveAccount.payload.plannedContributionPreTax;
  const plannedPost =
    taxTreatment === 'HSA'
      ? opts.effectiveAccount.payload.plannedContributionPreTax
      : opts.effectiveAccount.payload.plannedContributionPostTax;
  const companyPre =
    taxTreatment === 'MIXED'
      ? opts.latest.payload.companyContributionsPreTax ?? 0
      : taxTreatment === 'PRE_TAX'
        ? opts.latest.payload.companyContributions
        : 0;
  // HSA and ROTH route company contributions to the post bucket like POST_TAX.
  const companyPost =
    taxTreatment === 'MIXED'
      ? opts.latest.payload.companyContributionsPostTax ?? 0
      : taxTreatment === 'POST_TAX' ||
          taxTreatment === 'HSA' ||
          taxTreatment === 'ROTH'
        ? opts.latest.payload.companyContributions
        : 0;
  return {
    preTax: (plannedPre + companyPre) / 12,
    postTax: (plannedPost + companyPost) / 12,
  };
}
