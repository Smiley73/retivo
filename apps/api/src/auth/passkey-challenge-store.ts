/**
 * Shared, single-use store for WebAuthn challenges. Keyed by the caller's
 * choice of key (e.g. `reg:<userId>` for registration, `auth:<challenge>`
 * for the discoverable login) so a finish call can look up the challenge
 * issued at /start without a round-trip session id.
 *
 * Backed by the `PasskeyChallenge` DynamoDB table, so a challenge minted on
 * one API (Lambda) instance is consumable on another, and consumption is atomic across instances
 * (see `PasskeyChallengeRepository`). This class stays the seam every caller depends on — same
 * file, same class name, same DI registration — now an async facade over the repository.
 * Single-use, 5-minute TTL, enforced HERE against the stored `expiresAt` at read time: the table's
 * DynamoDB TTL is hygiene only (deletion lags up to ~48h, and DynamoDB Local never sweeps at all),
 * never the source of truth for whether a challenge is still live.
 *
 * The five key shapes that flow through this one store (`reg:<userId>`,
 * `stepup:<userId>:<purpose>:<challenge>`, `mfa:<userId>:<challenge>`,
 * `auth:<challenge>` — see `PasskeyController` / `PasskeyAssertionService`)
 * are the security binding itself: a challenge minted
 * under one key is never reachable under another. Do not redesign the key
 * shape here.
 */
import { Injectable } from '@nestjs/common';
import { PasskeyChallengeRepository } from '../dynamo/passkey-challenge.repository.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class PasskeyChallengeStore {
  constructor(private readonly repo: PasskeyChallengeRepository) {}

  /** Issue (create or replace) the challenge under `key`. Overwrites — a caller
   *  starting the same ceremony twice (a stable per-ceremony key) is expected. */
  async set(key: string, challenge: string, userId?: string): Promise<void> {
    await this.repo.issue({
      key,
      challenge,
      ...(userId !== undefined ? { userId } : {}),
      expiresAt: Math.floor((Date.now() + CHALLENGE_TTL_MS) / 1000),
    });
  }

  /**
   * Single-use atomic consume. Returns `null` when the key never existed,
   * was already consumed (this call or a concurrent one lost the race), or
   * its stored `expiresAt` has elapsed — the reader-side expiry check the
   * table's own TTL cannot be relied on to enforce.
   */
  async consume(key: string): Promise<{ challenge: string; userId?: string } | null> {
    const row = await this.repo.consume(key);
    if (!row) return null;
    if (Date.now() > row.expiresAt * 1000) return null;
    return { challenge: row.challenge, userId: row.userId };
  }
}
