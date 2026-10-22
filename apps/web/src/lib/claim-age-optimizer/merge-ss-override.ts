/**
 * Merge an optimizer-recommended claim-age pair into the existing SS
 * override block:
 *
 * - **Preserve** `benefitReductionPct` + `colaPct` +
 *   `colaTracksInflation` + the per-member `survivor` claim-age map from
 *   the currently-resolved override (overwriting them would silently
 *   reset a user-configured haircut / COLA / inflation-tracking choice —
 *   and dropping `survivor` would erase the survivor input the
 *   ranked winner was simulated with, so the applied scenario would no
 *   longer reproduce the candidate the user accepted).
 * - **Whole-year search** — a searched member's candidate carries
 *   `ageMonths` 0 (the grid only holds whole years); a member carried
 *   through unsearched (the 1-D fallback) or a stored month-level pair
 *   that won carries its stored months. Write the winner's months, absent
 *   meaning 0.
 * - **Single-member household** (`hasSecondary: false`) — strip the
 *   `secondary` key from the merged payload entirely.
 * - **Partial secondary** — when `hasSecondary: true` and the
 *   secondary's grid was empty (member past 70), write only the
 *   primary's age and keep the existing `secondary` override
 *   unchanged. The Apply path stays enabled because the primary
 *   recommendation remains actionable.
 */
import type {
  RetirementAgePerMember,
  SocialSecurityOverride,
} from '../../db/types';

interface OptimalPair {
  readonly primaryAgeYears: number;
  readonly primaryAgeMonths?: number;
  readonly secondaryAgeYears: number | null;
  readonly secondaryAgeMonths?: number;
}

export interface MergeSsOverrideArgs {
  readonly currentResolvedOverride: SocialSecurityOverride | undefined;
  readonly optimalPair: OptimalPair;
  readonly hasSecondary: boolean;
  readonly secondaryPastWindow: boolean;
}

export function mergeSsOverride(args: MergeSsOverrideArgs): SocialSecurityOverride {
  const { currentResolvedOverride, optimalPair, hasSecondary, secondaryPastWindow } = args;
  const primary: RetirementAgePerMember = {
    ageYears: optimalPair.primaryAgeYears,
    ageMonths: optimalPair.primaryAgeMonths ?? 0,
  };
  const merged: SocialSecurityOverride = { primary };
  if (currentResolvedOverride?.benefitReductionPct !== undefined) {
    merged.benefitReductionPct = currentResolvedOverride.benefitReductionPct;
  }
  if (currentResolvedOverride?.colaPct !== undefined) {
    merged.colaPct = currentResolvedOverride.colaPct;
  }
  if (currentResolvedOverride?.colaTracksInflation !== undefined) {
    merged.colaTracksInflation = currentResolvedOverride.colaTracksInflation;
  }
  if (currentResolvedOverride?.survivor !== undefined) {
    // The deterministic winner was ranked WITH the resolved survivor
    // claim ages — Apply must carry them into the written override or the
    // post-Apply projection would withhold the survivor benefit and
    // diverge from the ranked candidate.
    merged.survivor = currentResolvedOverride.survivor;
  }
  if (!hasSecondary) {
    // Single-member household — strip `secondary` even if the inherited
    // override carried one (cleaner storage; matches the scenario-
    // detail SS modal's existing single-member behaviour).
    return merged;
  }
  if (secondaryPastWindow) {
    // Keep the existing secondary value untouched. The primary
    // recommendation is still actionable on its own.
    if (currentResolvedOverride?.secondary !== undefined) {
      merged.secondary = currentResolvedOverride.secondary;
    }
    return merged;
  }
  if (optimalPair.secondaryAgeYears === null) {
    // Defensive: hasSecondary true but no recommendation produced.
    // Preserve the existing override (mirrors the past-window path).
    if (currentResolvedOverride?.secondary !== undefined) {
      merged.secondary = currentResolvedOverride.secondary;
    }
    return merged;
  }
  merged.secondary = {
    ageYears: optimalPair.secondaryAgeYears,
    ageMonths: optimalPair.secondaryAgeMonths ?? 0,
  };
  return merged;
}
