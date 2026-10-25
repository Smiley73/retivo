// Stream-triggered cascade Lambda: on a TTL REMOVE of a SignupApproval row, deletes the still-pending user, credential and email
// reservation in a TransactWrite. Idempotent; standalone, no Nest bootstrap.
import 'reflect-metadata';
import type {
  Context,
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import {
  DynamoDBClient,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

interface UserRow {
  userId: string;
  emailLowercase: string;
  householdId: string;
  approvalStatus?: 'auto_approved' | 'pending' | 'approved' | 'declined';
}

interface CascadeEnv {
  userTable: string;
  credentialTable: string;
  emailReservationTable: string;
  authEventTable: string;
  region: string;
}

let cachedDoc: DynamoDBDocumentClient | undefined;
let cachedEnv: CascadeEnv | undefined;

function getEnv(): CascadeEnv {
  if (cachedEnv) return cachedEnv;
  const required = (key: string): string => {
    const v = process.env[key];
    if (!v) {
      throw new Error(`Missing required env var: ${key}`);
    }
    return v;
  };
  cachedEnv = {
    userTable: required('TABLE_USER'),
    credentialTable: required('TABLE_CREDENTIAL'),
    emailReservationTable: required('TABLE_EMAIL_RESERVATION'),
    authEventTable: required('TABLE_AUTH_EVENT'),
    region: process.env.AWS_REGION ?? 'us-east-1',
  };
  return cachedEnv;
}

function getDoc(): DynamoDBDocumentClient {
  if (cachedDoc) return cachedDoc;
  const env = getEnv();
  const client = new DynamoDBClient({ region: env.region });
  cachedDoc = DynamoDBDocumentClient.from(client);
  return cachedDoc;
}

// True iff the REMOVE came from DynamoDB TTL (`userIdentity.principalId` is dynamodb.amazonaws.com), not an explicit
// api delete.
function isTtlDelete(record: DynamoDBRecord): boolean {
  const userIdentity = (record as DynamoDBRecord & {
    userIdentity?: { type?: string; principalId?: string };
  }).userIdentity;
  return (
    userIdentity?.type === 'Service' &&
    userIdentity?.principalId === 'dynamodb.amazonaws.com'
  );
}

function extractUserId(record: DynamoDBRecord): string | null {
  const oldImage = record.dynamodb?.OldImage;
  const userId = oldImage?.userId?.S;
  return typeof userId === 'string' && userId.length > 0 ? userId : null;
}

async function cascadeDeleteUser(userId: string): Promise<void> {
  const env = getEnv();
  const doc = getDoc();

  const userRes = await doc.send(
    new GetCommand({ TableName: env.userTable, Key: { userId } }),
  );
  const user = userRes.Item as UserRow | undefined;
  if (!user) {
    // Already cleaned up by the api decline path or a prior replay.
    return;
  }

  // Refuse to sweep a user approved between the TTL firing and the cascade running; the conditional Delete below
  // catches it too, but bailing saves a read.
  const status = user.approvalStatus ?? null;
  if (status !== 'pending' && status !== 'declined') return;

  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: env.emailReservationTable,
              Key: { emailLowercase: user.emailLowercase },
              ConditionExpression: 'userId = :u',
              ExpressionAttributeValues: { ':u': user.userId },
            },
          },
          {
            Delete: {
              TableName: env.userTable,
              Key: { userId: user.userId },
              ConditionExpression:
                'attribute_exists(userId) AND (approvalStatus = :pending OR approvalStatus = :declined)',
              ExpressionAttributeValues: {
                ':pending': 'pending',
                ':declined': 'declined',
              },
            },
          },
          {
            Delete: {
              TableName: env.credentialTable,
              Key: { userId: user.userId },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      // Lost the race (approved, or another replay cascaded first); benign.
      return;
    }
    throw err;
  }

  // Best-effort audit: losing the row does not justify failing the batch, which would replay the cascade endlessly.
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    await doc.send(
      new PutCommand({
        TableName: env.authEventTable,
        Item: {
          userId,
          eventId: `${Date.now()}-${randomUUID()}`,
          eventType: 'signup_approval_expired',
          ip: null,
          userAgent: null,
          metadata: { householdId: user.householdId },
          createdAt: new Date().toISOString(),
          // 1-year TTL, matching AuthEventsRepository.
          expiresAt: nowSec + 365 * 24 * 60 * 60,
        },
      }),
    );
  } catch (err) {
    console.warn(
      `signup-cascade: audit write failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export const handler = async (
  event: DynamoDBStreamEvent,
  _context: Context,
): Promise<DynamoDBBatchResponse> => {
  const failures: DynamoDBBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records ?? []) {
    if (record.eventName !== 'REMOVE') continue;
    if (!isTtlDelete(record)) continue;

    const userId = extractUserId(record);
    if (!userId) continue;

    try {
      await cascadeDeleteUser(userId);
    } catch (err) {
      console.error(
        `signup-cascade: cascade failed for ${userId}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      // Partial-batch failure: the EventSourceMapping bisects on function error, so only the offending record retries.
      const sequenceNumber = record.dynamodb?.SequenceNumber;
      if (sequenceNumber) {
        failures.push({ itemIdentifier: sequenceNumber });
      }
    }
  }
  return { batchItemFailures: failures };
};
