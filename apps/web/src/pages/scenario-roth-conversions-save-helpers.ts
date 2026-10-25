/** Pure helpers for the working-years Roth-conversions Save: builds the sparse preRetirementRothConversions and preRetirementRothConversionTaxRatePct fragments, pruning entries whose pair fails isValidWorkingYearsRothConversionPair (mirroring resolvePreRetirementRothConversions) so a re-save never carries a dangling id forward. */
import type {
  AccountPayload,
  Aggregate,
  ScenarioPayload,
} from '../db/types';
import type { DraftRothConversion } from './scenario-roth-conversions-draft-hook';
import { isValidWorkingYearsRothConversionPair } from '../lib/roth-conversion-eligibility';

type ScenarioOverrides = ScenarioPayload['overrides'];

export type PersistedRothConversion = NonNullable<
  ScenarioOverrides['preRetirementRothConversions']
>[number];

// Sanitises one draft entry: amount to a finite, ≥ 0 whole-dollar figure; the transient draftId (a React key) is stripped.
function toPersistedConversion(d: DraftRothConversion): PersistedRothConversion {
  const raw = d.annualAmountDollars;
  const amount = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  return {
    sourceAccountId: d.sourceAccountId,
    targetRothAccountId: d.targetRothAccountId,
    annualAmountDollars: amount,
    start: d.start,
    end: d.end,
  };
}

/** The conversions-array fragment: prunes orphan entries, sanitises amounts and omits the key when nothing survives (an empty array is never persisted). */
export function buildNextRothConversions(args: {
  drafts: ReadonlyArray<DraftRothConversion>;
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
}): { preRetirementRothConversions?: ReadonlyArray<PersistedRothConversion> } {
  const { drafts, accounts } = args;
  const accountById = new Map<string, { id: string; payload: AccountPayload }>();
  for (const a of accounts) accountById.set(a.id, { id: a.id, payload: a.payload });
  const kept = drafts
    .filter((d) => {
      const sourceRec = accountById.get(d.sourceAccountId);
      const targetRec = accountById.get(d.targetRothAccountId);
      if (!sourceRec || !targetRec) return false;
      return isValidWorkingYearsRothConversionPair(sourceRec, targetRec);
    })
    .map(toPersistedConversion);
  return kept.length > 0
    ? { preRetirementRothConversions: kept }
    : {};
}

/** Display-only assumed tax rate, clamped to [0, 100] and omitted when 0 (absent means no burden). */
export function buildNextRothConversionTaxRate(args: {
  taxRatePct: number;
}): { preRetirementRothConversionTaxRatePct?: number } {
  const raw = args.taxRatePct;
  const rate = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;
  return rate > 0 ? { preRetirementRothConversionTaxRatePct: rate } : {};
}
