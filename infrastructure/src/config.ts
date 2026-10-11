// Typed wrapper around Pulumi's stack configuration. Centralizes all
// `pulumi config get/set` keys in one place so the rest of the program
// can import a typed object instead of stringly-typed lookups.

import * as pulumi from "@pulumi/pulumi";
import {
  anythingSendsAlerts,
  assertEdgeAllowedIpsForStack,
  parseAlarmNotificationEmail,
  parseApiThrottle,
  parseEdgeAllowedIps,
  parseLambdaConcurrencyQuota,
  parseLogRetentionDays,
  parseRequiredBoolean,
} from "./config-helpers.mjs";

const cfg = new pulumi.Config("retivo");

/**
 * Stack-config view: typed, with sensible defaults where applicable.
 *
 * Update keys via:
 *   pulumi config set retivo:webOrigin https://...
 *   pulumi config set retivo:domainName ...
 *   pulumi config set retivo:apiDomainName api.dev.retivo.example.com
 *   pulumi config set retivo:sesFromAddress no-reply@example.com
 *   pulumi config set retivo:approverEmail owner@example.com
 *
 * The CloudFront geo-restriction is intentionally *not* a config knob —
 * this is a US-only application by design.
 * If that ever changes, edit `cloudfront.ts` directly so the decision
 * lives in code review rather than in a stack config that can silently
 * drift between dev and prod.
 */
export interface StackConfig {
  /** The exact origin the SPA is served from. Used for CORS + Origin checks. */
  readonly webOrigin: string;
  /** Optional. If set, Route53 + ACM cert will be provisioned. */
  readonly domainName: string | undefined;
  /**
   * Optional custom domain for the API (e.g. `api.dev.retivo.example.com`).
   * When set, a regional API Gateway custom domain + certificate are
   * provisioned and CloudFront's `/api/*` origin points at it; it must sit
   * under a Route53 hosted zone the stack can manage, and is validated as a
   * real FQDN. When empty (the default), CloudFront reaches the API through
   * the default execute-api host, which stays reachable but refuses any
   * request that did not come through CloudFront (the edge shared secret).
   */
  readonly apiDomainName: string | undefined;
  /**
   * Two-step edge cutover flag (default false). Keep false on the first
   * `pulumi up` that adds the custom domain + points CloudFront `/api/*`
   * at it; verify `/api/*` works; then set true on a second `pulumi up`
   * to disable the public execute-api endpoint (API reachable only via
   * the custom domain). Rollback = set back to false + `pulumi up`. Only
   * honored when `apiDomainName` is set. See docs/deploy.md.
   */
  readonly disableExecuteApiEndpoint: boolean;
  /**
   * Verified-in-SES sender for signup verification mail. Goes into
   * the SSM parameter the api Lambda reads at cold start. While SES is
   * in sandbox mode (default for new accounts), this address must be
   * verified via `aws sesv2 create-email-identity` before any mail
   * actually delivers — `bootstrap-stack.sh` triggers the verification
   * email automatically on first run. Defaults to a placeholder so
   * the stack provisions without forcing the operator to set it up
   * front; with the placeholder no verification mail is sent and a deployed
   * api never returns the verification token, so a new sign-up cannot
   * verify its email or sign in until a real address is set.
   */
  readonly sesFromAddress: string;
  /**
   * Owner/approver inbox for owner approval of new sign-ups
   * (`retivo:approverEmail`). The api Lambda receives it as APPROVER_EMAIL:
   * new-signup notices go here, and a signup from this exact address is
   * auto-approved as the owner. REQUIRED whenever `sesFromAddress` is a real
   * (non-placeholder) address — without it the api falls back to the sender,
   * which is a dead `noreply@` mailbox on deployed stacks.
   */
  readonly approverEmail: string | undefined;
  /** The Pulumi stack name (`dev`, `prod`, etc). Used in resource naming. */
  readonly stack: string;
  /**
   * Janitor retention floor: minimum number of snapshots per
   * household the daily janitor must keep, regardless of age. Default
   * 10.
   */
  readonly snapshotMinKeep: number;
  /**
   * Janitor age cutoff: snapshots older than this many days are
   * eligible for deletion (subject to the floor above). Default 90.
   */
  readonly snapshotMinAgeDays: number;
  /**
   * Cost-control knob (REQUIRED, no default): provision the CloudFront
   * AWS WAF web ACL (`AWSManagedRulesCommonRuleSet` + IP rate rule). The prod
   * example ships `true`, the dev example `false`; a dev stack may run
   * `false` behind the edge IP gate (`edgeAllowedIps`) instead, and
   * `loadConfig` warns when a stack has neither. See docs/deploy.md.
   */
  readonly enableWaf: boolean;
  /**
   * Dev-only edge IP gate (OPTIONAL, default empty = off): IPv4 addresses
   * or IPv4/prefix blocks allowed to reach the CloudFront distribution.
   * When non-empty, the SPA router CloudFront Function and a new `/api/*`
   * gate function answer 403 at the edge for any other viewer IP (no
   * origin, no Lambda), IPv6 is turned off on the distribution, and the
   * web domain's AAAA alias is skipped so a dual-stack browser cannot
   * arrive over an unmatched IPv6 address. Baked into the function code at
   * deploy time — a new home IP is `pulumi config set` + deploy. Prod
   * refuses a non-empty value (public product). Parsed/normalised in
   * config-helpers.mjs.
   */
  readonly edgeAllowedIps: ReadonlyArray<string>;
  /**
   * API Gateway `$default` stage throttle, steady-state requests/second
   * (OPTIONAL, default 20). Aggregate across every route and caller (the
   * HTTP API has one `$default` route), best-effort, and independent of
   * the burst value. Excess requests get API Gateway's own 429 without a
   * Lambda invocation — the free flood/cost guard on both stacks.
   */
  readonly apiThrottleRatePerSec: number;
  /**
   * API Gateway `$default` stage throttle burst (OPTIONAL, default 50).
   * See `apiThrottleRatePerSec`; AWS documents the two as independent, so
   * a burst below the rate is accepted.
   */
  readonly apiThrottleBurst: number;
  /**
   * Enforced-MFA master switch. OPTIONAL, defaults `true` —
   * a missing key fails secure (enforcement ON). When `true`, a password
   * login on a new/untrusted device returns an MFA challenge instead of a
   * session; `false` disables enforcement (the rollback kill-switch) without
   * a code change. Threaded to the api Lambda's AUTH_MFA_ENFORCED env var.
   */
  readonly authMfaEnforced: boolean;
  /**
   * Cost-control knob (REQUIRED, no default): own the account-level
   * CloudTrail trail from this stack. `false` skips trail + log bucket
   * entirely — NEW STACKS ONLY (the trail bucket has object-lock GOVERNANCE
   * + `forceDestroy: false`, so an existing stack cannot flip this without
   * manual Pulumi state surgery). See docs/deploy.md → "Audit trail
   * (`manageCloudTrail`)".
   */
  readonly manageCloudTrail: boolean;
  /**
   * Cost-control knob (REQUIRED, no default): enable DynamoDB
   * point-in-time recovery on every table. Prod example ships `true`; dev
   * example ships `false` (explicit cost/DR tradeoff — see docs/deploy.md →
   * "Point-in-time recovery (`enablePitr`)").
   */
  readonly enablePitr: boolean;
  /**
   * Cost-control knob (REQUIRED, no default): provision the immutable
   * AWS Backup vault (GOVERNANCE Vault Lock, daily, 90-day retention) over
   * every DynamoDB table + the S3 snapshots bucket, and enable S3 versioning
   * + the noncurrent-version lifecycle rule on the snapshots bucket. Prod
   * example ships `true`; dev example ships `false` — prod-only by design
   * (dev has no production data and a GOVERNANCE-locked vault would resist a
   * routine dev `pulumi destroy`). The region-global `RegionSettings`
   * singleton is prod-owned, so dev must never set this `true` while prod
   * owns it. See docs/deploy.md → "Backups (`enableBackups`)".
   */
  readonly enableBackups: boolean;
  /**
   * Alarm-group switch (REQUIRED, no default): the three intrusion-detection
   * alarms in `infrastructure/src/monitoring.ts` (refresh-token reuse,
   * MFA-failed burst, failed-login burst), on every stack. Gates exactly
   * that group. Required like the other paid-service switches: a default of
   * `true` would quietly bill a newcomer and a default of `false` would
   * quietly drop alerting. See docs/deploy.md.
   */
  readonly enableSecurityAlarms: boolean;
  /**
   * Alarm-group switch (REQUIRED, no default): the api error-count alarm on
   * every stack, plus the whole-API p95 latency alarm on the `prod` stack
   * only. Gates exactly that group.
   */
  readonly enableApiHealthAlarms: boolean;
  /**
   * Alarm-group switch (REQUIRED, no default): the five compactor alarms
   * (failure, coverage, snapshot-read-error, budget-limited, heartbeat) on
   * every stack, plus the janitor heartbeat on the `prod` stack only. Gates
   * exactly that group.
   */
  readonly enableBackgroundJobAlarms: boolean;
  /**
   * Alarm-group switch (REQUIRED, no default): the two account-wide Lambda
   * concurrency alarms (throttles, concurrency headroom). This group is
   * prod-only: on any other stack the switch deploys no alarms, though the
   * alarm topic and the `alarmNotificationEmail` requirement still follow it.
   */
  readonly enableCapacityAlarms: boolean;
  /**
   * Cost-control knob (REQUIRED, no default): CloudWatch Logs retention (in
   * days) applied to every Lambda + API Gateway log group. Must be one of
   * the AWS CloudWatch Logs retention enum values; any other value (e.g. 45)
   * fails config load. Dev example ships 7, prod ships 90.
   */
  readonly logRetentionDays: number;
  /**
   * Email address the per-stack CloudWatch alarm SNS topic subscribes.
   * REQUIRED (no default) whenever something sends alerts — any of the four
   * alarm-group switches or `enableBackups` is `true` (the shared
   * `anythingSendsAlerts` predicate in config-helpers.mjs); config load fails
   * loud without it. With all five off there is no topic, the key is neither
   * required nor read, and this is `undefined`. Format is NOT validated here
   * — a bad address surfaces as a failed SNS subscription with a clear
   * AWS error, acceptable for a single-operator ops key. The operator must
   * confirm the SNS subscription from their inbox after the first
   * `pulumi up`. See docs/deploy.md → "Alarms".
   */
  readonly alarmNotificationEmail: string | undefined;
  /**
   * OPTIONAL (default 10 — the account's current shared Lambda concurrency
   * quota; dev and prod share one account): the ceiling the prod-only
   * account-wide `ConcurrentExecutions` alarm's threshold (`quota - 2`) is
   * computed from. This key is the ONLY place the ceiling is written —
   * raising it here and redeploying moves the alarm threshold; nothing else
   * needs editing. Validated (integer, >= 3) in config-helpers.mjs.
   */
  readonly lambdaConcurrencyQuota: number;
  /**
   * Optional ARN of the IAM permissions boundary attached to every role this
   * stack creates. For accounts whose
   * policy requires every created role to carry a boundary. Unset (the
   * default) = no boundary.
   */
  readonly iamPermissionsBoundaryArn: string | undefined;
}

const DEFAULT_SES_FROM = "no-reply@example.invalid";
const DEFAULT_SNAPSHOT_MIN_KEEP = 10;
const DEFAULT_SNAPSHOT_MIN_AGE_DAYS = 90;

// A real FQDN: ≥ 2 dot-separated labels, each label alphanumeric with
// optional internal hyphens. Rejects empty labels, leading/trailing
// dots, and obviously bogus values so a misconfigured domain fails at
// preview rather than bricking the edge on deploy.
const FQDN_PATTERN =
  /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Minimal mailbox@host shape — enough to catch a pasted FQDN or an empty
// local part; SES/the api's zod `.email()` do the stricter check.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function loadConfig(): StackConfig {
  const stack = pulumi.getStack();
  const webOrigin = cfg.get("webOrigin") ?? "";
  const domainName = cfg.get("domainName") ?? "";
  const apiDomainName = cfg.get("apiDomainName") ?? "";
  const disableExecuteApiEndpoint =
    cfg.getBoolean("disableExecuteApiEndpoint") ?? false;
  const authMfaEnforced = cfg.getBoolean("authMfaEnforced") ?? true;
  const sesFromAddress = cfg.get("sesFromAddress") ?? DEFAULT_SES_FROM;
  const approverEmail = cfg.get("approverEmail") ?? "";
  const snapshotMinKeep =
    cfg.getNumber("snapshotMinKeep") ?? DEFAULT_SNAPSHOT_MIN_KEEP;
  const snapshotMinAgeDays =
    cfg.getNumber("snapshotMinAgeDays") ?? DEFAULT_SNAPSHOT_MIN_AGE_DAYS;
  const iamPermissionsBoundaryArn = cfg.get("iamPermissionsBoundaryArn") ?? "";

  // Cost-control knobs are REQUIRED — no defaults. The strict parse/validate
  // helpers live in config-helpers.mjs (dependency-free, unit-tested) so they
  // run without a Pulumi runtime; we hand them pulumi.Config's raw string
  // getter. A missing key, a non-boolean, or an off-enum logRetentionDays all
  // throw here → `pulumi preview/up` fails loud before any resource is touched.
  const rawGet = (key: string): string | undefined => cfg.get(key);
  const enableWaf = parseRequiredBoolean(rawGet, "enableWaf");
  const manageCloudTrail = parseRequiredBoolean(rawGet, "manageCloudTrail");
  const enablePitr = parseRequiredBoolean(rawGet, "enablePitr");
  const enableBackups = parseRequiredBoolean(rawGet, "enableBackups");
  const enableSecurityAlarms = parseRequiredBoolean(
    rawGet,
    "enableSecurityAlarms",
  );
  const enableApiHealthAlarms = parseRequiredBoolean(
    rawGet,
    "enableApiHealthAlarms",
  );
  const enableBackgroundJobAlarms = parseRequiredBoolean(
    rawGet,
    "enableBackgroundJobAlarms",
  );
  const enableCapacityAlarms = parseRequiredBoolean(
    rawGet,
    "enableCapacityAlarms",
  );
  const logRetentionDays = parseLogRetentionDays(rawGet);
  // The email is required only when something sends alerts; the same
  // predicate decides whether monitoring.ts builds the alarm topic.
  const alertSwitches = {
    enableSecurityAlarms,
    enableApiHealthAlarms,
    enableBackgroundJobAlarms,
    enableCapacityAlarms,
    enableBackups,
  };
  const alarmNotificationEmail = parseAlarmNotificationEmail(
    rawGet,
    alertSwitches,
  );
  const lambdaConcurrencyQuota = parseLambdaConcurrencyQuota(rawGet);
  const edgeAllowedIps = parseEdgeAllowedIps(rawGet);
  const apiThrottle = parseApiThrottle(rawGet);

  // Edge IP gate is dev-only: a non-empty allowlist on prod fails here,
  // before any resource is composed. A stack with neither WAF nor the gate
  // is allowed (the lowest-cost profile, see docs/deploy.md → "Firewall and
  // the dev edge IP gate") but warns on every preview/up so it is never an accident.
  assertEdgeAllowedIpsForStack(stack, edgeAllowedIps);
  if (!enableWaf && edgeAllowedIps.length === 0) {
    pulumi.log.warn(
      `retivo:enableWaf=false with no retivo:edgeAllowedIps — the ${stack} stack has neither WAF nor the edge IP gate (documented "lowest-cost" posture; set retivo:edgeAllowedIps to gate dev, or retivo:enableWaf=true).`,
    );
  }

  if (snapshotMinKeep < 1) {
    throw new Error(
      `retivo:snapshotMinKeep must be >= 1 (got ${snapshotMinKeep}). A floor of zero would let the janitor delete the only surviving snapshot for an inactive household.`,
    );
  }
  if (snapshotMinAgeDays < 1) {
    throw new Error(
      `retivo:snapshotMinAgeDays must be >= 1 (got ${snapshotMinAgeDays}).`,
    );
  }
  const sesFromIsReal =
    sesFromAddress.length > 0 && sesFromAddress !== DEFAULT_SES_FROM;
  if (sesFromIsReal && approverEmail.length === 0) {
    throw new Error(
      `retivo:approverEmail is required when retivo:sesFromAddress is set (got "${sesFromAddress}"). ` +
        `Without it the api routes signup-approval notices to the sender address. ` +
        `Run: pulumi config set retivo:approverEmail owner@example.com --stack ${stack}`,
    );
  }
  if (approverEmail.length > 0 && !EMAIL_PATTERN.test(approverEmail)) {
    throw new Error(
      `retivo:approverEmail must be an email address (got "${approverEmail}").`,
    );
  }
  if (webOrigin.length > 0 && !/^https:\/\/[^\s/]+$/.test(webOrigin)) {
    throw new Error(
      `retivo:webOrigin must be a full origin — scheme + host, no path or trailing slash — like https://app.example.com (got "${webOrigin}"). ` +
        `API Gateway CORS and the passkey RP ID both consume it; a bare hostname fails CreateApi with "Invalid format for origin". ` +
        `Run: pulumi config set retivo:webOrigin https://${webOrigin.replace(/^[a-z]+:\/\//, "")} --stack ${stack}`,
    );
  }
    if (apiDomainName.length > 0 && !FQDN_PATTERN.test(apiDomainName)) {
    throw new Error(
      `retivo:apiDomainName must be a real FQDN (got "${apiDomainName}"). Set a host like api.dev.retivo.example.com under a Route53 zone the stack can manage.`,
    );
  }
  if (stack === "prod" && logRetentionDays < 90) {
    throw new Error(
      `retivo:logRetentionDays must be >= 90 on the prod stack (got ${logRetentionDays}). ` +
        `NIST AU-11 requires 90-day minimum audit-log retention. ` +
        `Run: pulumi config set retivo:logRetentionDays 90 --stack prod`,
    );
  }
  if (enableBackups && stack !== "prod") {
    throw new Error(
      `retivo:enableBackups must be false on the ${stack} stack — backups are prod-only. ` +
        `The AWS Backup RegionSettings opt-in is an account+region singleton that prod owns; a non-prod stack enabling it would create an un-deletable GOVERNANCE vault and contend with prod for the singleton. ` +
        `Run: pulumi config set retivo:enableBackups false --stack ${stack}`,
    );
  }
  if (!anythingSendsAlerts(alertSwitches)) {
    pulumi.log.warn(
      `retivo:enableSecurityAlarms, retivo:enableApiHealthAlarms, retivo:enableBackgroundJobAlarms, retivo:enableCapacityAlarms, and retivo:enableBackups are all false — the ${stack} stack alarms on nothing: no alarm groups, no backup alerting, and no alarm SNS topic. Set any one of them to "true" to restore alerting; the alarm subscription is then re-created and stays in PendingConfirmation until its email link is clicked.`,
    );
  }

  return {
    webOrigin,
    domainName: domainName.length > 0 ? domainName : undefined,
    apiDomainName: apiDomainName.length > 0 ? apiDomainName : undefined,
    disableExecuteApiEndpoint,
    authMfaEnforced,
    sesFromAddress,
    approverEmail: approverEmail.length > 0 ? approverEmail : undefined,
    stack,
    snapshotMinKeep,
    snapshotMinAgeDays,
    enableWaf,
    manageCloudTrail,
    enablePitr,
    enableBackups,
    enableSecurityAlarms,
    enableApiHealthAlarms,
    enableBackgroundJobAlarms,
    enableCapacityAlarms,
    logRetentionDays,
    alarmNotificationEmail,
    lambdaConcurrencyQuota,
    edgeAllowedIps,
    apiThrottleRatePerSec: apiThrottle.ratePerSec,
    apiThrottleBurst: apiThrottle.burst,
    iamPermissionsBoundaryArn:
      iamPermissionsBoundaryArn.length > 0
        ? iamPermissionsBoundaryArn
        : undefined,
  };
}

/**
 * Resource-name prefix used across the program. Keeps every name stack-scoped
 * so dev and prod resources can co-exist without collision.
 */
export function namePrefix(stack: string): string {
  return `retivo-${stack}`;
}
