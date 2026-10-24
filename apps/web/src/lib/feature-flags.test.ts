import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BETA_FEATURES,
  betaFeature,
  hiddenBetaPdfSectionIds,
} from './feature-flags';

function reviewByCheckSkipped(env: Record<string, string | undefined>): boolean {
  return env.SKIP_REVIEW_BY_DATE_CHECK === '1';
}

function expectNoFlagPastReviewBy(flags: readonly { id: string; reviewBy: string }[], today: string): void {
  for (const f of flags) {
    expect(f.reviewBy >= today, `${f.id} reviewBy ${f.reviewBy} has passed`).toBe(true);
  }
}

// `OFFERED_BETA_FEATURE_IDS` is resolved from `VITE_BETA_FEATURES` once at load, so each case imports a fresh copy.
async function offeredFor(raw: string | undefined) {
  vi.resetModules();
  vi.stubEnv('VITE_BETA_FEATURES', raw);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { OFFERED_BETA_FEATURE_IDS } = await import('./feature-flags');
  return { offered: [...OFFERED_BETA_FEATURE_IDS].sort(), warn };
}

describe('VITE_BETA_FEATURES', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const allIds = BETA_FEATURES.map((f) => f.id).sort();

  it.each([undefined, '', '   ', 'all', 'ALL'])(
    'offers every registered feature for %j',
    async (raw) => {
      expect((await offeredFor(raw)).offered).toEqual(allIds);
    },
  );

  it.each(['none', ' None '])('offers nothing for %j', async (raw) => {
    expect((await offeredFor(raw)).offered).toEqual([]);
  });

  it('offers exactly the listed ids (whitespace + case tolerant)', async () => {
    const { offered } = await offeredFor(' Guardrails , ,projected-withdrawals ');
    expect(offered).toEqual(['guardrails', 'projected-withdrawals']);
  });

  it('warns about unknown ids and ignores them', async () => {
    const { offered, warn } = await offeredFor('guardrails,typo-feature');
    expect(offered).toEqual(['guardrails']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"typo-feature"'));
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

  // PR CI sets SKIP_REVIEW_BY_DATE_CHECK=1 so a passing review date cannot red unrelated PRs.
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
    const stale = [{ ...BETA_FEATURES[0], reviewBy: '2000-01-01' }];
    expect(() => expectNoFlagPastReviewBy(stale, '2026-10-08')).toThrow();
    expect(() => expectNoFlagPastReviewBy(stale, '1999-12-31')).not.toThrow();
  });

  it('betaFeature() looks an entry up by id', () => {
    expect(betaFeature('guardrails').label).toBe('Guardrails today');
  });
});
