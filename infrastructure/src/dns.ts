// Optional Route53 + ACM wiring. Only runs when stack config has
// retivo:domainName set. ACM certificates for CloudFront must live
// in us-east-1, so we use the dedicated provider here.
//
// Assumes the parent zone is already in Route53 (i.e. you've delegated
// example.com to AWS). The stack registers an ACM cert for the configured
// domain and an A/AAAA alias pointing at the CloudFront distribution.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

interface DnsOpts {
  readonly namePrefix: string;
  readonly domainName: string;
}

export interface DnsResult {
  readonly certificate: aws.acm.Certificate;
  readonly hostedZoneId: pulumi.Output<string>;
}

// Default tags mirror the stack-config `aws:defaultTags` on the default
// provider, so the resources this provider creates are tagged like
// everything else in the stack.
const usEast1 = new aws.Provider("aws-us-east-1-dns", {
  region: "us-east-1",
  defaultTags: {
    tags: { App: "retivo", Stack: pulumi.getStack() },
  },
});

/**
 * Look up the parent Route53 zone (e.g. for `dev.retivo.example.com`,
 * find `example.com`). The user is responsible for owning the zone and
 * delegating it to AWS — Pulumi does not create the zone.
 */
function parentZoneFqdn(domain: string): string {
  const parts = domain.split(".");
  if (parts.length < 2) {
    throw new Error(
      `domainName must be at least two labels (got "${domain}"). Set a real FQDN like dev.retivo.example.com.`,
    );
  }
  // Use the parent so wildcards / subdomains share one zone.
  return parts.slice(-2).join(".");
}

export function createDns(opts: DnsOpts): DnsResult {
  const { namePrefix, domainName } = opts;

  const parentZone = parentZoneFqdn(domainName);
  const zone = aws.route53.getZoneOutput({ name: parentZone, privateZone: false });

  // ACM cert in us-east-1 for the CloudFront alias.
  const certificate = new aws.acm.Certificate(
    `${namePrefix}-cert`,
    {
      domainName,
      validationMethod: "DNS",
    },
    { provider: usEast1 },
  );

  // DNS validation records. ACM emits one per domain.
  const validationRecord = new aws.route53.Record(
    `${namePrefix}-cert-validation`,
    {
      zoneId: zone.zoneId,
      name: certificate.domainValidationOptions[0].resourceRecordName,
      type: certificate.domainValidationOptions[0].resourceRecordType,
      records: [certificate.domainValidationOptions[0].resourceRecordValue],
      ttl: 60,
      allowOverwrite: true,
    },
  );

  new aws.acm.CertificateValidation(
    `${namePrefix}-cert-validation-wait`,
    {
      certificateArn: certificate.arn,
      validationRecordFqdns: [validationRecord.fqdn],
    },
    { provider: usEast1 },
  );

  return { certificate, hostedZoneId: zone.zoneId };
}

/**
 * Create the alias A/AAAA records pointing the configured domain at the
 * CloudFront distribution. Done after the distribution is up so we can
 * read its `domainName` and `hostedZoneId`. The AAAA alias is skipped when
 * the distribution has IPv6 off (the dev edge IP gate is on): with no AAAA
 * record a dual-stack browser resolves only the A record and arrives with
 * an IPv4 address the allowlist can match. The API domain's own AAAA
 * (createApiDomainAlias) is untouched — that host is not gated.
 */
export function createCloudFrontAliases(args: {
  readonly namePrefix: string;
  readonly hostedZoneId: pulumi.Output<string>;
  readonly domainName: string;
  readonly distributionDomainName: pulumi.Output<string>;
  readonly distributionHostedZoneId: pulumi.Output<string>;
  /** Mirrors the distribution's `isIpv6Enabled`; false skips the AAAA alias. */
  readonly ipv6Enabled: boolean;
}): void {
  const {
    namePrefix,
    hostedZoneId,
    domainName,
    distributionDomainName,
    distributionHostedZoneId,
    ipv6Enabled,
  } = args;

  new aws.route53.Record(`${namePrefix}-alias-a`, {
    zoneId: hostedZoneId,
    name: domainName,
    type: "A",
    aliases: [
      {
        name: distributionDomainName,
        zoneId: distributionHostedZoneId,
        evaluateTargetHealth: false,
      },
    ],
  });

  if (ipv6Enabled) {
    new aws.route53.Record(`${namePrefix}-alias-aaaa`, {
      zoneId: hostedZoneId,
      name: domainName,
      type: "AAAA",
      aliases: [
        {
          name: distributionDomainName,
          zoneId: distributionHostedZoneId,
          evaluateTargetHealth: false,
        },
      ],
    });
  }
}

export interface ApiDnsResult {
  /** Regional ACM cert (validated) for the API Gateway custom domain. */
  readonly certificate: aws.acm.Certificate;
  readonly certificateValidationArn: pulumi.Output<string>;
  readonly hostedZoneId: pulumi.Output<string>;
}

/**
 * Certificate wiring for the API Gateway custom domain. Distinct from
 * the CloudFront cert above: API Gateway HTTP API custom domains are
 * REGIONAL, so this cert is issued in the API's own region (the default
 * provider) — not us-east-1. DNS-validated via the parent Route53 zone.
 * Decoupled from the web `retivo:domainName`: the API domain can sit
 * in the same parent zone or a different one, and is provisioned even
 * when no web custom domain is configured.
 */
export function createApiDns(opts: {
  readonly namePrefix: string;
  readonly apiDomainName: string;
}): ApiDnsResult {
  const { namePrefix, apiDomainName } = opts;

  const parentZone = parentZoneFqdn(apiDomainName);
  const zone = aws.route53.getZoneOutput({ name: parentZone, privateZone: false });

  // Regional cert — default provider (API Gateway custom domains are
  // regional). No `{ provider: usEast1 }` here on purpose.
  const certificate = new aws.acm.Certificate(`${namePrefix}-api-cert`, {
    domainName: apiDomainName,
    validationMethod: "DNS",
  });

  const validationRecord = new aws.route53.Record(
    `${namePrefix}-api-cert-validation`,
    {
      zoneId: zone.zoneId,
      name: certificate.domainValidationOptions[0].resourceRecordName,
      type: certificate.domainValidationOptions[0].resourceRecordType,
      records: [certificate.domainValidationOptions[0].resourceRecordValue],
      ttl: 60,
      allowOverwrite: true,
    },
  );

  const validation = new aws.acm.CertificateValidation(
    `${namePrefix}-api-cert-validation-wait`,
    {
      certificateArn: certificate.arn,
      validationRecordFqdns: [validationRecord.fqdn],
    },
  );

  return {
    certificate,
    certificateValidationArn: validation.certificateArn,
    hostedZoneId: zone.zoneId,
  };
}

/**
 * Alias the API custom domain at the API Gateway regional domain target.
 * Done after the custom domain is created so we can read its regional
 * domain name + hosted-zone id.
 */
export function createApiDomainAlias(args: {
  readonly namePrefix: string;
  readonly hostedZoneId: pulumi.Output<string>;
  readonly apiDomainName: string;
  readonly targetDomainName: pulumi.Output<string>;
  readonly targetHostedZoneId: pulumi.Output<string>;
}): void {
  const { namePrefix, hostedZoneId, apiDomainName, targetDomainName, targetHostedZoneId } =
    args;

  new aws.route53.Record(`${namePrefix}-api-alias-a`, {
    zoneId: hostedZoneId,
    name: apiDomainName,
    type: "A",
    aliases: [
      {
        name: targetDomainName,
        zoneId: targetHostedZoneId,
        evaluateTargetHealth: false,
      },
    ],
  });

  new aws.route53.Record(`${namePrefix}-api-alias-aaaa`, {
    zoneId: hostedZoneId,
    name: apiDomainName,
    type: "AAAA",
    aliases: [
      {
        name: targetDomainName,
        zoneId: targetHostedZoneId,
        evaluateTargetHealth: false,
      },
    ],
  });
}
