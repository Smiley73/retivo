// Annual-contributions math: per-account rows and portfolio totals for the Account Contributions page.

import type {
  AccountBalancePayload,
  AccountPayload,
  AccountTaxTreatment,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import { assertNever } from './assert-never';

export interface AccountContributionRow {
  id: string;
  name: string;
  ownerDisplayName: string;
  type: AccountPayload['type'];
  taxTreatment: AccountTaxTreatment;
  active: boolean;
  notes: string;
  plannedPreTax: number;
  plannedPostTax: number;
  actualPreTax: number;
  actualPostTax: number;
  remainingPreTax: number;
  remainingPostTax: number;
  plannedTotal: number;
  actualTotal: number;
  remainingTotal: number;
}

interface ContributionSummaryTotals {
  totalPlanned: number;
  totalPlannedPreTax: number;
  totalPlannedPostTax: number;
  totalRemaining: number;
  totalRemainingPreTax: number;
  totalRemainingPostTax: number;
}

export interface ContributionSummary {
  year: number;
  accounts: AccountContributionRow[];
  summary: ContributionSummaryTotals;
}

/** Whether the pre-tax planned-contribution field is editable: PRE_TAX, MIXED and HSA (an HSA is funded pre-tax); POST_TAX and ROTH hide it. */
export function isTreatmentEditablePreTax(treatment: AccountTaxTreatment): boolean {
  switch (treatment) {
    case 'PRE_TAX':
    case 'MIXED':
    case 'HSA':
      return true;
    case 'POST_TAX':
    case 'ROTH':
      return false;
    default:
      return assertNever(treatment);
  }
}

/** Whether the post-tax planned-contribution field is editable: POST_TAX, MIXED and ROTH; PRE_TAX and HSA hide it (an HSA's planned contribution is stored pre-tax). */
export function isTreatmentEditablePostTax(treatment: AccountTaxTreatment): boolean {
  switch (treatment) {
    case 'POST_TAX':
    case 'MIXED':
    case 'ROTH':
      return true;
    case 'PRE_TAX':
    case 'HSA':
      return false;
    default:
      return assertNever(treatment);
  }
}

interface AccountInput {
  account: Aggregate<AccountPayload>;
  ownerDisplayName: string;
}

export function computeContributionSummary(
  accounts: AccountInput[],
  balances: Aggregate<AccountBalancePayload>[],
  members: Map<string, HouseholdMemberPayload>,
  year: number,
): ContributionSummary {
  void members; // ownerDisplayName is resolved by the caller, kept for future use

  const balanceByAccountId = new Map<string, AccountBalancePayload>();
  for (const b of balances) {
    if (b.payload.year === year) balanceByAccountId.set(b.payload.accountId, b.payload);
  }

  const rows: AccountContributionRow[] = accounts.map(({ account, ownerDisplayName }) => {
    const a = account.payload;
    const plannedPreTax = a.plannedContributionPreTax ?? 0;
    const plannedPostTax = a.plannedContributionPostTax ?? 0;
    const balance = balanceByAccountId.get(account.id);

    let actualPreTax = 0;
    let actualPostTax = 0;
    if (balance) {
      if (a.taxTreatment === 'MIXED') {
        actualPreTax =
          (balance.contributionsPreTax ?? 0) + (balance.companyContributionsPreTax ?? 0);
        actualPostTax =
          (balance.contributionsPostTax ?? 0) + (balance.companyContributionsPostTax ?? 0);
      } else if (a.taxTreatment === 'PRE_TAX' || a.taxTreatment === 'HSA') {
        // HSA contributions are made pre-tax, so the split mirrors PRE_TAX (as the Account Balances summary card does).
        actualPreTax = balance.totalContributions;
      } else if (a.taxTreatment === 'POST_TAX' || a.taxTreatment === 'ROTH') {
        // Roth is post-tax funded, like POST_TAX.
        actualPostTax = balance.totalContributions;
      } else {
        assertNever(a.taxTreatment);
      }
    }

    const remainingPreTax = plannedPreTax - actualPreTax;
    const remainingPostTax = plannedPostTax - actualPostTax;

    return {
      id: account.id,
      name: a.name,
      ownerDisplayName,
      type: a.type,
      taxTreatment: a.taxTreatment,
      active: a.active,
      notes: a.notes,
      plannedPreTax,
      plannedPostTax,
      actualPreTax,
      actualPostTax,
      remainingPreTax,
      remainingPostTax,
      plannedTotal: plannedPreTax + plannedPostTax,
      actualTotal: actualPreTax + actualPostTax,
      remainingTotal: remainingPreTax + remainingPostTax,
    };
  });

  const summary = rows.reduce<ContributionSummaryTotals>(
    (acc, r) => ({
      totalPlanned: acc.totalPlanned + r.plannedTotal,
      totalPlannedPreTax: acc.totalPlannedPreTax + r.plannedPreTax,
      totalPlannedPostTax: acc.totalPlannedPostTax + r.plannedPostTax,
      totalRemaining: acc.totalRemaining + r.remainingTotal,
      totalRemainingPreTax: acc.totalRemainingPreTax + r.remainingPreTax,
      totalRemainingPostTax: acc.totalRemainingPostTax + r.remainingPostTax,
    }),
    {
      totalPlanned: 0,
      totalPlannedPreTax: 0,
      totalPlannedPostTax: 0,
      totalRemaining: 0,
      totalRemainingPreTax: 0,
      totalRemainingPostTax: 0,
    },
  );

  return { year, accounts: rows, summary };
}
