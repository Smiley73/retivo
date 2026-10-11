/**
 * EmailVerificationService.consumeToken unit tests — the atomic single-use
 * consume transaction's cancellation mapping.
 *
 * Locks the two error branches of the delete-token + mark-verified
 * `TransactWriteItems`:
 *   - a `ConditionalCheckFailed` cancellation (a superseded / already-consumed
 *     token, or the user's verification handle moved) → `400
 *     VERIFICATION_TOKEN_INVALID`, no writes;
 *   - a transient cancellation that survives the bounded retry → `503
 *     VERIFICATION_WRITE_CONFLICT`.
 *
 * Mirrors the SignupApprovalService.approve harness (signup-approval.service.spec.ts):
 * the atomic transaction's `doc.send` is stubbed to drive each branch.
 */
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { SESClient } from '@aws-sdk/client-ses';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { EmailVerificationService } from './email-verification.service.js';
import { sha256 } from './refresh-token.service.js';
import type { EmailVerificationsRepository } from '../dynamo/email-verifications.repository.js';
import type { UsersRepository } from '../dynamo/users.repository.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { SignupApprovalService } from './signup-approval.service.js';
import type { EnvConfig } from '../common/env.config.js';
import type { EmailVerificationRow } from '../dynamo/types.js';

const RAW_TOKEN = 'raw-verification-token-1';
const USER_ID = 'u-verify';
const USER_EMAIL = 'verify@example.com';

function buildConfig(): ConfigService<EnvConfig, true> {
  const values: Partial<Record<keyof EnvConfig, unknown>> = {
    SES_FROM_ADDRESS: 'owner@example.com',
    WEB_ORIGIN: 'http://localhost:5173',
    TABLE_EMAIL_VERIFICATION: 'EmailVerification',
    TABLE_USER: 'User',
    NODE_ENV: 'test',
  };
  return {
    get: (key: keyof EnvConfig) => values[key],
  } as unknown as ConfigService<EnvConfig, true>;
}

function verificationRow(): EmailVerificationRow {
  return {
    verificationToken: sha256(RAW_TOKEN),
    userId: USER_ID,
    email: USER_EMAIL,
    createdAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    purpose: 'verify_email',
  };
}

/**
 * Build a service whose atomic consume transaction (`doc.send`) is driven by
 * `docSendImpl`. The token lookup resolves a fresh, unexpired `verify_email`
 * row so `consumeToken` reaches the transaction. `findById` is never reached
 * on the cancellation branches (they throw before the post-commit side
 * effects).
 */
function buildService(docSendImpl: () => Promise<unknown>): EmailVerificationService {
  const ses = { send: jest.fn().mockResolvedValue({}) } as unknown as SESClient;
  const doc = {
    send: jest.fn(docSendImpl),
  } as unknown as DynamoDBDocumentClient;
  const verifications = {
    findByToken: jest.fn().mockResolvedValue(verificationRow()),
    deleteToken: jest.fn().mockResolvedValue(undefined),
  } as unknown as EmailVerificationsRepository;
  const users = {
    markEmailVerifiedUpdate: jest.fn((userId: string, at: string, expectedToken: string) => ({
      tableName: 'User',
      key: { userId },
      update: {
        UpdateExpression: 'SET emailVerifiedAt = :at, updatedAt = :at',
        ConditionExpression:
          'attribute_exists(userId) AND currentVerificationToken = :tok',
        ExpressionAttributeValues: { ':at': at, ':tok': expectedToken },
      },
    })),
    findById: jest.fn().mockResolvedValue(null),
  } as unknown as UsersRepository;
  const auth = {
    record: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuthEventsRepository;
  const approval = {
    requestApproval: jest.fn().mockResolvedValue({ approvalToken: 'a' }),
  } as unknown as SignupApprovalService;
  return new EmailVerificationService(
    ses,
    doc,
    verifications,
    users,
    auth,
    approval,
    buildConfig(),
  );
}

describe('EmailVerificationService.consumeToken — atomic consume cancellation mapping', () => {
  it('maps a ConditionalCheckFailed transaction cancellation to 400 VERIFICATION_TOKEN_INVALID', async () => {
    const svc = buildService(() =>
      Promise.reject(
        new TransactionCanceledException({
          message: 'Transaction cancelled, please refer to CancellationReasons',
          $metadata: {},
          // Item 1 (the conditional mark-verified) failed — token consumed /
          // superseded, or the verification handle moved.
          CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
        }),
      ),
    );

    try {
      await svc.consumeToken(RAW_TOKEN);
      throw new Error('expected consumeToken() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'VERIFICATION_TOKEN_INVALID',
      });
    }
  });

  it('maps a surviving transient transaction conflict to 503 VERIFICATION_WRITE_CONFLICT', async () => {
    const svc = buildService(() =>
      // Every attempt cancels for a purely transient reason → runTransactWrite
      // exhausts its bounded retry and throws TransientTransactionError.
      Promise.reject(
        new TransactionCanceledException({
          message: 'Transaction cancelled, please refer to CancellationReasons',
          $metadata: {},
          CancellationReasons: [
            { Code: 'TransactionConflict' },
            { Code: 'TransactionConflict' },
          ],
        }),
      ),
    );

    try {
      await svc.consumeToken(RAW_TOKEN);
      throw new Error('expected consumeToken() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
        code: 'VERIFICATION_WRITE_CONFLICT',
      });
    }
  });
});
