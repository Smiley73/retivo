/**
 * Shared "revoke every session" capability.
 *
 * Before this service existed, three call sites hand-rolled the same sweep
 * with two subtly different scopes: `password-reset.service.ts` denylisted
 * still-valid access-token jtis from EVERY refresh row (active or already
 * revoked) — because a refresh rotation revokes the OLD row while its
 * already-issued access token stays valid for the rest of its ~60-minute TTL,
 * so an active-rows-only sweep leaves that pre-rotation token usable.
 * `change-password.service.ts` and `household-sweep.service.ts` instead
 * denylisted from ACTIVE rows only, which carries exactly that weakness.
 *
 * This service consolidates on the STRONGER, all-rows scope unconditionally —
 * the only per-caller variation is an optional extra jti to denylist (the
 * caller's own current access token, when it isn't already covered by a
 * refresh row — `change-password` and `household-sweep`'s consumers pass
 * theirs; `password-reset` and the factor-undo consume have no live session
 * to add). This tightens `change-password` and `household-sweep` behaviour
 * relative to what they did before — a fix, not a pure refactor.
 *
 * `revokeAll` retires the account's
 * session generation FIRST, atomically, as the actual correctness boundary
 * (`JwtAuthGuard` and every refresh-token issuance/rotation enforce it — see
 * jwt-auth.guard.ts and refresh-token.service.ts). The enumerate-and-
 * denylist sweep below is retained but demoted to immediate cleanup: it
 * still denylists still-valid access-token jtis right away instead of
 * waiting on their own TTL, but a bug in it can no longer let a revoked
 * account keep a usable session.
 */
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
  /** The caller's own current access-token jti, when the call site has a
   *  live session to add on top of the user's refresh rows (mirrors the
   *  prior `change-password` / `household-sweep` behaviour). Omitted by
   *  callers with no session context (password-reset consume, factor-undo
   *  consume). */
  extraJti?: { jti: string; expiresAt: number };
}

/**
 * Thrown internally when the generation-bump's ConditionCheck loses a race
 * — either a concurrent revocation already moved the generation, or the
 * `User` row no longer exists. Caught by the bounded retry in
 * {@link SessionRevocationService.retireCurrentGeneration}; never escapes it.
 */
class GenerationBumpConflict extends Error {
  constructor() {
    super('Session generation changed concurrently');
    this.name = 'GenerationBumpConflict';
  }
}

/** Bounded optimistic-concurrency retry for the generation bump below —
 *  concurrent account-wide revocations for the SAME user are rare (each is
 *  triggered by a distinct user-initiated event), so a small bound suffices. */
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
    // Conservative: long enough to outlive any refresh token that could
    // still carry the retired generation and attempt rotation. The ONLY
    // consumer of this tombstone (JwtAuthGuard, on access tokens) has a much
    // shorter TTL, so this is a deliberate over-approximation, not a tuned
    // value ("TTLs must outlive every token
    // that can carry the value they retire").
    this.generationTombstoneTtlSec = config.get('AUTH_REFRESH_TOKEN_TTL_MIN', { infer: true }) * 60;
  }

  /**
   * Revoke every refresh-token family for a user and denylist every
   * still-valid access-token jti drawn from ALL of that user's refresh rows
   * (not just the active ones — see the file header). Idempotent. Returns
   * the account's NEW (post-bump) session generation so a caller that
   * immediately re-issues a session (change-password) can stamp that exact
   * value instead of re-reading the `User` row — a plain eventually-
   * consistent `findById` immediately after this method's own write can
   * observe a stale replica still holding the RETIRED generation, which
   * would fail `RefreshTokenService.issue`'s ConditionCheck and turn an
   * already-committed password change into a spurious 401.
   */
  async revokeAll(args: RevokeAllArgs): Promise<{ sessionGeneration: number }> {
    // The linearization point: retire the account's CURRENT session
    // generation and tombstone it, atomically, BEFORE anything else. Every
    // access token minted before this instant is now provably dead through
    // JwtAuthGuard's tombstone check, and every refresh-token issuance or
    // rotation whose generation ConditionCheck reads before this commit
    // cannot commit after it (RefreshTokenService.issue) — regardless of
    // whether the cleanup sweep below ever sees the affected rows.
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

  /**
   * Atomically retire the account's current session generation and
   * tombstone it — see
   * `UsersRepository.bumpSessionGenerationTransactItem` for the invariant
   * this maintains. Bounded optimistic-concurrency retry: a losing bump
   * means another concurrent revocation already moved the generation, which
   * already achieves this call's goal, so re-reading and retrying (rather
   * than failing) is correct. A `User` row that has disappeared (concurrent
   * account deletion) fails closed on the FIRST iteration that observes it
   * missing — this never creates a phantom `User` row and never reports a
   * revocation that did not happen.
   *
   * Reads with `findByIdConsistent`, not the eventually-consistent
   * `findById`: both the initial read and every
   * retry's re-read follow immediately after `commitChangeTransaction`
   * (change-password) or another writer's own commit to this same item, the
   * exact window where a plain replica read is likely stale — treating that
   * stale miss as "the account no longer exists" would abort an
   * already-committed credential change with no generation retired. A
   * jittered backoff (`backoffMs`, shared with the transaction retries in
   * transact-write.ts) separates the retries so a losing attempt does not
   * immediately re-read the same contended item. Returns the NEW (post-bump)
   * generation.
   */
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
          // Exhausted the bounded retry against sustained concurrent
          // contention — a transient condition, not a business conflict.
          throw new ServiceUnavailableException({
            code: 'SESSION_REVOCATION_CONFLICT',
            message: 'Could not revoke sessions right now. Please retry.',
          });
        }
        // A transient cancellation surviving `runTransactWrite`'s own bounded
        // retry stays a 503 here too, not a 500 — this boundary is as much a
        // transaction as issuance/rotation's (refresh-token.service.ts).
        if (err instanceof TransientTransactionError) {
          throw new ServiceUnavailableException({
            code: 'SESSION_REVOCATION_CONFLICT',
            message: 'Could not revoke sessions right now. Please retry.',
          });
        }
        throw err;
      }
    }
    // Unreachable: every loop iteration either returns or throws above (the
    // last attempt's conflict branch always throws rather than `continue`s).
    // Satisfies TypeScript's control-flow analysis for the `Promise<number>`
    // return type without changing behaviour.
    throw new ServiceUnavailableException({
      code: 'SESSION_REVOCATION_CONFLICT',
      message: 'Could not revoke sessions right now. Please retry.',
    });
  }
}
