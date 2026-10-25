// Dev-only seed of a pre-verified, auto-approved user into the local emulator, only when DYNAMODB_ENDPOINT is set and NODE_ENV is
// not production. Credentials mirror apps/web/src/lib/dev-credentials.ts.
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { EnvConfig } from '../common/env.config.js';
import type {
  CredentialRow,
  EmailReservationRow,
  UserRow,
} from '../dynamo/types.js';

/** Email + password the local-dev seed inserts. Mirrored on the web side. */
export const LOCAL_DEV_EMAIL = 'dev@local.test';
const LOCAL_DEV_PASSWORD = 'LocalDevPass1!';

export async function ensureLocalDevUser(env: EnvConfig): Promise<'created' | 'exists' | 'skipped'> {
  if (!env.DYNAMODB_ENDPOINT) return 'skipped';
  if (env.NODE_ENV === 'production') return 'skipped';

  const credentials = { accessKeyId: 'local', secretAccessKey: 'local' };
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: env.AWS_REGION,
      endpoint: env.DYNAMODB_ENDPOINT,
      credentials,
    }),
  );

  const emailLowercase = LOCAL_DEV_EMAIL.toLowerCase();

  // Idempotent: an existing reservation means the user is seeded; skip the slow argon2 hash.
  const reservationLookup = await ddb.send(
    new GetCommand({
      TableName: env.TABLE_EMAIL_RESERVATION,
      Key: { emailLowercase },
    }),
  );
  if (reservationLookup.Item) return 'exists';

  const userId = randomUUID();
  const householdId = userId; // 1:1 in v1
  const now = new Date().toISOString();
  const passwordHash = await argon2.hash(LOCAL_DEV_PASSWORD, { type: argon2.argon2id });

  const user: UserRow = {
    userId,
    email: LOCAL_DEV_EMAIL,
    emailLowercase,
    householdId,
    emailVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
    approvalStatus: 'auto_approved',
  };
  const reservation: EmailReservationRow = {
    emailLowercase,
    userId,
    reservedAt: now,
  };
  const credential: CredentialRow = {
    userId,
    argon2Hash: passwordHash,
    updatedAt: now,
    credentialRevision: randomUUID(),
  };

  // Sequential Puts: DynamoDB Local is single-process, and a partial failure is retried by the next `pnpm dev`.
  await ddb.send(
    new PutCommand({
      TableName: env.TABLE_EMAIL_RESERVATION,
      Item: reservation,
      ConditionExpression: 'attribute_not_exists(emailLowercase)',
    }),
  );
  await ddb.send(
    new PutCommand({
      TableName: env.TABLE_USER,
      Item: user,
      ConditionExpression: 'attribute_not_exists(userId)',
    }),
  );
  await ddb.send(
    new PutCommand({
      TableName: env.TABLE_CREDENTIAL,
      Item: credential,
      ConditionExpression: 'attribute_not_exists(userId)',
    }),
  );

  return 'created';
}
