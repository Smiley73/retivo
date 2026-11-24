// A deployed-shape request (API Gateway v2 event through serverless-express over the real createApp() chain, edge secret configured) is throttled and audited as X-Viewer-Address only behind a valid proof; otherwise as the gateway's sourceIp. A socket-served request is unaffected.
// DISABLE_THROTTLE is cleared (process-wide, so isolated in this file) to observe the real guard bucket through X-RateLimit-Remaining.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Express } from 'express';
import { configure as serverlessExpress } from '@codegenie/serverless-express';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SESClient } from '@aws-sdk/client-ses';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import { DYNAMO_DOC_CLIENT, S3_CLIENT, SES_CLIENT, LAMBDA_CLIENT } from '../aws/aws.module.js';
import { HibpClient } from '../auth/hibp-client.js';
import type { AuthEventRow } from '../dynamo/types.js';
import { viewerAddressProof } from '../common/visitor-address.js';
import { freshEmail, scanAll, STRONG_PASSWORD } from './test-helpers.js';

const SECRET = 'edge-secret-test-vector';
const EDGE = '15.158.0.1';

// A fresh address per call: throttle counters persist in the emulator across runs.
function freshIp(): string {
  const [a, b, c] = randomUUID().match(/[0-9a-f]{2}/g)!.map((h) => parseInt(h, 16));
  return `198.${a}.${b}.${c}`;
}

// The throttler tracks an IPv6 address by its first 64 bits, so those must vary; the recorded `ip` is the full address.
function freshIpv6(): string {
  const [a, b, c] = randomUUID().match(/[0-9a-f]{4}/g)!;
  return `2001:${a}:${b}:${c}::9`;
}

interface SignupOptions {
  sourceIp: string;
  forwardedFor?: string;
  viewerAddress?: string;
  proof?: string | null;
  originVerify?: string;
}

describe('visitor address on the Lambda path', () => {
  let app: INestApplication;
  let lambdaHandler: (event: unknown, context: unknown) => Promise<APIGatewayProxyStructuredResultV2>;
  let priorFlag: string | undefined;
  let priorSecret: string | undefined;

  beforeAll(async () => {
    priorFlag = process.env.DISABLE_THROTTLE;
    priorSecret = process.env.EDGE_SHARED_SECRET;
    delete process.env.DISABLE_THROTTLE;
    process.env.EDGE_SHARED_SECRET = SECRET;
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
    if (priorSecret === undefined) delete process.env.EDGE_SHARED_SECRET;
    else process.env.EDGE_SHARED_SECRET = priorSecret;
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

  function signupEvent(o: SignupOptions): APIGatewayProxyEventV2 {
    const proof = o.proof === undefined ? viewerAddressProof(SECRET) : o.proof;
    return {
      version: '2.0',
      routeKey: '$default',
      rawPath: '/api/v1/auth/signup',
      rawQueryString: '',
      headers: {
        'content-type': 'application/json',
        origin: process.env.WEB_ORIGIN!,
        'x-origin-verify': o.originVerify ?? SECRET,
        ...(o.forwardedFor === undefined ? {} : { 'x-forwarded-for': o.forwardedFor }),
        ...(o.viewerAddress === undefined ? {} : { 'x-viewer-address': o.viewerAddress }),
        ...(proof === null ? {} : { 'x-viewer-address-proof': proof }),
      },
      requestContext: {
        http: { method: 'POST', path: '/api/v1/auth/signup', protocol: 'HTTP/1.1', sourceIp: o.sourceIp, userAgent: 'jest' },
      },
      body: JSON.stringify({ email: freshEmail(), password: STRONG_PASSWORD }),
      isBase64Encoded: false,
    } as unknown as APIGatewayProxyEventV2;
  }

  async function signup(o: SignupOptions) {
    const res = await lambdaHandler(signupEvent(o), {});
    expect(res.statusCode).toBe(202);
    const headers = res.headers as Record<string, string>;
    const userId = (JSON.parse(res.body!) as { userId: string }).userId;
    return { remaining: Number(headers['x-ratelimit-remaining']), ip: await authEventIp(userId) };
  }

  it.each([
    ['IPv4', freshIp],
    ['IPv6', freshIpv6],
  ])('records and counts the %s viewer address behind a valid proof, not sourceIp or a forwarding entry', async (_, fresh) => {
    const viewer = fresh();
    const first = await signup({ sourceIp: freshIp(), forwardedFor: `1.1.1.1, ${EDGE}`, viewerAddress: viewer });
    expect(first.ip).toBe(viewer);
    expect(first.remaining).toBe(9);
    const second = await signup({ sourceIp: freshIp(), forwardedFor: `2.2.2.2, ${EDGE}`, viewerAddress: viewer });
    expect(second.ip).toBe(viewer);
    expect(second.remaining).toBe(8);
  });

  it.each([
    ['no proof', null],
    ['a wrong proof', 'f'.repeat(64)],
    ['a proof of another secret', viewerAddressProof('another-secret')],
  ])('records and counts sourceIp, not the client-sent header, with %s', async (_, proof) => {
    const source = freshIp();
    const first = await signup({ sourceIp: source, forwardedFor: `1.1.1.1, ${EDGE}`, viewerAddress: freshIp(), proof });
    expect(first.ip).toBe(source);
    expect(first.remaining).toBe(9);
    const second = await signup({ sourceIp: source, forwardedFor: `2.2.2.2, ${EDGE}`, viewerAddress: freshIp(), proof });
    expect(second.remaining).toBe(8);
  });

  it('answers 403 and honors nothing when the origin secret is wrong, even behind a correct proof', async () => {
    const res = await lambdaHandler(
      signupEvent({ sourceIp: freshIp(), viewerAddress: freshIp(), originVerify: 'wrong-secret' }),
      {},
    );
    expect(res.statusCode).toBe(403);
  });

  it.each([
    ['missing', undefined],
    ['carrying a port', '203.0.113.9:443'],
    ['a comma-joined pair', '203.0.113.9, 198.51.100.7'],
  ])('keeps sourceIp and warns once when the header is %s behind a valid proof', async (_, viewerAddress) => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const source = freshIp();
    const r = await signup({ sourceIp: source, viewerAddress });
    expect(r.ip).toBe(source);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('viewer-address'))).toHaveLength(1);
  });

  it('does not warn about an unusable header when the proof is absent', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    const source = freshIp();
    const r = await signup({ sourceIp: source, viewerAddress: '203.0.113.9:443', proof: null });
    expect(r.ip).toBe(source);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('viewer-address'))).toHaveLength(0);
  });

  it('does not rewrite a socket-served request, which keeps what trust proxy yields', async () => {
    const viewer = freshIp();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('X-Origin-Verify', SECRET)
      .set('X-Viewer-Address', freshIp())
      .set('X-Viewer-Address-Proof', viewerAddressProof(SECRET))
      .set('X-Forwarded-For', `spoofed, ${viewer}`)
      .send({ email: freshEmail(), password: STRONG_PASSWORD });
    expect(res.status).toBe(202);
    expect(await authEventIp((res.body as { userId: string }).userId)).toBe(viewer);
  });
});
