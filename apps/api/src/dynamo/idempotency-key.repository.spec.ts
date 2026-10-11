/**
 * Integration tests for `IdempotencyKeyRepository` additions backing the
 * version-aware rejection replay:
 *   - `rowFor` stamps the server-internal `expectedVersion` only when the
 *     caller supplies one (rejections only — applied rows never need it).
 *   - `delete(key, expectedVersion)` is a CONDITIONAL single-key delete: it
 *     only removes a row that is STILL a `rejected` outcome at that exact
 *     `expectedVersion` (TOCTOU-safe), and treats a mismatched / already-gone
 *     row as "changed underneath" (returns `false`, never throws).
 *
 * Verified against the local DynamoDB emulator so the ConditionExpression
 * itself proves the guard, not a mock.
 */
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { bootstrapTestApp, type TestApp } from '../test/test-helpers.js';
import { IdempotencyKeyRepository } from './idempotency-key.repository.js';
import type { AppliedMutationResult, RejectedMutationResult } from './types.js';

function rejection(overrides: Partial<RejectedMutationResult> = {}): RejectedMutationResult {
  return {
    status: 'rejected',
    mutationId: randomUUID(),
    aggregateId: randomUUID(),
    reason: 'CONFLICT',
    currentVersion: 1,
    currentUpdatedAt: new Date().toISOString(),
    currentDeletedAt: null,
    ...overrides,
  };
}

function applied(overrides: Partial<AppliedMutationResult> = {}): AppliedMutationResult {
  return {
    status: 'applied',
    mutationId: randomUUID(),
    aggregateId: randomUUID(),
    newVersion: 1,
    newUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('IdempotencyKeyRepository — version-aware rejection replay', () => {
  let t: TestApp;
  let repo: IdempotencyKeyRepository;
  let table: string;

  beforeAll(async () => {
    t = await bootstrapTestApp();
    repo = t.module.get(IdempotencyKeyRepository);
    table = t.module
      .get(ConfigService)
      .get('TABLE_IDEMPOTENCY_KEY', { infer: true } as never) as unknown as string;
  });

  afterAll(async () => {
    await t.app.close();
  });

  async function seedRow(
    key: string,
    expectedVersion?: number,
    response: AppliedMutationResult | RejectedMutationResult = rejection(),
  ): Promise<void> {
    await t.doc.send(
      new PutCommand({
        TableName: table,
        Item: IdempotencyKeyRepository.rowFor(key, response, expectedVersion),
      }),
    );
  }

  describe('rowFor', () => {
    it('stamps expectedVersion only when the caller supplies one', () => {
      const key = randomUUID();
      const withVersion = IdempotencyKeyRepository.rowFor(key, rejection(), 0);
      expect(withVersion.expectedVersion).toBe(0);

      const withoutVersion = IdempotencyKeyRepository.rowFor(key, applied());
      expect(withoutVersion.expectedVersion).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('deletes a rejected row when the recorded expectedVersion matches', async () => {
      const key = randomUUID();
      await seedRow(key, 3);

      const deleted = await repo.delete(key, 3);

      expect(deleted).toBe(true);
      expect(await repo.lookup(key)).toBeNull();
    });

    it('does NOT delete (returns false) when the incoming expectedVersion does not match the stored row', async () => {
      const key = randomUUID();
      await seedRow(key, 3);

      const deleted = await repo.delete(key, 4);

      expect(deleted).toBe(false);
      // TOCTOU-safe: the mismatched delete attempt left the row intact.
      expect(await repo.lookup(key)).not.toBeNull();
    });

    it('deletes a LEGACY row (no expectedVersion attribute) when called with undefined', async () => {
      const key = randomUUID();
      await seedRow(key, undefined);

      const deleted = await repo.delete(key, undefined);

      expect(deleted).toBe(true);
      expect(await repo.lookup(key)).toBeNull();
    });

    it('does NOT delete a legacy row when called with a defined expectedVersion', async () => {
      const key = randomUUID();
      await seedRow(key, undefined);

      const deleted = await repo.delete(key, 0);

      expect(deleted).toBe(false);
      expect(await repo.lookup(key)).not.toBeNull();
    });

    it('treats deleting an absent key as "changed underneath" (returns false, never throws)', async () => {
      const key = randomUUID(); // never written
      await expect(repo.delete(key, 0)).resolves.toBe(false);
    });

    it('does NOT delete an APPLIED row even if a caller mistakenly targets it', async () => {
      const key = randomUUID();
      await seedRow(key, 3, applied());

      const deleted = await repo.delete(key, 3);

      expect(deleted).toBe(false);
      expect(await repo.lookup(key)).not.toBeNull();
    });
  });
});
