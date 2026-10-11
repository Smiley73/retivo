/**
 * Dev-only user seed for the local emulator stack.
 *
 * Idempotently inserts a pre-verified, auto-approved user into the
 * local DynamoDB so a fresh `pnpm emu:up` + `pnpm dev` skips the whole
 * signup → email-verify → approval dance during day-to-day development.
 *
 * Gate: only runs when `DYNAMODB_ENDPOINT` is set (= local emulator)
 * **and** `NODE_ENV !== 'production'`. The Lambda never calls this — `lambda.ts` has its own
 * bootstrap path. Jest tests don't either; this is a `main.ts`-only
 * surface so test isolation is unaffected.
 *
 * The web side mirrors the same `LOCAL_DEV_EMAIL` /
 * `LOCAL_DEV_PASSWORD` pair in `apps/web/src/lib/dev-credentials.ts` so
 * the auth fields pre-fill under a dev build (`import.meta.env.DEV`) when
 * the SPA is loaded from a local host (`localhost` / `127.0.0.1` or an
 * RFC1918 private IPv4). Keep them in sync if you change either side.
 */
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

  // Idempotency: if a reservation already exists for this email, the
  // user is already seeded. Skip without re-hashing the password
  // (argon2 is intentionally slow).
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
    // Fresh opaque revision — every
    // credential write mints one.
    credentialRevision: randomUUID(),
  };

  // Three sequential Puts — DynamoDB Local is single-process, so
  // ordering is enough; we don't need TransactWriteItems' atomicity
  // for a one-shot dev seed. If a partial failure leaves a half-state
  // behind, the next `pnpm dev` retries the missing pieces.
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
