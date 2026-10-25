// CloudFront distribution, the optional WAF web ACL, and the CloudFront Functions (security headers, SPA
// rewrite, dev viewer IP gate). WAFv2 for CLOUDFRONT scope must live in us-east-1.

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
  /** Host for the `/api/*` origin: the API custom domain when set, else the execute-api invoke host. */
  readonly apiOriginUrl: pulumi.Output<string>;
  readonly spaBucketRegionalDomainName: pulumi.Output<string>;
  readonly spaOriginAccessControlId: pulumi.Output<string>;
  /** Attached as `X-Origin-Verify` on every request to the API origin, which EdgeAuthMiddleware enforces. */
  readonly edgeSharedSecret: pulumi.Output<string>;
  readonly aliasDomain?: string;
  readonly acmCertificateArn?: pulumi.Output<string>;
  /** Provision the WAF web ACL (managed CommonRuleSet plus a 2000 req / 5 min per-IP block rule). */
  readonly enableWaf: boolean;
  /** Dev-only normalised `a.b.c.d/nn` allowlist; non-empty gates the SPA router and `/api/*` and turns IPv6 off. */
  readonly edgeAllowedIps: ReadonlyArray<string>;
  /** Assistant bridge port; set adds one `connect-src ws://127.0.0.1:<port>` CSP entry, unset leaves the function unchanged. */
  readonly assistantBridgePort?: number;
}

// US-only by product decision (USD-only figures, US tax rules), kept out of stack config so
// changing it goes through review.
const GEO_ALLOWLIST: ReadonlyArray<string> = ["US"];

export interface Edge {
  readonly distribution: aws.cloudfront.Distribution;
  /** Present only when `enableWaf` is true; undefined when WAF is skipped. */
  readonly webAcl?: aws.wafv2.WebAcl;
}

// WAFv2 and ACM for CLOUDFRONT scope must be created in us-east-1, whatever the stack's region.
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

  // Generated here, before any `new aws.*`, so an oversized or malformed allowlist fails the
  // preview.
  const gated = edgeAllowedIps.length > 0;
  const gateRules = edgeAllowedIps.map(ipv4CidrToRule);
  const spaRouterSource = gated
    ? gatedSpaRouterCode(gateRules)
    : spaRouterCode();
  const apiGateSource = gated ? gateOnlyCode(gateRules) : undefined;
  const securityHeadersSource = securityHeadersCode(assistantBridgePort);

  // ---------- WAF web ACL ----------
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
                  // SizeRestrictions_BODY would block the sync push bodies (up to 5 MB); the
                  // application enforces its own limits, so that one sub-rule counts instead of
                  // blocking.
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
  // With the IP gate on, the same function (same name, an in-place update) checks the allowlist first:
  // CloudFront allows one function per event type per behavior.
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
  const apiHost = apiOriginUrl.apply((url) =>
    url.replace(/^https?:\/\//, "").replace(/\/$/, ""),
  );

  const distribution = new aws.cloudfront.Distribution(
    `${namePrefix}-cdn`,
    {
      enabled: true,
      // The allowlist is IPv4-only; dns.ts skips the AAAA alias for the same reason.
      isIpv6Enabled: !gated,
      comment: `${namePrefix} api edge`,
      priceClass: "PriceClass_100", // US, Canada, Europe — cheapest tier.
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
          // Header name must avoid CloudFront's reserved X-Edge-*, X-Amz-Cf-* and X-Amzn-* names.
          customHeaders: [
            { name: "X-Origin-Verify", value: edgeSharedSecret },
          ],
        },
        {
          originId: "spa-s3",
          // Regional domain name avoids the legacy global redirect.
          domainName: spaBucketRegionalDomainName,
          originAccessControlId: spaOriginAccessControlId,
          // OAC supersedes OAI, so the OAI is empty.
          s3OriginConfig: { originAccessIdentity: "" },
        },
      ],

      // Cached aggressively; deploys invalidate `/index.html` and Vite content-hashes the assets.
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

      // No customErrorResponses: they are distribution-wide and would rewrite real /api/* 4xx
      // responses.

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
            // AWS ignores this on the shared *.cloudfront.net certificate; set so it carries over
            // to a custom cert.
            minimumProtocolVersion: "TLSv1.2_2021",
          },
    },
    { provider: usEast1 },
  );

  return { distribution, webAcl };
}

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
