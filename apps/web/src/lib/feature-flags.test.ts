import { describe, expect, it, vi } from 'vitest';
import {
  BETA_FEATURES,
  betaFeature,
  hiddenBetaPdfSectionIds,
  parseBetaFeatureConfig,
} from './feature-flags';

function reviewByCheckSkipped(env: Record<string, string | undefined>): boolean {
  return env.SKIP_REVIEW_BY_DATE_CHECK === '1';
}

function expectNoFlagPastReviewBy(flags: readonly { id: string; reviewBy: string }[], today: string): void {
  for (const f of flags) {
    expect(f.reviewBy >= today, `${f.id} reviewBy ${f.reviewBy} has passed`).toBe(true);
  }
}

describe('parseBetaFeatureConfig', () => {
  const allIds = BETA_FEATURES.map((f) => f.id);

  it.each([undefined, '', '   ', 'all', 'ALL'])(
    'offers every registered feature for %j',
    (raw) => {
      expect([...parseBetaFeatureConfig(raw)].sort()).toEqual([...allIds].sort());
    },
  );

  it('offers nothing for "none"', () => {
    expect(parseBetaFeatureConfig('none').size).toBe(0);
    expect(parseBetaFeatureConfig(' None ').size).toBe(0);
  });

  it('offers exactly the listed ids (whitespace + case tolerant)', () => {
    const offered = parseBetaFeatureConfig(' Guardrails , ,projected-withdrawals ');
    expect([...offered].sort()).toEqual(['guardrails', 'projected-withdrawals']);
  });

  it('reports unknown ids and ignores them', () => {
    const onUnknown = vi.fn();
    const offered = parseBetaFeatureConfig('guardrails,typo-feature', onUnknown);
    expect([...offered]).toEqual(['guardrails']);
    expect(onUnknown).toHaveBeenCalledWith('typo-feature');
  });
});

describe('hiddenBetaPdfSectionIds', () => {
  it('returns no sections when every beta feature is visible', () => {
    expect(hiddenBetaPdfSectionIds(() => true).size).toBe(0);
  });

  it('returns the projected-withdrawals table when that feature is hidden', () => {
    const hidden = hiddenBetaPdfSectionIds((id) => id !== 'projected-withdrawals');
    expect([...hidden]).toEqual(['table-withdrawal-guidance']);
  });
});

describe('BETA_FEATURES registry', () => {
  it('has unique ids, an owner, and ISO since / reviewBy dates on every entry', () => {
    const ids = BETA_FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of BETA_FEATURES) {
      expect(f.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(f.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(f.reviewBy >= f.since).toBe(true);
      expect(f.owner.length).toBeGreaterThan(0);
      expect(f.label.length).toBeGreaterThan(0);
    }
  });

  // Pull-request CI sets SKIP_REVIEW_BY_DATE_CHECK=1 so a flag's date passing
  // cannot red unrelated PRs; `main`, dispatch and local runs leave it unset.
  it.skipIf(reviewByCheckSkipped(process.env))(
    'has no flag past its reviewBy date (promote or retire it, then update the entry)',
    () => {
      expectNoFlagPastReviewBy(BETA_FEATURES, new Date().toISOString().slice(0, 10));
    },
  );

  it('keeps the reviewBy check live unless the PR-only skip variable is set', () => {
    expect(reviewByCheckSkipped({})).toBe(false);
    expect(reviewByCheckSkipped({ SKIP_REVIEW_BY_DATE_CHECK: '' })).toBe(false);
    expect(reviewByCheckSkipped({ SKIP_REVIEW_BY_DATE_CHECK: '1' })).toBe(true);
    // With the variable unset the assertion still bites: a past date fails it.
    const stale = [{ ...BETA_FEATURES[0], reviewBy: '2000-01-01' }];
    expect(() => expectNoFlagPastReviewBy(stale, '2026-10-08')).toThrow();
    expect(() => expectNoFlagPastReviewBy(stale, '1999-12-31')).not.toThrow();
  });

  it('betaFeature() looks an entry up by id', () => {
    expect(betaFeature('guardrails').label).toBe('Guardrails today');
  });
});
