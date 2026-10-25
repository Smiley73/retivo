// Typed wrapper around the `retivo:` Pulumi stack config; keys are documented in docs/deploy.md.

import * as pulumi from "@pulumi/pulumi";
import {
  anythingSendsAlerts,
  assertEdgeAllowedIpsForStack,
  parseAlarmNotificationEmail,
  parseApiThrottle,
  parseAssistantBridgePort,
  parseEdgeAllowedIps,
  parseLambdaConcurrencyQuota,
  parseLogRetentionDays,
  parseRequiredBoolean,
} from "./config-helpers.mjs";

const cfg = new pulumi.Config("retivo");

/**
 * Typed stack config. The `enable*`, `manageCloudTrail` and `logRetentionDays` knobs are required
 * with no default (a missing key fails config load), so a newcomer is never billed or left without
 * alerting by accident. The CloudFront geo restriction is not a knob: it is US-only by design and
 * lives in `cloudfront.ts` so changing it goes through code review.
 */
export interface StackConfig {
  /** The exact origin the SPA is served from; used for CORS and Origin checks. */
  readonly webOrigin: string;
  /** Optional; when set, Route53 and an ACM certificate are provisioned. */
  readonly domainName: string | undefined;
  /** Optional API custom domain (a real FQDN under a Route53 zone the stack manages). */
  readonly apiDomainName: string | undefined;
  /** Two-step cutover (docs/deploy.md): disables the public execute-api endpoint; needs `apiDomainName`. */
  readonly disableExecuteApiEndpoint: boolean;
  /** SES sender. The placeholder default sends no mail, so sign-ups cannot verify until a real one is set. */
  readonly sesFromAddress: string;
  /** Owner inbox for sign-up approvals (APPROVER_EMAIL); required when `sesFromAddress` is a real address. */
  readonly approverEmail: string | undefined;
  /** The Pulumi stack name (`dev`, `prod`); used in resource naming. */
  readonly stack: string;
  /** Janitor floor: snapshots per household kept regardless of age (default 10). */
  readonly snapshotMinKeep: number;
  /** Janitor age cutoff in days, subject to the floor (default 90). */
  readonly snapshotMinAgeDays: number;
  /** CloudFront WAF web ACL; a dev stack may run `false` behind `edgeAllowedIps` (docs/deploy.md "Firewall and the dev edge IP gate"). */
  readonly enableWaf: boolean;
  /** Dev-only IPv4 allowlist enforced at the edge; empty = off, and prod refuses a non-empty value. */
  readonly edgeAllowedIps: ReadonlyArray<string>;
  /** API Gateway `$default` stage steady-state throttle, requests/second (default 20). */
  readonly apiThrottleRatePerSec: number;
  /** API Gateway `$default` stage throttle burst (default 50); independent of the rate. */
  readonly apiThrottleBurst: number;
  /** Enforced-MFA master switch (AUTH_MFA_ENFORCED); defaults `true` so a missing key fails secure. */
  readonly authMfaEnforced: boolean;
  /** Own the account-level CloudTrail trail; new stacks only (docs/deploy.md "Audit trail (`manageCloudTrail`)"). */
  readonly manageCloudTrail: boolean;
  /** DynamoDB point-in-time recovery on every table (docs/deploy.md "Point-in-time recovery (`enablePitr`)"). */
  readonly enablePitr: boolean;
  /** The immutable AWS Backup vault; prod-only (docs/deploy.md "Backups (`enableBackups`)"). */
  readonly enableBackups: boolean;
  /** Alarm group: refresh-token reuse, MFA-failed burst and failed-login burst. */
  readonly enableSecurityAlarms: boolean;
  /** Alarm group: api error count on every stack, plus p95 latency on prod. */
  readonly enableApiHealthAlarms: boolean;
  /** Alarm group: the five compactor alarms on every stack, plus the janitor heartbeat on prod. */
  readonly enableBackgroundJobAlarms: boolean;
  /** Alarm group: the two account-wide Lambda concurrency alarms; deploys on prod only. */
  readonly enableCapacityAlarms: boolean;
  /** CloudWatch Logs retention in days for every Lambda and API Gateway log group; must be an AWS enum value. */
  readonly logRetentionDays: number;
  /** Alarm SNS topic subscriber; required whenever `anythingSendsAlerts` holds (docs/deploy.md "Alarms"). */
  readonly alarmNotificationEmail: string | undefined;
  /** Shared Lambda concurrency quota (default 10) that the prod concurrency alarm's threshold derives from. */
  readonly lambdaConcurrencyQuota: number;
  /** Permissions-boundary ARN attached to every role this stack creates; unset = none. */
  readonly iamPermissionsBoundaryArn: string | undefined;
  /** Loopback port of the local assistant bridge; adds one CSP `connect-src` entry. Unset = off. */
  readonly assistantBridgePort: number | undefined;
}

const DEFAULT_SES_FROM = "no-reply@example.invalid";
const DEFAULT_SNAPSHOT_MIN_KEEP = 10;
const DEFAULT_SNAPSHOT_MIN_AGE_DAYS = 90;

// A real FQDN, so a bad domain fails at preview rather than bricking the edge on deploy.
const FQDN_PATTERN =
  /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Minimal mailbox@host shape; SES and the api's zod `.email()` check strictly.
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

  // Required knobs have no default: a missing key, non-boolean or off-enum retention throws here,
  // before any resource is touched. The parsers take pulumi.Config's raw string getter.
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
  // The same predicate decides whether monitoring.ts builds the alarm topic.
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
  const assistantBridgePort = parseAssistantBridgePort(rawGet);

  // Edge IP gate is dev-only. Neither WAF nor the gate is the lowest-cost posture; warn so it is
  // never an accident.
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
    assistantBridgePort,
  };
}

/**
 * Resource-name prefix used across the program. Keeps every name stack-scoped
 * so dev and prod resources can co-exist without collision.
 */
export function namePrefix(stack: string): string {
  return `retivo-${stack}`;
}
