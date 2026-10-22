/**
 * The candidate grid: the plausible ordinary brackets, each with and without
 * the IRMAA / ACA cliff guards, plus the scenario's current plan as the
 * reference every other candidate is measured against.
 */

/** Brackets worth filling in retirement, as the federal table's rate fractions. */
const BRACKET_RATES: readonly number[] = [0.12, 0.22, 0.24, 0.32];

export interface CandidateSpec {
  readonly id: string;
  readonly isReference: boolean;
  /** Null on the reference. */
  readonly bracketRate: number | null;
  /** Null on the reference. */
  readonly guarded: boolean | null;
}

const REFERENCE_CANDIDATE_ID = 'current-plan';

function ladderCandidateId(rate: number, guarded: boolean): string {
  return `bracket-${Math.round(rate * 100)}-${guarded ? 'guarded' : 'unguarded'}`;
}

/** Reference first, then each bracket in ascending order, guarded before
 *  unguarded (a tie in every metric then prefers the more cautious plan). */
export function buildCandidateGrid(): readonly CandidateSpec[] {
  const grid: CandidateSpec[] = [
    { id: REFERENCE_CANDIDATE_ID, isReference: true, bracketRate: null, guarded: null },
  ];
  for (const rate of BRACKET_RATES) {
    for (const guarded of [true, false]) {
      grid.push({ id: ladderCandidateId(rate, guarded), isReference: false, bracketRate: rate, guarded });
    }
  }
  return grid;
}
