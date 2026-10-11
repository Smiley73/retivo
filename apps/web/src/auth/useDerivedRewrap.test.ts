/**
 * Tests for useDerivedRewrap — the derived post-reset password-slot re-wrap.
 *
 * Assertions that differ from the retired one-shot-marker hook:
 *  - the sign-in plaintext survives a FAILED unlock attempt inside the window
 *    (this hook is never wired to an unlock attempt at all — only to a
 *    SUCCESS, via `runDerive` — so there is nothing here to invert; the
 *    "clears the retained password on unlock failure" test has no analogue);
 *  - a rewrap failure is no longer swallowed-and-forgotten: it stays owed
 *    (nothing written) and is recorded as a diagnostic, but the derive itself
 *    never throws;
 *  - "does NOT rewrap when no password was retained" inverts to: the person
 *    is prompted.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client';

const getKeyEnvelopes = vi.fn();
vi.mock('./key-envelope-client', () => ({
  getKeyEnvelopes: (...args: unknown[]) => getKeyEnvelopes(...args),
}));

import { useDerivedRewrap } from './useDerivedRewrap';
// The real class — the hook classifies
// a `rotatePasswordSlot` failure by `instanceof` against this
// export, so an equivalent-shaped fake would not exercise the same check.
import { RewrapCommittedPinDegradedError } from './useZeroKnowledgeKey';

const OWED_SLOT = { slotType: 'password', slotId: 'password', credentialRevision: 'rev-old' };
const NOT_OWED_SLOT = { slotType: 'password', slotId: 'password', credentialRevision: 'rev-current' };
const LEGACY_SLOT = { slotType: 'password', slotId: 'password' }; // no revision at all

function envelopes(slots: unknown[], currentCredentialRevision = 'rev-current') {
  return { slots, envelopeSetVersion: 1, envelopeSetTag: 'tag', currentCredentialRevision };
}

function makeDeps(overrides: Partial<{
  getHdk: () => CryptoKey | null;
  rotatePasswordSlot: (pw: string) => Promise<void>;
  verifyPassword: (pw: string, opts?: unknown) => Promise<void>;
}> = {}) {
  return {
    getHdk: vi.fn().mockReturnValue({} as CryptoKey),
    rotatePasswordSlot: vi.fn().mockResolvedValue(undefined),
    verifyPassword: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const upgradeRequired = () =>
  new ApiRequestError(409, { code: 'UPGRADE_REQUIRED', message: 'Reload the page to continue.' });
const invalidCredentials = () =>
  new ApiRequestError(401, { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' });
const backoff = () =>
  new ApiRequestError(429, { code: 'LOGIN_BACKOFF', message: 'Too many attempts.' });

describe('useDerivedRewrap', () => {
  afterEach(() => vi.clearAllMocks());

  it('locked session: runDerive no-ops (nothing to verify a tag against yet)', async () => {
    const deps = makeDeps({ getHdk: vi.fn().mockReturnValue(null) });
    getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
    const { result } = renderHook(() => useDerivedRewrap(deps));

    act(() => result.current.runDerive());
    await act(async () => Promise.resolve());

    expect(getKeyEnvelopes).not.toHaveBeenCalled();
    expect(result.current.prompt).toBeNull();
  });

  it('no password slot: owes nothing, never prompted, never rotates', async () => {
    const deps = makeDeps();
    getKeyEnvelopes.mockResolvedValue(envelopes([{ slotType: 'recovery', slotId: 'recovery' }]));
    const { result } = renderHook(() => useDerivedRewrap(deps));

    act(() => result.current.runDerive());
    await waitFor(() => expect(getKeyEnvelopes).toHaveBeenCalled());

    expect(deps.rotatePasswordSlot).not.toHaveBeenCalled();
    expect(result.current.prompt).toBeNull();
  });

  it('not owed (slot revision matches current): never prompted, never rotates', async () => {
    const deps = makeDeps();
    getKeyEnvelopes.mockResolvedValue(envelopes([NOT_OWED_SLOT]));
    const { result } = renderHook(() => useDerivedRewrap(deps));

    act(() => result.current.retainPassword('Some-password!'));
    act(() => result.current.runDerive());
    await waitFor(() => expect(getKeyEnvelopes).toHaveBeenCalled());

    expect(deps.rotatePasswordSlot).not.toHaveBeenCalled();
    expect(result.current.prompt).toBeNull();
  });

  it('owed, plaintext in hand: re-wraps silently under the retained plaintext, no prompt', async () => {
    const deps = makeDeps();
    const owedEnvelopes = envelopes([OWED_SLOT]);
    getKeyEnvelopes.mockResolvedValue(owedEnvelopes);
    const { result } = renderHook(() => useDerivedRewrap(deps));

    act(() => result.current.retainPassword('NewPassw0rd!'));
    act(() => result.current.runDerive());
    // The derive's own fetched envelope response is threaded straight into
    // the silent write rather than spending a second
    // rate-limited read on the same unlock.
    await waitFor(() =>
      expect(deps.rotatePasswordSlot).toHaveBeenCalledWith('NewPassw0rd!', owedEnvelopes),
    );

    expect(result.current.prompt).toBeNull();
  });

  it('a legacy slot (no recorded revision at all) reads owed', async () => {
    const deps = makeDeps();
    const legacyEnvelopes = envelopes([LEGACY_SLOT]);
    getKeyEnvelopes.mockResolvedValue(legacyEnvelopes);
    const { result } = renderHook(() => useDerivedRewrap(deps));

    act(() => result.current.retainPassword('NewPassw0rd!'));
    act(() => result.current.runDerive());
    await waitFor(() =>
      expect(deps.rotatePasswordSlot).toHaveBeenCalledWith('NewPassw0rd!', legacyEnvelopes),
    );
  });

  it('owed, no plaintext in hand: prompts instead of rotating', async () => {
    const deps = makeDeps();
    getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
    const { result } = renderHook(() => useDerivedRewrap(deps));

    act(() => result.current.runDerive());
    await waitFor(() => expect(result.current.prompt).not.toBeNull());

    expect(deps.rotatePasswordSlot).not.toHaveBeenCalled();
    expect(result.current.prompt?.attemptsRemaining).toBeGreaterThan(0);
  });

  it('stale write authority (409 UPGRADE_REQUIRED) with plaintext in hand: re-verifies and retries once, silently', async () => {
    const deps = makeDeps({
      rotatePasswordSlot: vi
        .fn()
        .mockRejectedValueOnce(upgradeRequired())
        .mockResolvedValueOnce(undefined),
    });
    getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
    const { result } = renderHook(() => useDerivedRewrap(deps));

    act(() => result.current.retainPassword('NewPassw0rd!'));
    act(() => result.current.runDerive());

    await waitFor(() => expect(deps.rotatePasswordSlot).toHaveBeenCalledTimes(2));
    expect(deps.verifyPassword).toHaveBeenCalledWith('NewPassw0rd!', { purpose: 'password_slot_rewrap' });
    expect(result.current.prompt).toBeNull();
  });

  it('a tag/rollback (non-credential) failure leaves the slot untouched and never prompts as wrong-password', async () => {
    class FakeTagError extends Error {}
    const deps = makeDeps({
      rotatePasswordSlot: vi.fn().mockRejectedValue(new FakeTagError('envelope-set tag verification failed')),
    });
    getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
    const { result } = renderHook(() => useDerivedRewrap(deps));

    act(() => result.current.retainPassword('NewPassw0rd!'));
    await act(async () => {
      result.current.runDerive();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Refused for a non-credential reason: no verify-password retry attempted,
    // and never surfaced as the prompt (which is the wrong-password UI).
    expect(deps.verifyPassword).not.toHaveBeenCalled();
    expect(result.current.prompt).toBeNull();
  });

  it('a committed-but-degraded write (fallback floor landed) on the silent path is never treated as a refusal', async () => {
    const deps = makeDeps({
      rotatePasswordSlot: vi
        .fn()
        .mockRejectedValue(new RewrapCommittedPinDegradedError(3, false, new Error('idb broken'))),
    });
    getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
    const { result } = renderHook(() => useDerivedRewrap(deps));

    act(() => result.current.retainPassword('NewPassw0rd!'));
    await act(async () => {
      result.current.runDerive();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The server-side write already committed — the workspace stays live
    // and nothing reads as a refusal.
    expect(result.current.prompt).toBeNull();
  });

  it('a committed-but-locked write (neither the pin nor the floor could be confirmed) on the silent path surfaces the lock instead of discarding it', async () => {
    const deps = makeDeps({
      rotatePasswordSlot: vi
        .fn()
        .mockRejectedValue(new RewrapCommittedPinDegradedError(3, true, new Error('idb broken'))),
    });
    getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
    const { result } = renderHook(() => useDerivedRewrap(deps));

    act(() => result.current.retainPassword('NewPassw0rd!'));
    await act(async () => {
      result.current.runDerive();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The silent path must not discard this outcome, which would leave the
    // person to hit an unexplained unlock prompt later. It must surface here.
    expect(result.current.prompt).not.toBeNull();
    expect(result.current.prompt?.error).toMatch(/locked again/i);
  });

  it('running the derive again after a rewrap already landed is a harmless no-op', async () => {
    const deps = makeDeps();
    getKeyEnvelopes
      .mockResolvedValueOnce(envelopes([OWED_SLOT]))
      .mockResolvedValueOnce(envelopes([NOT_OWED_SLOT]));
    const { result } = renderHook(() => useDerivedRewrap(deps));

    act(() => result.current.retainPassword('NewPassw0rd!'));
    act(() => result.current.runDerive());
    await waitFor(() => expect(deps.rotatePasswordSlot).toHaveBeenCalledTimes(1));

    act(() => result.current.runDerive());
    await waitFor(() => expect(getKeyEnvelopes).toHaveBeenCalledTimes(2));
    expect(deps.rotatePasswordSlot).toHaveBeenCalledTimes(1);
  });

  describe('prompt answer', () => {
    it('a correct answer verifies, re-fetches + re-compares, rewraps once, and closes the prompt', async () => {
      const deps = makeDeps();
      const owedEnvelopes = envelopes([OWED_SLOT]);
      getKeyEnvelopes.mockResolvedValue(owedEnvelopes);
      const { result } = renderHook(() => useDerivedRewrap(deps));

      act(() => result.current.runDerive());
      await waitFor(() => expect(result.current.prompt).not.toBeNull());

      await act(async () => {
        await result.current.answerPrompt('CorrectPassw0rd!');
      });

      expect(deps.verifyPassword).toHaveBeenCalledWith('CorrectPassw0rd!', {
        purpose: 'password_slot_rewrap',
      });
      // answerPrompt re-fetches + re-compares the
      // owed-ness after password verification (a stale prompt must not
      // blindly re-wrap a slot another device already settled), and threads
      // that fresh response through — no longer `undefined`.
      expect(getKeyEnvelopes).toHaveBeenCalledTimes(2); // runDerive's own + answerPrompt's re-check
      expect(deps.rotatePasswordSlot).toHaveBeenCalledWith('CorrectPassw0rd!', owedEnvelopes);
      expect(result.current.prompt).toBeNull();
    });

    it('a stale prompt whose slot was already re-wrapped by another device closes without writing', async () => {
      const deps = makeDeps();
      const owedEnvelopes = envelopes([OWED_SLOT]);
      const nowSettledEnvelopes = envelopes([NOT_OWED_SLOT]);
      getKeyEnvelopes.mockResolvedValueOnce(owedEnvelopes).mockResolvedValueOnce(nowSettledEnvelopes);
      const { result } = renderHook(() => useDerivedRewrap(deps));

      act(() => result.current.runDerive());
      await waitFor(() => expect(result.current.prompt).not.toBeNull());

      await act(async () => {
        await result.current.answerPrompt('CorrectPassw0rd!');
      });

      // The re-check (second getKeyEnvelopes call) found the revisions now
      // match — another device already completed the re-wrap. The prompt
      // closes WITHOUT ever calling rotatePasswordSlot.
      expect(getKeyEnvelopes).toHaveBeenCalledTimes(2);
      expect(deps.rotatePasswordSlot).not.toHaveBeenCalled();
      expect(result.current.prompt).toBeNull();
    });

    it('a wrong answer surfaces as wrong-password and decrements the attempt bound; exhausting it surfaces a final message instead of vanishing', async () => {
      const deps = makeDeps({ verifyPassword: vi.fn().mockRejectedValue(invalidCredentials()) });
      getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
      const { result } = renderHook(() => useDerivedRewrap(deps));

      act(() => result.current.runDerive());
      await waitFor(() => expect(result.current.prompt).not.toBeNull());
      const startingAttempts = result.current.prompt!.attemptsRemaining;

      await act(async () => {
        await result.current.answerPrompt('wrong');
      });
      expect(result.current.prompt).not.toBeNull();
      expect(result.current.prompt?.attemptsRemaining).toBe(startingAttempts - 1);
      expect(result.current.prompt?.error).toMatch(/incorrect/i);
      expect(deps.rotatePasswordSlot).not.toHaveBeenCalled();

      for (let i = 0; i < startingAttempts - 1; i++) {
        await act(async () => {
          await result.current.answerPrompt('wrong');
        });
      }
      // The bound ends the asking for THIS unlock — still owed — but the
      // person is told why rather than watching the dialog silently vanish
      // on the last guess.
      expect(result.current.prompt).not.toBeNull();
      expect(result.current.prompt?.attemptsRemaining).toBe(0);
      expect(result.current.prompt?.error).toMatch(/incorrect/i);
      expect(deps.rotatePasswordSlot).not.toHaveBeenCalled();

      // Dismissing the terminal message is how this unlock's asking ends.
      act(() => result.current.dismissPrompt());
      expect(result.current.prompt).toBeNull();
    });

    it('a 429 LOGIN_BACKOFF reads as a wait, not a failure, does not count against the attempt bound, and surfaces wait wording instead of vanishing', async () => {
      const deps = makeDeps({ verifyPassword: vi.fn().mockRejectedValue(backoff()) });
      getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
      const { result } = renderHook(() => useDerivedRewrap(deps));

      act(() => result.current.runDerive());
      await waitFor(() => expect(result.current.prompt).not.toBeNull());

      await act(async () => {
        await result.current.answerPrompt('anything');
      });

      // The backoff does not count against the attempt bound, and the person
      // is told to wait rather than watching the dialog vanish with no
      // explanation.
      expect(result.current.prompt).not.toBeNull();
      expect(result.current.prompt?.attemptsRemaining).toBe(0);
      expect(result.current.prompt?.error).toMatch(/too many attempts/i);
      expect(deps.rotatePasswordSlot).not.toHaveBeenCalled();

      act(() => result.current.dismissPrompt());
      expect(result.current.prompt).toBeNull();
    });

    it('dismissing the prompt writes nothing; a later runDerive re-derives and asks again', async () => {
      const deps = makeDeps();
      getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
      const { result } = renderHook(() => useDerivedRewrap(deps));

      act(() => result.current.runDerive());
      await waitFor(() => expect(result.current.prompt).not.toBeNull());

      act(() => result.current.dismissPrompt());
      expect(result.current.prompt).toBeNull();
      expect(deps.rotatePasswordSlot).not.toHaveBeenCalled();

      act(() => result.current.runDerive());
      await waitFor(() => expect(result.current.prompt).not.toBeNull());
    });

    it('a refused write after a correct answer leaves it owed and tells the person, rather than closing as if it had succeeded', async () => {
      const deps = makeDeps({ rotatePasswordSlot: vi.fn().mockRejectedValue(upgradeRequired()) });
      getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
      const { result } = renderHook(() => useDerivedRewrap(deps));

      act(() => result.current.runDerive());
      await waitFor(() => expect(result.current.prompt).not.toBeNull());

      await act(async () => {
        await result.current.answerPrompt('CorrectPassw0rd!');
      });

      // One attempt only — the retry-with-verify loop is the SILENT path's
      // job, not the prompt-answer path's ("one attempt per unlock").
      expect(deps.rotatePasswordSlot).toHaveBeenCalledTimes(1);
      // The write failed after a CORRECT password — this must never read as
      // success: the prompt stays up with a message
      // distinguishing a transient refusal (expected to resolve on its own)
      // from a permanent integrity one, rather than closing silently.
      expect(result.current.prompt).not.toBeNull();
      expect(result.current.prompt?.error).toMatch(/couldn.t finish updating/i);
    });

    it('a permanent tag/rollback (integrity) refusal after a correct answer is worded distinctly from a transient one', async () => {
      const { KeyWrappingError } = await import('../crypto/key-wrapping');
      const deps = makeDeps({
        rotatePasswordSlot: vi.fn().mockRejectedValue(new KeyWrappingError('envelope-set tag verification failed')),
      });
      getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
      const { result } = renderHook(() => useDerivedRewrap(deps));

      act(() => result.current.runDerive());
      await waitFor(() => expect(result.current.prompt).not.toBeNull());

      await act(async () => {
        await result.current.answerPrompt('CorrectPassw0rd!');
      });

      expect(result.current.prompt).not.toBeNull();
      expect(result.current.prompt?.error).toMatch(/could not be verified/i);
    });

    it('a committed-but-degraded write (fallback floor landed) after a correct answer closes the prompt, not a refusal', async () => {
      const deps = makeDeps({
        rotatePasswordSlot: vi
          .fn()
          .mockRejectedValue(new RewrapCommittedPinDegradedError(3, false, new Error('idb broken'))),
      });
      getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
      const { result } = renderHook(() => useDerivedRewrap(deps));

      act(() => result.current.runDerive());
      await waitFor(() => expect(result.current.prompt).not.toBeNull());

      await act(async () => {
        await result.current.answerPrompt('CorrectPassw0rd!');
      });

      expect(result.current.prompt).toBeNull();
    });

    it('a committed-but-locked write (neither the pin nor the floor could be confirmed) after a correct answer says the device was locked, not that the password was refused', async () => {
      const deps = makeDeps({
        rotatePasswordSlot: vi
          .fn()
          .mockRejectedValue(new RewrapCommittedPinDegradedError(3, true, new Error('idb broken'))),
      });
      getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
      const { result } = renderHook(() => useDerivedRewrap(deps));

      act(() => result.current.runDerive());
      await waitFor(() => expect(result.current.prompt).not.toBeNull());

      await act(async () => {
        await result.current.answerPrompt('CorrectPassw0rd!');
      });

      expect(result.current.prompt).not.toBeNull();
      expect(result.current.prompt?.error).toMatch(/locked again/i);
      expect(result.current.prompt?.error).not.toMatch(/refused|incorrect/i);
    });
  });

  describe('plaintext lifetime', () => {
    it('clears the retained password on an explicit session-drop clear', async () => {
      const deps = makeDeps();
      getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
      const { result } = renderHook(() => useDerivedRewrap(deps));

      act(() => result.current.retainPassword('NewPassw0rd!'));
      act(() => result.current.clearRetainedPassword());
      act(() => result.current.runDerive());

      await waitFor(() => expect(result.current.prompt).not.toBeNull());
      expect(deps.rotatePasswordSlot).not.toHaveBeenCalled();
    });

    it('clears the retained password on unmount (navigation away)', async () => {
      const deps = makeDeps();
      getKeyEnvelopes.mockResolvedValue(envelopes([OWED_SLOT]));
      const first = renderHook(() => useDerivedRewrap(deps));
      act(() => first.result.current.retainPassword('NewPassw0rd!'));
      first.unmount();

      const second = renderHook(() => useDerivedRewrap(deps));
      act(() => second.result.current.runDerive());
      await waitFor(() => expect(second.result.current.prompt).not.toBeNull());
      expect(deps.rotatePasswordSlot).not.toHaveBeenCalled();
      second.unmount();
    });
  });
});
