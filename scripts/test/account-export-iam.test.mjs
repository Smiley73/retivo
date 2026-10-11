// Static IaC contract for the RevokedToken `UserIndex` GSI (used by the
// full-account export). Reads infrastructure/src/dynamo.ts and
// infrastructure/src/iam.ts as TEXT and asserts: the GSI is declared on the
// RevokedToken table, its ARN is listed in the api role's resource list, and
// no OTHER DynamoDB action was added to the api policy for it. Pulumi resources can't be
// unit-tested directly (no live AWS runtime), so this static contract is what
// actually pins the grant boundary — mirrors
// scripts/test/monitoring-contract.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INFRA = resolve(__dirname, '../../infrastructure/src');
const DYNAMO = readFileSync(resolve(INFRA, 'dynamo.ts'), 'utf8');
const IAM = readFileSync(resolve(INFRA, 'iam.ts'), 'utf8');

test('RevokedToken table declares the UserIndex GSI keyed on userId', () => {
  const at = DYNAMO.indexOf('const revokedToken = new aws.dynamodb.Table(');
  assert.notEqual(at, -1, 'revokedToken table declaration must exist');
  const end = DYNAMO.indexOf('\n  });', at);
  const block = DYNAMO.slice(at, end);
  assert.match(block, /name:\s*"UserIndex"/);
  assert.match(block, /keySchemas:\s*\[\{\s*attributeName:\s*"userId"/);
});

test('the UserIndex GSI projects only jti (base key), kind, revokedAt, expiresAt — never wrappedKey/tokenHash/etc', () => {
  const at = DYNAMO.indexOf('name: "UserIndex"');
  assert.notEqual(at, -1);
  const end = DYNAMO.indexOf('},', at);
  const block = DYNAMO.slice(at, end);
  assert.match(block, /projectionType:\s*"INCLUDE"/);
  assert.match(block, /nonKeyAttributes:\s*\["kind",\s*"revokedAt",\s*"expiresAt"\]/);
});

test('the api role resource list includes the UserIndex GSI ARN', () => {
  assert.match(IAM, /tables\.revokedToken\.arn.*index\/UserIndex/);
});

test('no DynamoDB action beyond the existing set was added to the api policy', () => {
  // The complete, exact action vocabulary the api policy is allowed to use
  // across every DynamoDB statement (DynamoTableActions, ScanLimitedTables,
  // HouseholdSweepBatchWrites, HouseholdKeyEnvelopeActions, MfaSecretPointOps,
  // TrustedDevicePointOpsAndQuery). This deliverable adds
  // a Query-on-GSI read (already covered by the existing `dynamodb:Query`
  // grant) and no new action name.
  const allowedActions = new Set([
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
    'dynamodb:DeleteItem',
    'dynamodb:Query',
    'dynamodb:ConditionCheckItem',
    'dynamodb:DescribeTable',
    'dynamodb:Scan',
    'dynamodb:BatchWriteItem',
    // Named only in comments explaining AWS has no such action to grant/
    // withhold — never an actual statement action. Allow-listed here so
    // that documentation doesn't fail this contract.
    'dynamodb:TransactWriteItems',
    'dynamodb:TransactGetItems',
  ]);
  // Scope to the api role's policy document only: from its `apiPolicyDocument`
  // declaration up to (not including) the compactor role's declaration, which
  // follows the api `RolePolicy` that closes the api policy.
  const start = IAM.indexOf('const apiPolicyDocument');
  const end = IAM.indexOf('const compactorRole = new aws.iam.Role(');
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const apiPolicyBlock = IAM.slice(start, end);
  const found = [...apiPolicyBlock.matchAll(/dynamodb:[A-Za-z]+/g)].map((m) => m[0]);
  assert.ok(found.length > 0, 'expected at least one dynamodb: action in the api policy block');
  for (const action of found) {
    assert.ok(
      allowedActions.has(action),
      `unexpected DynamoDB action ${action} added to the api policy — the full-account export adds no new action, only the UserIndex GSI resource`,
    );
  }
});
