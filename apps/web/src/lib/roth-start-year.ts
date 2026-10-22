/**
 * Resolve a Roth five-year-clock start from explicit facts or safe ledger evidence.
 */
import type {
  AccountBalancePayload,
  AccountPayload,
  AccountTaxTreatment,
  AccountType,
  Aggregate,
} from '../db/types';
import { isValidRothMoney, isValidRothTaxYear } from '../db/roth-fact-validation';
import { isPureRothEmployerType, isRothDesignatedRetirementType } from './balance-calc';

type RothStartYearSource =
  | 'explicit'
  | 'balance-history'
  | 'roth-ira-pool'
  | 'unavailable';

/** A resolved clock and the provenance shown in account/report disclosures. */
export interface ResolvedRothStartYear {
  readonly year?: number;
  readonly source: RothStartYearSource;
}

interface ResolveRothStartYearInput {
  readonly accountId: string;
  readonly type: AccountType | '';
  readonly taxTreatment: AccountTaxTreatment | '';
  readonly explicitYear: unknown;
  readonly balances: ReadonlyArray<
    Pick<Aggregate<AccountBalancePayload>, 'payload' | 'deletedAt'>
  >;
}

interface ResolveEffectiveRothStartYearInput extends ResolveRothStartYearInput {
  readonly ownerId: string;
  readonly inherited: boolean;
  readonly accounts: ReadonlyArray<
    Pick<Aggregate<AccountPayload>, 'id' | 'payload' | 'deletedAt'>
  >;
}

type RothEvidenceKind = 'ira' | 'designated-pure' | 'designated-mixed';

function evidenceKind(
  type: AccountType | '',
  taxTreatment: AccountTaxTreatment | '',
): RothEvidenceKind | undefined {
  if (type === 'RETIREMENT_ROTH_IRA') return 'ira';
  if (type !== '' && isPureRothEmployerType(type)) return 'designated-pure';
  if (
    type !== '' &&
    taxTreatment === 'MIXED' &&
    isRothDesignatedRetirementType(type)
  ) {
    return 'designated-mixed';
  }
  return undefined;
}

function positive(value: unknown): boolean {
  return isValidRothMoney(value) && value > 0;
}

function rowHasEvidence(payload: AccountBalancePayload, kind: RothEvidenceKind): boolean {
  if (kind === 'designated-mixed') {
    return [
      payload.startingBalancePostTax,
      payload.endingBalancePostTax,
      payload.contributionsPostTax,
      payload.companyContributionsPostTax,
      payload.rothInPlanRolloverTaxableAmount,
      payload.rothInPlanRolloverNontaxableAmount,
    ].some(positive);
  }
  const common = [
    payload.startingBalance,
    payload.endingBalance,
    payload.totalContributions,
    payload.rollover,
  ];
  const dated =
    kind === 'ira'
      ? [payload.rothConversionTaxableAmount, payload.rothConversionNontaxableAmount]
      : [
          payload.rothInPlanRolloverTaxableAmount,
          payload.rothInPlanRolloverNontaxableAmount,
        ];
  return [...common, ...dated].some(positive);
}

/**
 * Resolve an applicable Roth account's clock without persisting derived data.
 * Duplicate account/year rows follow the engine's first-row-wins import rule.
 */
export function resolveRothStartYear(
  input: ResolveRothStartYearInput,
): ResolvedRothStartYear {
  const kind = evidenceKind(input.type, input.taxTreatment);
  if (kind === undefined) return { source: 'unavailable' };
  if (isValidRothTaxYear(input.explicitYear)) {
    return { year: input.explicitYear, source: 'explicit' };
  }

  const firstByYear = new Map<number, AccountBalancePayload>();
  for (const balance of input.balances) {
    if (balance.deletedAt !== undefined || balance.payload.accountId !== input.accountId) continue;
    const year = balance.payload.year;
    if (!isValidRothTaxYear(year) || firstByYear.has(year)) continue;
    firstByYear.set(year, balance.payload);
  }
  const inferred = [...firstByYear.entries()]
    .filter(([, payload]) => rowHasEvidence(payload, kind))
    .map(([year]) => year)
    .sort((a, b) => a - b)[0];
  return inferred === undefined
    ? { source: 'unavailable' }
    : { year: inferred, source: 'balance-history' };
}

/**
 * Resolve the clock the engine effectively applies to this account. An owner's
 * own Roth IRAs share the earliest clock in their §408A pool; every inherited
 * Roth IRA remains a singleton with the original owner's clock.
 */
export function resolveEffectiveRothStartYear(
  input: ResolveEffectiveRothStartYearInput,
): ResolvedRothStartYear {
  const current = resolveRothStartYear(input);
  if (
    input.type !== 'RETIREMENT_ROTH_IRA' ||
    input.inherited ||
    input.ownerId === ''
  ) {
    return current;
  }

  let earliest = current;
  for (const account of input.accounts) {
    if (
      account.deletedAt !== undefined ||
      account.id === input.accountId ||
      account.payload.type !== 'RETIREMENT_ROTH_IRA' ||
      account.payload.ownerId !== input.ownerId ||
      account.payload.rmdInheritedAccount === true
    ) {
      continue;
    }
    const candidate = resolveRothStartYear({
      accountId: account.id,
      type: account.payload.type,
      taxTreatment: account.payload.taxTreatment,
      explicitYear: account.payload.rothIraFirstContributionTaxYear,
      balances: input.balances,
    });
    if (
      candidate.year !== undefined &&
      (earliest.year === undefined || candidate.year < earliest.year)
    ) {
      earliest = { year: candidate.year, source: 'roth-ira-pool' };
    }
  }
  return earliest;
}
