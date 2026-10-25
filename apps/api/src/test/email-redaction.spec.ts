// Mail-send failure logs across the auth services emit { userId, emailFingerprint }, never the raw email; Logger.prototype.warn is the capture point.
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

// A realistic SES rejection whose message embeds the raw recipient: the failure logs must log the error class (`err.name`), never
// `err.message`, because `redact` masks by field name and would not scrub an email inside a message string.
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

// The dev-mode (`!sesEnabled`) fallback paths log via `Logger.prototype.log`, not `.warn`.
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
      expect(res.status).toBe(202);
      expect(sendSpy).toHaveBeenCalled();
      expectFingerprintAndNoRawEmail(capture.calls, fp, email);
    } finally {
      capture.restore();
      sendSpy.mockRestore();
    }
  });

  it('resend-verification.service: SES dispatch failure emits emailFingerprint, not raw email', async () => {
    // Back-date `lastVerificationSentAt` past the 60s cooldown so resend actually attempts a send.
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
      // Resend is always 202, never a user-existence oracle.
      expect(res.status).toBe(202);
      expect(sendSpy).toHaveBeenCalled();
      expectFingerprintAndNoRawEmail(capture.calls, fp, email);
    } finally {
      capture.restore();
      sendSpy.mockRestore();
    }
  });

  it('email-verification.service: approval-mail request failure emits emailFingerprint, not raw email', async () => {
    // A foreign-email signup makes verify-email hit the approval-mail dispatch branch.
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
    // Bypasses the HTTP layer and forces the SES send path inside requestApproval to throw; the failure log is what is under test.
    const email = freshEmail();
    const fp = emailFingerprint(email);
    const userId = 'test-' + Math.random().toString(36).slice(2);

    const approvalService = t.module.get(SignupApprovalService);
    // Spying on the private `sendApprovalMail` from the instance runs the failure path without direct SES interaction.
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
    // The failure log lives in the private `afterSend` wrapper; drive it directly with an SES rejection embedding the recipient.
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
    // The failure log lives in the private `afterSend` wrapper; drive it directly with an SES rejection embedding the recipient.
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
    // A pending email-change intent lets the condition-pinned TransactWrite in `mintAndSendToken` commit and reach the mail dispatch, which is forced to reject with the new address embedded.
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
