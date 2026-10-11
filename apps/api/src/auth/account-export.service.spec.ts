/**
 * Unit tests for `AccountExportService.build`
 * covering two cases that are impractical to force
 * deterministically through the DynamoDB-Local integration harness
 * (`apps/api/src/test/account-export.spec.ts` covers the happy paths and
 * cross-user isolation there):
 *
 *  - A User row missing at read time (a concurrent account deletion racing
 *    the export) must fail closed rather than fabricate an empty account
 *    record and return a silently-partial `200` bundle.
 *  - A recycled `emailLowercase` — where a stale/eventually-consistent read
 *    of the caller's own email keys a lookup that now resolves to a
 *    DIFFERENT user's `EmailReservation` row — must never end up in the
 *    export, and a live/pending email that keeps changing across the
 *    bracketed consistent reads must fail closed rather than export
 *    possibly-mismatched data.
 *
 * Every dependency is a plain jest stub; only the methods `build()` actually
 * calls on a fully-populated, otherwise-empty account are wired up.
 */
import 'reflect-metadata';
import {
  AccountExportEmailKeyReadConflictError,
  AccountExportService,
  AccountExportUserGoneError,
} from './account-export.service.js';
import type { UsersRepository } from '../dynamo/users.repository.js';
import type { EmailReservationsRepository } from '../dynamo/email-reservations.repository.js';
import type { EmailVerificationsRepository } from '../dynamo/email-verifications.repository.js';
import type { PasswordResetsRepository } from '../dynamo/password-resets.repository.js';
import type { SignupApprovalsRepository } from '../dynamo/signup-approvals.repository.js';
import type { CredentialsRepository } from '../dynamo/credentials.repository.js';
import type { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import type { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import type { RevokedTokensRepository } from '../dynamo/revoked-tokens.repository.js';
import type { FailedLoginAttemptsRepository } from '../dynamo/failed-login-attempts.repository.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { HouseholdKeyEnvelopesRepository } from '../dynamo/household-key-envelopes.repository.js';
import type { UserMfaRepository } from '../dynamo/user-mfa.repository.js';
import type { MfaEmailOtpRepository } from '../dynamo/mfa-email-otp.repository.js';
import type { TrustedDeviceRepository } from '../dynamo/trusted-device.repository.js';
import type { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import type { MutationLogRepository } from '../dynamo/mutation-log.repository.js';
import type { AggregateVersionRepository } from '../dynamo/aggregate-version.repository.js';
import type { IdempotencyKeyRepository } from '../dynamo/idempotency-key.repository.js';
import type { DeviceRegistryRepository } from '../dynamo/device-registry.repository.js';
import type { EmailReservationRow, UserRow } from '../dynamo/types.js';

const USER_ID = 'user-alice';
const HOUSEHOLD_ID = 'household-alice';
const EMAIL_LOWERCASE = 'alice@example.test';

function userRow(over: Partial<UserRow> = {}): UserRow {
  const nowIso = new Date().toISOString();
  return {
    userId: USER_ID,
    email: 'Alice@example.test',
    emailLowercase: EMAIL_LOWERCASE,
    householdId: HOUSEHOLD_ID,
    emailVerifiedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...over,
  } as UserRow;
}

function reservationRow(over: Partial<EmailReservationRow> = {}): EmailReservationRow {
  return {
    emailLowercase: EMAIL_LOWERCASE,
    userId: USER_ID,
    reservedAt: new Date().toISOString(),
    ...over,
  };
}

/**
 * Build an `AccountExportService` with every constructor dependency stubbed.
 * `findByIdConsistent` is the only interesting mock by default (returns
 * `userRow()` every call); individual tests override it and
 * `emailReservations.findByEmail` to exercise the two findings.
 */
function makeService() {
  const findByIdConsistent = jest.fn().mockResolvedValue(userRow());
  const users = { findByIdConsistent } as unknown as UsersRepository;

  const findByEmail = jest.fn().mockResolvedValue(null);
  const emailReservations = { findByEmail } as unknown as EmailReservationsRepository;

  const emailVerifications = {
    listForUser: jest.fn().mockResolvedValue([]),
  } as unknown as EmailVerificationsRepository;
  const passwordResets = {
    findByToken: jest.fn().mockResolvedValue(null),
  } as unknown as PasswordResetsRepository;
  const signupApprovals = {
    listForUser: jest.fn().mockResolvedValue([]),
  } as unknown as SignupApprovalsRepository;
  const credentials = {
    findByUserId: jest.fn().mockResolvedValue(null),
  } as unknown as CredentialsRepository;
  const passkeys = {
    listForUser: jest.fn().mockResolvedValue([]),
  } as unknown as PasskeysRepository;
  const refreshTokens = {
    listAllForUser: jest.fn().mockResolvedValue([]),
  } as unknown as RefreshTokensRepository;
  const revokedTokens = {
    listForUser: jest.fn().mockResolvedValue([]),
  } as unknown as RevokedTokensRepository;
  const find = jest.fn().mockResolvedValue(null);
  const failedLoginAttempts = { find } as unknown as FailedLoginAttemptsRepository;
  const authEvents = {
    listForUser: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
  } as unknown as AuthEventsRepository;
  const householdKeyEnvelopes = {
    getStableEnvelopeSet: jest.fn().mockResolvedValue({ slots: [], meta: null }),
  } as unknown as HouseholdKeyEnvelopesRepository;
  const userMfa = { get: jest.fn().mockResolvedValue(null) } as unknown as UserMfaRepository;
  const mfaEmailOtp = {
    get: jest.fn().mockResolvedValue(null),
    getStepUp: jest.fn().mockResolvedValue(null),
  } as unknown as MfaEmailOtpRepository;
  const trustedDevices = {
    listByUser: jest.fn().mockResolvedValue([]),
  } as unknown as TrustedDeviceRepository;
  const workspaceMeta = {
    find: jest.fn().mockResolvedValue(null),
  } as unknown as WorkspaceMetaRepository;
  const mutationLog = {
    listForHousehold: jest.fn().mockResolvedValue([]),
  } as unknown as MutationLogRepository;
  const aggregateVersion = {
    listForHousehold: jest.fn().mockResolvedValue([]),
  } as unknown as AggregateVersionRepository;
  const idempotencyKey = {
    listForHousehold: jest.fn().mockResolvedValue([]),
  } as unknown as IdempotencyKeyRepository;
  const deviceRegistry = {
    listForHousehold: jest.fn().mockResolvedValue([]),
  } as unknown as DeviceRegistryRepository;

  const s3 = { send: jest.fn().mockResolvedValue({ Contents: [], IsTruncated: false }) };
  const config = { get: jest.fn().mockReturnValue('test-snapshots-bucket') };

  const service = new AccountExportService(
    s3 as never,
    config as never,
    users,
    emailReservations,
    emailVerifications,
    passwordResets,
    signupApprovals,
    credentials,
    passkeys,
    refreshTokens,
    revokedTokens,
    failedLoginAttempts,
    authEvents,
    householdKeyEnvelopes,
    userMfa,
    mfaEmailOtp,
    trustedDevices,
    workspaceMeta,
    mutationLog,
    aggregateVersion,
    idempotencyKey,
    deviceRegistry,
  );

  return { service, findByIdConsistent, findByEmail, find };
}

async function reject(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to reject');
    },
    (err: unknown) => err,
  );
}

describe('AccountExportService.build — deleted-user fail-closed', () => {
  it('throws AccountExportUserGoneError instead of fabricating an empty account record when the User row is gone', async () => {
    const { service, findByIdConsistent } = makeService();
    findByIdConsistent.mockResolvedValue(null);

    const err = await reject(service.build(USER_ID, HOUSEHOLD_ID, null));

    expect(err).toBeInstanceOf(AccountExportUserGoneError);
  });
});

describe('AccountExportService.build — recycled-email-key defense', () => {
  it("never exports a reservation row owned by a different userId, even though it was reached via this user's own emailLowercase", async () => {
    const { service, findByEmail } = makeService();
    // The live email key resolves to a row that belongs to SOMEONE ELSE —
    // exactly what a recycled, released-then-reclaimed address looks like.
    findByEmail.mockResolvedValue(reservationRow({ userId: 'user-bob' }));

    const page = await service.build(USER_ID, HOUSEHOLD_ID, null);

    expect('emailReservations' in page).toBe(true);
    expect((page as { emailReservations: EmailReservationRow[] }).emailReservations).toEqual([]);
  });

  it("exports a reservation row that DOES belong to this user", async () => {
    const { service, findByEmail } = makeService();
    const ownRow = reservationRow({ userId: USER_ID });
    findByEmail.mockResolvedValue(ownRow);

    const page = await service.build(USER_ID, HOUSEHOLD_ID, null);

    expect((page as { emailReservations: EmailReservationRow[] }).emailReservations).toEqual([
      ownRow,
    ]);
  });

  it('fails closed with AccountExportEmailKeyReadConflictError when the live email keeps changing across every bracketed consistent read', async () => {
    const { service, findByIdConsistent } = makeService();
    // A different emailLowercase on every call means the before/after
    // bracket can never agree, however many attempts are made.
    let n = 0;
    findByIdConsistent.mockImplementation(async () =>
      userRow({ emailLowercase: `alice-${n++}@example.test` }),
    );

    const err = await reject(service.build(USER_ID, HOUSEHOLD_ID, null));

    expect(err).toBeInstanceOf(AccountExportEmailKeyReadConflictError);
  });

  it('succeeds once the live/pending email is confirmed stable across the bracket', async () => {
    const { service, findByIdConsistent } = makeService();
    findByIdConsistent.mockResolvedValue(userRow());

    const page = await service.build(USER_ID, HOUSEHOLD_ID, null);

    expect((page as { emailReservations: EmailReservationRow[] }).emailReservations).toEqual([]);
  });
});
