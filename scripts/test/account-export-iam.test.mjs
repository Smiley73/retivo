// Static IaC contract for the RevokedToken `UserIndex` GSI: infrastructure/src/dynamo.ts and iam.ts are read as text.
// The GSI is declared, its ARN is in the api role's resources, and no other DynamoDB action was added for it.

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
  // The exact action vocabulary of every DynamoDB statement in the api policy.
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
    // Named only in comments, never as a statement action.
    'dynamodb:TransactWriteItems',
    'dynamodb:TransactGetItems',
  ]);
  // The api policy document only: up to the compactor role's declaration.
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
