/**
 * Server-side state reset for the e2e suite.
 *
 * The suite runs against a real local API (emulator-backed `pnpm dev`
 * stack) signed in as the seeded dev user, so per-test independence
 * needs the household-scoped server state wiped between tests — local
 * IndexedDB wipes alone would just re-pull the previous test's data on
 * the next bootstrap. Purging the key envelope also re-arms the
 * first-time encryption setup, which is what hands each test the
 * fresh, unkeyed household the first-run demo flow expects.
 *
 * Deliberately NOT purged: User / Credential / EmailReservation /
 * RefreshToken / auth tables — the seeded `dev@local.test` login the
 * fixture depends on lives there (the fixture's `clearCookies` already
 * drops the browser's session).
 *
 * Table names are the API's local-dev defaults (see `.env.example` —
 * `retirement-local-*`); DynamoDB Local runs `-sharedDb` so the fake
 * credentials below are accepted.
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
        // Re-submit UnprocessedItems until the batch fully lands —
        // dropping them silently leaves rows behind and the next
        // bootstrap pulls the "purged" data right back.
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

/**
 * Purge every row of the household-scoped tables, then KEEP sweeping
 * until a full pass finds nothing. A single scan+delete races
 * concurrent writers — the previous test's just-closed page draining
 * its final push, or the API's janitor/compactor rewriting the
 * mutation log — and rows written behind the scan resurrect the
 * "purged" household on the next bootstrap. (Observed in CI as the
 * first-run demo modal never opening: leftover members make the app
 * treat the workspace as established.)
 */
export async function purgeHouseholdState(): Promise<void> {
  const MAX_PASSES = 8;
  for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
    const seen = await purgeOnce();
    if (seen === 0) return;
    // Rows existed this pass — give any in-flight writer a beat to
    // finish, then sweep again until a clean pass proves quiescence.
    await new Promise((resolve) => setTimeout(resolve, 250 * pass));
  }
  throw new Error(
    `purgeHouseholdState: tables still repopulating after ${MAX_PASSES} passes — is something writing to the household continuously?`,
  );
}
