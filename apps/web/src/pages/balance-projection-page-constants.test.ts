/**
 * Unit tests for the Balance Projection page's basis-label resolver — the
 * function that decides which basis name a Monte-Carlo-aware chart title
 * suffixes. A title must name the basis actually driving its data: the MC
 * tier when an MC basis is selected, else the deterministic method.
 */
import { describe, expect, it } from 'vitest';
import {
  MC_BASIS_LABELS,
  METHOD_LABELS,
  VIEW_ORDER,
  parseBalanceProjectionView,
  resolvedBasisLabel,
} from './balance-projection-page-constants';

describe('resolvedBasisLabel', () => {
  it('returns the deterministic method label when no MC basis is active', () => {
    expect(resolvedBasisLabel(null, 'planned')).toBe('Planned');
    expect(resolvedBasisLabel(null, 'twr')).toBe('Historical');
  });

  it('returns the MC tier label when an MC basis is active, regardless of the held method', () => {
    expect(resolvedBasisLabel('mc-typical', 'planned')).toBe('Typical');
    expect(resolvedBasisLabel('mc-pessimistic', 'twr')).toBe('Pessimistic');
    expect(resolvedBasisLabel('mc-bad-luck', 'planned')).toBe('Bad-luck');
  });

  it('matches the canonical label maps so titles, the selector, and the legend agree', () => {
    expect(resolvedBasisLabel('mc-typical', 'planned')).toBe(
      MC_BASIS_LABELS['mc-typical'],
    );
    expect(resolvedBasisLabel(null, 'twr')).toBe(METHOD_LABELS.twr);
  });
});

describe('parseBalanceProjectionView', () => {
  it('defaults an absent param to Overview', () => {
    expect(parseBalanceProjectionView(null)).toBe('overview');
  });

  it('defaults an unrecognised param to Overview', () => {
    expect(parseBalanceProjectionView('bogus')).toBe('overview');
    expect(parseBalanceProjectionView('')).toBe('overview');
  });

  it('accepts every id in VIEW_ORDER verbatim', () => {
    for (const id of VIEW_ORDER) {
      expect(parseBalanceProjectionView(id)).toBe(id);
    }
  });

  it('places the safe-withdrawal-rate tab last (tab row AND print order)', () => {
    expect(VIEW_ORDER[VIEW_ORDER.length - 1]).toBe('swr');
  });
});
