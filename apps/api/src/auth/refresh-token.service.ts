/**
 * Refresh-token rotation + reuse detection.
 *
 * Token format on the wire: `<userId>.<base64url(48 random bytes)>`.
 * The leading userId lets us look up the row without a GSI; the random
 * suffix is the cryptographic part. We store SHA-256(token) as the SK
 * so a server-side breach can't be replayed at the cookie layer.
 *
 * Reuse: when /auth/refresh sees a token whose row is already revoked, the
 * entire tokenFamilyId is revoked — a revocation BARRIER is written FIRST,
 * then the family is enumerated with a
 * strongly consistent read and any still-valid access-token jti is
 * denylisted. Every issuance/rotation (`issue`, below) ConditionChecks that
 * same barrier's absence in its OWN commit, so no descendant can land after
 * the barrier exists — closing the "descendant created during detection"
 * race a plain enumerate-then-revoke sweep cannot.
 *
 * Account-wide revocation is a SEPARATE, stronger boundary
 * (`SessionRevocationService.revokeAll`): it bumps the `User` row's session
 * generation and tombstones the retired value atomically, and every
 * issuance/rotation here ConditionChecks that generation too. A family
 * barrier only ever kills the one family it names; the account generation
 * is never used to express a single-session or single-family revocation
 * (that would sign out every device on one device's reuse event).
 *
 * See docs/security.md, "Sessions".
 */
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
  // The householdId the access-token claim should carry. Persisted on
  // every row in the family so rotation reissues the right claim
  // value rather than falling back to `userId` (1:1 today, but the
  // claim is wrong if/when that invariant breaks).
  householdId: string;
  tokenFamilyId?: string; // omit on first login; passed in on rotation
  rotatedFrom?: string | null;
  jti: string; // matching access-token jti (for family-revoke denylist)
  // Persisted on every row in the family so rotation reissues the
  // same `deviceId` claim and the sync controller's
  // `dto.deviceId === me.deviceId` check holds across token refresh.
  deviceId: string;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * The credential revision this session's write authority is recorded
   * against. `issueInitial` callers pass the
   * value the caller resolved (login records the just-verified credential's
   * revision, an MFA-verified login the login-minted challenge's revision, a
   * change-password re-issue the revision its own commit just minted); a
   * passwordless passkey sign-in omits it. `rotate` always copies the
   * PREDECESSOR row's `credentialRevision` forward verbatim — never
   * re-derived — so a chain that carries none keeps carrying none.
   */
  credentialRevision?: string;
  /**
   * The account session generation this
   * session is minted under — the CURRENT value read from the `User` row at
   * fresh issuance, or the PREDECESSOR row's stamped value carried forward
   * verbatim on rotation (mirrors `credentialRevision`'s forwarding rule
   * above). `issue` ConditionChecks the `User` row's current generation
   * against this exact value in the same transaction as the row's own Put.
   */
  sessionGeneration: number;
}

interface RotateResult {
  /** Old jti so the caller can also denylist it on logout-equivalent paths. */
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

  /** Issue the first refresh token for a brand-new login. */
  async issueInitial(args: IssueArgs): Promise<{ token: string; row: RefreshTokenRow }> {
    return this.issue({
      ...args,
      tokenFamilyId: args.tokenFamilyId ?? randomUUID(),
      rotatedFrom: null,
    });
  }

  /**
   * Rotate: validate the presented token, mark its row revoked, and issue a
   * new one in the same family. On reuse-detection, plant a family
   * revocation barrier, revoke the entire family + denylist any in-flight
   * access-token jti.
   *
   * `newAccessTokenJti` is the caller's already-minted access-token jti
   * (replaces the deleted `setJti`
   * read/spread/Put): the new row is inserted carrying its FINAL jti from
   * the start, never patched afterward.
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

    // Older rows lack `householdId`. Force a clean re-login on those
    // legacy in-flight tokens rather than reissuing an access token
    // with an undefined claim.
    if (!row.householdId) throw invalidTokenError();

    // Cutover: every session
    // established before this shipped carries no `sessionGeneration` — the
    // same forced-clean-relogin treatment as the legacy `householdId` check
    // above, not a special case. Rejected here, before reuse detection even
    // runs: a legacy row is unconditionally dead regardless of `revokedAt`.
    if (row.sessionGeneration === undefined) throw invalidTokenError();

    if (row.revokedAt !== null) {
      // Reuse — kill the entire family. Incident-context warn only: the
      // `RefreshTokenReuse` metric is now emitted as direct EMF from
      // AuthEventsRepository off the `refresh_reuse_detected` AuthEvent
      // recorded below — this log is NOT its source, so the message is
      // deliberately not a metric-filter marker.
      this.logger.warn('Refresh token reuse detected', { userId: row.userId });
      // Barrier FIRST: any issuance or
      // rotation whose OWN transaction commits after this Put lands sees the
      // barrier via its ConditionCheck and cannot produce a live descendant.
      // A descendant that committed BEFORE the barrier landed is caught by
      // the strongly consistent enumeration immediately below instead — not
      // by the barrier itself.
      const barrierExpiresAt = Math.floor(Date.now() / 1000) + this.ttlSec;
      await this.revokedTokens.putFamilyBarrier(row.tokenFamilyId, row.userId, barrierExpiresAt);
      const family = await this.refreshTokens.listFamily(row.userId, row.tokenFamilyId, {
        consistentRead: true,
      });
      await this.refreshTokens.revokeFamily(family, new Date().toISOString());
      // Denylist any still-valid access tokens issued from this family.
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

    // Standard rotation. The predecessor's revoke now commits in the SAME
    // transaction as the descendant's Put (below, via `revokePredecessor`) —
    // ONE commit, not two. A concurrent /refresh call racing on the SAME
    // presented row loses that transact item's `ConditionalCheckFailed`
    // (`attribute_exists(userId) AND (attribute_not_exists(revokedAt) OR
    // revokedAt = :null)` — so does a presented row the account-deletion
    // sweep removed after the `find` above), which
    // `issue`'s `onConditionFailed` maps to the same 401 invalid-token this
    // used to throw directly — that's a race, not reuse, so we don't
    // escalate to family revocation; the client dedupes refreshes anyway. A
    // transient cancellation of the shared transaction, unlike before, now
    // leaves the presented row's `revokedAt` untouched and genuinely
    // retryable instead of orphaning a revoked-but-childless row.
    //
    // `credentialRevision` and `sessionGeneration` are both copied forward
    // from the PREDECESSOR row verbatim — never re-derived — so an
    // ordinary refresh can never drop or change the session's recorded write
    // authority or generation, and a chain that began carrying neither keeps
    // carrying neither.
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

  /**
   * Atomic write helper used by both initial issuance and rotation. The new
   * row's Put commits only inside a transaction that ALSO ConditionChecks
   * the account's session generation and the family's revocation-barrier
   * absence — both read at COMMIT time, not
   * at the top of this method, so a revoke or a reuse-detected barrier
   * landing anywhere up to the instant this transaction is validated closes
   * the window rather than merely narrowing it.
   */
  private async issue(args: {
    userId: string;
    householdId: string;
    tokenFamilyId: string;
    rotatedFrom: string | null;
    jti: string;
    deviceId: string;
    sessionGeneration: number;
    credentialRevision?: string;
    /**
     * When set (rotation only), the PREDECESSOR row's conditional revoke is committed
     * as a FOURTH item in this same transaction, instead of `rotate` revoking
     * it beforehand in its own separate write. A losing
     * `ConditionalCheckFailed` on this item (someone else already
     * revoked/rotated the predecessor) is indistinguishable, by design, from
     * the generation/barrier ConditionChecks losing — every reason maps to
     * the same `invalidTokenError()` below.
     */
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
      // Conditional spread — the DynamoDB DocumentClient marshaller rejects an
      // `undefined` attribute value, so an absent revision (passwordless
      // passkey sign-in, or a rotation whose predecessor carried none) must be
      // OMITTED, never written as `undefined`.
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
   * Revoke a single session and its ENTIRE family — mirrors the reuse branch in `rotate`:
   * plant the family's revocation barrier FIRST, then enumerate the family
   * with a strongly consistent read, revoke every row, and denylist any
   * still-valid access-token jti. Barrier-first closes the case where a
   * concurrent rotation's issuance transaction commits AFTER the barrier
   * lands (its ConditionCheck fails); the consistent enumeration right after
   * closes the case where that rotation's descendant committed BEFORE the
   * barrier landed (a plain "revoke the presented row, then plant the
   * barrier" ordering misses both: the descendant can already exist by the
   * time the barrier is written, and nothing afterward ever looks for it).
   *
   * `markRevoked`'s own `ConditionalCheckFailedException` (the row was
   * already revoked — e.g. a concurrent rotation won the race for it — or no
   * longer exists at all, because the account-deletion cascade's sweep
   * removed it between the read above and this write) is
   * swallowed: the barrier above already protects the family regardless, so
   * this is a no-op, not an error — and never a recreated partial row, which
   * is what an unguarded update against the absent key would have written.
   * A row that can no longer be found (already revoked, or never existed) has
   * no family to protect and no side effect.
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
 * SHA-256 hex digest. Hash-at-the-boundary helper: refresh tokens are hashed
 * before any persistence or lookup, so only the digest — never the raw
 * token — reaches DynamoDB or log context.
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
