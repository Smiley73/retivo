/**
 * Why a connection ended, as far as a browser can tell. Pure: the card maps the
 * members to text.
 *
 * Chromium denies a loopback WebSocket before any byte reaches the server (an
 * `error`, then close 1006), and an absent bridge produces the same events, so
 * "not running" and "blocked" are one diagnosis with two remedies unless the
 * local-network permission answers. What the tab can tell apart is everything
 * after the socket opens: no valid `hello` in time, a wrong version, a program
 * that cannot prove itself, `ALREADY_CONNECTED` and the `PAIRING_*` codes.
 */
import { handshakeErrorForCloseCode, type HandshakeErrorCode } from '@retirement/assistant-protocol';
import type { CloseInfo, SessionPhase } from './session-types';

/** What `navigator.permissions` said about local-network access. */
export type PermissionAnswer = 'granted' | 'denied' | 'prompt' | 'unknown';

export type Diagnosis =
  | { kind: 'none' }
  /** The socket never opened and the permission state is unknown: not running, or blocked. */
  | { kind: 'unreachable' }
  | { kind: 'not-running' }
  | { kind: 'blocked' }
  /** The socket opened but what answered is not the Retivo bridge. */
  | { kind: 'not-the-bridge' }
  | { kind: 'version-mismatch' }
  /** The program on the port could not prove it knows the code. */
  | { kind: 'bridge-unverified' }
  | { kind: 'already-connected' }
  | { kind: 'wrong-code' }
  | { kind: 'attempts-exceeded' }
  | { kind: 'code-expired' }
  | { kind: 'frame-too-large' }
  | { kind: 'protocol-error' }
  /** A paired connection dropped. */
  | { kind: 'connection-lost' };

const BY_HANDSHAKE_ERROR: Record<HandshakeErrorCode, Diagnosis> = {
  PROTOCOL_VERSION_MISMATCH: { kind: 'version-mismatch' },
  PAIRING_FAILED: { kind: 'wrong-code' },
  PAIRING_ATTEMPTS_EXCEEDED: { kind: 'attempts-exceeded' },
  PAIRING_EXPIRED: { kind: 'code-expired' },
  ALREADY_CONNECTED: { kind: 'already-connected' },
  FRAME_TOO_LARGE: { kind: 'frame-too-large' },
  PROTOCOL_ERROR: { kind: 'protocol-error' },
};

function beforeOpen(permission: PermissionAnswer): Diagnosis {
  if (permission === 'denied') return { kind: 'blocked' };
  if (permission === 'granted') return { kind: 'not-running' };
  return { kind: 'unreachable' };
}

function remoteClose(phase: SessionPhase, code: number, permission: PermissionAnswer): Diagnosis {
  const error = handshakeErrorForCloseCode(code);
  if (error !== undefined) return BY_HANDSHAKE_ERROR[error];
  if (phase === 'connecting') return beforeOpen(permission);
  if (phase === 'awaiting-hello') return { kind: 'not-the-bridge' };
  return { kind: 'connection-lost' };
}

function localClose(phase: SessionPhase, error: HandshakeErrorCode): Diagnosis {
  // A frame that does not decode before the first valid `hello` came from something other than the bridge.
  if (error === 'PROTOCOL_ERROR' && phase === 'awaiting-hello') return { kind: 'not-the-bridge' };
  // The tab closes with PAIRING_FAILED only when the bridge's proof did not verify.
  if (error === 'PAIRING_FAILED') return { kind: 'bridge-unverified' };
  return BY_HANDSHAKE_ERROR[error];
}

export function diagnose(phase: SessionPhase, close: CloseInfo | null, permission: PermissionAnswer): Diagnosis {
  if (close === null || close.kind === 'tab') return { kind: 'none' };
  switch (close.kind) {
    case 'remote':
      return remoteClose(phase, close.code, permission);
    case 'local':
      return localClose(phase, close.error);
    case 'deadline':
      return phase === 'connecting' ? beforeOpen(permission) : { kind: 'not-the-bridge' };
    case 'failed-to-open':
      return beforeOpen(permission);
  }
}

// Chrome has renamed the local-network permission; ask for each name it has used.
const PERMISSION_NAMES = ['loopback-network', 'local-network-access'];

/** Asks the browser about local-network access; an unknown permission name throws, which means "unknown". */
export async function readLocalNetworkPermission(): Promise<PermissionAnswer> {
  if (typeof navigator === 'undefined' || navigator.permissions === undefined) return 'unknown';
  for (const name of PERMISSION_NAMES) {
    try {
      // The name is not in lib.dom's PermissionName union, and an unknown name throws.
      const status = await navigator.permissions.query({ name: name as PermissionName });
      if (status.state === 'granted' || status.state === 'denied' || status.state === 'prompt') return status.state;
    } catch {
      // Not a permission this browser knows: try the next name.
    }
  }
  return 'unknown';
}

export type BrowserFamily = 'unsupported' | 'brave' | 'firefox' | 'chromium' | 'other';

/** Which remedy to show. Safari and every iOS browser are unsupported (O4); Brave hides itself from the UA. */
export function browserFamily(userAgent: string, isBrave: boolean): BrowserFamily {
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && /Mobile\//.test(userAgent));
  if (ios) return 'unsupported';
  if (isBrave) return 'brave';
  if (/Firefox\//.test(userAgent)) return 'firefox';
  if (/Chrome\/|Chromium\/|Edg\//.test(userAgent)) return 'chromium';
  if (/Safari\//.test(userAgent)) return 'unsupported';
  return 'other';
}
