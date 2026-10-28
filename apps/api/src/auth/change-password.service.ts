// Change-password orchestrator: commits the credential (and, when supplied, the re-wrapped `password` slot and meta bump) in one
// transaction, then revokes every session. See docs/security.md, "Password change, password reset".
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

type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

// The one code for every "cannot be evaluated as sent" rejection on the change-password and key-envelope write paths
// (a stale bundle posting no envelope fields to a slot-holding household, or a session whose write authority is stale
// or missing); the web maps it to a reload prompt, never a form error.
const UPGRADE_REQUIRED_ERROR = {
  code: 'UPGRADE_REQUIRED',
  message: 'Reload the page to continue.',
} as const;

export interface ChangePasswordArgs {
  userId: string;
  householdId: string;
  deviceId: string;
  /** Device-trust cookie value; lets a trusted device bypass the per-address backoff, as in login. */
  deviceTrustToken?: string;
  currentJti: string;
  currentAccessExp: number;
  currentPassword: string;
  newPassword: string;
  /**
   * Fresh step-up factor, required after the password gate when `AUTH_MFA_ENFORCED` is on; closes the key-strand
   * rotation vector.
   */
  method?: StepUpMethod;
  code?: string;
  assertion?: AuthenticationResponseJSON;
  ip: string | null;
  userAgent: string | null;
  /**
   * The current session recorded write authority, resolved by the controller from the refresh cookie, never
   * client-supplied. It is the credential conditional Put predecessor, so a superseded session, or one with no
   * recorded revision, fails the commit.
   */
  sessionCredentialRevision: string;
  /**
   * The re-wrapped `password` slot to commit with the credential. Present together with the three envelope fields, or
   * all four absent (the recovery-only exception); the server decides which shape applies from its own read of the
   * slots.
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
      // A JWT-valid claim whose User row is gone: a credential failure.
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
      });
    }

    // Password re-verify under the shared per-account backoff (change-password does not call VerifyPasswordService,
    // so this is a parallel wrap): a lockout is 429 before argon2, a wrong password is 401 and one failure, a
    // backend fault propagates uncounted. No `password_verify` audit, keeping the `password_change` contract. Trust
    // resolves as for other password-proof callers.
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

    // Fresh step-up layered on the password gate when `AUTH_MFA_ENFORCED` is on, before the credential rotates so a
    // bad factor never rotates the password or strands the household key.
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

    // The read decides which commit shape applies; the no-slot absence is re-asserted in the commit itself, so a
    // slot created in between still fails the change. Strongly consistent, and every password-type slot is
    // inspected: an eventual read could miss a noncanonical second row, and the client re-wrap covers only the
    // canonical slot, which would leave a stray row wrapped under the old password.
    const existingSlots = await this.envelopes.listSlots(args.householdId, true);
    const existingPasswordSlots = existingSlots.filter((s) => s.slotType === 'password');
    if (
      existingPasswordSlots.length > 1 ||
      (existingPasswordSlots.length === 1 && existingPasswordSlots[0]!.slotId !== PASSWORD_SLOT_ID)
    ) {
      // A legacy or duplicate password-type slot is refused, never moved or merged; a move is two rows across two
      // version steps with no atomic shape.
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

    // A body with no envelope fields from a household that holds a password slot is never performed
    // credential-only: an old bundle or a bug must not silently downgrade a household with a key to re-wrap.
    if (!hasRewrapBody && householdHoldsPasswordSlot) {
      throw new ConflictException(UPGRADE_REQUIRED_ERROR);
    }

    // The reverse: the server decides the shape, so a re-wrap body from a household with no password slot must not
    // mint a new canonical slot through change-password. A legitimate client reaches this only on a stale slot
    // view, so the same reload answer applies.
    if (hasRewrapBody && !householdHoldsPasswordSlot) {
      throw new ConflictException(UPGRADE_REQUIRED_ERROR);
    }

    // Same single-version-step guard as `KeyEnvelopeController.upsert`: `buildMetaPutTransactItem` only checks the
    // stored version against `expectedEnvelopeSetVersion`, never the new value, so this check stops a non-adjacent
    // jump.
    if (hasRewrapBody) {
      assertSingleVersionStep(args.expectedEnvelopeSetVersion!, args.envelopeSetVersion!);
    }

    const newHash = await argon2.hash(args.newPassword, { type: argon2.argon2id });
    const now = new Date().toISOString();
    // Minted once and used in both items, never a clock or `randomUUID()` read twice.
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

    // Archive the displaced password slot and meta like a key-envelope PUT; a race that changes the meta row fails
    // its Put condition inside the same transaction.
    const archiveItems = hasRewrapBody
      ? this.envelopes.buildArchiveTransactItems(
          args.householdId,
          existingPasswordSlots[0],
          await this.envelopes.getEnvelopeMeta(args.householdId, true),
          // Live slot ids at the displaced version: the archived meta restore manifest.
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

    // Revoke every existing session, including this device (a new one is minted below), denylisting still-valid
    // access jtis from all refresh rows, not just active ones.
    const { sessionGeneration } = await this.sessions.revokeAll({
      userId: args.userId,
      extraJti: { jti: args.currentJti, expiresAt: args.currentAccessExp },
    });
    // Remembered devices go with the sessions, so every device is challenged again on its next sign-in.
    await this.trustedDeviceSvc.revokeAll(args.userId, args.ip, args.userAgent, 'password_change');

    // Record the revision this commit just minted, so the new session carries write authority for a subsequent
    // change. `sessionGeneration` is the value `revokeAll` just committed, not re-read: a stale replica could hold
    // the generation just retired and turn a committed change into a spurious 401.
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

  // Runs the transaction and maps cancellations. Item 0 (credential Put, conditioned on the session write authority)
  // failing is the shared UPGRADE_REQUIRED; on the re-wrap shape item 2 (meta Put) failing is a real version
  // conflict; on the no-slot shape item 1 (absence check) failing means a slot appeared since the read. A transient
  // reason past the bounded retry is 503.
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
        // Defensive fallback: every guarded item is enumerated above.
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
