/**
 * ChangeEmailService.confirm → sendSecurityNotice unit tests.
 *
 * Locks the live defect this fix closes: the security notice mailed
 * to the OLD address on a completed email change interpolated the NEW
 * address raw into a `<strong>` element. A hijacked session could set the
 * pending address to a valid-but-hostile quoted local part —
 * `"<b>x</b>"@example.com` passes `@IsEmail()` — and inject markup into the
 * mail the real owner reads. Escaping is the fix; nothing about the DTO
 * changes (out of scope here).
 *
 * Pure unit test, mirrors the harness in signup-approval.service.spec.ts: a
 * stub `ses` with a `send` that captures the SendEmailCommand, `sesEnabled`
 * forced on via SES_ENDPOINT. Does NOT go through the Moto-backed HTTP suite
 * (apps/api/src/test/change-email.spec.ts) — that suite asserts rows/response
 * bodies, never an SES payload, so it can't see the rendered HTML at all.
 */
import type { ConfigService } from '@nestjs/config';
import type { SESClient } from '@aws-sdk/client-ses';
import { SendEmailCommand } from '@aws-sdk/client-ses';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ChangeEmailService } from './change-email.service.js';
import { sha256 } from './refresh-token.service.js';
import { escapeHtml } from '../common/escape-html.js';
import type { UsersRepository } from '../dynamo/users.repository.js';
import type { EmailVerificationsRepository } from '../dynamo/email-verifications.repository.js';
import type { PasswordResetsRepository } from '../dynamo/password-resets.repository.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { VerifyPasswordService } from './verify-password.service.js';
import type { MfaEmailOtpService } from './mfa-email-otp.service.js';
import type { StepUpService } from './step-up.service.js';
import type { EnvConfig } from '../common/env.config.js';
import type { EmailVerificationRow, UserRow } from '../dynamo/types.js';

const OLD_ADDRESS = 'real-owner@example.com';
// A valid-but-hostile quoted local part — verified by hand to pass
// `@IsEmail()`. The user sets THIS as
// the pending new address; the security notice mails to the OLD address.
const HOSTILE_NEW_ADDRESS = '"<b>x</b>"@example.com';
const RAW_TOKEN = 'raw-change-email-token';
const USER_ID = 'u-change-email';

function buildConfig(): ConfigService<EnvConfig, true> {
  const values: Partial<Record<keyof EnvConfig, unknown>> = {
    SES_FROM_ADDRESS: 'owner@example.com',
    WEB_ORIGIN: 'http://localhost:5173',
    TABLE_EMAIL_RESERVATION: 'EmailReservation',
    TABLE_EMAIL_VERIFICATION: 'EmailVerification',
    TABLE_USER: 'User',
    AUTH_MFA_ENFORCED: 'false',
    NODE_ENV: 'test',
    // Force SES "enabled" so confirm() issues a SendEmailCommand we can
    // capture, rather than logging a fingerprint (dev-mode branch).
    SES_ENDPOINT: 'http://localhost:4566',
    EXPOSE_VERIFICATION_TOKEN: 'false',
  };
  return {
    get: (key: keyof EnvConfig) => values[key],
  } as unknown as ConfigService<EnvConfig, true>;
}

function buildService(sesSends: SendEmailCommand[]): ChangeEmailService {
  const ses = {
    send: (cmd: SendEmailCommand) => {
      sesSends.push(cmd);
      return Promise.resolve({});
    },
  } as unknown as SESClient;
  const doc = {
    // The confirm-time swap transaction — its result is never inspected by
    // this test, only that the flow proceeds to the post-commit mail.
    send: jest.fn().mockResolvedValue({}),
  } as unknown as DynamoDBDocumentClient;
  const userRow: UserRow = {
    userId: USER_ID,
    email: OLD_ADDRESS,
    emailLowercase: OLD_ADDRESS.toLowerCase(),
    householdId: USER_ID,
    emailVerifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentResetToken: null,
  };
  const users = {
    findById: jest.fn().mockResolvedValue(userRow),
    swapEmailUpdate: jest.fn(() => ({
      tableName: 'User',
      key: { userId: USER_ID },
      update: {
        UpdateExpression: 'SET email = :email',
        ConditionExpression: 'attribute_exists(userId)',
        ExpressionAttributeValues: { ':email': HOSTILE_NEW_ADDRESS },
      },
    })),
  } as unknown as UsersRepository;
  const verificationRow: EmailVerificationRow = {
    verificationToken: sha256(RAW_TOKEN),
    userId: USER_ID,
    email: HOSTILE_NEW_ADDRESS,
    createdAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    purpose: 'change_email',
  };
  const verifications = {
    findByToken: jest.fn().mockResolvedValue(verificationRow),
    deleteToken: jest.fn().mockResolvedValue(undefined),
  } as unknown as EmailVerificationsRepository;
  const resets = {} as unknown as PasswordResetsRepository;
  const auth = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuthEventsRepository;
  const verifyPasswordSvc = {} as unknown as VerifyPasswordService;
  const mfaEmailOtpSvc = {} as unknown as MfaEmailOtpService;
  const stepUpSvc = {} as unknown as StepUpService;
  return new ChangeEmailService(
    doc,
    ses,
    users,
    verifications,
    resets,
    auth,
    verifyPasswordSvc,
    mfaEmailOtpSvc,
    stepUpSvc,
    buildConfig(),
  );
}

function bodyOf(cmd: SendEmailCommand): { subject: string; text: string; html: string } {
  const msg = cmd.input.Message!;
  return {
    subject: msg.Subject!.Data!,
    text: msg.Body!.Text!.Data!,
    html: msg.Body!.Html!.Data!,
  };
}

describe('ChangeEmailService.confirm — security notice to the old address', () => {
  it('escapes the hostile new address in the HTML body and mails only the old address', async () => {
    const sesSends: SendEmailCommand[] = [];
    const svc = buildService(sesSends);

    const result = await svc.confirm({ token: RAW_TOKEN, ip: null, userAgent: null });

    expect(result).toEqual({ email: HOSTILE_NEW_ADDRESS });
    // Exactly one mail: the security notice (confirm() never calls
    // sendVerificationMail — that runs on request/step-up, not confirm).
    // A test that only checked "no raw <b>" would also pass if no mail were
    // sent at all — assert the send happened.
    expect(sesSends).toHaveLength(1);
    const cmd = sesSends[0]!;
    expect(cmd.input.Destination!.ToAddresses).toEqual([OLD_ADDRESS]);

    const { html } = bodyOf(cmd);
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain(escapeHtml(HOSTILE_NEW_ADDRESS));
  });

  it('leaves the plain-text body and subject unescaped (no over-escaping)', async () => {
    const sesSends: SendEmailCommand[] = [];
    const svc = buildService(sesSends);

    await svc.confirm({ token: RAW_TOKEN, ip: null, userAgent: null });

    const { subject, text } = bodyOf(sesSends[0]!);
    // The plain-text body carries the address verbatim — escaping it would
    // render literal `&quot;` etc. in the reader's mail client.
    expect(text).toContain(HOSTILE_NEW_ADDRESS);
    expect(text).not.toContain(escapeHtml(HOSTILE_NEW_ADDRESS));
    // The subject has no interpolation at all here, and must stay untouched.
    expect(subject).toBe('Your account email was changed');
  });
});
