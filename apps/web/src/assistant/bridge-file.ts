/**
 * The bridge file this copy of Retivo serves. A stack that carries the assistant bridge port serves
 * the built bridge from its own origin next to a small `bridge.json` naming the file's version,
 * SHA-256 and size (written by `scripts/stage-bridge-bundle.mjs` at deploy time). The Settings card
 * reads that manifest to show the checksum a person verifies their download against.
 *
 * A copy that serves no bridge file (local `pnpm dev`, an older deployment) answers the same path
 * with the app shell or a 404: that is "unavailable", never an error. The manifest is data from the
 * network, so it is validated field by field and its checksum is shape-checked before it can reach
 * a pasted shell command (`bridgeInstallCommand` checks it again).
 */
import { useEffect, useState } from 'react';
import { BRIDGE_MANIFEST_FILE } from '@retirement/assistant-protocol';

export interface BridgeFileInfo {
  version: string;
  sha256: string;
  size: number;
}

export type BridgeFileState = { status: 'loading' } | { status: 'unavailable' } | { status: 'ready'; info: BridgeFileInfo };

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,32})?$/;
const MAX_BRIDGE_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

/** The manifest the copy serves, or null when it serves none or one that does not validate. Never throws. */
export async function fetchBridgeFileInfo(signal?: AbortSignal): Promise<BridgeFileInfo | null> {
  try {
    const response = await fetch(`/${BRIDGE_MANIFEST_FILE}`, {
      cache: 'no-store',
      credentials: 'omit',
      signal: signal === undefined ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const { version, sha256, size } = body as Record<string, unknown>;
    if (typeof version !== 'string' || !VERSION.test(version)) return null;
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_BRIDGE_BYTES) return null;
    return { version, sha256, size };
  } catch {
    // A network failure, a timeout, or HTML where JSON was expected (the SPA fallback).
    return null;
  }
}

/** Fetches the manifest once per mount while `enabled`. */
export function useBridgeFile(enabled: boolean): BridgeFileState {
  const [state, setState] = useState<BridgeFileState>({ status: 'loading' });
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    void fetchBridgeFileInfo(controller.signal).then((info) => {
      if (!controller.signal.aborted) setState(info === null ? { status: 'unavailable' } : { status: 'ready', info });
    });
    return () => controller.abort();
  }, [enabled]);
  return state;
}
