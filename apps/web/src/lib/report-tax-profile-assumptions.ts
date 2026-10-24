/** Account-specific tax assumptions for exported reports, grouped by rule. */
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import {
  EMPLOYER_PLAN_RMD_TYPES,
  readTaxProfileDraft,
  rmdBlockerMessages,
  showsDesignatedRothFields,
  showsRmdFields,
  showsRothIraFields,
} from './account-tax-profile';
import { isPureRothEmployerType } from './balance-calc';
import {
  resolveEffectiveRothStartYear,
  resolveRothStartYear,
} from './roth-start-year';
import { isQualifyingAccount, spouseMoreThan10YearsYounger } from './rmd';
import { reportAccountOwnerDisplayName } from './report-account-metrics';
import { sortReportAccounts } from './report-table-ordering';

export interface ReportTaxProfileAssumptionInput {
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
}

function list(label: string, names: readonly string[]): string | undefined {
  return names.length > 0 ? `${label}: ${names.join(', ')}.` : undefined;
}

function isFullyRothOwnerAccount(payload: AccountPayload): boolean {
  return (
    payload.type === 'RETIREMENT_ROTH_IRA' ||
    isPureRothEmployerType(payload.type)
  );
}

/**
 * Build exact, account-named disclosures for every derived or conservative
 * tax-profile input used by projections and reports.
 */
export function buildReportTaxProfileAssumptions({
  accounts,
  balances,
  members,
}: ReportTaxProfileAssumptionInput): string[] {
  const inferredYears: string[] = [];
  const pooledRothIraYears: string[] = [];
  const unavailableYears: string[] = [];
  const ownerTreatment: string[] = [];
  const noCurrentEmployerDelay: string[] = [];
  const noFirstYearDeferral: string[] = [];
  const uniformLifetimeTable: string[] = [];
  const blockerAccountsByReason = new Map<string, string[]>();
  const liveMembers = members.filter((member) => !member.deletedAt);
  const membersById = new Map(liveMembers.map((member) => [member.id, member.payload]));
  const orderedAccounts = sortReportAccounts(
    accounts
      .filter((account) => !account.deletedAt && account.payload.active)
      .map((account) => ({
        account,
        id: account.id,
        name: account.payload.name,
        ownerDisplayName: reportAccountOwnerDisplayName(account.payload, membersById),
      })),
  );
  const activePoolAccounts = orderedAccounts.map(({ account }) => account);

  for (const { account } of orderedAccounts) {
    const { payload } = account;
    const draft = readTaxProfileDraft(payload);
    const hasRothIra = showsRothIraFields(payload.type);
    const hasDesignated = showsDesignatedRothFields(payload.type, payload.taxTreatment);

    // Neither engine consults an inherited Roth IRA's five-year clock, so no Roth start-year group may name one. An
    // inherited designated-Roth plan keeps its groups, as do the inherited required-withdrawal blocker groups below.
    const inheritedRothIra = hasRothIra && payload.rmdInheritedAccount === true;
    if ((hasRothIra || hasDesignated) && !inheritedRothIra) {
      const baseInput = {
        accountId: account.id,
        type: payload.type,
        taxTreatment: payload.taxTreatment,
        explicitYear: hasRothIra
          ? payload.rothIraFirstContributionTaxYear
          : payload.designatedRothFirstParticipationTaxYear,
        balances,
      };
      const resolved = hasRothIra
        ? resolveEffectiveRothStartYear({
            ...baseInput,
            ownerId: payload.ownerId,
            inherited: false,
            accounts: activePoolAccounts,
          })
        : resolveRothStartYear(baseInput);
      if (resolved.source === 'balance-history') {
        inferredYears.push(`${payload.name} (${resolved.year})`);
      } else if (resolved.source === 'roth-ira-pool') {
        pooledRothIraYears.push(`${payload.name} (${resolved.year})`);
      } else if (resolved.source === 'unavailable') {
        unavailableYears.push(payload.name);
      }
    }

    if (!showsRmdFields(payload.type)) continue;
    const owner = liveMembers.find((member) => member.id === payload.ownerId);
    if (draft.rmdInheritedAccount) {
      for (const reason of rmdBlockerMessages(
        draft,
        payload.type,
        owner?.payload.birthdate,
      )) {
        const names = blockerAccountsByReason.get(reason) ?? [];
        names.push(payload.name);
        blockerAccountsByReason.set(reason, names);
      }
      continue;
    }
    if (isFullyRothOwnerAccount(payload)) continue;
    if (!isQualifyingAccount(payload.type, payload.taxTreatment)) continue;

    ownerTreatment.push(payload.name);
    if (
      EMPLOYER_PLAN_RMD_TYPES.has(payload.type) &&
      !(
        draft.rmdCurrentEmployerPlan &&
        draft.rmdFivePercentOwner === 'no' &&
        draft.rmdPlanRequiresDistributionAtStatutoryAge === 'no'
      )
    ) {
      noCurrentEmployerDelay.push(payload.name);
    }
    if (!draft.rmdFirstYearDeferralElected) noFirstYearDeferral.push(payload.name);

    const spouse = liveMembers.find((member) => member.id !== payload.ownerId);
    const eligibleSoleSpouse =
      draft.rmdSoleSpouseBeneficiary &&
      spouseMoreThan10YearsYounger(
        owner?.payload.birthdate,
        spouse?.payload.birthdate,
      ) === true;
    if (!eligibleSoleSpouse) uniformLifetimeTable.push(payload.name);
  }

  const disclosures = [
    list('Roth start years inferred from balance history', inferredYears),
    list(
      "Roth start years supplied by another Roth IRA in the owner's shared pool",
      pooledRothIraYears,
    ),
    list(
      'No supporting Roth history was found, so the five-year rule is treated as unmet',
      unavailableYears,
    ),
    list('Standard owner RMD treatment (not inherited) is used', ownerTreatment),
    list('No current-employer RMD delay is assumed', noCurrentEmployerDelay),
    list('No first-year RMD deferral is assumed', noFirstYearDeferral),
    list('The Uniform Lifetime Table III is used', uniformLifetimeTable),
  ].filter((entry): entry is string => entry !== undefined);

  for (const [reason, names] of blockerAccountsByReason) {
    disclosures.push(`Required-withdrawal estimate on hold — ${reason}: ${names.join(', ')}.`);
  }
  return disclosures;
}
