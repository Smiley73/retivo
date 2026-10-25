// resolveOpenResetWindow, the pure decision whether a factor enrolled now falls inside an open password-reset window: the window-boundary arithmetic in isolation
// (enrollment-gate.spec.ts covers marking, enforcing and lifting end to end).
import { resolveOpenResetWindow } from './factor-restriction.js';
import { RESET_TTL_SEC } from './password-reset.service.js';

type ResetWindowUser = Parameters<typeof resolveOpenResetWindow>[0];

const FACTOR_RESTRICTION_WINDOW_SEC = 24 * 60 * 60;
const REQUESTED_AT = '2026-01-01T00:00:00.000Z';
const REQUESTED_MS = Date.parse(REQUESTED_AT);

function user(overrides: Partial<ResetWindowUser> = {}): ResetWindowUser {
  return {
    currentResetToken: undefined,
    passwordResetRequestOpenedAt: REQUESTED_AT,
    lastPasswordResetCompletedAt: undefined,
    lastPasswordResetCompletedRequestedAt: undefined,
    ...overrides,
  };
}

describe('resolveOpenResetWindow', () => {
  it('returns null when no reset has ever been requested', () => {
    expect(resolveOpenResetWindow(user({ passwordResetRequestOpenedAt: undefined }), REQUESTED_MS)).toBeNull();
  });

  it('is open while a request is pending, within RESET_TTL_SEC', () => {
    const nowMs = REQUESTED_MS + (RESET_TTL_SEC * 1000 - 1);
    const result = resolveOpenResetWindow(
      user({ currentResetToken: 'hash-of-token' }),
      nowMs,
    );
    expect(result).toEqual({ requestedAt: REQUESTED_AT });
  });

  it('closes a pending, never-consumed request after RESET_TTL_SEC — a stale currentResetToken cannot restrict forever', () => {
    const nowMs = REQUESTED_MS + RESET_TTL_SEC * 1000 + 1;
    const result = resolveOpenResetWindow(
      user({ currentResetToken: 'hash-of-token' }),
      nowMs,
    );
    expect(result).toBeNull();
  });

  it('is open after completion, within FACTOR_RESTRICTION_WINDOW_SEC', () => {
    const completedAt = new Date(REQUESTED_MS + 60_000).toISOString();
    const nowMs = Date.parse(completedAt) + FACTOR_RESTRICTION_WINDOW_SEC * 1000 - 1;
    const result = resolveOpenResetWindow(
      user({
        currentResetToken: undefined,
        lastPasswordResetCompletedAt: completedAt,
        lastPasswordResetCompletedRequestedAt: REQUESTED_AT,
      }),
      nowMs,
    );
    expect(result).toEqual({ requestedAt: REQUESTED_AT });
  });

  it('closes FACTOR_RESTRICTION_WINDOW_SEC after completion', () => {
    const completedAt = new Date(REQUESTED_MS + 60_000).toISOString();
    const nowMs = Date.parse(completedAt) + FACTOR_RESTRICTION_WINDOW_SEC * 1000 + 1;
    const result = resolveOpenResetWindow(
      user({
        currentResetToken: undefined,
        lastPasswordResetCompletedAt: completedAt,
        lastPasswordResetCompletedRequestedAt: REQUESTED_AT,
      }),
      nowMs,
    );
    expect(result).toBeNull();
  });

  it('falls back to lastPasswordResetCompletedAt for requestedAt when lastPasswordResetCompletedRequestedAt is absent (pre-migration row)', () => {
    const completedAt = new Date(REQUESTED_MS + 60_000).toISOString();
    const nowMs = Date.parse(completedAt) + 1_000;
    const result = resolveOpenResetWindow(
      user({
        currentResetToken: undefined,
        passwordResetRequestOpenedAt: undefined,
        lastPasswordResetCompletedAt: completedAt,
        lastPasswordResetCompletedRequestedAt: undefined,
      }),
      nowMs,
    );
    expect(result).toEqual({ requestedAt: completedAt });
  });

  it('a later, never-consumed reset request cannot cancel a still-open post-completion window', () => {
    // Reset A: requested T0, completed T0+2m. Reset B: requested T0+10m, never consumed: it overwrites passwordResetRequestOpenedAt and sets currentResetToken,
    // but the lastPasswordResetCompleted* pair, set at A's consume, is untouched by a mere request.
    const completedAtA = new Date(REQUESTED_MS + 2 * 60_000).toISOString();
    const requestedAtB = new Date(REQUESTED_MS + 10 * 60_000).toISOString();
    // Past B's own RESET_TTL_SEC the pending branch is closed on its own; the completed branch must still carry the window.
    const nowMs = Date.parse(requestedAtB) + RESET_TTL_SEC * 1000 + 60_000;
    const result = resolveOpenResetWindow(
      user({
        currentResetToken: 'hash-of-token-b',
        passwordResetRequestOpenedAt: requestedAtB,
        lastPasswordResetCompletedAt: completedAtA,
        lastPasswordResetCompletedRequestedAt: REQUESTED_AT,
      }),
      nowMs,
    );
    expect(result).toEqual({ requestedAt: REQUESTED_AT });
  });

  it('returns the earlier requestedAt when the pending and completed branches are both open at once', () => {
    const completedAtA = new Date(REQUESTED_MS + 2 * 60_000).toISOString();
    const requestedAtB = new Date(REQUESTED_MS + 10 * 60_000).toISOString();
    // Within B's RESET_TTL_SEC both branches are open; the older instant (A's own request) must win.
    const nowMs = Date.parse(requestedAtB) + 60_000;
    const result = resolveOpenResetWindow(
      user({
        currentResetToken: 'hash-of-token-b',
        passwordResetRequestOpenedAt: requestedAtB,
        lastPasswordResetCompletedAt: completedAtA,
        lastPasswordResetCompletedRequestedAt: REQUESTED_AT,
      }),
      nowMs,
    );
    expect(result).toEqual({ requestedAt: REQUESTED_AT });
  });

  it('is closed once neither a pending request nor a recent completion is present', () => {
    const result = resolveOpenResetWindow(
      user({ currentResetToken: undefined, lastPasswordResetCompletedAt: undefined }),
      REQUESTED_MS + 1_000,
    );
    expect(result).toBeNull();
  });
});
