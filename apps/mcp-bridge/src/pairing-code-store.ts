/**
 * The bridge's one pairing code. It is minted lazily by the first tool call made
 * before pairing and handed out again to later calls while it is valid, so two
 * calls in a row cannot invalidate the code the person is typing. The attempt
 * counter lives here, not on a connection: a scanner that reconnects after every
 * guess gets no fresh count. The code dies on expiry, on exhausted attempts and
 * when pairing consumes it.
 */
import { randomInt } from 'node:crypto';
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
} from '@retirement/assistant-protocol';

export interface ActiveCode {
  /** Canonical 10-character code, the form `computeTabProof` takes. */
  code: string;
  expiresAtMs: number;
}

export interface PairingCodeStoreOptions {
  now?: () => number;
  /** Uniform integer in `[0, max)`; `crypto.randomInt` by default (rejection sampling, no modulo bias). */
  randomIndex?: (max: number) => number;
}

export class PairingCodeStore {
  private readonly now: () => number;
  private readonly randomIndex: (max: number) => number;
  private current: (ActiveCode & { failures: number }) | null = null;

  constructor(options: PairingCodeStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomIndex = options.randomIndex ?? ((max) => randomInt(max));
  }

  /** The valid code, or `null` when none was minted or the last one expired, ran out of attempts or was consumed. */
  peek(): ActiveCode | null {
    if (this.current === null) return null;
    if (this.now() >= this.current.expiresAtMs) {
      this.current = null;
      return null;
    }
    return { code: this.current.code, expiresAtMs: this.current.expiresAtMs };
  }

  /** The valid code, minting a fresh one only when there is none. */
  activeOrMint(): ActiveCode {
    const existing = this.peek();
    if (existing !== null) return existing;
    let code = '';
    for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
      code += PAIRING_CODE_ALPHABET[this.randomIndex(PAIRING_CODE_ALPHABET.length)];
    }
    this.current = { code, expiresAtMs: this.now() + PAIRING_CODE_TTL_MS, failures: 0 };
    return { code, expiresAtMs: this.current.expiresAtMs };
  }

  /** Counts a wrong proof against `code`; `exhausted` once the code is dead. A different code is left alone. */
  recordFailure(code: string): 'retry' | 'exhausted' {
    if (this.current === null || this.current.code !== code) return 'exhausted';
    this.current.failures += 1;
    if (this.current.failures < PAIRING_MAX_ATTEMPTS) return 'retry';
    this.current = null;
    return 'exhausted';
  }

  /** Pairing succeeded: the code is single use. */
  consume(code: string): void {
    if (this.current?.code === code) this.current = null;
  }
}
