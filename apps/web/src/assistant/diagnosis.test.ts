import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_CODES, type HandshakeErrorCode } from '@retirement/assistant-protocol';
import { browserFamily, diagnose, readLocalNetworkPermission, type PermissionAnswer } from './diagnosis';
import type { CloseInfo, SessionPhase } from './session-types';

describe('diagnose', () => {
  const remote = (code: number): CloseInfo => ({ kind: 'remote', code });
  const local = (error: HandshakeErrorCode): CloseInfo => ({ kind: 'local', error });

  it.each<[SessionPhase, CloseInfo | null, PermissionAnswer, string]>([
    // Nothing went wrong, or the tab ended it on purpose.
    ['idle', null, 'unknown', 'none'],
    ['ready', { kind: 'tab', reason: 'disconnect' }, 'denied', 'none'],
    // The socket never opened: Chromium denies and an absent bridge look the same unless the permission answers.
    ['connecting', remote(1006), 'unknown', 'unreachable'],
    ['connecting', remote(1006), 'prompt', 'unreachable'],
    ['connecting', remote(1006), 'denied', 'blocked'],
    ['connecting', remote(1006), 'granted', 'not-running'],
    ['connecting', { kind: 'failed-to-open' }, 'denied', 'blocked'],
    ['connecting', { kind: 'failed-to-open' }, 'unknown', 'unreachable'],
    ['connecting', { kind: 'deadline' }, 'granted', 'not-running'],
    // The socket opened, the permission no longer matters.
    ['awaiting-hello', { kind: 'deadline' }, 'denied', 'not-the-bridge'],
    ['awaiting-hello', remote(1006), 'granted', 'not-the-bridge'],
    ['awaiting-hello', local('PROTOCOL_ERROR'), 'unknown', 'not-the-bridge'],
    ['awaiting-paired', { kind: 'deadline' }, 'unknown', 'not-the-bridge'],
    ['awaiting-hello', local('PROTOCOL_VERSION_MISMATCH'), 'unknown', 'version-mismatch'],
    ['awaiting-paired', local('PAIRING_FAILED'), 'unknown', 'bridge-unverified'],
    ['awaiting-paired', local('PROTOCOL_ERROR'), 'unknown', 'protocol-error'],
    ['ready', local('FRAME_TOO_LARGE'), 'unknown', 'frame-too-large'],
    // What the bridge says with its own close codes.
    ['awaiting-hello', remote(CLOSE_CODES.PROTOCOL_VERSION_MISMATCH), 'unknown', 'version-mismatch'],
    ['awaiting-hello', remote(CLOSE_CODES.ALREADY_CONNECTED), 'unknown', 'already-connected'],
    ['awaiting-paired', remote(CLOSE_CODES.PAIRING_FAILED), 'unknown', 'wrong-code'],
    ['awaiting-paired', remote(CLOSE_CODES.PAIRING_ATTEMPTS_EXCEEDED), 'unknown', 'attempts-exceeded'],
    ['awaiting-paired', remote(CLOSE_CODES.PAIRING_EXPIRED), 'unknown', 'code-expired'],
    ['ready', remote(CLOSE_CODES.PROTOCOL_ERROR), 'unknown', 'protocol-error'],
    ['ready', remote(CLOSE_CODES.FRAME_TOO_LARGE), 'unknown', 'frame-too-large'],
    ['ready', remote(1009), 'unknown', 'frame-too-large'],
    // A paired connection that drops.
    ['ready', remote(1006), 'unknown', 'connection-lost'],
    ['ready', remote(1000), 'unknown', 'connection-lost'],
    ['awaiting-consent', remote(1006), 'unknown', 'connection-lost'],
  ])('%s + %j + permission %s -> %s', (phase, close, permission, kind) => {
    expect(diagnose(phase, close, permission).kind).toBe(kind);
  });
});

describe('readLocalNetworkPermission', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubPermissions(query: (descriptor: { name: string }) => Promise<{ state: string }>): void {
    vi.stubGlobal('navigator', { ...navigator, permissions: { query } });
  }

  it('is unknown when the browser has no permissions API', async () => {
    vi.stubGlobal('navigator', { userAgent: 'x' });
    expect(await readLocalNetworkPermission()).toBe('unknown');
  });

  it('is unknown when every permission name throws', async () => {
    const query = vi.fn().mockRejectedValue(new TypeError('not a valid value for enumeration PermissionName'));
    stubPermissions(query);
    expect(await readLocalNetworkPermission()).toBe('unknown');
    expect(query.mock.calls.length).toBeGreaterThan(1);
  });

  it('falls through an unknown name to one the browser answers', async () => {
    stubPermissions(async ({ name }) => {
      if (name === 'loopback-network') throw new TypeError('unknown');
      return { state: 'denied' };
    });
    expect(await readLocalNetworkPermission()).toBe('denied');
  });

  it.each(['granted', 'denied', 'prompt'] as const)('passes %s through', async (state) => {
    stubPermissions(async () => ({ state }));
    expect(await readLocalNetworkPermission()).toBe(state);
  });
});

describe('browserFamily', () => {
  const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0';
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1';

  it.each([
    [CHROME, false, 'chromium'],
    [CHROME, true, 'brave'],
    [FIREFOX, false, 'firefox'],
    [SAFARI, false, 'unsupported'],
    [IPHONE_CHROME, false, 'unsupported'],
    ['curl/8', false, 'other'],
  ])('%s (brave %s) -> %s', (userAgent, brave, family) => {
    expect(browserFamily(userAgent, brave)).toBe(family);
  });
});
