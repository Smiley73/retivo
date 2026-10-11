/**
 * Per-member candidate-age grid for the claim-age optimizer.
 *
 * The candidate set is `{a, a+1, …, 70}` where
 * `a = max(62, ceil(memberAgeYearsToday))`. The `ceil` (not `floor`)
 * is load-bearing — a member who is 62.5 years old today has already
 * passed age 62, so admitting it would produce a claim date in the
 * past. A member past 70 (or whose PIA is unset) returns an empty
 * grid; the engine then either degenerates to a 1-D search on the
 * other member or surfaces the "past claim-age window" callout.
 */
import type { RetirementAgePerMember } from '../../db/types';

const MIN_CLAIM_AGE = 62;
const MAX_CLAIM_AGE = 70;

export interface BuildCandidateGridArgs {
  /** Member's age in years today (fractional — birthdate-derived). */
  readonly memberAgeYearsToday: number;
  /** True iff the member has a PIA recorded. When false, SS contribution
   *  is $0 across every candidate and the grid degenerates to empty —
   *  the engine then skips this member in the joint search. */
  readonly hasPia: boolean;
}

export function buildCandidateGrid(args: BuildCandidateGridArgs): number[] {
  if (!args.hasPia) return [];
  const lowerBound = Math.max(MIN_CLAIM_AGE, Math.ceil(args.memberAgeYearsToday));
  if (lowerBound > MAX_CLAIM_AGE) return [];
  const out: number[] = [];
  for (let age = lowerBound; age <= MAX_CLAIM_AGE; age += 1) {
    out.push(age);
  }
  return out;
}

// Survivor-benefit claim window: a widow(er) benefit is payable from
// age 60 (42 USC 402(e)/(f)); the reduction schedule tops out at the
// survivor's FRA, so 70 is a safe generous upper bound for the window.
const MIN_SURVIVOR_CLAIM_AGE = 60;
const MAX_SURVIVOR_CLAIM_AGE = 70;

export interface BuildSurvivorCandidateGridArgs {
  /** The surviving member's RESOLVED survivor claim age — the EXACT stored
   *  `{ ageYears, ageMonths }` (the months component is load-bearing;
   *  Apply preserves the stored map verbatim, so the simulated candidate
   *  must carry it too) — or undefined when the scenario has none: the
   *  optimizer never synthesizes a survivor age (absent →
   *  survivor-dependent results stay withheld in every candidate), so an
   *  absent age yields an empty grid. */
  readonly resolvedSurvivorAge: RetirementAgePerMember | undefined;
  /** True iff the OTHER member (the prospective deceased) has a PIA — a
   *  survivor benefit derives from the deceased's record, so without one
   *  the dimension is inert. */
  readonly deceasedHasPia: boolean;
}

/**
 * Candidate set for the independent survivor claim-age dimension —
 * supported worker/survivor claimant types only (current-spouse survivor;
 * no divorced-spouse / child / disability claimants).
 *
 * One canonical semantic, VERBATIM-or-INERT: the grid NEVER
 * transforms a stored survivor age. A stored `{ ageYears, ageMonths }`
 * inside the 60–70 widow(er) window passes through VERBATIM — month-precise,
 * and regardless of whether it lies before or after the member's
 * current age (a "past" stored age relative to a modeled death is a
 * legitimate input the engine simulates faithfully: the benefit starts at
 * `max(claim month, death boundary)`, exactly what the post-Apply
 * projection does with the same stored value). A stored age truly OUTSIDE
 * the window returns the empty grid — the dimension stays INERT
 * and every downstream consumer (deterministic overlay, MC,
 * Apply) falls back to the SAME resolved stored section, so ranking and
 * Apply still agree. Rounding/clamping to a different age is forbidden:
 * ranking would simulate an age Apply never writes.
 */
export function buildSurvivorCandidateGrid(
  args: BuildSurvivorCandidateGridArgs,
): RetirementAgePerMember[] {
  if (!args.deceasedHasPia) return [];
  if (args.resolvedSurvivorAge === undefined) return [];
  // Month-precise window test — `62y6m` is 62.5, not 62/63.
  const storedFractionalYears =
    args.resolvedSurvivorAge.ageYears + args.resolvedSurvivorAge.ageMonths / 12;
  if (
    storedFractionalYears < MIN_SURVIVOR_CLAIM_AGE ||
    storedFractionalYears > MAX_SURVIVOR_CLAIM_AGE
  ) {
    return [];
  }
  return [{ ...args.resolvedSurvivorAge }];
}
