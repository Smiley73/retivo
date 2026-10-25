// HTTP API (API Gateway v2) fronting the api Lambda, behind CloudFront. With `apiDomainName` set it is reachable
// only through the regional custom domain, which closes the direct-API-Gateway bypass of WAF and geo-restriction.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

interface ApiGatewayOpts {
  readonly namePrefix: string;
  readonly apiLambda: aws.lambda.Function;
  readonly webOrigin: string;
  /** Regional custom domain; when set, the domain and its mapping are created. */
  readonly apiDomainName?: string;
  /** Regional ACM certificate ARN; required with `apiDomainName`. */
  readonly apiCertificateArn?: pulumi.Output<string>;
  /** Disables the public execute-api endpoint; flip it second, once CloudFront `/api/*` works (docs/deploy.md). */
  readonly disableExecuteApiEndpoint?: boolean;
  /**
   * `$default` stage throttle, aggregate across every path (the HTTP API has one `$default` route) and best-effort.
   * Reserved concurrency is not an option on the shared account quota; excess requests get API Gateway's own 429.
   */
  readonly apiThrottleRatePerSec: number;
  readonly apiThrottleBurst: number;
  /** CloudWatch Logs retention in days for the access log group. */
  readonly logRetentionDays: number;
}

export interface ApiGateway {
  readonly api: aws.apigatewayv2.Api;
  readonly stage: aws.apigatewayv2.Stage;
  readonly invokeUrl: pulumi.Output<string>;
  /** Custom domain resource when `apiDomainName` is configured. */
  readonly customDomain?: aws.apigatewayv2.DomainName;
  /** The host CloudFront uses as the `/api/*` origin: the custom domain, else the execute-api host. */
  readonly originUrl: pulumi.Output<string>;
  /** The stage's access-log group. */
  readonly accessLogGroup: aws.cloudwatch.LogGroup;
}

export function createApiGateway(opts: ApiGatewayOpts): ApiGateway {
  const {
    namePrefix,
    apiLambda,
    webOrigin,
    apiDomainName,
    apiCertificateArn,
    disableExecuteApiEndpoint = false,
    apiThrottleRatePerSec,
    apiThrottleBurst,
    logRetentionDays,
  } = opts;

  const api = new aws.apigatewayv2.Api(`${namePrefix}-http-api`, {
    name: `${namePrefix}-http-api`,
    protocolType: "HTTP",
    disableExecuteApiEndpoint,
    // Narrow at the gateway; the Lambda also enforces Origin/Referer and answers preflight itself.
    corsConfiguration: {
      allowOrigins: webOrigin.length > 0 ? [webOrigin] : [],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "X-CSRF-Token"],
      allowCredentials: true,
      maxAge: 600,
    },
  });

  const integration = new aws.apigatewayv2.Integration(
    `${namePrefix}-lambda-integration`,
    {
      apiId: api.id,
      integrationType: "AWS_PROXY",
      integrationUri: apiLambda.invokeArn,
      payloadFormatVersion: "2.0",
      timeoutMilliseconds: 29000,
    },
  );

  new aws.apigatewayv2.Route(`${namePrefix}-default-route`, {
    apiId: api.id,
    routeKey: "$default",
    target: pulumi.interpolate`integrations/${integration.id}`,
  });

  new aws.lambda.Permission(`${namePrefix}-apigw-invoke`, {
    action: "lambda:InvokeFunction",
    function: apiLambda.name,
    principal: "apigateway.amazonaws.com",
    sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
  });

  const accessLogGroup = stageLogGroup(namePrefix, logRetentionDays);

  const stage = new aws.apigatewayv2.Stage(`${namePrefix}-default-stage`, {
    apiId: api.id,
    name: "$default",
    autoDeploy: true,
    defaultRouteSettings: {
      throttlingRateLimit: apiThrottleRatePerSec,
      throttlingBurstLimit: apiThrottleBurst,
    },
    accessLogSettings: {
      destinationArn: accessLogGroup.arn,
      // status and duration stay unquoted so they log as JSON numbers, which the numeric
      // metric-filter patterns need.
      format:
        '{"requestId":"$context.requestId",' +
        '"ip":"$context.identity.sourceIp",' +
        '"method":"$context.httpMethod",' +
        '"path":"$context.path",' +
        '"status":$context.status,' +
        '"duration":$context.responseLatency,' +
        '"requestTime":"$context.requestTime",' +
        '"userAgent":"$context.identity.userAgent"}',
    },
  });

  const invokeUrl = api.apiEndpoint;

  // HTTP API custom domains are regional, so the cert is the default-provider one, not the
  // us-east-1 viewer cert.
  let customDomain: aws.apigatewayv2.DomainName | undefined;
  let originUrl = invokeUrl;
  if (apiDomainName && apiCertificateArn) {
    customDomain = new aws.apigatewayv2.DomainName(`${namePrefix}-api-domain`, {
      domainName: apiDomainName,
      domainNameConfiguration: {
        certificateArn: apiCertificateArn,
        endpointType: "REGIONAL",
        securityPolicy: "TLS_1_2",
      },
    });

    new aws.apigatewayv2.ApiMapping(`${namePrefix}-api-mapping`, {
      apiId: api.id,
      domainName: customDomain.id,
      stage: stage.id,
    });

    originUrl = pulumi.interpolate`https://${customDomain.domainName}`;
  }

  return { api, stage, invokeUrl, customDomain, originUrl, accessLogGroup };
}

function stageLogGroup(
  namePrefix: string,
  logRetentionDays: number,
): aws.cloudwatch.LogGroup {
  return new aws.cloudwatch.LogGroup(`${namePrefix}-apigw-access-logs`, {
    name: `/aws/apigateway/${namePrefix}-http-api`,
    retentionInDays: logRetentionDays,
  });
}
