// CloudFront distribution + AWS WAF (CommonRuleSet + an IP rate-based BLOCK
// rule, when `enableWaf`) + CloudFront Functions: strict security headers,
// the SPA-route rewrite, and the dev-only viewer IP gate
// (`edgeAllowedIps`). Geo-restriction is hardcoded US-only. Shield Standard
// is automatic — nothing to configure.
//
// Important: AWS WAF Classic for CloudFront is GLOBAL (us-east-1) and
// AWS WAFv2 must use the `us-east-1` region for CLOUDFRONT scope. We use
// WAFv2.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { ipv4CidrToRule } from "./config-helpers.mjs";
import {
  gateOnlyCode,
  gatedSpaRouterCode,
  securityHeadersCode,
  spaRouterCode,
} from "./edge-functions.mjs";

interface CloudFrontOpts {
  readonly namePrefix: string;
  /**
   * Host for the `/api/*` origin. The regional API Gateway custom domain
   * when `retivo:apiDomainName` is set (the execute-api endpoint is
   * then disabled), else the raw execute-api invoke host. The edge
   * shared-secret origin header is preserved either way.
   */
  readonly apiOriginUrl: pulumi.Output<string>;
  readonly spaBucketRegionalDomainName: pulumi.Output<string>;
  readonly spaOriginAccessControlId: pulumi.Output<string>;
  /**
   * Shared secret CloudFront will attach as `X-Edge-Auth` on every
   * request it forwards to the API Gateway origin. The api Lambda's
   * EdgeAuthMiddleware enforces it; direct hits to the APIGW invoke
   * URL that bypass CloudFront fail with `EDGE_AUTH_REQUIRED`. Read
   * from SSM at deploy time so rotation = `aws ssm put-parameter` +
   * `pulumi up`.
   */
  readonly edgeSharedSecret: pulumi.Output<string>;
  readonly aliasDomain?: string;
  readonly acmCertificateArn?: pulumi.Output<string>;
  /**
   * Cost-control knob (REQUIRED at the call site, sourced from
   * `retivo:enableWaf`): when false, the AWS WAF web ACL is not created
   * and CloudFront ships without a `webAclId`. When true, the
   * `AWSManagedRulesCommonRuleSet` ACL is provisioned alongside an IP
   * rate-based BLOCK rule (2000 req / 5 min per IP).
   */
  readonly enableWaf: boolean;
  /**
   * Dev-only edge IP gate (sourced from `retivo:edgeAllowedIps`, already
   * normalised to `a.b.c.d/nn`). Empty = off (today's behaviour). Non-empty:
   * the SPA router function gains the allowlist check, a second function
   * gates `/api/*`, and the distribution turns IPv6 off so every viewer
   * arrives with an IPv4 address the allowlist can match.
   */
  readonly edgeAllowedIps: ReadonlyArray<string>;
  /**
   * AI assistant connector port (sourced from `retivo:assistantBridgePort`).
   * Unset = off: the security-headers function is byte-identical to the one
   * every stack already runs. Set: the SPA CSP gains exactly one
   * `connect-src` entry, `ws://127.0.0.1:<port>`.
   */
  readonly assistantBridgePort?: number;
}

// US-only application by design — the
// service is not localized, financial figures are USD-only, and the
// SSA/IRS/tax-treatment rules baked into the planning math don't apply
// outside the US. Restricting at the edge is the cheapest line of
// defense (free, runs before WAF) and avoids exposing the API to
// regions we don't intend to serve. If that changes, edit this list.
const GEO_ALLOWLIST: ReadonlyArray<string> = ["US"];

export interface Edge {
  readonly distribution: aws.cloudfront.Distribution;
  /** Present only when `enableWaf` is true; undefined when WAF is skipped. */
  readonly webAcl?: aws.wafv2.WebAcl;
}

/**
 * CloudFront WAF is scoped CLOUDFRONT and only deployable in us-east-1.
 * This provider makes sure WAFv2 + ACM resources are created there even
 * if the rest of the stack is in another region.
 */
// Default tags mirror the stack-config `aws:defaultTags` on the default
// provider, so the resources this provider creates are tagged like
// everything else in the stack.
const usEast1 = new aws.Provider("aws-us-east-1", {
  region: "us-east-1",
  defaultTags: {
    tags: { App: "retivo", Stack: pulumi.getStack() },
  },
});

export function createEdge(opts: CloudFrontOpts): Edge {
  const {
    namePrefix,
    apiOriginUrl,
    spaBucketRegionalDomainName,
    spaOriginAccessControlId,
    edgeSharedSecret,
    aliasDomain,
    acmCertificateArn,
    enableWaf,
    edgeAllowedIps,
    assistantBridgePort,
  } = opts;

  // Edge IP gate — the function SOURCE is generated (and size-checked, 10 KB
  // CloudFront limit) here, before the first `new aws.*` below, so an
  // oversized or malformed allowlist fails the preview without registering
  // any resource.
  const gated = edgeAllowedIps.length > 0;
  const gateRules = edgeAllowedIps.map(ipv4CidrToRule);
  const spaRouterSource = gated
    ? gatedSpaRouterCode(gateRules)
    : spaRouterCode();
  const apiGateSource = gated ? gateOnlyCode(gateRules) : undefined;
  const securityHeadersSource = securityHeadersCode(assistantBridgePort);

  // ---------- WAF web ACL with the AWS managed CommonRuleSet ----------
  // Created only when enableWaf is true (cost-control knob). When false,
  // CloudFront ships without a webAclId — geo-restriction + the security-
  // headers function still apply, but the managed CommonRuleSet does not.
  const webAcl = enableWaf
    ? new aws.wafv2.WebAcl(
        `${namePrefix}-cloudfront-acl`,
        {
          name: `${namePrefix}-cloudfront-acl`,
          scope: "CLOUDFRONT",
          defaultAction: { allow: {} },
          visibilityConfig: {
            cloudwatchMetricsEnabled: true,
            metricName: `${namePrefix}-cloudfront-acl`,
            sampledRequestsEnabled: true,
          },
          rules: [
            {
              name: "AWS-CommonRuleSet",
              priority: 1,
              overrideAction: { none: {} },
              statement: {
                managedRuleGroupStatement: {
                  name: "AWSManagedRulesCommonRuleSet",
                  vendorName: "AWS",
                  // SizeRestrictions_BODY caps request bodies at WAF's 8 KB
                  // default and would also block bodies larger than the
                  // raisable AssociationConfig ceiling (64 KB). The sync
                  // push endpoint accepts up to 5 MB and enforces its own
                  // per-mutation + per-batch limits at the application
                  // layer (100 mutations, 64 KB/payload, 5 MB total). We
                  // count this sub-rule instead of blocking on it; the rest
                  // of CommonRuleSet (XSS / RFI / SQLi / etc.) stays in
                  // BLOCK mode.
                  ruleActionOverrides: [
                    {
                      name: "SizeRestrictions_BODY",
                      actionToUse: { count: {} },
                    },
                  ],
                },
              },
              visibilityConfig: {
                cloudwatchMetricsEnabled: true,
                metricName: "common-rule-set",
                sampledRequestsEnabled: true,
              },
            },
            {
              name: "IPRateLimit",
              priority: 2,
              statement: {
                rateBasedStatement: {
                  limit: 2000,
                  aggregateKeyType: "IP",
                  evaluationWindowSec: 300,
                },
              },
              action: { block: {} },
              visibilityConfig: {
                cloudwatchMetricsEnabled: true,
                metricName: `${namePrefix}-rate-limit`,
                sampledRequestsEnabled: true,
              },
            },
          ],
        },
        { provider: usEast1 },
      )
    : undefined;

  // ---------- CloudFront Function for security headers ----------
  // Lightweight JS that runs on every viewer-response. Cannot import
  // anything; must stay under 10 KB compiled.
  const securityHeadersFn = new aws.cloudfront.Function(
    `${namePrefix}-security-headers`,
    {
      name: `${namePrefix}-security-headers`,
      runtime: "cloudfront-js-2.0",
      code: securityHeadersSource,
      comment: "Append strict security headers",
    },
    { provider: usEast1 },
  );

  // ---------- CloudFront Function for SPA routing fallback ----------
  // Viewer-request on the SPA cache behavior only. Rewrites paths that
  // look like SPA routes (no file extension, not under /api/) to
  // /index.html so React Router can resolve them. Replaces the previous
  // distribution-level customErrorResponses, which incorrectly rewrote
  // real API 403/404 responses to /index.html and masked sync errors.
  //
  // When the dev edge IP gate is on, the SAME function (same name, so the
  // change is an in-place UpdateFunction/PublishFunction) runs the viewer-IP
  // allowlist check first and answers 403 from the edge for anyone else —
  // CloudFront allows one function per event type per behavior, so the gate
  // is folded into the router rather than chained. Generators live in
  // edge-functions.mjs so the emitted code is executed under `node --test`.
  const spaRouterFn = new aws.cloudfront.Function(
    `${namePrefix}-spa-router`,
    {
      name: `${namePrefix}-spa-router`,
      runtime: "cloudfront-js-2.0",
      code: spaRouterSource,
      comment: gated
        ? "Viewer IP allowlist + rewrite SPA routes to /index.html (viewer-request)"
        : "Rewrite SPA routes to /index.html (viewer-request)",
    },
    { provider: usEast1 },
  );

  // ---------- CloudFront Function gating /api/* (dev IP gate only) ----------
  // Same allowlist, no rewrite: a viewer outside the list gets a 403 before
  // API Gateway or the Lambda is invoked. Named with the stack's
  // name prefix (CloudFront Functions are untaggable). Absent when the gate
  // is off.
  const apiGateFn = apiGateSource
    ? new aws.cloudfront.Function(
        `${namePrefix}-api-gate`,
        {
          name: `${namePrefix}-api-gate`,
          runtime: "cloudfront-js-2.0",
          code: apiGateSource,
          comment: "Viewer IP allowlist for /api/* (viewer-request)",
        },
        { provider: usEast1 },
      )
    : undefined;

  // ---------- Origin: API Gateway (custom domain when configured) ----------
  // Strip the protocol and trailing slash from the origin URL — CloudFront
  // wants the bare host name as the origin.
  const apiHost = apiOriginUrl.apply((url) =>
    url.replace(/^https?:\/\//, "").replace(/\/$/, ""),
  );

  const distribution = new aws.cloudfront.Distribution(
    `${namePrefix}-cdn`,
    {
      enabled: true,
      // IPv6 is turned off while the dev IP gate is on: the allowlist is
      // IPv4-only, and a dual-stack home connection would otherwise reach
      // the edge over IPv6 and be refused. dns.ts skips the AAAA alias for
      // the same reason.
      isIpv6Enabled: !gated,
      comment: `${namePrefix} api edge`,
      priceClass: "PriceClass_100", // US, Canada, Europe — cheapest tier.
      // Only attach the ACL when WAF is provisioned; omitted entirely when
      // enableWaf=false so CloudFront has no webAclId.
      webAclId: webAcl?.arn,
      aliases: aliasDomain ? [aliasDomain] : [],

      origins: [
        {
          originId: "api-gateway",
          domainName: apiHost,
          customOriginConfig: {
            httpPort: 80,
            httpsPort: 443,
            originProtocolPolicy: "https-only",
            originSslProtocols: ["TLSv1.2"],
          },
          // Shared secret stamped on every request CloudFront forwards
          // to APIGW. EdgeAuthMiddleware in the api Lambda rejects any
          // request that doesn't carry it — closing the direct-APIGW
          // bypass. Read from SSM at deploy time; rotation = put-
          // parameter + pulumi up.
          //
          // Header name must avoid CloudFront's reserved list — any
          // X-Edge-* / X-Amz-Cf-* / X-Amzn-* / standard HTTP header is
          // rejected with `InvalidArgument: HeaderName ... not allowed`.
          // `X-Origin-Verify` is the AWS-recommended convention for
          // this exact pattern.
          customHeaders: [
            { name: "X-Origin-Verify", value: edgeSharedSecret },
          ],
        },
        {
          originId: "spa-s3",
          // Regional domain name avoids the legacy global redirect.
          domainName: spaBucketRegionalDomainName,
          originAccessControlId: spaOriginAccessControlId,
          // s3OriginConfig with empty originAccessIdentity — OAC supersedes OAI.
          s3OriginConfig: { originAccessIdentity: "" },
        },
      ],

      // Default behavior serves the SPA from S3. Aggressively cached;
      // the bootstrap script invalidates `/index.html` on each deploy
      // (the asset URLs are content-hashed by Vite so they don't need
      // invalidation).
      defaultCacheBehavior: {
        targetOriginId: "spa-s3",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        compress: true,
        cachePolicyId: managedCachePolicyId("Managed-CachingOptimized"),
        functionAssociations: [
          {
            eventType: "viewer-request",
            functionArn: spaRouterFn.arn,
          },
          {
            eventType: "viewer-response",
            functionArn: securityHeadersFn.arn,
          },
        ],
      },

      // /api/* path pattern routes to API Gateway. Caching disabled;
      // forwards Authorization + Cookie + X-CSRF-Token + Origin headers.
      orderedCacheBehaviors: [
        {
          pathPattern: "/api/*",
          targetOriginId: "api-gateway",
          viewerProtocolPolicy: "redirect-to-https",
          allowedMethods: ["GET", "HEAD", "OPTIONS", "POST", "PATCH", "DELETE", "PUT"],
          cachedMethods: ["GET", "HEAD"],
          compress: true,
          cachePolicyId: managedCachePolicyId("Managed-CachingDisabled"),
          originRequestPolicyId: managedOriginRequestPolicyId(
            "Managed-AllViewerExceptHostHeader",
          ),
          functionAssociations: [
            // Dev IP gate on /api/* (viewer-request) — only when gated; the
            // security-headers viewer-response association is unchanged.
            ...(apiGateFn
              ? [{ eventType: "viewer-request", functionArn: apiGateFn.arn }]
              : []),
            {
              eventType: "viewer-response",
              functionArn: securityHeadersFn.arn,
            },
          ],
        },
      ],

      // SPA routing fallback is handled by the spaRouterFn viewer-request
      // function on the default cache behavior — it rewrites unmatched
      // SPA paths to /index.html before S3 ever sees them. We deliberately
      // do not set customErrorResponses here: those are distribution-wide
      // and would also rewrite genuine 4xx responses from the /api/*
      // cache behavior, masking real API errors (was the cause of an
      // earlier sync regression).

      restrictions: {
        geoRestriction: {
          restrictionType: "whitelist",
          locations: [...GEO_ALLOWLIST],
        },
      },

      viewerCertificate: acmCertificateArn
        ? {
            acmCertificateArn,
            sslSupportMethod: "sni-only",
            minimumProtocolVersion: "TLSv1.2_2021",
          }
        : {
            cloudfrontDefaultCertificate: true,
            // AWS ignores `minimumProtocolVersion` on the shared
            // *.cloudfront.net certificate — TLS 1.0/1.1 remain enabled
            // there. Set it anyway so intent is documented and the
            // property carries over automatically the moment a custom
            // ACM cert is attached.
            minimumProtocolVersion: "TLSv1.2_2021",
          },
    },
    { provider: usEast1 },
  );

  return { distribution, webAcl };
}

/**
 * AWS publishes UUIDs for managed cache and origin-request policies.
 * Hard-coded here per AWS docs; stable across accounts.
 */
function managedCachePolicyId(name: string): string {
  const map: Record<string, string> = {
    "Managed-CachingDisabled": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "Managed-CachingOptimized": "658327ea-f89d-4fab-a63d-7e88639e58f6",
  };
  const id = map[name];
  if (!id) throw new Error(`Unknown managed cache policy: ${name}`);
  return id;
}

function managedOriginRequestPolicyId(name: string): string {
  const map: Record<string, string> = {
    "Managed-AllViewerExceptHostHeader": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    "Managed-AllViewer": "216adef6-5c7f-47e4-b989-5492eafa07d3",
  };
  const id = map[name];
  if (!id) throw new Error(`Unknown managed origin-request policy: ${name}`);
  return id;
}
