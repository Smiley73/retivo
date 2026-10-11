#!/usr/bin/env node
/**
 * Manually invoked, one-time operator hygiene command. Permanently deletes the
 * invalid OLD-FORMAT security rows that an earlier clean cutover to numeric TTLs
 * deliberately orphaned — it never converts, dual-reads, or retains them.
 * The operator procedure is in AGENTS.md, "Legacy security-row hygiene".
 *
 * SAFETY MODEL — this command can permanently delete production data. It is a
 * standalone script only: it NEVER runs from application startup, a Lambda
 * handler, a deployment script, CI, or a schedule, and it refuses by default.
 * Two separate, explicit approval gates stand between it and a real delete:
 *   1. `--stack prod --dry-run` — report only (owner approves this first).
 *   2. `--stack prod --execute --confirm-execute` — perform deletes (owner
 *      gives a second, separate approval quoting the dry-run counts).
 * Any other invocation shape (no `--stack`, a non-`prod` stack, `--execute`
 * without `--confirm-execute`, no mode flag, unknown flags) refuses with a
 * clear message and a non-zero exit, doing NO scanning or deletion.
 *
 * WHAT IS ELIGIBLE (exact — never widened):
 *   - `MfaEmailOtp` / `TrustedDevice` rows whose `expiresAt` is present but
 *     NONNUMERIC (a legacy ISO-8601 string). A valid numeric epoch-second TTL
 *     row, or a row with no `expiresAt` at all, is never touched.
 *
 * NOT IN SCOPE — legacy signup-approval rows are deliberately EXCLUDED. A
 * direct application-issued DeleteItem on a SignupApproval row would bypass the
 * TTL-only cascade trigger: the household-cleanup cascade
 * (apps/api/src/signup-cascade-lambda.ts) processes only REMOVE stream events
 * attributed to DynamoDB's own TTL sweep and skips any application delete (see
 * `isTtlDelete()`), so deleting the row here would strand the associated
 * pending User/Credential/EmailReservation rows forever — exactly the hazard
 * documented in apps/api/src/auth/signup-approval.service.ts's `loadAndValidate`
 * comment. Legacy signup-approval rows are left to DynamoDB's native TTL sweep,
 * which fires the cascade and cleans up the full pending-signup subgraph safely.
 *
 * Every delete is CONDITIONAL on the row still matching the old-format
 * predicate at write time, so a row concurrently converted/rewritten between
 * scan and delete is safely skipped (reported as "modified since scan"), never
 * blindly erased. After `--execute` a redacted postcheck re-scans and reports
 * that zero old-format rows remain (a nonzero count is an explicit failure).
 *
 * The report is REDACTED: only table names, region/stack, counts, and consumed
 * capacity are printed — never secrets, emails, device/approval tokens, hashes,
 * or raw row bodies.
 *
 * Credentials come from the OPERATOR's standard AWS SDK credential chain (no
 * hardcoded role, no application-role assumption, no new IAM permission). If
 * that identity cannot Scan/DeleteItem the two tables, the command aborts
 * cleanly with the permission error.
 *
 * Usage (only these two shapes are accepted):
 *   pnpm --filter @retirement/api security:legacy-data-hygiene -- --stack prod --dry-run
 *   pnpm --filter @retirement/api security:legacy-data-hygiene -- --stack prod --execute --confirm-execute
 */
import { parseArgs as nodeParseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/** Thrown when the invocation is refused before any AWS I/O. */
export class RefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RefusalError';
  }
}

/**
 * Parse + validate the CLI flags, refusing by default. Returns
 * `{ stack: 'prod', mode: 'dry-run' | 'execute' }` for the two accepted
 * shapes; throws {@link RefusalError} (no AWS I/O) for anything else.
 */
export function parseArgs(argv) {
  let values;
  try {
    ({ values } = nodeParseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        stack: { type: 'string' },
        'dry-run': { type: 'boolean' },
        execute: { type: 'boolean' },
        'confirm-execute': { type: 'boolean' },
      },
    }));
  } catch (err) {
    throw new RefusalError(
      `unrecognized or malformed arguments (${err.message}). Accepted: ` +
        '`--stack prod --dry-run` OR `--stack prod --execute --confirm-execute`.',
    );
  }

  if (values.stack !== 'prod') {
    throw new RefusalError(
      `--stack must be exactly "prod" (got ${
        values.stack === undefined ? 'no --stack' : JSON.stringify(values.stack)
      }). This one-time hygiene command only targets the production stack.`,
    );
  }

  const dryRun = values['dry-run'] === true;
  const execute = values.execute === true;
  const confirm = values['confirm-execute'] === true;

  if (dryRun && execute) {
    throw new RefusalError(
      '--dry-run and --execute are mutually exclusive; choose exactly one mode.',
    );
  }
  if (dryRun) {
    if (confirm) {
      throw new RefusalError('--confirm-execute is only valid together with --execute.');
    }
    return { stack: 'prod', mode: 'dry-run' };
  }
  if (execute) {
    if (!confirm) {
      throw new RefusalError(
        '--execute requires --confirm-execute (the second, separate approval gate). ' +
          'Run --dry-run first, review the reported counts, then re-run with both flags.',
      );
    }
    return { stack: 'prod', mode: 'execute' };
  }
  throw new RefusalError(
    'no mode flag. Pass --dry-run (report only) or --execute --confirm-execute (perform deletes).',
  );
}

/**
 * Deployed DynamoDB table name for a stack, mirroring
 * `namePrefix(stack)` + the per-table suffix in `infrastructure/src/dynamo.ts`
 * (the single source of truth for deployed names). Not a new config mechanism.
 */
export function resolveTableName(stack, suffix) {
  return `retivo-${stack}-${suffix}`;
}

/**
 * True iff `expiresAt` is present but NOT a number — the legacy ISO-8601 string
 * form the old rows carried. A DynamoDB Scan through the document client
 * unmarshals a numeric epoch-second TTL to a JS `number` and a legacy ISO value
 * to a JS `string`, so a type check distinguishes old from new. A valid numeric
 * TTL, and a row missing `expiresAt` entirely, are both ineligible (conservative
 * — the tool never deletes an ambiguous row).
 */
export function isNonNumericTtl(expiresAt) {
  return expiresAt !== undefined && expiresAt !== null && typeof expiresAt !== 'number';
}

/**
 * Conditional-delete params for a TTL row (OTP / trusted-device): delete only
 * if `expiresAt` is still present and still nonnumeric. A row concurrently
 * converted to a numeric TTL between scan and delete fails the condition and is
 * skipped, never erased.
 */
export function buildTtlDeleteParams(tableName, key) {
  return {
    TableName: tableName,
    Key: key,
    ConditionExpression: 'attribute_exists(expiresAt) AND NOT attribute_type(expiresAt, :numType)',
    ExpressionAttributeValues: { ':numType': 'N' },
  };
}

/**
 * The two tables in scope, each with the exact old-format predicate, the
 * key/projection needed to classify + delete, and the conditional-delete
 * params. Projections fetch only the key + the classifying attribute — never a
 * secret/token/email/hash — so nothing sensitive is ever read into memory or a
 * log line. The signup-approval table is deliberately absent — see the
 * "NOT IN SCOPE" note in the module header (a direct delete would bypass the
 * TTL-only cascade trigger and strand the pending-signup subgraph).
 */
export const TABLE_SPECS = [
  {
    id: 'mfaEmailOtp',
    suffix: 'mfa-email-otp',
    projection: ['userId', 'expiresAt'],
    isEligible: (item) => isNonNumericTtl(item.expiresAt),
    deleteParams: (tableName, item) => buildTtlDeleteParams(tableName, { userId: item.userId }),
  },
  {
    id: 'trustedDevice',
    suffix: 'trusted-device',
    projection: ['userId', 'deviceId', 'expiresAt'],
    isEligible: (item) => isNonNumericTtl(item.expiresAt),
    deleteParams: (tableName, item) =>
      buildTtlDeleteParams(tableName, { userId: item.userId, deviceId: item.deviceId }),
  },
];

/**
 * Orchestrate the scan / (execute) delete / postcheck over the injected
 * `client`. Pure of the AWS SDK — `client` is either the real wrapper from
 * {@link createAwsClient} or a test double. The `log` sink only ever receives
 * redacted count/metadata lines. Returns a structured summary.
 *
 * @param {{ scan: (t: string, p: string[]) => Promise<{items: object[], scannedCount: number, consumedCapacityUnits: number}>, conditionalDelete: (params: object) => Promise<'deleted'|'skipped'> }} client
 * @param {{ stack: string, mode: 'dry-run'|'execute', region?: string, log?: (line: string) => void }} opts
 */
export async function runCleanup(client, { stack, mode, region, log = () => {} }) {
  const regionLabel = region ?? '(default AWS SDK credential/region chain)';
  log(`security-retention-cleanup: stack=${stack} region=${regionLabel} mode=${mode}`);
  log(
    'Report is redacted — only table names, counts, and consumed capacity are ' +
      'printed; never keys, tokens, emails, hashes, or row bodies.',
  );

  const tables = [];
  let hadSkips = false;

  for (const spec of TABLE_SPECS) {
    const tableName = resolveTableName(stack, spec.suffix);
    const scan = await client.scan(tableName, spec.projection);
    const eligible = scan.items.filter((item) => spec.isEligible(item));
    const entry = {
      id: spec.id,
      tableName,
      scannedCount: scan.scannedCount,
      consumedCapacityUnits: scan.consumedCapacityUnits,
      eligibleCount: eligible.length,
    };
    log(
      `  [${spec.id}] table=${tableName} scannedItems=${entry.scannedCount} ` +
        `consumedCapacityUnits=${entry.consumedCapacityUnits} ` +
        `eligibleForDeletion=${entry.eligibleCount}`,
    );

    if (mode === 'execute') {
      let deleted = 0;
      let skipped = 0;
      for (const item of eligible) {
        const outcome = await client.conditionalDelete(spec.deleteParams(tableName, item));
        if (outcome === 'deleted') deleted += 1;
        else skipped += 1;
      }
      entry.deletedCount = deleted;
      entry.skippedCount = skipped;
      if (skipped > 0) hadSkips = true;
      log(
        `  [${spec.id}] deleted=${deleted} ` +
          `skipped(condition-failed, modified since scan)=${skipped}`,
      );
    }

    tables.push(entry);
  }

  let hadPostcheckFailure = false;
  if (mode === 'execute') {
    log('Postcheck: re-scanning for any remaining old-format rows (expect zero).');
    for (const spec of TABLE_SPECS) {
      const tableName = resolveTableName(stack, spec.suffix);
      const scan = await client.scan(tableName, spec.projection);
      const remaining = scan.items.filter((item) => spec.isEligible(item)).length;
      const entry = tables.find((t) => t.id === spec.id);
      entry.remainingEligibleCount = remaining;
      if (remaining > 0) {
        hadPostcheckFailure = true;
        log(
          `  [${spec.id}] WARNING: ${remaining} old-format row(s) still present ` +
            'after execute — investigate before declaring the hygiene job complete.',
        );
      } else {
        log(`  [${spec.id}] clean: 0 old-format rows remain.`);
      }
    }
  }

  log(
    `Done. ${
      mode === 'execute'
        ? hadPostcheckFailure
          ? 'Postcheck FAILED — see warnings above.'
          : 'Postcheck clean.'
        : 'Dry-run only — no rows were deleted.'
    }`,
  );

  return { stack, region: regionLabel, mode, tables, hadSkips, hadPostcheckFailure };
}

/** Human-readable message for an AWS failure, calling out permission problems. */
export function formatAwsError(err) {
  const name = err?.name ?? 'Error';
  const message = err?.message ?? String(err);
  if (/AccessDenied|NotAuthorized|UnrecognizedClient|CredentialsProviderError|ExpiredToken/i.test(name)) {
    return (
      `error: the configured AWS identity cannot scan/delete the target tables ` +
      `(${name}: ${message}). Use an operator identity with dynamodb:Scan + ` +
      `dynamodb:DeleteItem on the two tables and retry.`
    );
  }
  return `error: ${name}: ${message}`;
}

// Bulk operator script — bound every outbound Scan/DeleteItem so a stalled
// socket can never leave an `--execute` run indefinitely suspended after a
// partial delete. The AWS SDK v3 Node HTTP handler applies NO request timeout
// by default. Sized generously (this is an offline bulk sweep, not the
// sub-5s sync request path) and mirrors the inline `requestHandler` pattern in
// apps/api/src/aws/aws.module.ts.
export const DYNAMO_REQUEST_TIMEOUT_MS = 30_000;
export const DYNAMO_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Config object passed to `new DynamoDBClient(...)`. Exported (pure, no AWS
 * dependency) so a test can assert the bounded timeouts are wired without a
 * live SDK. `region` is threaded through only when defined; when absent the SDK
 * resolves it from the standard credential/config chain.
 */
export function buildDynamoClientConfig(region) {
  return {
    ...(region ? { region } : {}),
    requestHandler: {
      requestTimeout: DYNAMO_REQUEST_TIMEOUT_MS,
      connectionTimeout: DYNAMO_CONNECTION_TIMEOUT_MS,
    },
  };
}

/**
 * Resolve the region the constructed client will ACTUALLY target. In AWS SDK
 * v3 `client.config.region` is a resolver (usually async) that walks the same
 * credential/config chain the client uses, so the operator-facing report shows
 * the true destructive target rather than a blank `AWS_REGION` env var while
 * the client silently resolves a different region from `~/.aws/config`.
 * Returns `undefined` when no region resolves (reported as the default-chain
 * label) — the resolver rejects when nothing is configured, which is the
 * legitimate "no explicit region" case, not an error to surface.
 */
export async function resolveClientRegion(client) {
  try {
    const region = await client.config.region();
    return typeof region === 'string' && region.length > 0 ? region : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wrap a DynamoDB document client + its command constructors into the
 * `{ scan, conditionalDelete }` shape {@link runCleanup} consumes. Extracted
 * and exported so the Scan pagination loop can be unit-tested against a fake
 * `doc`/command pair without a live AWS SDK.
 *
 * @param {{ doc: { send: (cmd: object) => Promise<object> }, ScanCommand: new (input: object) => object, DeleteCommand: new (input: object) => object }} deps
 */
export function buildDocClient({ doc, ScanCommand, DeleteCommand }) {
  return {
    async scan(tableName, projection) {
      const names = {};
      const projectionExpression = projection
        .map((attr, i) => {
          const placeholder = `#a${i}`;
          names[placeholder] = attr;
          return placeholder;
        })
        .join(', ');
      const items = [];
      let scannedCount = 0;
      let consumedCapacityUnits = 0;
      let ExclusiveStartKey;
      do {
        const r = await doc.send(
          new ScanCommand({
            TableName: tableName,
            ProjectionExpression: projectionExpression,
            ExpressionAttributeNames: names,
            ExclusiveStartKey,
            ReturnConsumedCapacity: 'TOTAL',
          }),
        );
        for (const item of r.Items ?? []) items.push(item);
        scannedCount += r.ScannedCount ?? 0;
        consumedCapacityUnits += r.ConsumedCapacity?.CapacityUnits ?? 0;
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return { items, scannedCount, consumedCapacityUnits };
    },
    async conditionalDelete(params) {
      try {
        await doc.send(new DeleteCommand(params));
        return 'deleted';
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') return 'skipped';
        throw err;
      }
    },
  };
}

/**
 * Build the real DynamoDB-backed client. The AWS SDK is imported lazily here so
 * the module (and its pure, exported predicates) can be unit-tested without any
 * AWS dependency. Credentials/region come from the standard SDK chain; requests
 * are time-bounded via {@link buildDynamoClientConfig}. Returns the
 * `{ scan, conditionalDelete }` wrapper plus `resolvedRegion` — the region the
 * client actually resolved, for the operator-facing report.
 */
async function createAwsClient({ region }) {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand, DeleteCommand } = await import(
    '@aws-sdk/lib-dynamodb'
  );
  const client = new DynamoDBClient(buildDynamoClientConfig(region));
  const doc = DynamoDBDocumentClient.from(client);
  const resolvedRegion = await resolveClientRegion(client);
  return { resolvedRegion, ...buildDocClient({ doc, ScanCommand, DeleteCommand }) };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof RefusalError) {
      process.stderr.write(`refusing: ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const region = process.env.AWS_REGION;
  try {
    const client = await createAwsClient({ region });
    const summary = await runCleanup(client, {
      stack: opts.stack,
      mode: opts.mode,
      // Report the region the client ACTUALLY resolved, not the raw env var —
      // an unset AWS_REGION lets the SDK resolve a real region from the
      // credential/config chain, and the operator report must show the true
      // destructive target.
      region: client.resolvedRegion,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    if (summary.hadPostcheckFailure) process.exitCode = 1;
  } catch (err) {
    process.stderr.write(`${formatAwsError(err)}\n`);
    process.exitCode = 1;
  }
}

// Standalone-only: run solely when invoked directly as a script, never on
// import (so the app, tests, and any tooling can import the pure helpers above
// with zero side effects and no AWS SDK dependency).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
