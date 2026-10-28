#!/usr/bin/env node
/**
 * Read-only operator report: for every user, print name, email, and the
 * timestamp of their most recent successful sign-in (from the AuthEvent
 * table's `login` and `passkey_assert` events). Does not modify any data.
 *
 * Usage:
 *   pnpm --filter @retirement/api last-login-report --stack dev
 *   pnpm --filter @retirement/api last-login-report --stack prod
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/** Stacks this report can target, and the region their tables live in. */
const STACK_REGIONS = { dev: 'us-east-1', prod: 'us-east-1' };

export function parseCliArgs(argv) {
  // `pnpm run <script> -- --stack dev` forwards a literal `--`; drop it.
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    strict: true,
    allowPositionals: false,
    options: {
      stack: { type: 'string' },
    },
  });
  if (!Object.hasOwn(STACK_REGIONS, values.stack ?? '')) {
    throw new Error(
      `--stack must be one of ${Object.keys(STACK_REGIONS).join(', ')} (got ${
        values.stack === undefined ? 'no --stack' : JSON.stringify(values.stack)
      })`,
    );
  }
  return { stack: values.stack };
}

export function resolveTableName(stack, suffix) {
  return `retivo-${stack}-${suffix}`;
}

async function scanAll(doc, ScanCommand, params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await doc.send(new ScanCommand({ ...params, ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * Newest successful sign-in timestamp and total successful sign-in count for
 * one user.
 *
 * Pages through the whole event history rather than reading a single page:
 * DynamoDB applies `FilterExpression` *after* reading each page, so a user with
 * enough non-sign-in events could otherwise return an empty first page and be
 * misreported as never having signed in — and a count from one page would
 * silently undercount.
 */
export async function signInStatsFor(doc, QueryCommand, tableName, userId) {
  let lastSignIn = null;
  let count = 0;
  let ExclusiveStartKey;
  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'userId = :userId',
        FilterExpression: 'eventType IN (:login, :passkey)',
        ExpressionAttributeValues: {
          ':userId': userId,
          ':login': 'login',
          ':passkey': 'passkey_assert',
        },
        // Keeps pages roughly newest-first; `createdAt` below resolves exact
        // ordering because KSUID payloads are random within the same second.
        ScanIndexForward: false,
        ExclusiveStartKey,
      }),
    );
    const items = page.Items ?? [];
    count += items.length;
    for (const item of items) {
      const createdAt = item.createdAt;
      if (typeof createdAt === 'string' && (lastSignIn === null || createdAt > lastSignIn)) {
        lastSignIn = createdAt;
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return { lastSignIn, count };
}

export async function run(stack) {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand, QueryCommand } = await import(
    '@aws-sdk/lib-dynamodb'
  );
  // The stack's own region wins over an unrelated CLI/profile default.
  const region = process.env.AWS_REGION ?? STACK_REGIONS[stack];
  const client = new DynamoDBClient({ region });
  const doc = DynamoDBDocumentClient.from(client);

  const userTable = resolveTableName(stack, 'user');
  const authEventTable = resolveTableName(stack, 'auth-event');

  const users = await scanAll(doc, ScanCommand, {
    TableName: userTable,
    ProjectionExpression: 'userId, email, firstName, lastName',
  });

  const rows = [];
  for (const user of users) {
    const { lastSignIn, count } = await signInStatsFor(
      doc,
      QueryCommand,
      authEventTable,
      user.userId,
    );
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || '(no name on file)';
    rows.push({ name, email: user.email ?? '(no email on file)', lastSignIn, count });
  }

  rows.sort((a, b) => (b.lastSignIn ?? '').localeCompare(a.lastSignIn ?? ''));
  return rows;
}

/**
 * Render a stored UTC ISO timestamp in the operator's local time zone. Returns
 * the raw value unchanged if it is not a parseable date, so a malformed row is
 * visible rather than silently printed as "Invalid Date".
 */
export function formatLocalDateTime(isoTimestamp) {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return isoTimestamp;
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

// A stored name can carry terminal escapes or bidi overrides; Cc and Cf cover both, and a dropped joiner only
// changes how a name prints.
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu;

/**
 * Lay the report out as fixed-width columns sized to their widest cell. Tabs
 * alone render ragged, because a single tab stop cannot absorb the spread
 * between a short name and a long email address.
 */
export function formatTable(header, rows, rightAlign = new Set()) {
  const all = [header, ...rows].map((cells) =>
    cells.map((cell) => cell.replace(UNPRINTABLE, '')),
  );
  const widths = header.map((_, column) =>
    Math.max(...all.map((cells) => cells[column].length)),
  );
  return all.map((cells) =>
    cells
      .map((cell, column) => {
        if (rightAlign.has(column)) return cell.padStart(widths[column]);
        // The last column needs no padding — trailing spaces only add wrap risk.
        return column === cells.length - 1 ? cell : cell.padEnd(widths[column]);
      })
      .join('  '),
  );
}

function printReport(rows) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const header = ['NAME', 'EMAIL', 'SIGN-INS', `LAST SIGN-IN (${timeZone})`];
  const cells = rows.map((row) => [
    row.name,
    row.email,
    String(row.count),
    row.lastSignIn ? formatLocalDateTime(row.lastSignIn) : 'never signed in',
  ]);
  for (const line of formatTable(header, cells, new Set([2]))) console.log(line);
  console.log(`\n${rows.length} user(s) total.`);
}

async function main() {
  let stack;
  try {
    ({ stack } = parseCliArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  const rows = await run(stack);
  printReport(rows);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
