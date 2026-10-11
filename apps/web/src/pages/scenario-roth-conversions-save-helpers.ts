/**
 * Pure helpers for the working-years Roth-conversions sub-page Save path.
 * Build two sparse override
 * fragments (`preRetirementRothConversions`, `preRetirementRothConversionTaxRatePct`)
 * the page spreads into one `nextOverrides` object and dispatches via a single
 * `saveScenario`.
 *
 * Sparse-persist rule (mirrors the inflation / withdrawal-strategy helpers):
 *  - the conversions array is OMITTED when it resolves to empty (so an
 *    all-removed scenario inherits / carries no key);
 *  - an entry is PRUNED at save (orphan cleanup) unless its (source, target)
 *    pair passes `isValidWorkingYearsRothConversionPair` — mirrors
 *    `resolvePreRetirementRothConversions`, so a re-save never carries a
 *    wrong-type, inactive, inherited-Roth-IRA-target, or cross-owner id
 *    forward;
 *  - the amount is sanitised to a finite, non-negative whole-dollar figure;
 *  - the rate clamps to `[0, 100]`.
 *
 * The resolver (`resolvePreRetirementRothConversions`) re-hardens all of this
 * at the engine boundary (import-bundle threat surface); this is the
 * UI-side prune so a re-save never carries a dangling id forward.
 */
import type {
  AccountPayload,
  Aggregate,
  ScenarioPayload,
} from '../db/types';
import type { DraftRothConversion } from './scenario-roth-conversions-draft-hook';
import { isValidWorkingYearsRothConversionPair } from '../lib/roth-conversion-eligibility';

type ScenarioOverrides = ScenarioPayload['overrides'];

/** A persisted conversion entry — the exact stored shape on `ScenarioOverrides`. */
export type PersistedRothConversion = NonNullable<
  ScenarioOverrides['preRetirementRothConversions']
>[number];

/** Sanitise one draft entry into the stored shape: amount → finite, ≥ 0,
 *  whole dollars; anchors carried verbatim (they are already the `age | year`
 *  subset the picker emits). The transient `draftId` (a UI-only React key) is
 *  STRIPPED so it never persists. */
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

/**
 * Conversions-array fragment. Prunes an entry (orphan cleanup) unless its
 * (source, target) pair passes `isValidWorkingYearsRothConversionPair` —
 * mirrors `resolvePreRetirementRothConversions` so a re-save never carries a
 * wrong-type, inactive, inherited-Roth-IRA-target, or cross-owner id forward.
 * Then sanitises amounts and
 * OMITS the key entirely when nothing survives (sparse — empty array is never
 * persisted). The scenario then inherits / carries no conversions.
 */
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

/** Display-only assumed tax-rate fragment — clamped to `[0, 100]`, OMITTED
 *  when it resolves to 0 (sparse; absent ⇒ 0 burden). */
export function buildNextRothConversionTaxRate(args: {
  taxRatePct: number;
}): { preRetirementRothConversionTaxRatePct?: number } {
  const raw = args.taxRatePct;
  const rate = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;
  return rate > 0 ? { preRetirementRothConversionTaxRatePct: rate } : {};
}
