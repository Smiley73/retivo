/**
 * Integration tests for `MfaEmailOtpRepository` against DynamoDB Local.
 * Covers the get/put/delete contract:
 *  - get on a missing row returns null;
 *  - put round-trips the live code-hash row;
 *  - delete removes the row.
 *
 * Uses fresh userIds per case so suites stay independent on the shared
 * DynamoDB Local instance.
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTestApp, type TestApp } from '../test/test-helpers.js';
import { MfaEmailOtpRepository } from './mfa-email-otp.repository.js';
import type { MfaEmailOtpRow } from './types.js';

describe('MfaEmailOtpRepository', () => {
  let t: TestApp;
  let repo: MfaEmailOtpRepository;

  beforeAll(async () => {
    t = await bootstrapTestApp();
    repo = t.module.get(MfaEmailOtpRepository);
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('returns null for a user with no outstanding code', async () => {
    expect(await repo.get(randomUUID())).toBeNull();
  });

  it('round-trips a live code-hash row through put + get (numeric epoch-second TTL)', async () => {
    const userId = randomUUID();
    const row: MfaEmailOtpRow = {
      userId,
      codeHash: 'a'.repeat(64),
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      sentAt: '2026-06-12T00:00:00.000Z',
      attempts: 0,
    };
    await repo.put(row);
    const got = await repo.get(userId);
    expect(got).toEqual(row);
    // The stored TTL value is a Number so DynamoDB TTL can auto-purge it.
    expect(typeof got?.expiresAt).toBe('number');
  });

  it('deletes the row', async () => {
    const userId = randomUUID();
    await repo.put({
      userId,
      codeHash: 'b'.repeat(64),
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      sentAt: '2026-06-12T00:00:00.000Z',
      attempts: 2,
    });
    await repo.delete(userId);
    expect(await repo.get(userId)).toBeNull();
  });
});
