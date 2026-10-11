/**
 * Integration tests for `FailedLoginAttemptsRepository` against DynamoDB Local.
 * The decisive property is that `increment` is a
 * single atomic `UpdateItem` (`ADD`), so N CONCURRENT failed-login records
 * produce an exact `+N` — the previous find-then-`Put` was a read/modify/write
 * that could silently drop a concurrent increment (lost update).
 *
 * Uses fresh emails per case so suites stay independent on the shared
 * DynamoDB Local instance.
 */
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
    // checkBackoff only reads the repository; the other collaborators are unused.
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

    // Fire all increments concurrently — the whole point of the atomic ADD.
    await Promise.all(
      Array.from({ length: N }, () => repo.increment(email, TTL_SEC)),
    );

    const row = await repo.find(email);
    expect(row?.consecutiveFailures).toBe(N);

    // Backoff tier is DERIVED from the count + latest failure: 8 failures
    // = 3 grace + exponent 5 → a 2^5 = 32 s wait, still inside the window since
    // the misses just happened.
    const state = await service.checkBackoff(email);
    expect(state.blocked).toBe(true);
    expect(state.retryAfterSec).toBeGreaterThan(16);
    expect(state.retryAfterSec).toBeLessThanOrEqual(32);
  });

  it('a delayed increment with an older timestamp still counts +1 but never regresses lastFailedAt/expiresAt', async () => {
    const email = freshEmail();

    // Newer failure commits first — a far-future clock so its TTL never purges.
    jest.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
    const newer = await repo.increment(email, TTL_SEC);
    expect(newer.consecutiveFailures).toBe(1);

    // A "delayed"/out-of-order request whose captured clock is OLDER lands after
    // the newer one. The counter must still advance (fail-safe), but the
    // timestamp/TTL must NOT move backward (monotonic advance).
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    const delayed = await repo.increment(email, TTL_SEC);

    expect(delayed.consecutiveFailures).toBe(2);
    expect(delayed.lastFailedAt).toBe(newer.lastFailedAt);
    expect(delayed.expiresAt).toBe(newer.expiresAt);
  });

  it('fallback after a concurrent clear() recreates a row with a valid lastFailedAt AND expiresAt', async () => {
    const email = freshEmail();

    // Establish a row, then simulate a concurrent `clear()` that deletes it
    // between the primary conditional write failing and the fallback running.
    await repo.increment(email, TTL_SEC);
    await repo.clear(email);
    expect(await repo.find(email)).toBeNull();

    // Force the primary conditional `UpdateCommand` to raise
    // ConditionalCheckFailedException so the fallback path runs — but against a
    // row the `clear()` just deleted. A bare `ADD` would recreate a row with no
    // `lastFailedAt`/`expiresAt`; the `if_not_exists` seed must repopulate both.
    const doc = env.doc;
    const sendSpy = jest.spyOn(doc, 'send');
    // The first send inside `increment` is the primary conditional write; reject
    // it once. `mockImplementationOnce` applies only to that call — every later
    // send (the fallback update, the `find` below) falls through to the real
    // client the spy wraps.
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

    // The persisted row (not just the returned attributes) carries both fields,
    // so `checkBackoff` sees a finite timestamp and the row still TTL-expires.
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

    // A second crossing inside the same window is a no-op — one notice/24h.
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

    // A successful sign-in clears the counter but preserves the stamp.
    await repo.clear(email);

    // A fresh burst crosses the threshold again — still inside the 24h window.
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
