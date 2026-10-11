/**
 * SignupApprovalService.requestApproval unit tests — the approval-mail
 * content contract.
 *
 * Locks that the owner approval email names the applicant (first + last +
 * email) in both the subject and the body, and that the applicant's
 * birthdate is NEVER included (PII). SES is forced "enabled" via
 * a SES_ENDPOINT config value so the SendEmailCommand is captured rather
 * than logged.
 */
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { SESClient } from '@aws-sdk/client-ses';
import { SendEmailCommand } from '@aws-sdk/client-ses';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { SignupApprovalService } from './signup-approval.service.js';
import { sha256 } from './refresh-token.service.js';
import type { SignupApprovalsRepository } from '../dynamo/signup-approvals.repository.js';
import type { UsersRepository } from '../dynamo/users.repository.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EnvConfig } from '../common/env.config.js';
import type { SignupApprovalRow, UserRow } from '../dynamo/types.js';
import { emailFingerprint } from '../common/email-fingerprint.js';

const BIRTHDATE = '1980-04-15';

function buildConfig(
  overrides: Partial<Record<keyof EnvConfig, unknown>> = {},
): ConfigService<EnvConfig, true> {
  const values: Partial<Record<keyof EnvConfig, unknown>> = {
    SES_FROM_ADDRESS: 'owner@example.com',
    APPROVER_EMAIL: 'owner@example.com',
    WEB_ORIGIN: 'http://localhost:5173',
    // Force SES on so sendApprovalMail issues a SendEmailCommand we can
    // capture (otherwise it only logs the link in non-prod).
    SES_ENDPOINT: 'http://localhost:4566',
    NODE_ENV: 'test',
    TABLE_USER: 'User',
    TABLE_CREDENTIAL: 'Credential',
    TABLE_EMAIL_RESERVATION: 'EmailReservation',
    TABLE_SIGNUP_APPROVAL: 'SignupApproval',
    ...overrides,
  };
  return {
    get: (key: keyof EnvConfig) => values[key],
  } as unknown as ConfigService<EnvConfig, true>;
}

function buildService(sentCommands: SendEmailCommand[]): SignupApprovalService {
  const ses = {
    send: (cmd: SendEmailCommand) => {
      sentCommands.push(cmd);
      return Promise.resolve({});
    },
  } as unknown as SESClient;
  const approvals = {
    insert: jest.fn().mockResolvedValue(undefined),
  } as unknown as SignupApprovalsRepository;
  const users = {} as unknown as UsersRepository;
  const auth = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuthEventsRepository;
  const doc = {} as unknown as DynamoDBDocumentClient;
  return new SignupApprovalService(
    ses,
    doc,
    approvals,
    users,
    auth,
    buildConfig(),
  );
}

function dataOf(cmd: SendEmailCommand): {
  subject: string;
  text: string;
  html: string;
} {
  const msg = cmd.input.Message!;
  return {
    subject: msg.Subject!.Data!,
    text: msg.Body!.Text!.Data!,
    html: msg.Body!.Html!.Data!,
  };
}

describe('SignupApprovalService.requestApproval — approval-mail content', () => {
  it('names the applicant (first + last + email) in the subject and body', async () => {
    const sent: SendEmailCommand[] = [];
    const svc = buildService(sent);

    await svc.requestApproval({
      userId: 'u-1',
      email: 'jane@example.com',
      firstName: 'Jane',
      lastName: 'Smith',
    });

    expect(sent).toHaveLength(1);
    const { subject, text, html } = dataOf(sent[0]);
    expect(subject).toBe('Approve new account: Jane Smith <jane@example.com>');
    expect(text).toContain('Jane Smith <jane@example.com>');
    expect(html).toContain('Jane Smith &lt;jane@example.com&gt;');
  });

  it('never includes the applicant birthdate in the subject or body', async () => {
    const sent: SendEmailCommand[] = [];
    const svc = buildService(sent);

    // requestApproval never receives birthdate; assert defence-in-depth
    // that the rendered mail carries no date-like PII even if a value
    // leaked into scope.
    await svc.requestApproval({
      userId: 'u-2',
      email: 'jane@example.com',
      firstName: 'Jane',
      lastName: 'Smith',
    });

    const { subject, text, html } = dataOf(sent[0]);
    expect(subject).not.toContain(BIRTHDATE);
    expect(text).not.toContain(BIRTHDATE);
    expect(html).not.toContain(BIRTHDATE);
  });

  it('falls back to the bare email when no name was captured (old client)', async () => {
    const sent: SendEmailCommand[] = [];
    const svc = buildService(sent);

    await svc.requestApproval({ userId: 'u-3', email: 'nobody@example.com' });

    const { subject, text } = dataOf(sent[0]);
    expect(subject).toBe('Approve new account: nobody@example.com');
    expect(text).toContain('Applicant: nobody@example.com');
  });

  it('stores sha256(rawToken) at rest and issues/sends only the raw token', async () => {
    const sent: SendEmailCommand[] = [];
    const ses = {
      send: (cmd: SendEmailCommand) => {
        sent.push(cmd);
        return Promise.resolve({});
      },
    } as unknown as SESClient;
    const insert = jest.fn().mockResolvedValue(undefined);
    const approvals = { insert } as unknown as SignupApprovalsRepository;
    const svc = new SignupApprovalService(
      ses,
      {} as unknown as DynamoDBDocumentClient,
      approvals,
      {} as unknown as UsersRepository,
      { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuthEventsRepository,
      buildConfig(),
    );

    const { approvalToken } = await svc.requestApproval({
      userId: 'u-hash',
      email: 'h@example.com',
    });

    // Raw token issued to the caller / mail link: 43-char base64url (32 bytes).
    expect(approvalToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Row stored under the DIGEST, never the raw token.
    expect(insert).toHaveBeenCalledTimes(1);
    const storedRow = insert.mock.calls[0][0] as SignupApprovalRow;
    expect(storedRow.approvalToken).toBe(sha256(approvalToken));
    expect(storedRow.approvalToken).not.toBe(approvalToken);
    // The raw token rides the mail link; the digest never appears in it.
    const { text } = dataOf(sent[0]);
    expect(text).toContain(encodeURIComponent(approvalToken));
    expect(text).not.toContain(sha256(approvalToken));
  });
});

/**
 * SignupApprovalService.approve → sendApprovedNotificationMail unit tests.
 *
 * Locks the best-effort "you're approved" user notice: it goes to the
 * approved user (not the owner), links to `/login`, personalises with the
 * escaped first name, and never lets a SES outage or
 * a user-row read failure break the approval. Dev-mode logs with
 * emailFingerprint instead of sending.
 */
describe('SignupApprovalService.approve — approved-user notification', () => {
  const APPROVAL_TOKEN = 'approval-token-1';
  const USER_ID = 'u-approved';
  const USER_EMAIL = 'newuser@example.com';

  function approvalRow(): SignupApprovalRow {
    return {
      approvalToken: APPROVAL_TOKEN,
      userId: USER_ID,
      email: USER_EMAIL,
      createdAt: new Date().toISOString(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  interface Harness {
    svc: SignupApprovalService;
    sesSends: SendEmailCommand[];
    findByIdMock: jest.Mock;
    setApprovalStatus: jest.Mock;
  }

  function buildApproveHarness(opts: {
    findByIdImpl?: () => Promise<UserRow | null>;
    sesThrows?: boolean;
    sesEnabled?: boolean;
    /** Override the atomic approve transaction's `doc.send` (defaults to a
     *  resolve). Used to drive the ConditionalCheckFailed / transient branches. */
    docSendImpl?: () => Promise<unknown>;
  }): Harness {
    const sesSends: SendEmailCommand[] = [];
    const ses = {
      send: (cmd: SendEmailCommand) => {
        sesSends.push(cmd);
        if (opts.sesThrows) {
          return Promise.reject(new Error('SES is down'));
        }
        return Promise.resolve({});
      },
    } as unknown as SESClient;

    const findByIdMock = jest.fn(
      opts.findByIdImpl ?? (() => Promise.resolve(null)),
    );
    const setApprovalStatus = jest.fn().mockResolvedValue(undefined);
    const approvals = {
      findByToken: jest.fn().mockResolvedValue(approvalRow()),
      deleteToken: jest.fn().mockResolvedValue(undefined),
    } as unknown as SignupApprovalsRepository;
    const users = {
      findById: findByIdMock,
      setApprovalStatus,
      // approve() folds a conditional User update into an atomic
      // TransactWrite via this builder (returns the update parts).
      approveSignupUpdate: jest.fn((userId: string) => ({
        tableName: 'User',
        key: { userId },
        update: {
          UpdateExpression: 'SET approvalStatus = :approved, updatedAt = :now',
          ConditionExpression: 'attribute_exists(userId) AND approvalStatus = :pending',
          ExpressionAttributeValues: {
            ':approved': 'approved',
            ':pending': 'pending',
            ':now': new Date().toISOString(),
          },
        },
      })),
    } as unknown as UsersRepository;
    const auth = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuthEventsRepository;
    // approve()'s atomic delete-token + user-update transaction. Defaults
    // to a clean commit; `docSendImpl` drives the cancellation branches.
    const doc = {
      send: jest.fn(opts.docSendImpl ?? (() => Promise.resolve({}))),
    } as unknown as DynamoDBDocumentClient;

    const svc = new SignupApprovalService(
      ses,
      doc,
      approvals,
      users,
      auth,
      buildConfig(
        opts.sesEnabled === false
          ? { SES_ENDPOINT: undefined, NODE_ENV: 'test' }
          : {},
      ),
    );
    return { svc, sesSends, findByIdMock, setApprovalStatus };
  }

  function bodyOf(cmd: SendEmailCommand): { text: string; html: string } {
    const msg = cmd.input.Message!;
    return { text: msg.Body!.Text!.Data!, html: msg.Body!.Html!.Data! };
  }

  it('notifies the approved user at their own address with a /login link and the escaped first name', async () => {
    const { svc, sesSends } = buildApproveHarness({
      findByIdImpl: () =>
        Promise.resolve({
          userId: USER_ID,
          email: USER_EMAIL,
          firstName: 'A<b>&',
        } as unknown as UserRow),
    });

    const result = await svc.approve(APPROVAL_TOKEN);
    expect(result).toEqual({ userId: USER_ID, email: USER_EMAIL });

    expect(sesSends).toHaveLength(1);
    const cmd = sesSends[0];
    // Recipient is the approved user, NOT the owner.
    expect(cmd.input.Destination!.ToAddresses).toEqual([USER_EMAIL]);
    const { text, html } = bodyOf(cmd);
    expect(text).toContain('http://localhost:5173/login');
    expect(html).toContain('http://localhost:5173/login');
    // First name is escaped in the HTML body and never appears raw.
    expect(html).toContain('Hi A&lt;b&gt;&amp;,');
    expect(html).not.toContain('A<b>&,');
  });

  it('still resolves when the SES send throws (best-effort)', async () => {
    const { svc, sesSends } = buildApproveHarness({
      findByIdImpl: () =>
        Promise.resolve({
          userId: USER_ID,
          email: USER_EMAIL,
          firstName: 'Jane',
        } as unknown as UserRow),
      sesThrows: true,
    });

    await expect(svc.approve(APPROVAL_TOKEN)).resolves.toEqual({
      userId: USER_ID,
      email: USER_EMAIL,
    });
    // A send was attempted (and threw); the approval still succeeded.
    expect(sesSends).toHaveLength(1);
  });

  it('still resolves when the user-row read throws, and sends no mail', async () => {
    const { svc, sesSends, findByIdMock } = buildApproveHarness({
      findByIdImpl: () => Promise.reject(new Error('DynamoDB unavailable')),
    });

    await expect(svc.approve(APPROVAL_TOKEN)).resolves.toEqual({
      userId: USER_ID,
      email: USER_EMAIL,
    });
    expect(findByIdMock).toHaveBeenCalledWith(USER_ID);
    // findById threw before the send — no SES call.
    expect(sesSends).toHaveLength(0);
  });

  it('sends with a generic "Hi," greeting when the user row is absent', async () => {
    const { svc, sesSends } = buildApproveHarness({
      findByIdImpl: () => Promise.resolve(null),
    });

    await svc.approve(APPROVAL_TOKEN);

    expect(sesSends).toHaveLength(1);
    const { text, html } = bodyOf(sesSends[0]);
    expect(text).toContain('Hi,');
    expect(html).toContain('<p>Hi,</p>');
    expect(sesSends[0].input.Destination!.ToAddresses).toEqual([USER_EMAIL]);
  });

  it('sends with a generic "Hi," greeting when firstName is whitespace-only', async () => {
    const { svc, sesSends } = buildApproveHarness({
      findByIdImpl: () =>
        Promise.resolve({
          userId: USER_ID,
          email: USER_EMAIL,
          firstName: '   ',
        } as unknown as UserRow),
    });

    await svc.approve(APPROVAL_TOKEN);

    expect(sesSends).toHaveLength(1);
    const { text, html } = bodyOf(sesSends[0]);
    expect(text).toContain('Hi,');
    expect(html).toContain('<p>Hi,</p>');
  });

  it('maps a ConditionalCheckFailed transaction cancellation to 400 APPROVAL_TOKEN_INVALID', async () => {
    const { svc } = buildApproveHarness({
      docSendImpl: () =>
        Promise.reject(
          new TransactionCanceledException({
            message: 'Transaction cancelled, please refer to CancellationReasons',
            $metadata: {},
            // Item 1 (the conditional User flip) failed — token consumed / user
            // no longer pending (raced with a decline or already approved).
            CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
          }),
        ),
    });

    try {
      await svc.approve(APPROVAL_TOKEN);
      throw new Error('expected approve() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'APPROVAL_TOKEN_INVALID',
      });
    }
  });

  it('maps a surviving transient transaction conflict to 503 APPROVAL_WRITE_CONFLICT', async () => {
    const { svc } = buildApproveHarness({
      // Every attempt cancels for a purely transient reason → runTransactWrite
      // exhausts its bounded retry and throws TransientTransactionError.
      docSendImpl: () =>
        Promise.reject(
          new TransactionCanceledException({
            message: 'Transaction cancelled, please refer to CancellationReasons',
            $metadata: {},
            CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'TransactionConflict' }],
          }),
        ),
    });

    try {
      await svc.approve(APPROVAL_TOKEN);
      throw new Error('expected approve() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
        code: 'APPROVAL_WRITE_CONFLICT',
      });
    }
  });

  it('logs with emailFingerprint and does not call SES in dev mode (sesEnabled=false)', async () => {
    const { svc, sesSends } = buildApproveHarness({
      sesEnabled: false,
      findByIdImpl: () =>
        Promise.resolve({
          userId: USER_ID,
          email: USER_EMAIL,
          firstName: 'Jane',
        } as unknown as UserRow),
    });
    const logSpy = jest
      .spyOn(
        (svc as unknown as { logger: { log: (...a: unknown[]) => void } })
          .logger,
        'log',
      )
      .mockImplementation(() => undefined);

    await svc.approve(APPROVAL_TOKEN);

    expect(sesSends).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    // The dev-mode log now uses structured-object form ({ emailFingerprint, loginLink }).
    const logArg = logSpy.mock.calls[0][0] as { emailFingerprint: string; loginLink: string };
    // Fingerprint, not the raw recipient address (no PII in logs).
    expect(logArg.emailFingerprint).toBe(emailFingerprint(USER_EMAIL));
    expect(logArg.emailFingerprint).not.toContain(USER_EMAIL);
    expect(logArg.loginLink).toContain('http://localhost:5173/login');
  });
});
