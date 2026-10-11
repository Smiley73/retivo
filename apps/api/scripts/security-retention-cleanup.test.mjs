// Unit tests for the manual legacy-security-row hygiene command.
// Pure/mocked — never touches real AWS: the exported helpers are tested directly and `runCleanup` runs against an in-memory fake
// DynamoDB client. Run under `pnpm test:scripts` (node:test), mirroring the
// sibling build-lambda operator-script test in scripts/test/.
//
// Covers: argument refusal (no mode / non-prod stack / execute-without-confirm
// / unknown flags), exact old-format classification (numeric vs nonnumeric
// expiresAt), redacted report output, conditional-delete failure handling
// (skipped, not miscounted as deleted), postcheck failure reporting, Scan
// pagination accumulation, bounded client timeouts, and effective-region
// resolution. The signup-approval table is deliberately OUT of scope (a direct
// delete would bypass the TTL-only cascade trigger — see the module header).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  RefusalError,
  parseArgs,
  resolveTableName,
  isNonNumericTtl,
  buildTtlDeleteParams,
  runCleanup,
  formatAwsError,
  buildDocClient,
  buildDynamoClientConfig,
  resolveClientRegion,
  TABLE_SPECS,
} from '../scripts/security-retention-cleanup.mjs';

const MFA_TABLE = resolveTableName('prod', 'mfa-email-otp');
const DEVICE_TABLE = resolveTableName('prod', 'trusted-device');

/** A hashed secret value (lowercase-hex SHA-256 → 64 chars) for redaction checks. */
function hashedSecret(seed) {
  return createHash('sha256').update(seed).digest('hex');
}

/**
 * In-memory DynamoDB stand-in. `scans[tableName]` is either a single scan
 * response or an array queue consumed one-per-scan-call (call 1 = initial,
 * call 2 = postcheck). `onDelete(params)` decides 'deleted' | 'skipped'.
 */
function fakeClient({ scans = {}, onDelete } = {}) {
  const scanCalls = [];
  const deleteCalls = [];
  const cursors = {};
  return {
    scanCalls,
    deleteCalls,
    async scan(tableName, projection) {
      scanCalls.push({ tableName, projection });
      const configured = scans[tableName];
      let result;
      if (Array.isArray(configured)) {
        const idx = cursors[tableName] ?? 0;
        result = configured[Math.min(idx, configured.length - 1)];
        cursors[tableName] = idx + 1;
      } else {
        result = configured;
      }
      return result ?? { items: [], scannedCount: 0, consumedCapacityUnits: 0 };
    },
    async conditionalDelete(params) {
      deleteCalls.push(params);
      return onDelete ? onDelete(params) : 'deleted';
    },
  };
}

// ---------- parseArgs — refusal by default ----------

test('parseArgs accepts the dry-run shape', () => {
  assert.deepEqual(parseArgs(['--stack', 'prod', '--dry-run']), {
    stack: 'prod',
    mode: 'dry-run',
  });
});

test('parseArgs accepts the execute shape with confirmation', () => {
  assert.deepEqual(parseArgs(['--stack', 'prod', '--execute', '--confirm-execute']), {
    stack: 'prod',
    mode: 'execute',
  });
});

test('parseArgs refuses with no arguments', () => {
  assert.throws(() => parseArgs([]), RefusalError);
});

test('parseArgs refuses with a mode but no --stack', () => {
  assert.throws(() => parseArgs(['--dry-run']), RefusalError);
});

test('parseArgs refuses a non-production stack', () => {
  assert.throws(() => parseArgs(['--stack', 'dev', '--dry-run']), RefusalError);
  assert.throws(() => parseArgs(['--stack', 'local', '--execute', '--confirm-execute']), RefusalError);
});

test('parseArgs refuses --stack prod with no mode flag', () => {
  assert.throws(() => parseArgs(['--stack', 'prod']), RefusalError);
});

test('parseArgs refuses --execute without --confirm-execute', () => {
  assert.throws(() => parseArgs(['--stack', 'prod', '--execute']), RefusalError);
});

test('parseArgs refuses --confirm-execute without --execute', () => {
  assert.throws(() => parseArgs(['--stack', 'prod', '--confirm-execute']), RefusalError);
});

test('parseArgs refuses ambiguous --dry-run + --execute', () => {
  assert.throws(
    () => parseArgs(['--stack', 'prod', '--dry-run', '--execute', '--confirm-execute']),
    RefusalError,
  );
});

test('parseArgs refuses unknown flags', () => {
  assert.throws(() => parseArgs(['--stack', 'prod', '--dry-run', '--force']), RefusalError);
});

// ---------- old-format classification ----------

test('isNonNumericTtl classifies numeric vs nonnumeric expiresAt', () => {
  assert.equal(isNonNumericTtl(1893456000), false); // valid numeric epoch-second TTL
  assert.equal(isNonNumericTtl('2026-01-01T00:00:00.000Z'), true); // legacy ISO string
  assert.equal(isNonNumericTtl(undefined), false); // missing — never deleted
  assert.equal(isNonNumericTtl(null), false);
});

test('TABLE_SPECS excludes the signup-approval table (TTL-only cascade)', () => {
  // A direct DeleteItem on a SignupApproval row would bypass the TTL-only
  // cascade trigger and strand the pending-signup subgraph — the tool must
  // never target that table.
  const ids = TABLE_SPECS.map((spec) => spec.id);
  assert.deepEqual(ids, ['mfaEmailOtp', 'trustedDevice']);
  assert.ok(!TABLE_SPECS.some((spec) => spec.suffix === 'signup-approval'));
});

test('buildTtlDeleteParams is conditional on a still-nonnumeric expiresAt', () => {
  const params = buildTtlDeleteParams(DEVICE_TABLE, { userId: 'u1', deviceId: 'd1' });
  assert.equal(params.TableName, DEVICE_TABLE);
  assert.deepEqual(params.Key, { userId: 'u1', deviceId: 'd1' });
  assert.equal(
    params.ConditionExpression,
    'attribute_exists(expiresAt) AND NOT attribute_type(expiresAt, :numType)',
  );
  assert.deepEqual(params.ExpressionAttributeValues, { ':numType': 'N' });
});

// ---------- runCleanup: dry-run report + redaction ----------

test('runCleanup dry-run reports eligible counts, deletes nothing, and never prints secrets', async () => {
  const secretEmail = 'victim@example.com';
  const codeHash = hashedSecret('otp-code');
  const tokenHash = hashedSecret('device-secret');

  const client = fakeClient({
    scans: {
      [MFA_TABLE]: {
        items: [
          { userId: 'u1', expiresAt: 1893456000, codeHash }, // valid numeric — ineligible
          { userId: 'u2', expiresAt: '2026-01-01T00:00:00.000Z', codeHash, email: secretEmail }, // legacy — eligible
        ],
        scannedCount: 2,
        consumedCapacityUnits: 1.5,
      },
      [DEVICE_TABLE]: {
        items: [{ userId: 'u3', deviceId: 'd1', expiresAt: '2026-02-01T00:00:00.000Z', tokenHash }],
        scannedCount: 1,
        consumedCapacityUnits: 0.5,
      },
    },
  });

  const lines = [];
  const summary = await runCleanup(client, {
    stack: 'prod',
    mode: 'dry-run',
    region: 'us-east-1',
    log: (l) => lines.push(l),
  });

  assert.equal(client.deleteCalls.length, 0); // dry-run never deletes
  const byId = Object.fromEntries(summary.tables.map((t) => [t.id, t]));
  assert.equal(byId.mfaEmailOtp.eligibleCount, 1);
  assert.equal(byId.trustedDevice.eligibleCount, 1);
  assert.equal(byId.signupApproval, undefined); // signup-approval never scanned
  assert.equal(summary.hadPostcheckFailure, false);

  const blob = lines.join('\n');
  assert.ok(blob.includes('eligibleForDeletion='));
  assert.ok(blob.includes(MFA_TABLE));
  // Redaction: no secrets/emails/hashes in the report.
  for (const secret of [secretEmail, codeHash, tokenHash]) {
    assert.ok(!blob.includes(secret), `report must not print secret value ${secret}`);
  }
});

// ---------- runCleanup: execute + postcheck ----------

test('runCleanup execute deletes eligible rows against prod tables and postcheck reports clean', async () => {
  const client = fakeClient({
    scans: {
      [MFA_TABLE]: [
        { items: [{ userId: 'u2', expiresAt: '2026-01-01T00:00:00.000Z' }], scannedCount: 1, consumedCapacityUnits: 1 },
        { items: [], scannedCount: 0, consumedCapacityUnits: 1 }, // postcheck: clean
      ],
      [DEVICE_TABLE]: [
        { items: [{ userId: 'u3', deviceId: 'd1', expiresAt: '2026-02-01T00:00:00.000Z' }], scannedCount: 1, consumedCapacityUnits: 1 },
        { items: [], scannedCount: 0, consumedCapacityUnits: 1 },
      ],
    },
  });

  const summary = await runCleanup(client, { stack: 'prod', mode: 'execute', region: 'us-east-1' });

  assert.equal(client.deleteCalls.length, 2);
  // Every delete targeted a prod table with a conditional predicate.
  for (const params of client.deleteCalls) {
    assert.ok(params.TableName.startsWith('retivo-prod-'));
    assert.ok(typeof params.ConditionExpression === 'string' && params.ConditionExpression.length > 0);
  }
  const byId = Object.fromEntries(summary.tables.map((t) => [t.id, t]));
  assert.equal(byId.mfaEmailOtp.deletedCount, 1);
  assert.equal(byId.mfaEmailOtp.skippedCount, 0);
  assert.equal(byId.mfaEmailOtp.remainingEligibleCount, 0);
  assert.equal(summary.hadSkips, false);
  assert.equal(summary.hadPostcheckFailure, false);
});

test('runCleanup execute reports a condition-failed delete as skipped, not deleted', async () => {
  const client = fakeClient({
    scans: {
      [MFA_TABLE]: [
        {
          items: [
            { userId: 'u2', expiresAt: '2026-01-01T00:00:00.000Z' },
            { userId: 'u5', expiresAt: '2026-01-03T00:00:00.000Z' },
          ],
          scannedCount: 2,
          consumedCapacityUnits: 1,
        },
        // Postcheck: the concurrently-converted row is now numeric → ineligible.
        { items: [{ userId: 'u5', expiresAt: 1893456000 }], scannedCount: 1, consumedCapacityUnits: 1 },
      ],
    },
    // u5's row was converted to a numeric TTL between scan and delete → skipped.
    onDelete: (params) => (params.Key.userId === 'u5' ? 'skipped' : 'deleted'),
  });

  const summary = await runCleanup(client, { stack: 'prod', mode: 'execute', region: 'us-east-1' });

  const mfa = summary.tables.find((t) => t.id === 'mfaEmailOtp');
  assert.equal(mfa.deletedCount, 1); // only u2
  assert.equal(mfa.skippedCount, 1); // u5 skipped, NOT counted as deleted
  assert.equal(mfa.remainingEligibleCount, 0); // u5 is now numeric, not eligible
  assert.equal(summary.hadSkips, true);
  assert.equal(summary.hadPostcheckFailure, false);
});

test('runCleanup execute flags a postcheck failure when a qualifying row survives', async () => {
  const client = fakeClient({
    scans: {
      [MFA_TABLE]: [
        { items: [{ userId: 'u2', expiresAt: '2026-01-01T00:00:00.000Z' }], scannedCount: 1, consumedCapacityUnits: 1 },
        // Postcheck still finds an old-format row (e.g. condition-check race).
        { items: [{ userId: 'u9', expiresAt: '2026-01-09T00:00:00.000Z' }], scannedCount: 1, consumedCapacityUnits: 1 },
      ],
    },
  });

  const lines = [];
  const summary = await runCleanup(client, {
    stack: 'prod',
    mode: 'execute',
    region: 'us-east-1',
    log: (l) => lines.push(l),
  });

  const mfa = summary.tables.find((t) => t.id === 'mfaEmailOtp');
  assert.equal(mfa.remainingEligibleCount, 1);
  assert.equal(summary.hadPostcheckFailure, true);
  assert.ok(lines.join('\n').includes('WARNING'));
});

// ---------- permission-error reporting ----------

test('formatAwsError surfaces a permission failure with actionable guidance', () => {
  const denied = Object.assign(new Error('User is not authorized to perform: dynamodb:Scan'), {
    name: 'AccessDeniedException',
  });
  const msg = formatAwsError(denied);
  assert.ok(msg.includes('cannot scan/delete'));
  assert.ok(msg.includes('dynamodb:Scan'));

  const generic = Object.assign(new Error('boom'), { name: 'SomeOtherError' });
  assert.equal(formatAwsError(generic), 'error: SomeOtherError: boom');
});

// ---------- buildDocClient — real Scan pagination loop ----------

/** Minimal fake command class: records its input as `.input`, like the SDK. */
class FakeCommand {
  constructor(input) {
    this.input = input;
  }
}

test('buildDocClient.scan follows LastEvaluatedKey and accumulates every page', async () => {
  const sendCalls = [];
  const page1Key = { userId: 'cursor-1' };
  const doc = {
    async send(command) {
      sendCalls.push(command);
      if (sendCalls.length === 1) {
        return {
          Items: [{ userId: 'a' }, { userId: 'b' }],
          ScannedCount: 2,
          ConsumedCapacity: { CapacityUnits: 1.5 },
          LastEvaluatedKey: page1Key,
        };
      }
      return {
        Items: [{ userId: 'c' }],
        ScannedCount: 1,
        ConsumedCapacity: { CapacityUnits: 0.5 },
        LastEvaluatedKey: undefined,
      };
    },
  };

  const client = buildDocClient({ doc, ScanCommand: FakeCommand, DeleteCommand: FakeCommand });
  const result = await client.scan(MFA_TABLE, ['userId', 'expiresAt']);

  // (a) items from both pages accumulate into one result.
  assert.deepEqual(result.items, [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }]);
  // (b) scannedCount + consumedCapacityUnits sum across both pages.
  assert.equal(result.scannedCount, 3);
  assert.equal(result.consumedCapacityUnits, 2);
  // Two Scan calls: the loop ran a second page.
  assert.equal(sendCalls.length, 2);
  // (c) the second Scan carries ExclusiveStartKey === page 1's LastEvaluatedKey.
  assert.equal(sendCalls[0].input.ExclusiveStartKey, undefined);
  assert.equal(sendCalls[1].input.ExclusiveStartKey, page1Key);
});

test('buildDocClient.conditionalDelete maps a ConditionalCheckFailed to skipped', async () => {
  const doc = {
    async send() {
      throw Object.assign(new Error('condition failed'), {
        name: 'ConditionalCheckFailedException',
      });
    },
  };
  const client = buildDocClient({ doc, ScanCommand: FakeCommand, DeleteCommand: FakeCommand });
  assert.equal(await client.conditionalDelete({ TableName: MFA_TABLE }), 'skipped');
});

// ---------- bounded client timeouts ----------

test('buildDynamoClientConfig wires bounded request + connection timeouts', () => {
  const config = buildDynamoClientConfig('us-east-1');
  assert.equal(config.region, 'us-east-1');
  assert.ok(config.requestHandler.requestTimeout > 0);
  assert.ok(config.requestHandler.connectionTimeout > 0);
  // Absent region is threaded as no region key (SDK resolves from the chain),
  // but the timeouts are always present.
  const noRegion = buildDynamoClientConfig(undefined);
  assert.ok(!('region' in noRegion));
  assert.ok(noRegion.requestHandler.requestTimeout > 0);
  assert.ok(noRegion.requestHandler.connectionTimeout > 0);
});

// ---------- effective-region resolution ----------

test('resolveClientRegion reports the region the client actually resolved', async () => {
  // Client's config chain resolves a real region even though AWS_REGION is unset.
  const client = { config: { region: async () => 'ap-southeast-2' } };
  assert.equal(await resolveClientRegion(client), 'ap-southeast-2');
});

test('resolveClientRegion returns undefined when no region resolves', async () => {
  const rejects = { config: { region: async () => {
    throw new Error('Region is missing');
  } } };
  assert.equal(await resolveClientRegion(rejects), undefined);

  const blank = { config: { region: async () => '' } };
  assert.equal(await resolveClientRegion(blank), undefined);
});
