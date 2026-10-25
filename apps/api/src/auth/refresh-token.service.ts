// Refresh-token rotation and reuse detection (`<userId>.<48 random bytes>`; SHA-256 is the SK, so a breach cannot be replayed at the
// cookie layer). See docs/security.md, "Sessions".
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import { RevokedTokensRepository } from '../dynamo/revoked-tokens.repository.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { runTransactWrite, TransientTransactionError } from '../dynamo/transact-write.js';
import type { RefreshTokenRow } from '../dynamo/types.js';

interface IssueArgs {
  userId: string;
  /**
   * The householdId the rotated access-token claim carries; persisted on every row so rotation does not fall back to
   * `userId`.
   */
  householdId: string;
  tokenFamilyId?: string; // omit on first login; passed in on rotation
  rotatedFrom?: string | null;
  jti: string; // matching access-token jti (for family-revoke denylist)
  /**
   * Persisted on every row so rotation reissues the same `deviceId` claim and the sync controller device check holds.
   */
  deviceId: string;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * The credential revision this session write authority is recorded against. `rotate` copies the predecessor value
   * forward verbatim, so a chain that carries none keeps carrying none; a passwordless passkey sign-in omits it.
   */
  credentialRevision?: string;
  /**
   * The account session generation this session is minted under: the User row value at fresh issuance, or the
   * predecessor value carried forward on rotation. `issue` ConditionChecks it against the User row in the same
   * transaction.
   */
  sessionGeneration: number;
}

interface RotateResult {
  oldJti: string;
  newToken: string;
  newRow: RefreshTokenRow;
}

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly ttlSec: number;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly revokedTokens: RevokedTokensRepository,
    private readonly users: UsersRepository,
    private readonly auth: AuthEventsRepository,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.ttlSec = config.get('AUTH_REFRESH_TOKEN_TTL_MIN', { infer: true }) * 60;
  }

  async issueInitial(args: IssueArgs): Promise<{ token: string; row: RefreshTokenRow }> {
    return this.issue({
      ...args,
      tokenFamilyId: args.tokenFamilyId ?? randomUUID(),
      rotatedFrom: null,
    });
  }

  /**
   * Rotates: validates the presented token, revokes its row and issues a new one in the same family. On reuse it
   * plants a family revocation barrier, revokes the whole family and denylists any in-flight access-token jti.
   * `newAccessTokenJti` is minted by the caller, so the new row carries its final jti and is never patched afterward.
   */
  async rotate(
    presentedToken: string,
    newAccessTokenJti: string,
    ip?: string | null,
    userAgent?: string | null,
  ): Promise<RotateResult> {
    const parsed = parseToken(presentedToken);
    if (!parsed) throw invalidTokenError();

    const tokenHash = sha256(presentedToken);
    const row = await this.refreshTokens.find(parsed.userId, tokenHash);
    if (!row) throw invalidTokenError();

    // Legacy rows lack `householdId`: force a clean re-login rather than reissue an undefined claim.
    if (!row.householdId) throw invalidTokenError();

    // Cutover: a legacy session with no `sessionGeneration` gets the same forced re-login, unconditionally dead
    // regardless of `revokedAt`.
    if (row.sessionGeneration === undefined) throw invalidTokenError();

    if (row.revokedAt !== null) {
      // Reuse kills the whole family. Incident-context warn only; the RefreshTokenReuse metric comes from
      // AuthEventsRepository off the audit event, so this is not a metric-filter marker.
      this.logger.warn('Refresh token reuse detected', { userId: row.userId });
      // Barrier first: any issuance or rotation committing after this Put sees it via its ConditionCheck and cannot
      // produce a live descendant; one that committed before is caught by the strongly consistent enumeration below.
      // A plain enumerate-then-revoke sweep cannot close the descendant-created-during-detection race.
      const barrierExpiresAt = Math.floor(Date.now() / 1000) + this.ttlSec;
      await this.revokedTokens.putFamilyBarrier(row.tokenFamilyId, row.userId, barrierExpiresAt);
      const family = await this.refreshTokens.listFamily(row.userId, row.tokenFamilyId, {
        consistentRead: true,
      });
      await this.refreshTokens.revokeFamily(family, new Date().toISOString());
      // Denylist any still-valid access tokens from this family.
      await Promise.all(
        family
          .filter((m) => m.jti && m.expiresAt * 1000 > Date.now())
          .map((m) =>
            this.revokedTokens.revoke({
              jti: m.jti,
              userId: m.userId,
              revokedAt: new Date().toISOString(),
              expiresAt: m.expiresAt,
            }),
          ),
      );
      await this.auth.record({
        userId: row.userId,
        eventType: 'refresh_reuse_detected',
        ip,
        userAgent,
        metadata: { tokenFamilyId: row.tokenFamilyId },
      });
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REUSED',
        message: 'Refresh-token reuse detected. All sessions revoked.',
      });
    }

    if (row.expiresAt * 1000 < Date.now()) throw invalidTokenError();

    // Standard rotation: the predecessor revoke commits in the same transaction as the descendant Put. A concurrent
    // /refresh on the same presented row (or one the deletion sweep removed) loses its ConditionalCheckFailed,
    // which `issue` maps to the same 401: a race, not reuse, so no family revocation. A transient cancellation
    // leaves the predecessor untouched and retryable. `credentialRevision` and `sessionGeneration` are copied
    // forward verbatim, never re-derived.
    const fresh = await this.issue({
      userId: row.userId,
      householdId: row.householdId,
      tokenFamilyId: row.tokenFamilyId,
      rotatedFrom: row.tokenHash,
      jti: newAccessTokenJti,
      deviceId: row.deviceId,
      credentialRevision: row.credentialRevision,
      sessionGeneration: row.sessionGeneration,
      revokePredecessor: { tokenHash: row.tokenHash, at: new Date().toISOString() },
      ip,
      userAgent,
    });

    return { oldJti: row.jti, newToken: fresh.token, newRow: fresh.row };
  }

  // Atomic write for initial issuance and rotation: the Put commits only in a transaction that also ConditionChecks the
  // account session generation and the family barrier absence, both evaluated at commit time, so a revoke or barrier
  // landing up to that instant closes the window.
  private async issue(args: {
    userId: string;
    householdId: string;
    tokenFamilyId: string;
    rotatedFrom: string | null;
    jti: string;
    deviceId: string;
    sessionGeneration: number;
    credentialRevision?: string;
    // Rotation only: the predecessor conditional revoke commits as a fourth item in this transaction. A lost revoke
    // condition is indistinguishable, by design, from the generation or barrier checks losing; all map to
    // `invalidTokenError()`.
    revokePredecessor?: { tokenHash: string; at: string };
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<{ token: string; row: RefreshTokenRow }> {
    const random = randomBytes(48).toString('base64url');
    const token = `${args.userId}.${random}`;
    const tokenHash = sha256(token);
    const now = new Date();
    const row: RefreshTokenRow = {
      userId: args.userId,
      householdId: args.householdId,
      tokenHash,
      tokenFamilyId: args.tokenFamilyId,
      expiresAt: Math.floor(now.getTime() / 1000) + this.ttlSec,
      revokedAt: null,
      rotatedFrom: args.rotatedFrom,
      userAgent: args.userAgent ?? null,
      ip: args.ip ?? null,
      jti: args.jti,
      deviceId: args.deviceId,
      createdAt: now.toISOString(),
      sessionGeneration: args.sessionGeneration,
      // The DocumentClient marshaller rejects `undefined`, so an absent revision is omitted, never written as
      // undefined.
      ...(args.credentialRevision !== undefined
        ? { credentialRevision: args.credentialRevision }
        : {}),
    };
    try {
      await runTransactWrite(
        this.doc,
        [
          this.refreshTokens.insertTransactItem(row),
          this.users.conditionCheckSessionGenerationTransactItem(
            args.userId,
            args.sessionGeneration,
          ),
          this.revokedTokens.conditionCheckNoFamilyBarrierTransactItem(args.tokenFamilyId),
          ...(args.revokePredecessor
            ? [
                this.refreshTokens.revokeTransactItem(
                  args.userId,
                  args.revokePredecessor.tokenHash,
                  args.revokePredecessor.at,
                ),
              ]
            : []),
        ],
        () => {
          throw invalidTokenError();
        },
      );
    } catch (err) {
      if (err instanceof TransientTransactionError) {
        throw new ServiceUnavailableException({
          code: 'REFRESH_TOKEN_CONFLICT',
          message: 'Could not complete sign-in right now. Please retry.',
        });
      }
      throw err;
    }
    return { token, row };
  }

  /**
   * Revokes a single session and its entire family, as the reuse branch does: barrier first (a concurrent rotation
   * committing after it fails its ConditionCheck), then a strongly consistent enumeration (catching a descendant
   * committed before it), revoking every row and denylisting access jtis. A `markRevoked` ConditionalCheckFailed
   * (already revoked, or removed by the deletion sweep) is swallowed because the barrier already protects the family,
   * and never recreates a partial row.
   */
  async revokeOne(userId: string, tokenHash: string): Promise<void> {
    const row = await this.refreshTokens.find(userId, tokenHash, { consistentRead: true });
    if (!row) return;

    const barrierExpiresAt = Math.floor(Date.now() / 1000) + this.ttlSec;
    await this.revokedTokens.putFamilyBarrier(row.tokenFamilyId, userId, barrierExpiresAt);

    try {
      await this.refreshTokens.markRevoked(userId, tokenHash, new Date().toISOString());
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }

    const family = await this.refreshTokens.listFamily(userId, row.tokenFamilyId, {
      consistentRead: true,
    });
    await this.refreshTokens.revokeFamily(family, new Date().toISOString());
    await Promise.all(
      family
        .filter((m) => m.jti && m.expiresAt * 1000 > Date.now())
        .map((m) =>
          this.revokedTokens.revoke({
            jti: m.jti,
            userId: m.userId,
            revokedAt: new Date().toISOString(),
            expiresAt: m.expiresAt,
          }),
        ),
    );
  }
}

function parseToken(raw: string): { userId: string; random: string } | null {
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  return { userId: raw.slice(0, dot), random: raw.slice(dot + 1) };
}

/**
 * SHA-256 hex digest; refresh tokens are hashed before any persistence or lookup, so only the digest reaches DynamoDB
 * or logs.
 */
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function invalidTokenError(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'INVALID_REFRESH_TOKEN',
    message: 'Refresh token is invalid or expired.',
  });
}
