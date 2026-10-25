// Single-use store for WebAuthn challenges, backed by the PasskeyChallenge table so consumption is atomic across Lambda instances. The key
// shapes (`reg:`, `stepup:`, `mfa:`, `auth:`) are the security binding: do not redesign them.
import { Injectable } from '@nestjs/common';
import { PasskeyChallengeRepository } from '../dynamo/passkey-challenge.repository.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class PasskeyChallengeStore {
  constructor(private readonly repo: PasskeyChallengeRepository) {}

  /** Issues (creates or replaces) the challenge under `key`; a caller restarting the same ceremony is expected. */
  async set(key: string, challenge: string, userId?: string): Promise<void> {
    await this.repo.issue({
      key,
      challenge,
      ...(userId !== undefined ? { userId } : {}),
      expiresAt: Math.floor((Date.now() + CHALLENGE_TTL_MS) / 1000),
    });
  }

  /**
   * Single-use atomic consume: null when the key never existed, was already consumed (including a concurrent loser),
   * or its `expiresAt` elapsed. The 5-minute window is enforced here, since the table TTL lags up to ~48h and
   * DynamoDB Local never sweeps.
   */
  async consume(key: string): Promise<{ challenge: string; userId?: string } | null> {
    const row = await this.repo.consume(key);
    if (!row) return null;
    if (Date.now() > row.expiresAt * 1000) return null;
    return { challenge: row.challenge, userId: row.userId };
  }
}
