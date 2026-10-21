// Pulumi entry point. Composes the per-resource modules into a single
// stack: tables, snapshots bucket, SSM parameters, IAM roles, Lambdas, API
// Gateway, CloudFront, monitoring and the optional backup vault and audit
// trail.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { loadConfig, namePrefix } from "./src/config";
import { createTables } from "./src/dynamo";
import { createSnapshotsBucket } from "./src/s3";
import { createSsmParameters } from "./src/ssm";
import { createRoles } from "./src/iam";
import { createLambdas, createProbeLambda } from "./src/lambda";
import { createApiGateway } from "./src/api-gateway";
import { createEdge } from "./src/cloudfront";
import { createMonitoring } from "./src/monitoring";
import {
  createApiDns,
  createApiDomainAlias,
  createCloudFrontAliases,
  createDns,
} from "./src/dns";
import { attachSpaBucketPolicy, createSpaHosting } from "./src/spa-hosting";
import { createCloudTrail } from "./src/cloudtrail";
import { createSignupCascade } from "./src/signup-cascade";
import { createBackup } from "./src/backup";

const cfg = loadConfig();
const prefix = namePrefix(cfg.stack);

// DynamoDB tables (sync + auth). PITR per the stack-configured knob.
const tables = createTables({ namePrefix: prefix, enablePitr: cfg.enablePitr });

// S3 workspace snapshots bucket. Versioning + the noncurrent-version
// lifecycle rule ride the prod-only `enableBackups` knob:
// AWS Backup for S3 only protects versioned buckets, and versioning closes the
// api-role-overwrite gap on the live prod bucket. Dev's bucket is unchanged.
const snapshots = createSnapshotsBucket({
  namePrefix: prefix,
  enableVersioning: cfg.enableBackups,
});

// SSM parameter placeholders. JWT/refresh/edge secrets are
// random + rotated by the bootstrap script (Pulumi ignoreChanges on
// value). The SES from-address is a config value managed by Pulumi.
const ssm = createSsmParameters({
  namePrefix: prefix,
  stack: cfg.stack,
  sesFromAddress: cfg.sesFromAddress,
});

// IAM roles (least privilege; api ≠ compactor)
const roles = createRoles({
  namePrefix: prefix,
  tables,
  snapshotsBucketArn: snapshots.bucket.arn,
  ssmParameterArns: ssm.arns,
  permissionsBoundaryArn: cfg.iamPermissionsBoundaryArn,
});

// Lambda functions. Bundled artifact comes from
//   `pnpm --filter @retirement/api build:lambda` (apps/api/build/lambda).
// Compactor schedule is enabled. The cadence (hourly on prod, every 6 hours
// on dev — see lambda.ts) is benign for a single-household workspace; a
// no-op run on an empty workspace is logged + skipped.
//
// Janitor schedule enabled by default. Daily run that enforces snapshot
// retention; it replaces a blanket 90-day S3 lifecycle rule, which would
// have deleted the data of users inactive past the cutoff.
const lambdas = createLambdas({
  namePrefix: prefix,
  stack: cfg.stack,
  tables,
  snapshotsBucketName: snapshots.bucketName,
  roles,
  webOrigin: cfg.webOrigin,
  approverEmail: cfg.approverEmail,
  compactorEnabled: true,
  janitorEnabled: true,
  authMfaEnforced: cfg.authMfaEnforced,
  snapshotMinKeep: cfg.snapshotMinKeep,
  snapshotMinAgeDays: cfg.snapshotMinAgeDays,
  logRetentionDays: cfg.logRetentionDays,
});

// Regional ACM cert + Route53 zone lookup for the API custom domain.
// Distinct from the us-east-1 CloudFront cert (API Gateway HTTP API
// custom domains are regional). Provisioned whenever apiDomainName is
// configured, independent of the web domainName.
const apiDns = cfg.apiDomainName
  ? createApiDns({ namePrefix: prefix, apiDomainName: cfg.apiDomainName })
  : undefined;

// API Gateway (HTTP API → api Lambda). When apiDomainName is set,
// a regional custom domain + mapping are created and CloudFront's
// /api/* origin points at it; disableExecuteApiEndpoint (two-step
// cutover flag) locks out the raw execute-api host.
const apiGw = createApiGateway({
  namePrefix: prefix,
  apiLambda: lambdas.api,
  webOrigin: cfg.webOrigin,
  apiDomainName: cfg.apiDomainName,
  apiCertificateArn: apiDns?.certificateValidationArn,
  disableExecuteApiEndpoint: cfg.apiDomainName
    ? cfg.disableExecuteApiEndpoint
    : false,
  // Free stage-wide flood guard on both stacks (config keys, defaults 20/50).
  apiThrottleRatePerSec: cfg.apiThrottleRatePerSec,
  apiThrottleBurst: cfg.apiThrottleBurst,
  logRetentionDays: cfg.logRetentionDays,
});

// Optional DNS (Route53 + ACM cert) when domainName is configured
const dns = cfg.domainName
  ? createDns({ namePrefix: prefix, domainName: cfg.domainName })
  : undefined;

// SPA hosting — private S3 bucket served exclusively through CloudFront
// via Origin Access Control. Contents uploaded by the bootstrap script.
const spa = createSpaHosting({ namePrefix: prefix });

// Read the edge-shared-secret from SSM at preview/up time. Pulumi
// re-evaluates this data source on every run; if the secret rotates
// (via `aws ssm put-parameter --overwrite`), the next `pulumi up`
// updates the CloudFront origin custom header automatically. The api
// Lambda independently re-fetches it on cold start.
const edgeSharedSecret = aws.ssm
  .getParameterOutput(
    { name: ssm.edgeSharedSecret.name, withDecryption: true },
    { dependsOn: [ssm.edgeSharedSecret] },
  )
  .apply((p) => p.value);

// CloudFront + WAF + security-headers function. Default behavior
// serves the SPA from S3; /api/* routes to API Gateway. Geo-restriction
// is hardcoded to US-only inside cloudfront.ts. `edgeAllowedIps` (dev-only,
// refused on prod at config load) turns on the viewer-IP gate that
// can stand in for WAF on a dev stack.
const edge = createEdge({
  namePrefix: prefix,
  apiOriginUrl: apiGw.originUrl,
  spaBucketRegionalDomainName: spa.bucketRegionalDomainName,
  spaOriginAccessControlId: spa.originAccessControl.id,
  edgeSharedSecret: pulumi.secret(edgeSharedSecret),
  aliasDomain: cfg.domainName,
  acmCertificateArn: dns?.certificate.arn,
  enableWaf: cfg.enableWaf,
  edgeAllowedIps: cfg.edgeAllowedIps,
  assistantBridgePort: cfg.assistantBridgePort,
});

// Health-check probe Lambda. Created AFTER createEdge() so the
// CloudFront distribution domain is available as its API_ENDPOINT — the
// probe must hit the distribution (which injects X-Origin-Verify), not the
// raw API GW host. No circular dependency: probe -> edge -> apiGw ->
// coreLambdas, no reverse edge.
const probe = createProbeLambda({
  namePrefix: prefix,
  stack: cfg.stack,
  probeApiEndpoint: pulumi.interpolate`https://${edge.distribution.domainName}`,
  logRetentionDays: cfg.logRetentionDays,
  permissionsBoundaryArn: cfg.iamPermissionsBoundaryArn,
});

// Per-stack CloudWatch monitoring with an explicit dev/prod policy matrix
// (SNS topic + email, availability + data-integrity + security alarms). Prod
// carries the full alarm inventory; dev is reduced to critical
// availability, data-integrity, and intrusion-detection signals only. Created
// last, after every metric source exists, so no alarm is permanently in
// INSUFFICIENT_DATA. `stack` drives the isProd dev/prod split internally;
// layered on top, four required group switches (security, API health,
// background jobs, capacity) each gate exactly their own alarms — see
// monitoring.ts.
const monitoringOpts = {
  namePrefix: prefix,
  stack: cfg.stack,
  alarmEmail: cfg.alarmNotificationEmail,
  apiLambda: lambdas.api,
  compactorLambda: lambdas.compactor,
  janitorLambda: lambdas.janitor,
  apiId: apiGw.api.id,
  apiLogGroup: lambdas.apiLogGroup,
  lambdaConcurrencyQuota: cfg.lambdaConcurrencyQuota,
  enableSecurityAlarms: cfg.enableSecurityAlarms,
  enableApiHealthAlarms: cfg.enableApiHealthAlarms,
  enableBackgroundJobAlarms: cfg.enableBackgroundJobAlarms,
  enableCapacityAlarms: cfg.enableCapacityAlarms,
};

// Immutable AWS Backup vault. PROD-ONLY, gated behind the required
// `retivo:enableBackups` knob: the GOVERNANCE-locked vault is the
// live-role-isolated disaster floor over every DynamoDB table + the S3 snapshots
// bucket. Created last so the alarm SNS topic (monitoring.alarmTopic) and the
// backup service role already exist. Dev (enableBackups=false) provisions none
// of it and its snapshots bucket stays un-versioned. The region-global
// RegionSettings singleton inside is PROD-owned — dev must never enable
// backups while prod owns it (see docs/deploy.md → "Backups (`enableBackups`)").
//
// `createMonitoring` is called with the literal `enableBackups: true`/`false`
// here — not a shared variable — because that literal is what selects the
// overload whose return type promises a non-optional `alarmTopic` for the
// `createBackup` call below (monitoring.ts, MonitoringOutputs). A cast or a
// truthiness guard on `monitoring.alarmTopic` would let a future guard change
// silently drop backup alerting; this makes the compiler enforce it instead.
if (cfg.enableBackups) {
  const monitoring = createMonitoring({
    ...monitoringOpts,
    enableBackups: true,
  });
  createBackup({
    namePrefix: prefix,
    tables,
    snapshotsBucketArn: snapshots.bucket.arn,
    backupRole: roles.backup,
    alarmTopic: monitoring.alarmTopic,
  });
} else {
  createMonitoring({ ...monitoringOpts, enableBackups: false });
}

// Bucket policy can only reference the distribution's ARN, so it's
// attached after the distribution is constructed.
attachSpaBucketPolicy({
  namePrefix: prefix,
  bucket: spa.bucket,
  distributionArn: edge.distribution.arn,
});

if (cfg.domainName && dns) {
  createCloudFrontAliases({
    namePrefix: prefix,
    hostedZoneId: dns.hostedZoneId,
    domainName: cfg.domainName,
    distributionDomainName: edge.distribution.domainName,
    distributionHostedZoneId: edge.distribution.hostedZoneId,
    // No AAAA while the IPv4-only edge gate is on (cloudfront.ts turns the
    // distribution's IPv6 off for the same reason).
    ipv6Enabled: cfg.edgeAllowedIps.length === 0,
  });
}

// Route53 alias for the API custom domain → the regional API Gateway
// domain target. Done after the custom domain is created so we can read
// its regional domain name + hosted-zone id.
if (cfg.apiDomainName && apiDns && apiGw.customDomain) {
  createApiDomainAlias({
    namePrefix: prefix,
    hostedZoneId: apiDns.hostedZoneId,
    apiDomainName: cfg.apiDomainName,
    targetDomainName:
      apiGw.customDomain.domainNameConfiguration.targetDomainName,
    targetHostedZoneId:
      apiGw.customDomain.domainNameConfiguration.hostedZoneId,
  });
}

// Stream-triggered cascade for the signup-approval gate. Owns its own
// IAM role (disjoint from the api + compactor roles) and is wired to the
// SignupApproval table's stream — TTL-driven REMOVEs reap the user-row
// sub-graph for unapproved signups.
const signupCascade = createSignupCascade({
  namePrefix: prefix,
  stack: cfg.stack,
  tables,
  logRetentionDays: cfg.logRetentionDays,
  permissionsBoundaryArn: cfg.iamPermissionsBoundaryArn,
});

// Account-level audit trail. One trail
// captures management events from every stack in the account; the log
// bucket is object-lock-enabled (GOVERNANCE 90d), with log-file validation
// (a digest chain) so tampering is detectable. GOVERNANCE still permits a
// full account admin to lift the lock. Free for the first trail per region.
//
// Owned per the `retivo:manageCloudTrail` knob. NEW STACKS ONLY: once a
// stack has created the trail + its object-lock bucket, flipping this flag to
// false would make Pulumi try to delete an undeletable bucket — see
// docs/deploy.md → "Audit trail (`manageCloudTrail`)". When false the trail + bucket are skipped
// and the related outputs render `(disabled)`.
const cloudTrail = cfg.manageCloudTrail
  ? createCloudTrail({ namePrefix: prefix })
  : undefined;

// ---------- Stack outputs (visible via `pulumi stack output`) ----------

export const stack = cfg.stack;

export const tableNames = {
  workspaceMeta: tables.workspaceMeta.name,
  mutationLog: tables.mutationLog.name,
  aggregateVersion: tables.aggregateVersion.name,
  idempotencyKey: tables.idempotencyKey.name,
  deviceRegistry: tables.deviceRegistry.name,
  user: tables.user.name,
  emailReservation: tables.emailReservation.name,
  emailVerification: tables.emailVerification.name,
  credential: tables.credential.name,
  passkey: tables.passkey.name,
  refreshToken: tables.refreshToken.name,
  revokedToken: tables.revokedToken.name,
  failedLoginAttempt: tables.failedLoginAttempt.name,
  authEvent: tables.authEvent.name,
  signupApproval: tables.signupApproval.name,
};

export const snapshotsBucket = snapshots.bucketName;

export const apiLambda = lambdas.api.name;
export const compactorLambda = lambdas.compactor.name;
export const janitorLambda = lambdas.janitor.name;
export const accountSnapshotPurgeLambda = lambdas.snapshotPurge.name;
export const probeLambda = probe.lambda.name;
export const signupCascadeLambda = signupCascade.name;

export const apiGatewayInvokeUrl = apiGw.invokeUrl;
export const apiCustomDomain = cfg.apiDomainName ?? "(not configured)";
export const cloudfrontDomain = edge.distribution.domainName;
export const cloudfrontDistributionId = edge.distribution.id;
// `(disabled)` sentinel when the cost-control knob skips the resource, so
// `pulumi stack output` stays readable instead of crashing on undefined.
export const wafWebAclArn: pulumi.Output<string> | string =
  edge.webAcl?.arn ?? "(disabled)";
export const spaBucket = spa.bucketName;

export const customDomain = cfg.domainName ?? "(not configured)";

export const cloudTrailName: pulumi.Output<string> | string =
  cloudTrail?.trail.name ?? "(disabled)";
export const cloudTrailBucket: pulumi.Output<string> | string =
  cloudTrail?.bucket.bucket ?? "(disabled)";
