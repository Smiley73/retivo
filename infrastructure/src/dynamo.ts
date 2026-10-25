// All DynamoDB tables: on-demand billing, TTL on the short-lived token and event tables. Schemas mirror apps/api/src/dynamo.
// PITR follows `enablePitr`, a per-stack cost/DR choice (docs/deploy.md "Point-in-time recovery (`enablePitr`)").

import * as aws from "@pulumi/aws";

export interface Tables {
  // Sync tables
  readonly workspaceMeta: aws.dynamodb.Table;
  readonly mutationLog: aws.dynamodb.Table;
  readonly aggregateVersion: aws.dynamodb.Table;
  readonly idempotencyKey: aws.dynamodb.Table;
  readonly deviceRegistry: aws.dynamodb.Table;
  // Auth tables
  readonly user: aws.dynamodb.Table;
  readonly emailReservation: aws.dynamodb.Table;
  readonly emailVerification: aws.dynamodb.Table;
  readonly passwordReset: aws.dynamodb.Table;
  readonly credential: aws.dynamodb.Table;
  readonly passkey: aws.dynamodb.Table;
  readonly refreshToken: aws.dynamodb.Table;
  readonly revokedToken: aws.dynamodb.Table;
  readonly failedLoginAttempt: aws.dynamodb.Table;
  readonly authEvent: aws.dynamodb.Table;
  readonly signupApproval: aws.dynamodb.Table;
  readonly householdKeyEnvelope: aws.dynamodb.Table;
  // Enforced second-factor (MFA) tables
  readonly userMfa: aws.dynamodb.Table;
  readonly mfaEmailOtp: aws.dynamodb.Table;
  readonly trustedDevice: aws.dynamodb.Table;
  // Shared WebAuthn ceremony state
  readonly passkeyChallenge: aws.dynamodb.Table;
}

interface CommonOpts {
  readonly namePrefix: string;
  /** Point-in-time recovery on every table; no per-table override. */
  readonly enablePitr: boolean;
}

/**
 * Settings shared by every table: on-demand billing, PITR per `enablePitr`, and the AWS-owned SSE key
 * (no KMS requests, free, but no CloudTrail visibility of decrypts; docs/security.md "Backups and
 * at-rest encryption"). `serverSideEncryption.enabled: false` selects the owned key; `true` without a
 * `kmsMasterKeyId` silently moves every table onto the billed AWS-managed `aws/dynamodb` key.
 */
function commonArgs(
  enablePitr: boolean,
): Omit<aws.dynamodb.TableArgs, "name" | "attributes" | "hashKey"> {
  return {
    billingMode: "PAY_PER_REQUEST",
    pointInTimeRecovery: { enabled: enablePitr },
    serverSideEncryption: { enabled: false },
  };
}

export function createTables(opts: CommonOpts): Tables {
  const { namePrefix, enablePitr } = opts;
  const t = (name: string) => `${namePrefix}-${name}`;

  // --- Sync tables ---------------------------------------------------------

  const workspaceMeta = new aws.dynamodb.Table(t("workspace-meta"), {
    ...commonArgs(enablePitr),
    name: t("workspace-meta"),
    hashKey: "householdId",
    attributes: [{ name: "householdId", type: "S" }],
  });

  const mutationLog = new aws.dynamodb.Table(t("mutation-log"), {
    ...commonArgs(enablePitr),
    name: t("mutation-log"),
    hashKey: "householdId",
    rangeKey: "sequenceId",
    attributes: [
      { name: "householdId", type: "S" },
      { name: "sequenceId", type: "S" },
    ],
  });

  const aggregateVersion = new aws.dynamodb.Table(t("aggregate-version"), {
    ...commonArgs(enablePitr),
    name: t("aggregate-version"),
    hashKey: "householdId",
    rangeKey: "aggregateId",
    attributes: [
      { name: "householdId", type: "S" },
      { name: "aggregateId", type: "S" },
    ],
  });

  const idempotencyKey = new aws.dynamodb.Table(t("idempotency-key"), {
    ...commonArgs(enablePitr),
    name: t("idempotency-key"),
    hashKey: "key",
    attributes: [{ name: "key", type: "S" }],
    ttl: { attributeName: "expiresAt", enabled: true },
  });

  const deviceRegistry = new aws.dynamodb.Table(t("device-registry"), {
    ...commonArgs(enablePitr),
    name: t("device-registry"),
    hashKey: "householdId",
    rangeKey: "deviceId",
    attributes: [
      { name: "householdId", type: "S" },
      { name: "deviceId", type: "S" },
    ],
  });

  // --- Auth tables ---------------------------------------------------------

  const user = new aws.dynamodb.Table(t("user"), {
    ...commonArgs(enablePitr),
    name: t("user"),
    hashKey: "userId",
    attributes: [
      { name: "userId", type: "S" },
      { name: "emailLowercase", type: "S" },
    ],
    globalSecondaryIndexes: [
      {
        name: "EmailIndex",
        // keySchemas replaces the GSI hashKey, deprecated in @pulumi/aws v7.
        keySchemas: [{ attributeName: "emailLowercase", keyType: "HASH" }],
        projectionType: "ALL",
      },
    ],
  });

  const emailReservation = new aws.dynamodb.Table(t("email-reservation"), {
    ...commonArgs(enablePitr),
    name: t("email-reservation"),
    hashKey: "emailLowercase",
    attributes: [{ name: "emailLowercase", type: "S" }],
  });

  const emailVerification = new aws.dynamodb.Table(t("email-verification"), {
    ...commonArgs(enablePitr),
    name: t("email-verification"),
    hashKey: "verificationToken",
    attributes: [{ name: "verificationToken", type: "S" }],
    ttl: { attributeName: "expiresAt", enabled: true },
  });

  const passwordReset = new aws.dynamodb.Table(t("password-reset"), {
    ...commonArgs(enablePitr),
    name: t("password-reset"),
    hashKey: "resetToken",
    attributes: [{ name: "resetToken", type: "S" }],
    ttl: { attributeName: "expiresAt", enabled: true },
  });

  const credential = new aws.dynamodb.Table(t("credential"), {
    ...commonArgs(enablePitr),
    name: t("credential"),
    hashKey: "userId",
    attributes: [{ name: "userId", type: "S" }],
  });

  const passkey = new aws.dynamodb.Table(t("passkey"), {
    ...commonArgs(enablePitr),
    name: t("passkey"),
    hashKey: "userId",
    rangeKey: "credentialId",
    attributes: [
      { name: "userId", type: "S" },
      { name: "credentialId", type: "S" },
    ],
  });

  const refreshToken = new aws.dynamodb.Table(t("refresh-token"), {
    ...commonArgs(enablePitr),
    name: t("refresh-token"),
    hashKey: "userId",
    rangeKey: "tokenHash",
    attributes: [
      { name: "userId", type: "S" },
      { name: "tokenHash", type: "S" },
    ],
    ttl: { attributeName: "expiresAt", enabled: true },
  });

  // `UserIndex` lets the account export reach a user's rows without a Scan, which the api role
  // lacks. INCLUDE projects only what the export reads; the key attributes are always projected.
  const revokedToken = new aws.dynamodb.Table(t("revoked-token"), {
    ...commonArgs(enablePitr),
    name: t("revoked-token"),
    hashKey: "jti",
    attributes: [
      { name: "jti", type: "S" },
      { name: "userId", type: "S" },
    ],
    ttl: { attributeName: "expiresAt", enabled: true },
    globalSecondaryIndexes: [
      {
        name: "UserIndex",
        keySchemas: [{ attributeName: "userId", keyType: "HASH" }],
        projectionType: "INCLUDE",
        nonKeyAttributes: ["kind", "revokedAt", "expiresAt"],
      },
    ],
  });

  const failedLoginAttempt = new aws.dynamodb.Table(t("failed-login-attempt"), {
    ...commonArgs(enablePitr),
    name: t("failed-login-attempt"),
    hashKey: "emailLowercase",
    attributes: [{ name: "emailLowercase", type: "S" }],
    ttl: { attributeName: "expiresAt", enabled: true },
  });

  // The NEW_AND_OLD_IMAGES stream gives the cascade Lambda the deleted row's userId on TTL removal.
  const signupApproval = new aws.dynamodb.Table(t("signup-approval"), {
    ...commonArgs(enablePitr),
    name: t("signup-approval"),
    hashKey: "approvalToken",
    attributes: [{ name: "approvalToken", type: "S" }],
    ttl: { attributeName: "expiresAt", enabled: true },
    streamEnabled: true,
    streamViewType: "NEW_AND_OLD_IMAGES",
  });

  const authEvent = new aws.dynamodb.Table(t("auth-event"), {
    ...commonArgs(enablePitr),
    name: t("auth-event"),
    hashKey: "userId",
    rangeKey: "eventId",
    attributes: [
      { name: "userId", type: "S" },
      { name: "eventId", type: "S" },
    ],
    ttl: { attributeName: "expiresAt", enabled: true },
  });

  // Own table, so key material stays outside the compactor's privilege boundary. Only archived rows
  // carry `expiresAt`, and TTL keys on that attribute alone: an operator restore that republishes
  // an archived row at a live key must strip it first (AGENTS.md "Key-envelope archive recovery").
  // DynamoDB TTL deletes lazily, so the 30-day archive retention is a floor.
  const householdKeyEnvelope = new aws.dynamodb.Table(t("household-key-envelope"), {
    ...commonArgs(enablePitr),
    name: t("household-key-envelope"),
    hashKey: "householdId",
    rangeKey: "slotId",
    attributes: [
      { name: "householdId", type: "S" },
      { name: "slotId", type: "S" },
    ],
    ttl: { attributeName: "expiresAt", enabled: true },
  });

  // --- Enforced second-factor (MFA) tables ---

  // Isolated like HouseholdKeyEnvelope: SSE plus a narrow api-role grant, no separate CMK.
  const userMfa = new aws.dynamodb.Table(t("user-mfa"), {
    ...commonArgs(enablePitr),
    name: t("user-mfa"),
    hashKey: "userId",
    attributes: [{ name: "userId", type: "S" }],
  });

  const mfaEmailOtp = new aws.dynamodb.Table(t("mfa-email-otp"), {
    ...commonArgs(enablePitr),
    name: t("mfa-email-otp"),
    hashKey: "userId",
    attributes: [{ name: "userId", type: "S" }],
    ttl: { attributeName: "expiresAt", enabled: true },
  });

  const trustedDevice = new aws.dynamodb.Table(t("trusted-device"), {
    ...commonArgs(enablePitr),
    name: t("trusted-device"),
    hashKey: "userId",
    rangeKey: "deviceId",
    attributes: [
      { name: "userId", type: "S" },
      { name: "deviceId", type: "S" },
    ],
    ttl: { attributeName: "expiresAt", enabled: true },
  });

  // Shared WebAuthn challenge and request-throttle storage, keyed by caller-namespaced strings (the
  // key is the security binding; see PasskeyChallengeStore). Expiry is enforced by the reader at
  // read time, not by DynamoDB TTL, which lags up to ~48h; the TTL attribute is hygiene only.
  const passkeyChallenge = new aws.dynamodb.Table(t("passkey-challenge"), {
    ...commonArgs(enablePitr),
    name: t("passkey-challenge"),
    hashKey: "key",
    attributes: [{ name: "key", type: "S" }],
    ttl: { attributeName: "expiresAt", enabled: true },
  });

  return {
    workspaceMeta,
    mutationLog,
    aggregateVersion,
    idempotencyKey,
    deviceRegistry,
    user,
    emailReservation,
    emailVerification,
    passwordReset,
    credential,
    passkey,
    refreshToken,
    revokedToken,
    failedLoginAttempt,
    authEvent,
    signupApproval,
    householdKeyEnvelope,
    userMfa,
    mfaEmailOtp,
    trustedDevice,
    passkeyChallenge,
  };
}
