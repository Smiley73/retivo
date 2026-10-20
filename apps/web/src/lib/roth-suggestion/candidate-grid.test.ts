import { describe, expect, it } from 'vitest';
import { BRACKET_RATES, REFERENCE_CANDIDATE_ID, buildCandidateGrid } from './candidate-grid';

describe('buildCandidateGrid', () => {
  const grid = buildCandidateGrid();

  it('puts the current plan first with no bracket and no guard flag', () => {
    expect(grid[0]).toEqual({
      id: REFERENCE_CANDIDATE_ID,
      isReference: true,
      bracketRate: null,
      guarded: null,
    });
  });

  it('adds a guarded then an unguarded candidate for each plausible bracket', () => {
    expect(BRACKET_RATES).toEqual([0.12, 0.22, 0.24, 0.32]);
    expect(grid.slice(1).map((c) => [c.bracketRate, c.guarded])).toEqual([
      [0.12, true],
      [0.12, false],
      [0.22, true],
      [0.22, false],
      [0.24, true],
      [0.24, false],
      [0.32, true],
      [0.32, false],
    ]);
  });

  it('gives every candidate a distinct readable id', () => {
    expect(new Set(grid.map((c) => c.id)).size).toBe(9);
    expect(grid[1].id).toBe('bracket-12-guarded');
    expect(grid[8].id).toBe('bracket-32-unguarded');
  });
});
