// Optional Route53 and ACM wiring when `retivo:domainName` is set; the parent zone must already be in Route53.
// CloudFront certificates must live in us-east-1, hence the dedicated provider.

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

const usEast1 = new aws.Provider("aws-us-east-1-dns", {
  region: "us-east-1",
  defaultTags: {
    tags: { App: "retivo", Stack: pulumi.getStack() },
  },
});

function parentZoneFqdn(domain: string): string {
  const parts = domain.split(".");
  if (parts.length < 2) {
    throw new Error(
      `domainName must be at least two labels (got "${domain}"). Set a real FQDN like dev.retivo.example.com.`,
    );
  }
  return parts.slice(-2).join(".");
}

export function createDns(opts: DnsOpts): DnsResult {
  const { namePrefix, domainName } = opts;

  const parentZone = parentZoneFqdn(domainName);
  const zone = aws.route53.getZoneOutput({ name: parentZone, privateZone: false });

  const certificate = new aws.acm.Certificate(
    `${namePrefix}-cert`,
    {
      domainName,
      validationMethod: "DNS",
    },
    { provider: usEast1 },
  );

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
 * Creates the A/AAAA aliases to the distribution. The AAAA alias is skipped when IPv6 is off (dev edge IP gate), so a
 * dual-stack browser arrives over IPv4, which the allowlist can match.
 */
export function createCloudFrontAliases(args: {
  readonly namePrefix: string;
  readonly hostedZoneId: pulumi.Output<string>;
  readonly domainName: string;
  readonly distributionDomainName: pulumi.Output<string>;
  readonly distributionHostedZoneId: pulumi.Output<string>;
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
  readonly certificate: aws.acm.Certificate;
  readonly certificateValidationArn: pulumi.Output<string>;
  readonly hostedZoneId: pulumi.Output<string>;
}

/** Certificate wiring for the API custom domain; regional, so it uses the default provider, not us-east-1. */
export function createApiDns(opts: {
  readonly namePrefix: string;
  readonly apiDomainName: string;
}): ApiDnsResult {
  const { namePrefix, apiDomainName } = opts;

  const parentZone = parentZoneFqdn(apiDomainName);
  const zone = aws.route53.getZoneOutput({ name: parentZone, privateZone: false });

  // Regional cert: deliberately no `{ provider: usEast1 }`.
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
