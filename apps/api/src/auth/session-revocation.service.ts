// Shared "revoke every session": `revokeAll` retires the session generation atomically (the correctness boundary), then denylists access jtis
// from ALL refresh rows, since a rotation revokes the old row while its access token stays valid.
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import { RevokedTokensRepository } from '../dynamo/revoked-tokens.repository.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { backoffMs, runTransactWrite, sleep, TransientTransactionError } from '../dynamo/transact-write.js';

export interface RevokeAllArgs {
  userId: string;
  /**
   * The caller own current access-token jti when it is not covered by a refresh row; omitted by callers with no
   * session (password-reset consume, factor-undo consume).
   */
  extraJti?: { jti: string; expiresAt: number };
}

// Thrown inside `retireCurrentGeneration` when the generation-bump ConditionCheck loses a race (a concurrent
// revocation, or the User row is gone); caught by its bounded retry.
class GenerationBumpConflict extends Error {
  constructor() {
    super('Session generation changed concurrently');
    this.name = 'GenerationBumpConflict';
  }
}

// Bounded optimistic retry: concurrent revocations for one user are rare, so a small bound suffices.
const MAX_GENERATION_BUMP_ATTEMPTS = 3;

@Injectable()
export class SessionRevocationService {
  private readonly generationTombstoneTtlSec: number;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly revoked: RevokedTokensRepository,
    private readonly users: UsersRepository,
    config: ConfigService<EnvConfig, true>,
  ) {
    // Conservative: outlives any refresh token that could still carry the retired generation; the only consumer
    // (JwtAuthGuard, on access tokens) has a much shorter TTL. TTLs must outlive every token that can carry the
    // value they retire.
    this.generationTombstoneTtlSec = config.get('AUTH_REFRESH_TOKEN_TTL_MIN', { infer: true }) * 60;
  }

  /**
   * Revokes every refresh-token family for a user and denylists every still-valid access jti from all of that user
   * refresh rows. Idempotent. Returns the new session generation so a caller that re-issues a session
   * (change-password) stamps it instead of re-reading from a replica that may still hold the retired value and turn a
   * committed change into a spurious 401.
   */
  async revokeAll(args: RevokeAllArgs): Promise<{ sessionGeneration: number }> {
    // The linearization point: retire and tombstone the current generation atomically before anything else. Every
    // earlier access token is dead through the guard tombstone check, and no refresh issuance whose ConditionCheck
    // read before this commit can commit after it, whether or not the sweep below sees the rows.
    const sessionGeneration = await this.retireCurrentGeneration(args.userId);

    const now = new Date().toISOString();
    const nowSec = Math.floor(Date.now() / 1000);
    const all = await this.refreshTokens.listAllForUser(args.userId);
    const active = all.filter((r) => r.revokedAt === null);
    if (active.length > 0) {
      await this.refreshTokens.revokeFamily(active, now);
    }
    const jtisToRevoke = new Map<string, number>();
    for (const row of all) {
      if (row.jti && row.expiresAt > nowSec) {
        jtisToRevoke.set(row.jti, row.expiresAt);
      }
    }
    if (args.extraJti && args.extraJti.expiresAt > nowSec) {
      jtisToRevoke.set(args.extraJti.jti, args.extraJti.expiresAt);
    }
    for (const [jti, expiresAt] of jtisToRevoke) {
      await this.revoked.revoke({ jti, userId: args.userId, revokedAt: now, expiresAt });
    }
    return { sessionGeneration };
  }

  // Atomically retires the current generation and tombstones it (see
  // `UsersRepository.bumpSessionGenerationTransactItem`). A losing bump means another revocation already moved it, so
  // re-read and retry; a User row that disappeared fails closed, never creating a phantom row. Reads with
  // `findByIdConsistent`: right after another commit to this item a replica read is likely stale, and treating that
  // miss as "no account" would abort a committed credential change with no generation retired. Retries are separated
  // by jittered backoff. Returns the new generation.
  private async retireCurrentGeneration(userId: string): Promise<number> {
    for (let attempt = 1; attempt <= MAX_GENERATION_BUMP_ATTEMPTS; attempt++) {
      const user = await this.users.findByIdConsistent(userId);
      if (!user) {
        throw new Error(
          `Cannot revoke sessions for ${userId}: the account no longer exists`,
        );
      }
      const current = user.sessionGeneration ?? 0;
      const expiresAt = Math.floor(Date.now() / 1000) + this.generationTombstoneTtlSec;
      try {
        await runTransactWrite(
          this.doc,
          [
            this.users.bumpSessionGenerationTransactItem(userId, current),
            this.revoked.tombstoneGenerationTransactItem(userId, current, expiresAt),
          ],
          () => {
            throw new GenerationBumpConflict();
          },
        );
        return current + 1;
      } catch (err) {
        if (err instanceof GenerationBumpConflict) {
          if (attempt < MAX_GENERATION_BUMP_ATTEMPTS) {
            await sleep(backoffMs(attempt));
            continue;
          }
          // Exhausted the bounded retry under sustained contention: transient, not a business conflict.
          throw new ServiceUnavailableException({
            code: 'SESSION_REVOCATION_CONFLICT',
            message: 'Could not revoke sessions right now. Please retry.',
          });
        }
        // A transient cancellation surviving the retry stays a 503, not a 500.
        if (err instanceof TransientTransactionError) {
          throw new ServiceUnavailableException({
            code: 'SESSION_REVOCATION_CONFLICT',
            message: 'Could not revoke sessions right now. Please retry.',
          });
        }
        throw err;
      }
    }
    // Unreachable; satisfies TypeScript control-flow for the return type.
    throw new ServiceUnavailableException({
      code: 'SESSION_REVOCATION_CONFLICT',
      message: 'Could not revoke sessions right now. Please retry.',
    });
  }
}
