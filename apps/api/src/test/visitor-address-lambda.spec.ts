// A deployed-shape request (API Gateway v2 event through serverless-express over the real createApp() chain) is throttled and audited as the visitor, not the CloudFront edge; a socket-served request is unaffected.
// DISABLE_THROTTLE is cleared (process-wide, so isolated in this file) to observe the real guard bucket through X-RateLimit-Remaining.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Express } from 'express';
import { configure as serverlessExpress } from '@codegenie/serverless-express';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SESClient } from '@aws-sdk/client-ses';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import { DYNAMO_DOC_CLIENT, S3_CLIENT, SES_CLIENT, LAMBDA_CLIENT } from '../aws/aws.module.js';
import { HibpClient } from '../auth/hibp-client.js';
import type { AuthEventRow } from '../dynamo/types.js';
import { freshEmail, scanAll, STRONG_PASSWORD } from './test-helpers.js';

const EDGE = '130.176.0.1';

// A fresh address per call: throttle counters persist in the emulator across runs.
function freshIp(): string {
  const [a, b, c] = randomUUID().match(/[0-9a-f]{2}/g)!.map((h) => parseInt(h, 16));
  return `198.${a}.${b}.${c}`;
}

describe('visitor address on the Lambda path', () => {
  let app: INestApplication;
  let lambdaHandler: (event: unknown, context: unknown) => Promise<APIGatewayProxyStructuredResultV2>;
  let priorFlag: string | undefined;

  beforeAll(async () => {
    priorFlag = process.env.DISABLE_THROTTLE;
    delete process.env.DISABLE_THROTTLE;
    jest.spyOn(HibpClient.prototype, 'isPwned').mockResolvedValue(false);
    const { ensureLocalAwsResources } = await import('../aws/local-bootstrap.js');
    const { validateEnv } = await import('../common/env.config.js');
    await ensureLocalAwsResources(validateEnv());
    const { createApp } = await import('../lambda.js');
    app = await createApp();
    lambdaHandler = serverlessExpress({ app: app.getHttpAdapter().getInstance() as Express }) as unknown as typeof lambdaHandler;
  }, 60000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (priorFlag !== undefined) process.env.DISABLE_THROTTLE = priorFlag;
    if (!app) return;
    const doc = app.get<DynamoDBDocumentClient>(DYNAMO_DOC_CLIENT);
    const ddb = (doc as unknown as { config: { client?: () => DynamoDBClient } }).config.client?.();
    const s3 = app.get<S3Client>(S3_CLIENT);
    const ses = app.get<SESClient>(SES_CLIENT);
    const lambda = app.get<LambdaClient>(LAMBDA_CLIENT);
    await app.close();
    doc.destroy();
    ddb?.destroy();
    s3.destroy();
    ses.destroy();
    lambda.destroy();
  });

  async function authEventIp(userId: string): Promise<string | null | undefined> {
    const table = app.get(ConfigService).get('TABLE_AUTH_EVENT', { infer: true } as never) as unknown as string;
    const rows = await scanAll<AuthEventRow>(app.get<DynamoDBDocumentClient>(DYNAMO_DOC_CLIENT), table);
    return rows.find((r) => r.userId === userId && r.eventType === 'signup')?.ip;
  }

  function signupEvent(forwardedFor: string | undefined, sourceIp: string): APIGatewayProxyEventV2 {
    return {
      version: '2.0',
      routeKey: '$default',
      rawPath: '/api/v1/auth/signup',
      rawQueryString: '',
      headers: {
        'content-type': 'application/json',
        origin: process.env.WEB_ORIGIN!,
        ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
      },
      requestContext: {
        http: { method: 'POST', path: '/api/v1/auth/signup', protocol: 'HTTP/1.1', sourceIp, userAgent: 'jest' },
      },
      body: JSON.stringify({ email: freshEmail(), password: STRONG_PASSWORD }),
      isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2;
  }

  async function signup(forwardedFor: string | undefined, sourceIp: string) {
    const res = await lambdaHandler(signupEvent(forwardedFor, sourceIp), {});
    expect(res.statusCode).toBe(202);
    const headers = res.headers as Record<string, string>;
    const userId = (JSON.parse(res.body!) as { userId: string }).userId;
    return { remaining: Number(headers['x-ratelimit-remaining']), ip: await authEventIp(userId) };
  }

  it('counts and records the visitor when the gateway appends the edge to the header', async () => {
    const viewer = freshIp();
    const first = await signup(`1.1.1.1, ${viewer}, ${EDGE}`, EDGE);
    expect(first.ip).toBe(viewer);
    expect(first.remaining).toBe(9);
    // A different planted leftmost entry from the same visitor lands in the same bucket.
    const second = await signup(`2.2.2.2, ${viewer}, ${EDGE}`, EDGE);
    expect(second.remaining).toBe(8);
  });

  it('counts and records the visitor when the gateway passes the header through', async () => {
    const viewer = freshIp();
    const first = await signup(`1.1.1.1, ${viewer}`, EDGE);
    expect(first.ip).toBe(viewer);
    expect(first.remaining).toBe(9);
    const second = await signup(`2.2.2.2, ${viewer}`, EDGE);
    expect(second.remaining).toBe(8);
  });

  it('keeps sourceIp when the request carries no forwarding header', async () => {
    const source = freshIp();
    const r = await signup(undefined, source);
    expect(r.ip).toBe(source);
    expect(r.remaining).toBe(9);
  });

  it('does not rewrite a socket-served request, which keeps what trust proxy yields', async () => {
    const viewer = freshIp();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('X-Forwarded-For', `spoofed, ${viewer}`)
      .send({ email: freshEmail(), password: STRONG_PASSWORD });
    expect(res.status).toBe(202);
    expect(await authEventIp((res.body as { userId: string }).userId)).toBe(viewer);
  });
});
