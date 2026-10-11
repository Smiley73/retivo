/**
 * Verifies that SES / mail-send failure logs across the auth services
 * (signup, resend-verification, email-verification approval, signup-approval,
 * mfa-email-otp, password-reset, change-email) emit
 * `{ userId, emailFingerprint }` and not the raw email string. Uses
 * `Logger.prototype.warn` as the capture point — the services all instantiate
 * per-class `new Logger(...)` from `@nestjs/common`, so prototype spying is the
 * single right hook.
 *
 * Each failure is forced with an SES-shaped rejection whose message embeds the
 * raw recipient address (`sesRejectionEmbeddingEmail`), so the negative proof
 * genuinely exercises the `reason: err.name` (not `err.message`) redaction —
 * `redact` masks by field name, so an email baked into a message string would
 * otherwise reach CloudWatch un-scrubbed.
 *
 * The verification covers both directions:
 *   (a) fingerprint of the expected email is present in the captured
 *       log args (presence proof).
 *   (b) the raw email substring is absent from the serialized log args
 *       (negative proof — the requirement is "no raw email", not "fingerprint
 *       is also present").
 */
import request from 'supertest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  STRONG_PASSWORD,
  bootstrapTestApp,
  freshEmail,
  type TestApp,
} from './test-helpers.js';
import { EmailVerificationService } from '../auth/email-verification.service.js';
import { SignupApprovalService } from '../auth/signup-approval.service.js';
import { MfaEmailOtpService } from '../auth/mfa-email-otp.service.js';
import { PasswordResetService } from '../auth/password-reset.service.js';
import { ChangeEmailService } from '../auth/change-email.service.js';
import type { UserRow } from '../dynamo/types.js';
import { emailFingerprint } from '../common/email-fingerprint.js';

interface CapturedCall {
  args: unknown[];
  serialized: string;
}

// A realistic SES send rejection: the AWS error message embeds the raw
// recipient address (e.g. "Email address is not verified: user@example.com").
// The mail-dispatch failure logs must log the error CLASS (`err.name`), never
// `err.message` — `redact` masks by field name, so an email baked into a
// message string would otherwise reach CloudWatch un-scrubbed.
function sesRejectionEmbeddingEmail(email: string): Error {
  return new Error(`Email address is not verified: ${email}`);
}

function captureWarn(): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const spy = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation((...args: unknown[]) => {
      calls.push({ args, serialized: JSON.stringify(args) });
    });
  return { calls, restore: () => spy.mockRestore() };
}

// The dev-mode (`!sesEnabled`) fallback paths log via `Logger.prototype.log`,
// not `.warn` — spy that instead. Same capture shape.
function captureLog(): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const spy = jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation((...args: unknown[]) => {
      calls.push({ args, serialized: JSON.stringify(args) });
    });
  return { calls, restore: () => spy.mockRestore() };
}

function expectFingerprintAndNoRawEmail(
  calls: CapturedCall[],
  expectedFingerprint: string,
  rawEmail: string,
): void {
  const matching = calls.find((c) => c.serialized.includes(expectedFingerprint));
  expect(matching).toBeDefined();
  // Negative proof: the raw email must not appear anywhere in the captured
  // call arguments (incl. nested objects, message strings, etc.).
  for (const c of calls) {
    expect(c.serialized.toLowerCase()).not.toContain(rawEmail.toLowerCase());
  }
}

describe('email redaction in failure logs', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('signup.service: SES dispatch failure emits emailFingerprint, not raw email', async () => {
    const email = freshEmail();
    const fp = emailFingerprint(email);
    const verifyService = t.module.get(EmailVerificationService);
    const sendSpy = jest
      .spyOn(verifyService, 'sendVerificationMail')
      .mockRejectedValueOnce(sesRejectionEmbeddingEmail(email));
    const capture = captureWarn();
    try {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email, password: STRONG_PASSWORD });
      // Signup itself succeeds — the failed SES dispatch is swallowed
      // and logged. The user is created either way.
      expect(res.status).toBe(202);
      expect(sendSpy).toHaveBeenCalled();
      expectFingerprintAndNoRawEmail(capture.calls, fp, email);
    } finally {
      capture.restore();
      sendSpy.mockRestore();
    }
  });

  it('resend-verification.service: SES dispatch failure emits emailFingerprint, not raw email', async () => {
    // Seed an unverified user via signup, then back-date its
    // `lastVerificationSentAt` past the 60s cooldown so the resend
    // endpoint actually attempts a send instead of silently no-oping.
    const email = freshEmail();
    const fp = emailFingerprint(email);
    const signup = await request(t.app.getHttpServer())
      .post('/api/v1/auth/signup')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email, password: STRONG_PASSWORD });
    expect(signup.status).toBe(202);
    const userId = signup.body.userId as string;
    const userTable = t.module
      .get(ConfigService)
      .get('TABLE_USER', { infer: true } as never) as unknown as string;
    const staleSentAtIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await t.doc.send(
      new UpdateCommand({
        TableName: userTable,
        Key: { userId },
        UpdateExpression: 'SET lastVerificationSentAt = :stale',
        ExpressionAttributeValues: { ':stale': staleSentAtIso },
      }),
    );

    const verifyService = t.module.get(EmailVerificationService);
    const sendSpy = jest
      .spyOn(verifyService, 'sendVerificationMail')
      .mockRejectedValueOnce(sesRejectionEmbeddingEmail(email));
    const capture = captureWarn();
    try {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/resend-verification')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email });
      // resend endpoint is always 202 — never a user-existence oracle.
      expect(res.status).toBe(202);
      expect(sendSpy).toHaveBeenCalled();
      expectFingerprintAndNoRawEmail(capture.calls, fp, email);
    } finally {
      capture.restore();
      sendSpy.mockRestore();
    }
  });

  it('email-verification.service: approval-mail request failure emits emailFingerprint, not raw email', async () => {
    // Seed a foreign-email signup so the verify-email step actually
    // hits the approval-mail dispatch branch.
    const email = freshEmail();
    const fp = emailFingerprint(email);
    const signup = await request(t.app.getHttpServer())
      .post('/api/v1/auth/signup')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email, password: STRONG_PASSWORD });
    expect(signup.status).toBe(202);
    const verificationToken = signup.body.verificationToken as string;
    expect(verificationToken).toBeTruthy();

    const approvalService = t.module.get(SignupApprovalService);
    const reqApprovalSpy = jest
      .spyOn(approvalService, 'requestApproval')
      .mockRejectedValueOnce(sesRejectionEmbeddingEmail(email));
    const capture = captureWarn();
    try {
      const res = await request(t.app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: verificationToken });
      // verify-email itself returns 200 — the approval failure is
      // swallowed and logged.
      expect(res.status).toBe(200);
      expect(reqApprovalSpy).toHaveBeenCalled();
      expectFingerprintAndNoRawEmail(capture.calls, fp, email);
    } finally {
      capture.restore();
      reqApprovalSpy.mockRestore();
    }
  });

  it('email-verification.service: dev-mode (!sesEnabled) link log carries neither token nor email', async () => {
    const email = freshEmail();
    const rawToken = 'devtoken-' + Math.random().toString(36).slice(2);
    const verifyService = t.module.get(EmailVerificationService);
    // Force the dev/test fallback branch regardless of the emulator's SES.
    (verifyService as unknown as { sesEnabled: boolean }).sesEnabled = false;
    const capture = captureLog();
    try {
      await verifyService.sendVerificationMail(email, rawToken);
      // A log line was emitted, and it is the fixed argument-free marker.
      expect(capture.calls.length).toBeGreaterThan(0);
      for (const c of capture.calls) {
        expect(c.serialized).not.toContain(rawToken);
        expect(c.serialized.toLowerCase()).not.toContain(email.toLowerCase());
      }
      expect(
        capture.calls.some((c) =>
          c.serialized.includes('verification_link_dev_mode_sent'),
        ),
      ).toBe(true);
    } finally {
      capture.restore();
      (verifyService as unknown as { sesEnabled: boolean }).sesEnabled = true;
    }
  });

  it('signup-approval.service: dev-mode (!sesEnabled) link log carries neither token nor applicant email/name', async () => {
    const email = freshEmail();
    const rawToken = 'approvaltoken-' + Math.random().toString(36).slice(2);
    const firstName = 'Zoltan';
    const lastName = 'Testovich';
    const approvalService = t.module.get(SignupApprovalService);
    (approvalService as unknown as { sesEnabled: boolean }).sesEnabled = false;
    const capture = captureLog();
    try {
      await (
        approvalService as unknown as {
          sendApprovalMail(
            applicantEmail: string,
            token: string,
            name: { firstName?: string; lastName?: string },
          ): Promise<void>;
        }
      ).sendApprovalMail(email, rawToken, { firstName, lastName });
      expect(capture.calls.length).toBeGreaterThan(0);
      for (const c of capture.calls) {
        expect(c.serialized).not.toContain(rawToken);
        expect(c.serialized.toLowerCase()).not.toContain(email.toLowerCase());
        expect(c.serialized).not.toContain(firstName);
        expect(c.serialized).not.toContain(lastName);
      }
      expect(
        capture.calls.some((c) =>
          c.serialized.includes('approval_link_dev_mode_sent'),
        ),
      ).toBe(true);
    } finally {
      capture.restore();
      (approvalService as unknown as { sesEnabled: boolean }).sesEnabled = true;
    }
  });

  it('signup-approval.service: approval-mail dispatch failure emits emailFingerprint, not raw email', async () => {
    // Force the SES send path inside requestApproval to throw. Bypass
    // the HTTP layer; the service is injectable, the failure log is
    // what we're after.
    const email = freshEmail();
    const fp = emailFingerprint(email);
    const userId = 'test-' + Math.random().toString(36).slice(2);

    const approvalService = t.module.get(SignupApprovalService);
    // The private `sendApprovalMail` is reachable via the prototype as
    // an indirect property; spying on it from the instance ensures the
    // failure path runs without any direct SES interaction. The repo
    // `insert` call still runs; we let it write a real row (cleanup is
    // not necessary for log capture).
    const sendApprovalSpy = jest
      .spyOn(
        approvalService as unknown as {
          sendApprovalMail(email: string, token: string): Promise<void>;
        },
        'sendApprovalMail',
      )
      .mockRejectedValueOnce(sesRejectionEmbeddingEmail(email));
    const capture = captureWarn();
    try {
      await approvalService.requestApproval({ userId, email });
      expect(sendApprovalSpy).toHaveBeenCalled();
      expectFingerprintAndNoRawEmail(capture.calls, fp, email);
    } finally {
      capture.restore();
      sendApprovalSpy.mockRestore();
    }
  });

  it('mfa-email-otp.service: code-mail dispatch failure emits emailFingerprint, not raw email', async () => {
    // The failure log lives in the private `afterSend` wrapper; drive it
    // directly with an SES rejection whose message embeds the recipient email.
    const email = freshEmail();
    const fp = emailFingerprint(email);
    const userId = 'test-' + Math.random().toString(36).slice(2);
    const mfaService = t.module.get(MfaEmailOtpService);
    const sendSpy = jest
      .spyOn(
        mfaService as unknown as {
          sendCodeMail(to: string, code: string): Promise<void>;
        },
        'sendCodeMail',
      )
      .mockRejectedValueOnce(sesRejectionEmbeddingEmail(email));
    const capture = captureWarn();
    try {
      await (
        mfaService as unknown as {
          afterSend(email: string, rawCode: string, userId: string): Promise<void>;
        }
      ).afterSend(email, '000000', userId);
      expect(sendSpy).toHaveBeenCalled();
      expectFingerprintAndNoRawEmail(capture.calls, fp, email);
    } finally {
      capture.restore();
      sendSpy.mockRestore();
    }
  });

  it('password-reset.service: mail dispatch failure emits emailFingerprint, not raw email', async () => {
    // The failure log lives in the private `afterSend` wrapper; drive it
    // directly with an SES rejection whose message embeds the recipient email.
    const email = freshEmail();
    const fp = emailFingerprint(email);
    const userId = 'test-' + Math.random().toString(36).slice(2);
    const resetService = t.module.get(PasswordResetService);
    const sendSpy = jest
      .spyOn(
        resetService as unknown as {
          sendResetMail(to: string, token: string): Promise<void>;
        },
        'sendResetMail',
      )
      .mockRejectedValueOnce(sesRejectionEmbeddingEmail(email));
    const capture = captureWarn();
    try {
      await (
        resetService as unknown as {
          afterSend(user: UserRow, newToken: string): Promise<void>;
        }
      ).afterSend({ userId, email } as unknown as UserRow, 'reset-token');
      expect(sendSpy).toHaveBeenCalled();
      expectFingerprintAndNoRawEmail(capture.calls, fp, email);
    } finally {
      capture.restore();
      sendSpy.mockRestore();
    }
  });

  it('change-email.service: verification-mail dispatch failure emits emailFingerprint, not raw email', async () => {
    // Seed a real user with a pending email-change intent so the
    // condition-pinned TransactWrite in `mintAndSendToken` commits and reaches
    // the mail dispatch, then force that dispatch to reject with an SES-shaped
    // error embedding the NEW recipient address.
    const email = freshEmail();
    const newEmail = freshEmail();
    const fp = emailFingerprint(newEmail);
    const signup = await request(t.app.getHttpServer())
      .post('/api/v1/auth/signup')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email, password: STRONG_PASSWORD });
    expect(signup.status).toBe(202);
    const userId = signup.body.userId as string;
    const userTable = t.module
      .get(ConfigService)
      .get('TABLE_USER', { infer: true } as never) as unknown as string;
    await t.doc.send(
      new UpdateCommand({
        TableName: userTable,
        Key: { userId },
        UpdateExpression: 'SET pendingEmail = :pe, pendingEmailLowercase = :pel',
        ExpressionAttributeValues: {
          ':pe': newEmail,
          ':pel': newEmail.toLowerCase(),
        },
      }),
    );

    const changeEmailService = t.module.get(ChangeEmailService);
    const sendSpy = jest
      .spyOn(
        changeEmailService as unknown as {
          sendVerificationMail(to: string, token: string): Promise<void>;
        },
        'sendVerificationMail',
      )
      .mockRejectedValueOnce(sesRejectionEmbeddingEmail(newEmail));
    const capture = captureWarn();
    try {
      await (
        changeEmailService as unknown as {
          mintAndSendToken(user: UserRow): Promise<string>;
        }
      ).mintAndSendToken({
        userId,
        email,
        emailLowercase: email.toLowerCase(),
        pendingEmail: newEmail,
        pendingEmailLowercase: newEmail.toLowerCase(),
      } as unknown as UserRow);
      expect(sendSpy).toHaveBeenCalled();
      expectFingerprintAndNoRawEmail(capture.calls, fp, newEmail);
    } finally {
      capture.restore();
      sendSpy.mockRestore();
    }
  });
});
