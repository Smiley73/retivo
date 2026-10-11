// Focused tests for the read-only last-login operator report. The fake
// document client verifies the DynamoDB query shape and pagination without
// touching AWS.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signInStatsFor } from './last-login-report.mjs';

class FakeQueryCommand {
  constructor(input) {
    this.input = input;
  }
}

test('signInStatsFor counts both methods and uses createdAt within one KSUID second', async () => {
  const firstPageCursor = { userId: 'user-1', eventId: 'older-page' };
  const pages = [
    {
      Items: [{ eventType: 'passkey_assert', createdAt: '2026-08-19T14:00:00.100Z' }],
      LastEvaluatedKey: firstPageCursor,
    },
    {
      // KSUID ordering is random within a second, so this later createdAt can
      // appear on a later page even though ScanIndexForward is false.
      Items: [{ eventType: 'login', createdAt: '2026-08-19T14:00:00.900Z' }],
      LastEvaluatedKey: undefined,
    },
  ];
  const calls = [];
  const doc = {
    async send(command) {
      calls.push(command.input);
      return pages.shift();
    },
  };

  const result = await signInStatsFor(doc, FakeQueryCommand, 'auth-events', 'user-1');

  assert.deepEqual(result, {
    lastSignIn: '2026-08-19T14:00:00.900Z',
    count: 2,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].FilterExpression, 'eventType IN (:login, :passkey)');
  assert.deepEqual(calls[0].ExpressionAttributeValues, {
    ':userId': 'user-1',
    ':login': 'login',
    ':passkey': 'passkey_assert',
  });
  assert.equal(calls[0].ScanIndexForward, false);
  assert.deepEqual(calls[1].ExclusiveStartKey, firstPageCursor);
});

test('signInStatsFor continues after a filtered page with no matches', async () => {
  const firstPageCursor = { userId: 'user-3', eventId: 'next-page' };
  const pages = [
    { Items: [], LastEvaluatedKey: firstPageCursor },
    {
      Items: [{ eventType: 'passkey_assert', createdAt: '2026-08-19T15:00:00.000Z' }],
      LastEvaluatedKey: undefined,
    },
  ];
  const calls = [];
  const doc = {
    async send(command) {
      calls.push(command.input);
      return pages.shift();
    },
  };

  const result = await signInStatsFor(doc, FakeQueryCommand, 'auth-events', 'user-3');

  assert.deepEqual(result, {
    lastSignIn: '2026-08-19T15:00:00.000Z',
    count: 1,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].ExclusiveStartKey, firstPageCursor);
});

test('signInStatsFor returns no sign-in when all pages are empty', async () => {
  const doc = {
    async send() {
      return { Items: [], LastEvaluatedKey: undefined };
    },
  };

  const result = await signInStatsFor(doc, FakeQueryCommand, 'auth-events', 'user-2');

  assert.deepEqual(result, { lastSignIn: null, count: 0 });
});
