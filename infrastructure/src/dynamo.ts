// All DynamoDB tables. On-demand billing, TTL on the short-lived token and
// event tables. Schemas mirror the repositories in apps/api/src/dynamo.
// Point-in-time recovery (PITR) is stack-configured via
// `createTables({ enablePitr })` (sourced from `retivo:enablePitr`) — prod
// enables it, the dev example forgoes it as an explicit cost/DR tradeoff
// (docs/deploy.md → "Point-in-time recovery (`enablePitr`)").

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
  /**
   * Cost-control knob (sourced from `retivo:enablePitr`): enable
   * point-in-time recovery on every table. Applied uniformly — there is no
   * per-table override. Prod ships `true`; the dev example ships `false`
   * (explicit cost/DR tradeoff — see docs/deploy.md → "Point-in-time recovery
   * (`enablePitr`)").
   */
  readonly enablePitr: boolean;
}

/**
 * Default settings used by every table:
 *   - Pay-per-request (on-demand) billing.
 *   - PITR per the stack-configured `enablePitr` flag (no longer always-on;
 *     a 35-day continuous-backup window when enabled). prod=on; dev example
 *     =off as a deliberate cost/DR tradeoff (docs/deploy.md → "Point-in-time
 *     recovery (`enablePitr`)").
 *   - SSE with the AWS-**owned** key: no KMS API requests, $0, and no
 *     CloudTrail visibility into data-at-rest decrypts. This is a deliberate
 *     trade-off — auditability of decrypts for guaranteed-free, zero KMS
 *     free-tier contention (docs/security.md → "Backups and at-rest
 *     encryption"). Selector quirk: `serverSideEncryption.enabled: false` is
 *     the AWS-*owned* key; `enabled: true` with no `kmsMasterKeyId` is the
 *     AWS-*managed* `aws/dynamodb` key (billed + CloudTrail-logged). Do not
 *     "re-enable" SSE thinking it strengthens encryption — it silently moves
 *     every table onto the billed managed key.
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

  // KSUID-keyed; SK is sortable, range queries supported.
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

  // Per-aggregate version tracking — used for the optimistic-concurrency
  // condition on every push. PK householdId + SK aggregateId means we
  // can transactionally update the version while appending to MutationLog.
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

  // Composite hash key written as `householdId#deviceId#mutationId`.
  // 7-day TTL on `expiresAt`.
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

  // GSI EmailIndex on emailLowercase for login lookup.
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
        // hashKey on a GSI is deprecated in @pulumi/aws v7 — use keySchemas
        // (plural). One entry per attribute; keyType "HASH" for partition,
        // "RANGE" for sort.
        keySchemas: [{ attributeName: "emailLowercase", keyType: "HASH" }],
        projectionType: "ALL",
      },
    ],
  });

  // Enforces signup uniqueness via TransactWriteItems with User.
  const emailReservation = new aws.dynamodb.Table(t("email-reservation"), {
    ...commonArgs(enablePitr),
    name: t("email-reservation"),
    hashKey: "emailLowercase",
    attributes: [{ name: "emailLowercase", type: "S" }],
  });

  // 24-hour TTL on `expiresAt`.
  const emailVerification = new aws.dynamodb.Table(t("email-verification"), {
    ...commonArgs(enablePitr),
    name: t("email-verification"),
    hashKey: "verificationToken",
    attributes: [{ name: "verificationToken", type: "S" }],
    ttl: { attributeName: "expiresAt", enabled: true },
  });

  // Self-service password reset. PK resetToken + 15-min TTL on
  // `expiresAt`. Mirrors the email-verification token table.
  //
  // COST IMPACT: a new billable DynamoDB
  // table. On-demand (PAY_PER_REQUEST) + stack-configured PITR like every
  // other token table → ≈$0 at single-household scale (free-tier
  // on-demand; a handful of short-lived rows). No GSI, no Scan grant.
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

  // 30-day TTL on `expiresAt`. tokenFamilyId stored as a non-key attribute.
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

  // TTL = original token's exp (≤ 60 min). GSI `UserIndex` (for the account
  // export): the table is keyed by `jti` alone and rows carry `userId`, but
  // there was no index to reach a user's revoked/denylisted-token rows without
  // a Scan — Scan on this table is deliberately withheld from the api role.
  // `INCLUDE` projection carries only the attributes the export needs (jti,
  // kind, revokedAt, expiresAt; jti and userId are always included as the base
  // table's key + the GSI's own hash key) so a per-row GetItem is never needed.
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

  // 24-hour TTL on `expiresAt` (after last failure).
  const failedLoginAttempt = new aws.dynamodb.Table(t("failed-login-attempt"), {
    ...commonArgs(enablePitr),
    name: t("failed-login-attempt"),
    hashKey: "emailLowercase",
    attributes: [{ name: "emailLowercase", type: "S" }],
    ttl: { attributeName: "expiresAt", enabled: true },
  });

  // 7-day TTL on `expiresAt`. NEW_AND_OLD_IMAGES stream so the cascade
  // Lambda receives the deleted row's userId on TTL-driven REMOVE
  // events.
  const signupApproval = new aws.dynamodb.Table(t("signup-approval"), {
    ...commonArgs(enablePitr),
    name: t("signup-approval"),
    hashKey: "approvalToken",
    attributes: [{ name: "approvalToken", type: "S" }],
    ttl: { attributeName: "expiresAt", enabled: true },
    streamEnabled: true,
    streamViewType: "NEW_AND_OLD_IMAGES",
  });

  // 1-year TTL on `expiresAt`. KSUID-keyed for time-ordered queries.
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

  // Zero-knowledge key envelopes. PK householdId + SK
  // slotId; SK `ENVELOPE_META` holds the per-household envelope-set
  // integrity row. Dedicated table (not folded into WorkspaceMeta) so key
  // material stays outside the compactor's privilege boundary. No GSIs.
  //
  // TTL on `expiresAt`: only ARCHIVE-namespaced
  // rows (a displaced slot or the displaced ENVELOPE_META row from a version
  // an envelope write just superseded) ever carry this attribute — a live
  // slot or the live meta row never does, so TTL only ever reaps archive
  // rows. The TTL is keyed on the attribute alone, not the row's namespace:
  // an operator restore that republishes an archived row at a live key must
  // strip `expiresAt` first (AGENTS.md → "Key-envelope archive recovery").
  // Archive retention is 30 days; DynamoDB TTL deletes lazily (up to ~48h
  // late), so this is a floor on retention, not a ceiling.
  //
  // COST IMPACT: a new billable DynamoDB table. On-demand
  // (PAY_PER_REQUEST) + stack-configured PITR like every other table → ≈$0 at
  // single-household scale (free-tier on-demand; PITR, when enabled, billed on
  // stored bytes, negligible for a handful of slot + bounded archive rows).
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

  // --- Enforced second-factor (MFA) tables ----------------------

  // TOTP enrollment state, one row per user. PK userId,
  // no TTL. SSE-protected at rest by the dedicated table + a narrow api-role
  // grant (point-ops only) — the HouseholdKeyEnvelope isolation pattern, no
  // separate KMS CMK. No GSIs.
  //
  // COST IMPACT: a new billable DynamoDB table.
  // On-demand (PAY_PER_REQUEST) + stack-configured PITR like every other
  // table → ≈$0 at single-household scale (free-tier on-demand; a handful of
  // rows).
  const userMfa = new aws.dynamodb.Table(t("user-mfa"), {
    ...commonArgs(enablePitr),
    name: t("user-mfa"),
    hashKey: "userId",
    attributes: [{ name: "userId", type: "S" }],
  });

  // Live Email-OTP code hash, one row per user. PK userId, ~10-min TTL on
  // `expiresAt` (the daily-cap counters live on the User row so they survive
  // this TTL). No GSIs.
  //
  // COST IMPACT: a new billable DynamoDB table.
  // On-demand + stack-configured PITR → ≈$0 at single-household scale
  // (free-tier on-demand; one short-lived row per pending challenge).
  const mfaEmailOtp = new aws.dynamodb.Table(t("mfa-email-otp"), {
    ...commonArgs(enablePitr),
    name: t("mfa-email-otp"),
    hashKey: "userId",
    attributes: [{ name: "userId", type: "S" }],
    ttl: { attributeName: "expiresAt", enabled: true },
  });

  // Per-device MFA-skip trust. PK userId + SK deviceId, ~30-day TTL on
  // `expiresAt`. Query-by-userId backs the manage-trusted-devices listing +
  // the account-deletion cascade. No GSIs.
  //
  // COST IMPACT: a new billable DynamoDB table.
  // On-demand + stack-configured PITR → ≈$0 at single-household scale
  // (free-tier on-demand; a few rows per user).
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

  // Shared, single-use WebAuthn challenge storage. PK `key` — the caller's own namespaced string
  // (`reg:<userId>`, `stepup:<userId>:<purpose>:<challenge>`,
  // `mfa:<userId>:<challenge>`, `auth:<challenge>` — the key string IS the
  // security binding; see PasskeyChallengeStore). Replaces the old
  // per-process in-memory Map so a challenge minted on one API (Lambda)
  // instance is consumable on another and single-use consumption is atomic
  // across instances (DeleteItem + ReturnValues ALL_OLD — one item-level op,
  // not a read-then-delete pair). 5-min TTL enforced by the reader against
  // `expiresAt` at read time, NOT by this table's DynamoDB TTL (deletion
  // lags up to ~48h; DynamoDB Local never sweeps at all) — this attribute is
  // hygiene only. The `auth:`-namespaced rows (unauthenticated-writable) are
  // distinguishable at this layer by their key prefix alone, so an
  // admission bound needs no table reshape; today the only bound on
  // anonymous challenge rows is the route's `@Throttle` budget plus this TTL.
  // The same table also holds the shared request-throttle counters, under a
  // distinct `throttle:` key prefix.
  //
  // COST IMPACT: a new billable DynamoDB table (adding one is an ask-before
  // change, see AGENTS.md → "Project-specific 'ask before'"). On-demand
  // (PAY_PER_REQUEST) + stack-configured PITR like every sibling
  // token table; no GSI, no Scan grant — every access is a keyed point-op
  // (the account-deletion cascade deliberately does not sweep this table).
  // Rows are usable for 5 minutes and stored
  // only until the TTL sweep (up to ~48h), so steady-state storage is
  // negligible and TTL deletes are unbilled; the
  // write volume tracks every WebAuthn ceremony start/finish (register,
  // login, MFA, step-up) — 2 write request units per ceremony (issue +
  // consume). DynamoDB's standing free tier (25 GB storage / 25 provisioned
  // WCU-RCU) does NOT cover on-demand request units, so this is billed from
  // the first request — at on-demand pricing of ~$1.25 per million write
  // request units (us-east-2, current AWS list price — verify at deploy
  // time), a household's few hundred ceremonies a month cost well under a
  // cent. The one open variable is the unauthenticated `authenticate/start`
  // route, which can mint a row with no session at all; that path is bounded
  // only by its per-IP `@Throttle` limit, not a storage-layer admission
  // ceiling.
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
