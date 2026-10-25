// FailedLoginAttemptsRepository on DynamoDB Local: `increment` is one atomic UpdateItem ADD, so N concurrent failures give an exact +N (the old find-then-Put could drop an increment).
import { randomUUID } from 'node:crypto';
import {
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { createRepoTestEnv, type RepoTestEnv } from '../test/test-helpers.js';
import { FailedLoginAttemptsRepository } from './failed-login-attempts.repository.js';
import { FailedLoginService } from '../auth/failed-login.service.js';

const TTL_SEC = 24 * 60 * 60;

function freshEmail(): string {
  return `${randomUUID()}@example.test`;
}

describe('FailedLoginAttemptsRepository.increment', () => {
  let env: RepoTestEnv;
  let repo: FailedLoginAttemptsRepository;
  let service: FailedLoginService;

  beforeAll(async () => {
    env = await createRepoTestEnv();
    repo = new FailedLoginAttemptsRepository(env.doc, env.config);
    service = new FailedLoginService(repo, {} as never, {} as never);
  });

  afterAll(async () => {
    env.destroy();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates the row at 1 on the first increment and returns the new attributes', async () => {
    const email = freshEmail();
    const row = await repo.increment(email, TTL_SEC);
    expect(row.emailLowercase).toBe(email);
    expect(row.consecutiveFailures).toBe(1);
    expect(typeof row.expiresAt).toBe('number');
    expect(row.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('N concurrent increments land an exact +N (no lost update) and the expected backoff tier', async () => {
    const email = freshEmail();
    const N = 8;

    await Promise.all(
      Array.from({ length: N }, () => repo.increment(email, TTL_SEC)),
    );

    const row = await repo.find(email);
    expect(row?.consecutiveFailures).toBe(N);

    // The backoff tier is derived from count and latest failure: 8 failures = 3 grace + exponent 5, a 32 s wait still inside the window.
    const state = await service.checkBackoff(email);
    expect(state.blocked).toBe(true);
    expect(state.retryAfterSec).toBeGreaterThan(16);
    expect(state.retryAfterSec).toBeLessThanOrEqual(32);
  });

  it('a delayed increment with an older timestamp still counts +1 but never regresses lastFailedAt/expiresAt', async () => {
    const email = freshEmail();

    // A far-future clock keeps the newer failure's TTL from purging.
    jest.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
    const newer = await repo.increment(email, TTL_SEC);
    expect(newer.consecutiveFailures).toBe(1);

    // A delayed request with an older captured clock lands after the newer one: the counter still advances but the timestamp and TTL must not move backward.
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    const delayed = await repo.increment(email, TTL_SEC);

    expect(delayed.consecutiveFailures).toBe(2);
    expect(delayed.lastFailedAt).toBe(newer.lastFailedAt);
    expect(delayed.expiresAt).toBe(newer.expiresAt);
  });

  it('fallback after a concurrent clear() recreates a row with a valid lastFailedAt AND expiresAt', async () => {
    const email = freshEmail();

    await repo.increment(email, TTL_SEC);
    await repo.clear(email);
    expect(await repo.find(email)).toBeNull();

    // Forcing the primary conditional write to fail runs the fallback against a row `clear()` just deleted; a bare ADD would recreate a row without
    // `lastFailedAt`/`expiresAt`, so the `if_not_exists` seed must repopulate both.
    const doc = env.doc;
    const sendSpy = jest.spyOn(doc, 'send');
    // `mockImplementationOnce` rejects only the primary conditional write; later sends fall through to the real client.
    let primaryCmd: unknown;
    sendSpy.mockImplementationOnce((cmd: unknown) => {
      primaryCmd = cmd;
      return Promise.reject(
        new ConditionalCheckFailedException({
          message: 'The conditional request failed',
          $metadata: {},
        }),
      ) as never;
    });

    const row = await repo.increment(email, TTL_SEC);
    expect(primaryCmd).toBeInstanceOf(UpdateCommand);

    expect(row.consecutiveFailures).toBe(1);
    expect(row.lastFailedAt).toBeDefined();
    expect(typeof row.lastFailedAt).toBe('string');
    expect(row.expiresAt).toBeDefined();
    expect(typeof row.expiresAt).toBe('number');
    expect(row.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const persisted = await repo.find(email);
    expect(persisted?.lastFailedAt).toBeDefined();
    expect(persisted?.expiresAt).toBeDefined();
    expect(persisted?.consecutiveFailures).toBe(1);
  });

  it('find issues a strongly-consistent read for backoff enforcement', async () => {
    const email = freshEmail();
    await repo.increment(email, TTL_SEC);

    const doc = env.doc;
    const sendSpy = jest.spyOn(doc, 'send');

    await repo.find(email);

    const consistentGet = sendSpy.mock.calls.some(
      ([cmd]) => cmd instanceof GetCommand && cmd.input.ConsistentRead === true,
    );
    expect(consistentGet).toBe(true);
  });

  it('clear removes the row so a fresh attempt starts unblocked', async () => {
    const email = freshEmail();
    await repo.increment(email, TTL_SEC);
    await repo.clear(email);
    expect(await repo.find(email)).toBeNull();
    expect(await service.checkBackoff(email)).toEqual({
      blocked: false,
      retryAfterSec: 0,
    });
  });
});

describe('FailedLoginAttemptsRepository — guessing-notice stamp', () => {
  let env: RepoTestEnv;
  let repo: FailedLoginAttemptsRepository;

  beforeAll(async () => {
    env = await createRepoTestEnv();
    repo = new FailedLoginAttemptsRepository(env.doc, env.config);
  });

  afterAll(async () => {
    env.destroy();
  });

  it('stampGuessingNotice advances once and refuses a second stamp inside the window', async () => {
    const email = freshEmail();
    await repo.increment(email, TTL_SEC);

    expect(await repo.stampGuessingNotice(email, TTL_SEC)).toBe(true);
    const row = await repo.find(email);
    expect(row?.guessingNoticeSentAt).toBeDefined();

    expect(await repo.stampGuessingNotice(email, TTL_SEC)).toBe(false);
  });

  it('clear() preserves an existing stamp but removes the counter (a stamp-only row reads as unblocked)', async () => {
    const email = freshEmail();
    await repo.increment(email, TTL_SEC);
    await repo.stampGuessingNotice(email, TTL_SEC);

    await repo.clear(email);

    const row = await repo.find(email);
    expect(row).not.toBeNull();
    expect(row?.guessingNoticeSentAt).toBeDefined();
    expect(row?.consecutiveFailures).toBeUndefined();
  });

  it('clear() still deletes the row outright when no stamp exists (unchanged common path)', async () => {
    const email = freshEmail();
    await repo.increment(email, TTL_SEC);
    await repo.clear(email);
    expect(await repo.find(email)).toBeNull();
  });

  it('a second guessing burst after a clear() does not re-notify inside the same 24h window', async () => {
    const email = freshEmail();
    await repo.increment(email, TTL_SEC);
    expect(await repo.stampGuessingNotice(email, TTL_SEC)).toBe(true);

    await repo.clear(email);

    await repo.increment(email, TTL_SEC);
    expect(await repo.stampGuessingNotice(email, TTL_SEC)).toBe(false);
  });

  it('deleteRow removes the row outright even with a guessing-notice stamp present (regression: clear() alone would leave it behind on account deletion)', async () => {
    const email = freshEmail();
    await repo.increment(email, TTL_SEC);
    expect(await repo.stampGuessingNotice(email, TTL_SEC)).toBe(true);

    await repo.deleteRow(email);

    expect(await repo.find(email)).toBeNull();
  });
});
