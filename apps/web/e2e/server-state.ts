/**
 * Purges the household-scoped DynamoDB Local rows between tests; User, Credential and auth tables stay so the seeded dev login survives.
 * Table names are the API's local-dev defaults (`.env.example`).
 */
import {
  DynamoDBClient,
  ScanCommand,
  BatchWriteItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';

const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

interface PurgeTable {
  name: string;
  keyAttrs: string[];
}

const HOUSEHOLD_TABLES: PurgeTable[] = [
  { name: 'retirement-local-workspace-meta', keyAttrs: ['householdId'] },
  { name: 'retirement-local-mutation-log', keyAttrs: ['householdId', 'sequenceId'] },
  { name: 'retirement-local-aggregate-version', keyAttrs: ['householdId', 'aggregateId'] },
  { name: 'retirement-local-idempotency-key', keyAttrs: ['key'] },
  { name: 'retirement-local-device-registry', keyAttrs: ['householdId', 'deviceId'] },
  { name: 'retirement-local-household-key-envelope', keyAttrs: ['householdId', 'slotId'] },
];

let client: DynamoDBClient | null = null;

function ddb(): DynamoDBClient {
  client ??= new DynamoDBClient({
    endpoint: ENDPOINT,
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  return client;
}

/** One scan + batch-delete sweep; returns how many rows it saw. */
async function purgeOnce(): Promise<number> {
  let seen = 0;
  for (const t of HOUSEHOLD_TABLES) {
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const r = await ddb().send(
        new ScanCommand({
          TableName: t.name,
          ExclusiveStartKey: lastKey,
          ProjectionExpression: t.keyAttrs.map((_, i) => `#k${i}`).join(', '),
          ExpressionAttributeNames: Object.fromEntries(
            t.keyAttrs.map((a, i) => [`#k${i}`, a]),
          ),
        }),
      );
      const items = r.Items ?? [];
      seen += items.length;
      // BatchWriteItem caps at 25 deletes per call.
      for (let i = 0; i < items.length; i += 25) {
        let requests = items.slice(i, i + 25).map((it) => ({
          DeleteRequest: {
            Key: Object.fromEntries(
              t.keyAttrs.map((k) => [k, it[k]]),
            ) as Record<string, AttributeValue>,
          },
        }));
        // Resubmit UnprocessedItems: dropping them leaves rows behind.
        while (requests.length > 0) {
          const w = await ddb().send(
            new BatchWriteItemCommand({ RequestItems: { [t.name]: requests } }),
          );
          requests = (w.UnprocessedItems?.[t.name] ?? []) as typeof requests;
        }
      }
      lastKey = r.LastEvaluatedKey;
    } while (lastKey);
  }
  return seen;
}

/** Sweep the household tables until a full pass finds nothing: a single scan+delete races concurrent writers (a closing page's final push, the compactor). */
export async function purgeHouseholdState(): Promise<void> {
  const MAX_PASSES = 8;
  for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
    const seen = await purgeOnce();
    if (seen === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250 * pass));
  }
  throw new Error(
    `purgeHouseholdState: tables still repopulating after ${MAX_PASSES} passes — is something writing to the household continuously?`,
  );
}
