/**
 * Change-password orchestrator. Validates the
 * current password, hashes the new one, and commits the credential row +
 * (when the caller supplies a re-wrapped slot) the household-key `password`
 * slot + the envelope-set meta bump in ONE `TransactWriteItems` — the
 * credential and the key either both change or neither does. A
 * server-confirmed no-password-slot (recovery-only) household may instead
 * commit the credential alone, with the slot's continued absence asserted as
 * a condition of that same transaction.
 *
 * After a committed change: revokes every existing refresh family, denylists
 * every live `jti`, and issues a fresh session recording the revision THIS
 * commit just minted (not the one it authenticated against). Audit event
 * lands as `password_change`.
 *
 * See docs/security.md, "Password change, password reset".
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { CredentialsRepository } from '../dynamo/credentials.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { HouseholdKeyEnvelopesRepository } from '../dynamo/household-key-envelopes.repository.js';
import { PASSWORD_SLOT_ID, type CredentialRow } from '../dynamo/types.js';
import { runTransactWrite, TransientTransactionError } from '../dynamo/transact-write.js';
import { buildKeyEnvelopeSlotRow } from './key-envelope-row.js';
import { assertSingleVersionStep } from './envelope-version-guard.js';
import type { UpsertKeyEnvelopeSlotDto } from './dto/auth.dto.js';
import { PasswordValidatorService } from './password-validator.service.js';
import { FailedLoginService } from './failed-login.service.js';
import { LoginService, type LoginResult } from './login.service.js';
import { StepUpService, type StepUpMethod } from './step-up.service.js';
import { SessionRevocationService } from './session-revocation.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';

/** One item of a `TransactWriteCommand`'s `TransactItems` array. */
type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

/**
 * The single error code shared by every "this request cannot be evaluated as
 * sent" rejection on the change-password / key-envelope write paths (the rolling-deployment cases): a stale bundle posting no envelope fields to a
 * slot-holding household, and a session whose write authority the credential
 * `ConditionCheck` finds stale or missing (a superseded session, or a
 * pre-rollout session that never recorded one). The web maps this ONE code to
 * a reload prompt, never a validation error on a form.
 */
const UPGRADE_REQUIRED_ERROR = {
  code: 'UPGRADE_REQUIRED',
  message: 'Reload the page to continue.',
} as const;

export interface ChangePasswordArgs {
  userId: string;
  householdId: string;
  deviceId: string;
  /** Device-trust cookie value — lets a
   *  trusted device's password re-verify bypass the per-address backoff,
   *  mirroring login/delete-account. */
  deviceTrustToken?: string;
  currentJti: string;
  currentAccessExp: number;
  currentPassword: string;
  newPassword: string;
  /** Fresh step-up factor — required after the
   * password gate when `AUTH_MFA_ENFORCED` is on; absent on the flag-off
   * password-only floor. Closes the key-strand rotation vector. */
  method?: StepUpMethod;
  code?: string;
  assertion?: AuthenticationResponseJSON;
  ip: string | null;
  userAgent: string | null;
  /**
   * The CURRENT session's recorded write authority, resolved by the controller from the refresh
   * cookie the same way `logout` resolves its row — never a client-supplied value. Asserted as the
   * credential row's own conditional-`Put` predecessor: a superseded session (one whose sign-in
   * predates a credential rotation that has since landed), or one carrying no recorded revision at
   * all, fails the commit.
   */
  sessionCredentialRevision: string;
  /**
   * The re-wrapped `password` slot to commit atomically with the credential.
   * Present together with `envelopeSetVersion` /
   * `expectedEnvelopeSetVersion` / `envelopeSetTag`, or all four absent (the
   * server-confirmed no-slot / recovery-only exception). Never a client
   * choice — the server decides which shape applies from its own read of the
   * household's slots, below.
   */
  slot?: UpsertKeyEnvelopeSlotDto;
  envelopeSetVersion?: number;
  expectedEnvelopeSetVersion?: number;
  envelopeSetTag?: string;
}

@Injectable()
export class ChangePasswordService {
  private readonly mfaEnforced: boolean;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    private readonly credentials: CredentialsRepository,
    private readonly passwords: PasswordValidatorService,
    private readonly auth: AuthEventsRepository,
    private readonly users: UsersRepository,
    private readonly failed: FailedLoginService,
    private readonly loginSvc: LoginService,
    private readonly stepUpSvc: StepUpService,
    private readonly envelopes: HouseholdKeyEnvelopesRepository,
    private readonly sessions: SessionRevocationService,
    private readonly trustedDeviceSvc: TrustedDeviceService,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.mfaEnforced = config.get('AUTH_MFA_ENFORCED', { infer: true }) === 'true';
  }

  async change(args: ChangePasswordArgs): Promise<LoginResult> {
    const user = await this.users.findById(args.userId);
    if (!user) {
      // JWT-valid claim whose User row is gone — treat as a credential failure.
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
      });
    }

    // Password re-verify wrapped with the shared per-account backoff —
    // the same treatment
    // delete-account already uses on its own inline Argon2 check (change-password
    // does not call VerifyPasswordService, so this is a parallel internal wrap).
    // A lockout throws 429 before argon2 is paid; a wrong password records one
    // failure + throws 401 INVALID_CREDENTIALS; a backend/argon2 fault
    // propagates uncounted. No `password_verify` audit here, preserving
    // change-password's existing audit contract (`password_change` on success).
    //
    // Device identity: resolve trust the same
    // way the other password-proof callers do, so a valid trusted-device
    // cookie bypasses the per-address backoff and a miss counts against that
    // device's own ceiling instead of the shared address counter.
    const trust = {
      trusted: await this.trustedDeviceSvc.verify(
        args.userId,
        args.deviceId,
        args.deviceTrustToken,
      ),
      userId: args.userId,
      deviceId: args.deviceId,
    };
    await this.failed.verifyWithBackoff({
      emailLowercase: user.emailLowercase,
      verify: async () => {
        const credential = await this.credentials.findByUserId(args.userId);
        return credential
          ? await argon2.verify(credential.argon2Hash, args.currentPassword)
          : false;
      },
      trust,
    });

    // Fresh second-factor step-up — layered on top
    // of the password gate when `AUTH_MFA_ENFORCED` is on; skipped on the flag-off
    // floor. Runs before the credential rotation so a bad factor never
    // rotates the password / strands the household key. The `StepUpService` emits
    // its own audit and throws `MFA_CODE_INVALID` (or a passkey-specific code).
    if (this.mfaEnforced) {
      if (!args.method) {
        await this.stepUpSvc.recordMissingProofFailure({
          userId: args.userId,
          purpose: 'change_password',
          ip: args.ip,
          userAgent: args.userAgent,
        });
        throw new BadRequestException({
          code: 'STEP_UP_PROOF_MISSING',
          message: 'A second factor is required to change your password.',
        });
      }
      await this.stepUpSvc.verify({
        userId: args.userId,
        purpose: 'change_password',
        method: args.method,
        code: args.code,
        assertion: args.assertion,
        ip: args.ip,
        userAgent: args.userAgent,
      });
    }

    if (args.currentPassword === args.newPassword) {
      throw new BadRequestException({
        code: 'PASSWORD_SAME_AS_CURRENT',
        message: 'New password must differ from the current password.',
      });
    }

    await this.passwords.validate(args.newPassword);

    // ---- Server-read eligibility, then the atomic commit ----
    //
    // The eligibility read decides WHICH commit shape applies; the actual
    // absence (for the no-slot shape) is re-asserted as a condition of the
    // commit itself, below, so a slot created between this read and the write
    // still fails the whole change.
    // Strongly consistent: an eventually-consistent read
    // can return the canonical `password` slot while missing a SECOND,
    // noncanonical password-type row that already exists (a state the
    // previous endpoint allowed). Inspect EVERY password-type slot, not just
    // the first one DynamoDB happens to return — a household holding more
    // than one is exactly as unsafe to proceed on as one at the wrong id: the
    // web client's re-wrap is only ever computed over the canonical slot, so
    // a stray second row would be left wrapped under the old password while
    // the stored tag (computed over the substituted canonical set) claims it
    // covers the true slot set.
    const existingSlots = await this.envelopes.listSlots(args.householdId, true);
    const existingPasswordSlots = existingSlots.filter((s) => s.slotType === 'password');
    if (
      existingPasswordSlots.length > 1 ||
      (existingPasswordSlots.length === 1 && existingPasswordSlots[0]!.slotId !== PASSWORD_SLOT_ID)
    ) {
      // A legacy/duplicate password-type slot (impossible for any household
      // created by a shipped bundle) is refused, never moved/merged — a move
      // is two rows across two version steps with no atomic shape.
      throw new ConflictException({
        code: 'PASSWORD_SLOT_NOT_CANONICAL',
        message:
          'This account cannot change its password right now. Re-run key setup, or report the problem.',
      });
    }
    const householdHoldsPasswordSlot = existingPasswordSlots.length === 1;

    const hasRewrapBody =
      args.slot !== undefined &&
      args.envelopeSetVersion !== undefined &&
      args.expectedEnvelopeSetVersion !== undefined &&
      args.envelopeSetTag !== undefined;

    if (hasRewrapBody && args.slot!.slotType !== 'password') {
      throw new BadRequestException({
        code: 'INVALID_SLOT_ID',
        message: 'The re-wrapped slot must be a password-type slot.',
      });
    }

    // A body carrying no envelope fields from a household that DOES hold a
    // password slot is never performed as a credential-only change — that is
    // exactly the commit-or-neither contract this method exists to
    // enforce (an old bundle, or a bug, must not silently downgrade to a
    // credential-only change on a household with a key to re-wrap).
    if (!hasRewrapBody && householdHoldsPasswordSlot) {
      throw new ConflictException(UPGRADE_REQUIRED_ERROR);
    }

    // The reverse direction of the same contract (the server decides which
    // shape applies from its own read of the household's slots, never the
    // client): a rewrap-shaped body from a household the server
    // confirms holds NO password slot must not pick the three-item commit —
    // committing it would silently mint a brand-new canonical `password`
    // slot through change-password, a shape that endpoint was never meant to create. The
    // legitimate client only ever reaches this on a stale view of the slot
    // set (the slot vanished between its read and this request), so the
    // same reload answer applies.
    if (hasRewrapBody && !householdHoldsPasswordSlot) {
      throw new ConflictException(UPGRADE_REQUIRED_ERROR);
    }

    // Same single-version-step guard `KeyEnvelopeController.upsert` applies
    // at its boundary:
    // the proposed `envelopeSetVersion` must be exactly the caller's held
    // `expectedEnvelopeSetVersion` + 1. `buildMetaPutTransactItem`'s
    // DynamoDB condition only checks the row's CURRENT stored version against
    // `expectedEnvelopeSetVersion` — it never constrains the NEW value being
    // written, so this boundary check is the only thing standing between a
    // correct `expectedEnvelopeSetVersion` and an arbitrary, non-adjacent
    // `envelopeSetVersion` jump.
    if (hasRewrapBody) {
      assertSingleVersionStep(args.expectedEnvelopeSetVersion!, args.envelopeSetVersion!);
    }

    const newHash = await argon2.hash(args.newPassword, { type: argon2.argon2id });
    const now = new Date().toISOString();
    // Minted ONCE into a local and put into both items below — never
    // read a clock or `randomUUID()` twice and hope the two agree.
    const newRevision = randomUUID();
    const credentialRow: CredentialRow = {
      userId: args.userId,
      argon2Hash: newHash,
      updatedAt: now,
      credentialRevision: newRevision,
    };
    const credentialPutItem = this.credentials.putTransactItem(
      credentialRow,
      args.sessionCredentialRevision,
    );

    // Archive the displaced password slot + envelope-set meta — this commit re-wraps the canonical
    // `password` slot exactly like a key-envelope PUT would, so it must archive like one. Read
    // close to commit time (consistent); a race that actually changes the meta row before this
    // transaction lands fails the meta `Put`'s own `ConditionExpression` INSIDE the same
    // transaction, so nothing here commits on a stale read.
    const archiveItems = hasRewrapBody
      ? this.envelopes.buildArchiveTransactItems(
          args.householdId,
          existingPasswordSlots[0],
          await this.envelopes.getEnvelopeMeta(args.householdId, true),
          // The live slot-id membership at the displaced version — the
          // archived meta's restore manifest, from the same
          // consistent `listSlots` read above.
          existingSlots.map((s) => s.slotId),
        )
      : [];

    const transactItems: TransactItem[] = hasRewrapBody
      ? [
          credentialPutItem,
          this.envelopes.buildSlotPutTransactItem(
            buildKeyEnvelopeSlotRow(
              args.householdId,
              PASSWORD_SLOT_ID,
              args.slot!,
              newRevision,
            ),
          ),
          this.envelopes.buildMetaPutTransactItem(
            args.householdId,
            args.envelopeSetVersion!,
            args.envelopeSetTag!,
            args.expectedEnvelopeSetVersion!,
          ),
          ...archiveItems,
        ]
      : [
          credentialPutItem,
          this.envelopes.buildPasswordSlotAbsenceCheckTransactItem(args.householdId),
        ];

    await this.commitChangeTransaction(transactItems, hasRewrapBody);

    // Revoke every existing session through the shared capability —
    // including the current device's; the
    // caller mints a new session below so the current tab keeps working. This
    // now denylists still-valid access-token jtis from ALL of the user's
    // refresh rows, not just the active ones, tightening this method's prior
    // active-rows-only scope.
    const { sessionGeneration } = await this.sessions.revokeAll({
      userId: args.userId,
      extraJti: { jti: args.currentJti, expiresAt: args.currentAccessExp },
    });

    // Record the revision THIS commit just minted — not the one the session
    // authenticated against — so the freshly-issued session immediately
    // carries write authority for a subsequent change. `sessionGeneration` is
    // the value `revokeAll` just committed — never re-read via `issueSession`'s
    // own eventually-consistent `findById`, which could observe a stale
    // replica still holding the generation THIS call just retired and turn
    // an already-committed password change into a spurious 401.
    const session = await this.loginSvc.issueSession({
      userId: args.userId,
      householdId: args.householdId,
      deviceId: args.deviceId,
      credentialRevision: newRevision,
      sessionGeneration,
      ip: args.ip,
      userAgent: args.userAgent,
    });

    await this.auth.record({
      userId: args.userId,
      eventType: 'password_change',
      ip: args.ip,
      userAgent: args.userAgent,
      metadata: { deviceId: args.deviceId },
    });

    return session;
  }

  /**
   * Run the credential(+slot+meta) transaction and map its cancellation
   * reasons. Item 0 is always the credential `Put`, conditioned on the
   * session's recorded write authority — a failure there is the ONE
   * `UPGRADE_REQUIRED` code shared with the key-envelope write path. On the
   * re-wrap shape, item 2 (the meta `Put`) failing is a real envelope-set
   * version conflict; on the no-slot shape, item 1 (the absence
   * `ConditionCheck`) failing means a password slot appeared between the
   * eligibility read and this commit. A transient reason that survives the
   * shared bounded retry is a `503`, never a business conflict.
   */
  private async commitChangeTransaction(
    transactItems: TransactItem[],
    isRewrap: boolean,
  ): Promise<void> {
    try {
      await runTransactWrite(this.doc, transactItems, (reasons) => {
        if (reasons[0]?.Code === 'ConditionalCheckFailed') {
          throw new ConflictException(UPGRADE_REQUIRED_ERROR);
        }
        if (isRewrap && reasons[2]?.Code === 'ConditionalCheckFailed') {
          throw new ConflictException({
            code: 'STALE_ENVELOPE_VERSION',
            message: 'Envelope-set version is stale or non-monotonic.',
          });
        }
        if (!isRewrap && reasons[1]?.Code === 'ConditionalCheckFailed') {
          throw new ConflictException({
            code: 'PASSWORD_SLOT_PRESENT',
            message:
              'A password unlock method was just set up for this account. Reload and try again.',
          });
        }
        // Defensive fallback — every guarded item above is enumerated.
        throw new ConflictException({
          code: 'STALE_ENVELOPE_VERSION',
          message: 'Envelope-set version is stale or non-monotonic.',
        });
      });
    } catch (err) {
      if (err instanceof TransientTransactionError) {
        throw new ServiceUnavailableException({
          code: 'CHANGE_PASSWORD_CONFLICT',
          message: 'Could not save this change right now. Try again.',
        });
      }
      throw err;
    }
  }
}
