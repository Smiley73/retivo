// HTTP API (API Gateway v2) fronting the api Lambda. CloudFront sits in
// front of this. When `apiDomainName` is configured the API is reachable
// ONLY through a regional custom domain (CloudFront `/api/*` → the
// custom domain) and the public execute-api endpoint is disabled, so the
// raw `*.execute-api.*` host no longer invokes the Lambda. Combined with
// the EDGE_SHARED_SECRET origin header this closes the direct-APIGW
// bypass of WAF + geo-restriction.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

interface ApiGatewayOpts {
  readonly namePrefix: string;
  readonly apiLambda: aws.lambda.Function;
  readonly webOrigin: string;
  /** Custom API domain (regional). When set, the custom domain + mapping are created. */
  readonly apiDomainName?: string;
  /** Regional ACM cert ARN for the custom domain. Required when apiDomainName is set. */
  readonly apiCertificateArn?: pulumi.Output<string>;
  /**
   * Disable the public execute-api endpoint so the API is reachable only
   * via the custom domain. Deploy in two steps (see docs/deploy.md):
   * keep this false until CloudFront `/api/*` is verified against the
   * custom domain, then flip to true.
   */
  readonly disableExecuteApiEndpoint?: boolean;
  /**
   * `$default` stage throttle (sourced from `retivo:apiThrottleRatePerSec`
   * / `retivo:apiThrottleBurst`): steady-state requests/second and burst.
   * Aggregate across auth + sync + direct-custom-domain traffic (the HTTP
   * API has a single `$default` route, so the stage setting covers every
   * path); best-effort, not a hard ceiling; the two values are independent.
   * Per-IP fairness is the app's Nest throttler (per Lambda execution
   * environment). Reserved concurrency is not an option on the shared
   * 10-execution account quota (AWS requires >= 100 unreserved). Excess
   * requests get API Gateway's own `429 {"message":"Too Many Requests"}`
   * (no Retry-After, no X-Build-Id) without a Lambda invocation.
   */
  readonly apiThrottleRatePerSec: number;
  readonly apiThrottleBurst: number;
  /**
   * Cost-control knob (sourced from `retivo:logRetentionDays`):
   * CloudWatch Logs retention in days for the API Gateway access log group.
   * Dev example=7, prod=90.
   */
  readonly logRetentionDays: number;
}

export interface ApiGateway {
  readonly api: aws.apigatewayv2.Api;
  readonly stage: aws.apigatewayv2.Stage;
  readonly invokeUrl: pulumi.Output<string>;
  /** Custom domain resource when apiDomainName is configured. */
  readonly customDomain?: aws.apigatewayv2.DomainName;
  /**
   * The host CloudFront should use as the `/api/*` origin: the custom
   * domain when configured, else the execute-api invoke host.
   */
  readonly originUrl: pulumi.Output<string>;
  /** API Gateway access-log group (the stage writes its access logs here). */
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
    // Reachable only via the custom domain once this is true — the raw
    // execute-api host stops invoking the Lambda.
    disableExecuteApiEndpoint,
    // CORS at the gateway is intentionally narrow — the API Lambda also
    // enforces Origin/Referer (defense-in-depth) and
    // answers preflight itself in the Lambda handler.
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

  // Catch-all route → api Lambda. Every path goes through the same handler;
  // specific paths could override it if ever needed.
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
    // Stage-wide throttle (see ApiGatewayOpts). Changing the config keys is
    // an in-place stage update — no redeploy of anything else.
    defaultRouteSettings: {
      throttlingRateLimit: apiThrottleRatePerSec,
      throttlingBurstLimit: apiThrottleBurst,
    },
    accessLogSettings: {
      destinationArn: accessLogGroup.arn,
      // status and duration must be unquoted so CloudWatch Logs emits them
      // as JSON numbers — metric filter patterns { $.status = 409 } and
      // { $.status >= 500 } require numeric comparison, not string.
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

  // The stage's invoke URL is `<api-id>.execute-api.<region>.amazonaws.com/<stage>`.
  // For $default, that's just the api-endpoint host with no path suffix.
  const invokeUrl = api.apiEndpoint;

  // Optional regional custom domain. API Gateway HTTP API custom domains
  // are regional, so this uses the regional ACM cert (default provider),
  // distinct from the us-east-1 CloudFront viewer cert.
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

    // CloudFront's `/api/*` origin points at the custom domain host.
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
    // Stack-configured retention (retivo:logRetentionDays) — matches the
    // Lambda log groups so an incident review window is consistent across the
    // request path. Dev=7, prod=90.
    retentionInDays: logRetentionDays,
  });
}
