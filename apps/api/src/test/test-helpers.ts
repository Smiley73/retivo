// Helpers for the API integration suite: a booted Nest app per suite against the DynamoDB Local and Moto emulators.
// Suites in one worker share a table set, so tests use unique data (random emails and uuids).
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { INestApplication, ValidationPipe, ClassSerializerInterceptor } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { json, urlencoded } from 'express';
import {
  DynamoDBClient,
  ScanCommand,
  BatchWriteItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand as DocScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SESClient } from '@aws-sdk/client-ses';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import { ConfigService } from '@nestjs/config';
import { generateSync } from 'otplib';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../auth/refresh-token.service.js';
import type { AuthEventRow, MfaEmailOtpRow } from '../dynamo/types.js';
import { stepUpOtpPk } from '../dynamo/mfa-email-otp.repository.js';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import {
  REFRESH_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  DEVICE_TRUST_COOKIE_NAME,
} from '../auth/cookie-config.js';
import { HibpClient } from '../auth/hibp-client.js';
import { HttpErrorFilter } from '../common/http-error.filter.js';
import { CorrelationIdMiddleware } from '../common/correlation-id.middleware.js';
import { BuildIdMiddleware } from '../common/build-id.middleware.js';
import {
  DYNAMO_DOC_CLIENT,
  S3_CLIENT,
  SES_CLIENT,
  LAMBDA_CLIENT,
} from '../aws/aws.module.js';
import { validateEnv, type EnvConfig } from '../common/env.config.js';
import { ensureLocalAwsResources } from '../aws/local-bootstrap.js';

let resourcesEnsured = false;

export interface TestApp {
  app: INestApplication;
  module: TestingModule;
  /** Underlying low-level DynamoDB client for purges + raw assertions. */
  ddb: DynamoDBClient;
  /** Document client (used by repos) — exposed for tests that prefer typed access. */
  doc: DynamoDBDocumentClient;
}

async function ensureResources(): Promise<void> {
  if (!resourcesEnsured) {
    await ensureLocalAwsResources(validateEnv());
    resourcesEnsured = true;
  }
}

export interface RepoTestEnv {
  /** Real document client against the local emulator (no Nest app). */
  doc: DynamoDBDocumentClient;
  /** Config exposing the per-worker table names, as repositories expect. */
  config: ConfigService<EnvConfig, true>;
  /** Destroy the client's socket pool (call in `afterAll`). */
  destroy: () => void;
}

/** Repository-spec alternative to `bootstrapTestApp()`: ensures the local tables exist and returns a document client and config, without booting `AppModule`. */
export async function createRepoTestEnv(): Promise<RepoTestEnv> {
  await ensureResources();
  const env = validateEnv();
  const doc = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: env.AWS_REGION,
      endpoint: env.DYNAMODB_ENDPOINT,
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }),
    { marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false } },
  );
  const config = new ConfigService<EnvConfig, true>({ ...env });
  return { doc, config, destroy: () => doc.destroy() };
}

/** Builds the full API app wired like `main.ts`, minus helmet and CORS (in-process supertest needs neither). */
export async function bootstrapTestApp(): Promise<TestApp> {
  await ensureResources();
  // HibpClient is stubbed so tests never reach api.pwnedpasswords.com (3 s stalls offline, flaky); password-validator.service.spec.ts
  // covers the real client's fail-open behaviour.
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(HibpClient)
    .useValue({ isPwned: async () => false })
    .compile();

  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useLogger(false);

  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ extended: true, limit: '5mb' }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new HttpErrorFilter());
  app.use(new CorrelationIdMiddleware().use);
  app.use(new BuildIdMiddleware().use);
  app.setGlobalPrefix('api/v1', { exclude: [] });

  await app.init();

  const doc = moduleRef.get<DynamoDBDocumentClient>(DYNAMO_DOC_CLIENT);
  const ddb = (
    doc as unknown as { config: { client: () => DynamoDBClient } }
  ).config.client?.() ?? new DynamoDBClient({
    endpoint: process.env.DYNAMODB_ENDPOINT,
    region: process.env.AWS_REGION ?? 'us-east-1',
  });

  // None of the registered AWS clients implements `OnModuleDestroy`, so `app.close()` leaves their keep-alive pools open and jest reports
  // a worker that failed to exit; destroy them after the app shuts down.
  const s3 = moduleRef.get<S3Client>(S3_CLIENT);
  const ses = moduleRef.get<SESClient>(SES_CLIENT);
  const lambda = moduleRef.get<LambdaClient>(LAMBDA_CLIENT);
  const nestClose = app.close.bind(app);
  app.close = async (): Promise<void> => {
    await nestClose();
    doc.destroy();
    ddb.destroy();
    s3.destroy();
    ses.destroy();
    lambda.destroy();
  };

  return { app, module: moduleRef, ddb, doc };
}

const TABLE_ENV_KEYS = [
  'TABLE_USER',
  'TABLE_EMAIL_RESERVATION',
  'TABLE_CREDENTIAL',
  'TABLE_PASSKEY',
  'TABLE_REFRESH_TOKEN',
  'TABLE_REVOKED_TOKEN',
  'TABLE_FAILED_LOGIN_ATTEMPT',
  'TABLE_AUTH_EVENT',
  'TABLE_EMAIL_VERIFICATION',
  'TABLE_PASSWORD_RESET',
  'TABLE_WORKSPACE_META',
  'TABLE_MUTATION_LOG',
  'TABLE_AGGREGATE_VERSION',
  'TABLE_IDEMPOTENCY_KEY',
  'TABLE_DEVICE_REGISTRY',
  'TABLE_SIGNUP_APPROVAL',
  'TABLE_HOUSEHOLD_KEY_ENVELOPE',
  'TABLE_USER_MFA',
  'TABLE_MFA_EMAIL_OTP',
  'TABLE_TRUSTED_DEVICE',
  'TABLE_PASSKEY_CHALLENGE',
] as const;

interface TableInfo {
  name: string;
  keyAttrs: string[];
}

let cachedTableInfo: TableInfo[] | null = null;

async function discoverTables(ddb: DynamoDBClient): Promise<TableInfo[]> {
  if (cachedTableInfo) return cachedTableInfo;
  const env = validateEnv();
  const out: TableInfo[] = [];
  for (const key of TABLE_ENV_KEYS) {
    const name = env[key];
    if (!name) continue;
    await ddb.send(new ScanCommand({ TableName: name, Limit: 1 }));
    out.push({ name, keyAttrs: keyAttrsFromSample(name) });
  }
  cachedTableInfo = out;
  return out;
}

function keyAttrsFromSample(tableName: string): string[] {
  return keyAttrsByTable(tableName, validateEnv());
}

function keyAttrsByTable(name: string, env: ReturnType<typeof validateEnv>): string[] {
  switch (name) {
    case env.TABLE_USER:
      return ['userId'];
    case env.TABLE_EMAIL_RESERVATION:
      return ['emailLowercase'];
    case env.TABLE_CREDENTIAL:
      return ['userId'];
    case env.TABLE_PASSKEY:
      return ['userId', 'credentialId'];
    case env.TABLE_REFRESH_TOKEN:
      return ['userId', 'tokenHash'];
    case env.TABLE_REVOKED_TOKEN:
      return ['jti'];
    case env.TABLE_FAILED_LOGIN_ATTEMPT:
      return ['emailLowercase'];
    case env.TABLE_AUTH_EVENT:
      return ['userId', 'eventId'];
    case env.TABLE_EMAIL_VERIFICATION:
      return ['verificationToken'];
    case env.TABLE_PASSWORD_RESET:
      return ['resetToken'];
    case env.TABLE_WORKSPACE_META:
      return ['householdId'];
    case env.TABLE_MUTATION_LOG:
      return ['householdId', 'sequenceId'];
    case env.TABLE_AGGREGATE_VERSION:
      return ['householdId', 'aggregateId'];
    case env.TABLE_IDEMPOTENCY_KEY:
      return ['key'];
    case env.TABLE_DEVICE_REGISTRY:
      return ['householdId', 'deviceId'];
    case env.TABLE_SIGNUP_APPROVAL:
      return ['approvalToken'];
    case env.TABLE_HOUSEHOLD_KEY_ENVELOPE:
      return ['householdId', 'slotId'];
    case env.TABLE_USER_MFA:
      return ['userId'];
    case env.TABLE_MFA_EMAIL_OTP:
      return ['userId'];
    case env.TABLE_TRUSTED_DEVICE:
      return ['userId', 'deviceId'];
    case env.TABLE_PASSKEY_CHALLENGE:
      return ['key'];
    default:
      return [];
  }
}

/** Scans and deletes every row in every known table; O(n), so for purging between suites, not between assertions. */
export async function purgeAllTables(ddb: DynamoDBClient): Promise<void> {
  const tables = await discoverTables(ddb);
  for (const t of tables) {
    if (t.keyAttrs.length === 0) continue;
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
      const r = await ddb.send(
        new ScanCommand({
          TableName: t.name,
          ExclusiveStartKey: lastKey,
          ProjectionExpression: t.keyAttrs.map((_, i) => `#k${i}`).join(', '),
          ExpressionAttributeNames: Object.fromEntries(
            t.keyAttrs.map((a, i) => [`#k${i}`, a]),
          ),
        }),
      );
      const items = r.Items ?? [];
      // BatchWriteItem caps at 25 deletes per call.
      for (let i = 0; i < items.length; i += 25) {
        const slice = items.slice(i, i + 25);
        await ddb.send(
          new BatchWriteItemCommand({
            RequestItems: {
              [t.name]: slice.map((it) => ({
                DeleteRequest: {
                  Key: Object.fromEntries(
                    t.keyAttrs.map((k) => [k, it[k]]),
                  ) as Record<string, AttributeValue>,
                },
              })),
            },
          }),
        );
      }
      lastKey = r.LastEvaluatedKey;
    } while (lastKey);
  }
}

/** Default password for test signups: meets the length and class rules, and the stubbed HIBP client never flags it. */
export const STRONG_PASSWORD = 'TestPassw0rd!Test';

/** A logged-in test user's credential set; suites consume only the fields they need. */
export interface Session {
  accessToken: string;
  refreshCookie: string;
  csrfCookie: string;
  csrfValue: string;
  deviceId: string;
  householdId: string;
  userId: string;
  email: string;
}

/** Parse `Set-Cookie` response headers into a name → decoded-value map. */
export function parseSetCookies(raw: string[] | string | undefined): Record<string, string> {
  if (!raw) return {};
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: Record<string, string> = {};
  for (const line of arr) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

/** Signup, verify-email, owner approval, login. Test emails are never the configured `APPROVER_EMAIL`, so approval is always required. */
export async function signupVerifyLogin(
  t: Pick<TestApp, 'app' | 'module' | 'doc'>,
): Promise<Session> {
  const email = freshEmail();
  const signup = await request(t.app.getHttpServer())
    .post('/api/v1/auth/signup')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ email, password: STRONG_PASSWORD });
  if (signup.status !== 202 || typeof signup.body.userId !== 'string') {
    throw new Error(
      `signupVerifyLogin: signup returned ${signup.status}: ${JSON.stringify(signup.body)}`,
    );
  }
  // The SignupApproval table stores only the token's SHA-256 digest, so the raw token comes from the verify-email dev trapdoor (`EXPOSE_VERIFICATION_TOKEN=true`).
  const verify = await request(t.app.getHttpServer())
    .post('/api/v1/auth/verify-email')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ token: signup.body.verificationToken });
  if (verify.status !== 200 || typeof verify.body.approvalToken !== 'string') {
    throw new Error(
      `signupVerifyLogin: verify-email returned ${verify.status}: ${JSON.stringify(verify.body)}`,
    );
  }
  await approvePendingSignup(t.app, verify.body.approvalToken);
  const deviceId = freshDeviceId();
  const login = await request(t.app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ email, password: STRONG_PASSWORD, deviceId });
  if (login.status !== 200 || !login.body.accessToken) {
    throw new Error(
      `signupVerifyLogin: login returned ${login.status}: ${JSON.stringify(login.body)}`,
    );
  }
  const cookies = parseSetCookies(login.headers['set-cookie']);
  const claims = decodeAccessClaims(login.body.accessToken);
  return {
    accessToken: login.body.accessToken,
    refreshCookie: `${REFRESH_COOKIE_NAME}=${encodeURIComponent(cookies[REFRESH_COOKIE_NAME])}`,
    csrfCookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(cookies[CSRF_COOKIE_NAME])}`,
    csrfValue: cookies[CSRF_COOKIE_NAME],
    deviceId,
    householdId: claims.householdId,
    userId: claims.userId,
    email,
  };
}

/** Shape of a single mutation in a `POST /sync/push` request body. */
export interface PushMutation {
  id: string;
  aggregateId: string;
  aggregateType: string;
  operation: 'create' | 'update' | 'delete';
  version: number;
  schemaVersion: number;
  payload: Record<string, unknown>;
  timestamp: number;
  deviceId: string;
}

/**
 * Builds a valid push mutation for the session's device. `version` is the client's expected previous version: a fresh create
 * asserts no row exists (0) and the server stores 1.
 */
export function makeMutation(
  s: Pick<Session, 'deviceId'>,
  overrides: Partial<PushMutation> = {},
): PushMutation {
  return {
    id: randomUUID(),
    aggregateId: randomUUID(),
    aggregateType: 'household',
    operation: 'create',
    version: 0,
    schemaVersion: 1,
    payload: { name: 'Test Household', currency: 'USD', createdAt: new Date().toISOString() },
    timestamp: Date.now(),
    deviceId: s.deviceId,
    ...overrides,
  };
}

/** A random lower-case email, so concurrent cases do not collide on the email-reservation row. */
export function freshEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

/** Generate a fresh deviceId UUID. */
export function freshDeviceId(): string {
  return randomUUID();
}

/** Approves a verified-but-pending signup with its raw approval token, captured from the verify-email response (only the digest is stored). */
export async function approvePendingSignup(
  app: { getHttpServer(): unknown },
  rawApprovalToken: string,
): Promise<void> {
  const supertest = (await import('supertest')).default;
  const res = await supertest(app.getHttpServer() as never)
    .post('/api/v1/auth/approve-signup')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ token: rawApprovalToken });
  if (res.status !== 200) {
    throw new Error(
      `approvePendingSignup: approve returned ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
}

/** Decode a JWS compact-form access token's payload (no verification). */
export function decodeAccessClaims(token: string): {
  userId: string;
  householdId: string;
  deviceId: string;
  jti: string;
  exp: number;
} {
  const [, payloadB64] = token.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
}

/** Reads every row of a table as plain objects, for counting or inspecting side-effect rows. */
export async function scanAll<T>(doc: DynamoDBDocumentClient, tableName: string): Promise<T[]> {
  const out: T[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(
      new DocScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey }),
    );
    for (const item of r.Items ?? []) {
      out.push(item as T);
    }
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

let otpReverse: Map<string, string> | null = null;
/** sha256(code) -> 6-digit code, built once per jest worker (~1 s). */
function otpReverseMap(): Map<string, string> {
  if (!otpReverse) {
    otpReverse = new Map();
    for (let i = 0; i < 1_000_000; i++) {
      const code = i.toString().padStart(6, '0');
      otpReverse.set(sha256(code), code);
    }
  }
  return otpReverse;
}

/** Recover the 6-digit Email-OTP code from its stored sha256 `codeHash`. */
export function recoverCodeHash(codeHash: string): string {
  const code = otpReverseMap().get(codeHash);
  if (!code) throw new Error('recoverCodeHash: no 6-digit preimage');
  return code;
}

/** Recover the live login Email-OTP code for a user (codes are never persisted raw). */
export async function recoverEmailOtp(t: TestApp, userId: string): Promise<string> {
  const otpTable = t.module
    .get(ConfigService)
    .get('TABLE_MFA_EMAIL_OTP', { infer: true } as never) as unknown as string;
  const rows = await scanAll<MfaEmailOtpRow>(t.doc, otpTable);
  const row = rows.find((r) => r.userId === userId);
  expect(row).toBeTruthy();
  return recoverCodeHash(row!.codeHash);
}

/** Resolve a ConfigService key (e.g. `TABLE_USER`) to its value for this app. */
export function table(t: Pick<TestApp, 'module'>, key: string): string {
  return t.module.get(ConfigService).get(key, { infer: true } as never) as unknown as string;
}

type SessionCreds = Pick<Session, 'accessToken' | 'refreshCookie' | 'csrfCookie' | 'csrfValue'>;

/** Authenticated bearer + CSRF + cookie headers for a session. */
export function authSet(s: SessionCreds): (req: request.Test) => request.Test {
  return (req) =>
    req
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${s.accessToken}`)
      .set('X-CSRF-Token', s.csrfValue)
      .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '));
}

/** Password login that must succeed; returns the full session handle. */
export async function login(
  t: Pick<TestApp, 'app'>,
  email: string,
  password: string = STRONG_PASSWORD,
): Promise<Session> {
  const deviceId = freshDeviceId();
  const res = await request(t.app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ email, password, deviceId });
  if (res.status !== 200 || !res.body.accessToken) {
    throw new Error(`login: returned ${res.status}: ${JSON.stringify(res.body)}`);
  }
  const cookies = parseSetCookies(res.headers['set-cookie']);
  const claims = decodeAccessClaims(res.body.accessToken);
  return {
    accessToken: res.body.accessToken,
    refreshCookie: `${REFRESH_COOKIE_NAME}=${encodeURIComponent(cookies[REFRESH_COOKIE_NAME])}`,
    csrfCookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(cookies[CSRF_COOKIE_NAME])}`,
    csrfValue: cookies[CSRF_COOKIE_NAME],
    deviceId,
    householdId: claims.householdId,
    userId: claims.userId,
    email,
  };
}

/** Signup -> verify-email -> owner-approve. Returns the account handles. */
export async function signupVerifyApprove(
  t: Pick<TestApp, 'app'>,
): Promise<{ email: string; userId: string }> {
  const email = freshEmail();
  const signup = await request(t.app.getHttpServer())
    .post('/api/v1/auth/signup')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ email, password: STRONG_PASSWORD });
  expect(signup.status).toBe(202);
  const verify = await request(t.app.getHttpServer())
    .post('/api/v1/auth/verify-email')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ token: signup.body.verificationToken })
    .expect(200);
  await approvePendingSignup(t.app, verify.body.approvalToken);
  return { email, userId: signup.body.userId as string };
}

/** Password-factor login returning the raw response (challenge or session). */
export async function loginRaw(
  t: Pick<TestApp, 'app'>,
  email: string,
  deviceId: string,
  cookies: string[] = [],
): Promise<request.Response> {
  const req = request(t.app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('Origin', process.env.WEB_ORIGIN!);
  if (cookies.length) req.set('Cookie', cookies.join('; '));
  return req.send({ email, password: STRONG_PASSWORD, deviceId });
}

/** Drive the email-OTP MFA path end-to-end; returns the raw `/mfa/verify` response. */
export async function completeEmailOtpLogin(
  t: TestApp,
  email: string,
  userId: string,
  deviceId: string,
  rememberDevice = false,
): Promise<request.Response> {
  const challenge = await loginRaw(t, email, deviceId);
  expect(challenge.status).toBe(200);
  expect(challenge.body.mfaRequired).toBe(true);
  const challengeToken = challenge.body.challengeToken as string;
  await request(t.app.getHttpServer())
    .post('/api/v1/auth/mfa/email/send')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ challengeToken })
    .expect(202);
  const code = await recoverEmailOtp(t, userId);
  return request(t.app.getHttpServer())
    .post('/api/v1/auth/mfa/verify')
    .set('Origin', process.env.WEB_ORIGIN!)
    .send({ challengeToken, method: 'email_otp', code, deviceId, rememberDevice });
}

/**
 * Completes an Email-OTP challenge with `rememberDevice` and returns the verify response plus the `Cookie` header value
 * that presents the minted device trust (for suites running with `AUTH_MFA_ENFORCED=true`).
 */
export async function rememberDeviceViaEmailOtp(
  t: TestApp,
  email: string,
  userId: string,
  deviceId: string,
): Promise<{ verify: request.Response; trustCookie: string }> {
  const verify = await completeEmailOtpLogin(t, email, userId, deviceId, true);
  expect(verify.status).toBe(200);
  const trust = parseSetCookies(verify.headers['set-cookie'])[DEVICE_TRUST_COOKIE_NAME];
  expect(trust).toBeTruthy();
  return { verify, trustCookie: `${DEVICE_TRUST_COOKIE_NAME}=${encodeURIComponent(trust)}` };
}

/** The `reason` of every `mfa_device_forgotten` event for `deviceId`, in no particular order. */
export async function deviceForgottenReasons(
  t: TestApp,
  userId: string,
  deviceId: string,
): Promise<unknown[]> {
  const rows = await scanAll<AuthEventRow>(t.doc, table(t, 'TABLE_AUTH_EVENT'));
  return rows
    .filter(
      (r) =>
        r.userId === userId &&
        r.eventType === 'mfa_device_forgotten' &&
        r.metadata?.deviceId === deviceId,
    )
    .map((r) => r.metadata?.reason);
}

/** Signup, verify, approve, then an MFA-challenged login completed with Email-OTP (for suites running with `AUTH_MFA_ENFORCED=true`). */
export async function signupAndLoginMfa(t: TestApp): Promise<Session> {
  const { email, userId } = await signupVerifyApprove(t);
  const deviceId = freshDeviceId();
  const verify = await completeEmailOtpLogin(t, email, userId, deviceId);
  expect(verify.status).toBe(200);
  const cookies = parseSetCookies(verify.headers['set-cookie']);
  return {
    accessToken: verify.body.accessToken,
    refreshCookie: `${REFRESH_COOKIE_NAME}=${encodeURIComponent(cookies[REFRESH_COOKIE_NAME])}`,
    csrfCookie: `${CSRF_COOKIE_NAME}=${encodeURIComponent(cookies[CSRF_COOKIE_NAME])}`,
    csrfValue: cookies[CSRF_COOKIE_NAME],
    deviceId,
    householdId: userId,
    userId,
    email,
  };
}

/**
 * Sends and recovers a purpose-bound step-up Email-OTP. Clears the 60s send cooldown first (one counter per user across
 * purposes) so a second send is not a silent no-op.
 */
export async function sendAndRecoverStepUpOtp(
  t: TestApp,
  s: SessionCreds,
  purpose: string,
): Promise<string> {
  const { userId } = decodeAccessClaims(s.accessToken);
  await t.doc.send(
    new UpdateCommand({
      TableName: table(t, 'TABLE_USER'),
      Key: { userId },
      UpdateExpression: 'REMOVE stepUpEmailOtpLastSentAt',
    }),
  );
  await authSet(s)(request(t.app.getHttpServer()).post('/api/v1/auth/step-up/email-otp/send'))
    .send({ purpose })
    .expect(202);
  const rows = await scanAll<MfaEmailOtpRow>(t.doc, table(t, 'TABLE_MFA_EMAIL_OTP'));
  const row = rows.find((r) => r.userId === stepUpOtpPk(userId));
  expect(row).toBeTruthy();
  return recoverCodeHash(row!.codeHash);
}

/** Enrolls and confirms TOTP and returns the secret. The confirm write is gated, so a fresh account proves it with Email-OTP. */
export async function enrollTotp(t: TestApp, s: SessionCreds): Promise<string> {
  const start = await authSet(s)(
    request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/start'),
  ).send({});
  expect(start.status).toBe(200);
  const secret = start.body.secret as string;
  const otpCode = await sendAndRecoverStepUpOtp(t, s, 'mfa_totp_enroll');
  const confirm = await authSet(s)(
    request(t.app.getHttpServer()).post('/api/v1/auth/mfa/totp/enroll/confirm'),
  ).send({
    code: generateSync({ secret }),
    stepUp: { currentPassword: STRONG_PASSWORD, method: 'email_otp', code: otpCode },
  });
  expect(confirm.status).toBe(200);
  expect(confirm.body.totpEnabled).toBe(true);
  return secret;
}
