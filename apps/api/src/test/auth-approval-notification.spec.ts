// POST /auth/approve-signup sends the approved user a best-effort SES notice with a login link, and still returns 200 when the send throws. The default harness leaves SES
// disabled, so this suite builds its own app with SES_ENDPOINT set and a capturing SES_CLIENT fake; verify-email mail rides the same fake, so captures are filtered by subject.
import 'reflect-metadata';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import {
  INestApplication,
  ValidationPipe,
  ClassSerializerInterceptor,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { json, urlencoded } from 'express';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SendEmailCommand, type SESClient } from '@aws-sdk/client-ses';
import { AppModule } from '../app.module.js';
import { HttpErrorFilter } from '../common/http-error.filter.js';
import { CorrelationIdMiddleware } from '../common/correlation-id.middleware.js';
import { BuildIdMiddleware } from '../common/build-id.middleware.js';
import { DYNAMO_DOC_CLIENT, SES_CLIENT } from '../aws/aws.module.js';
import { validateEnv } from '../common/env.config.js';
import { ensureLocalAwsResources } from '../aws/local-bootstrap.js';
import {
  STRONG_PASSWORD,
  freshEmail,
} from './test-helpers.js';

let sesSends: SendEmailCommand[] = [];
let sesShouldThrow = false;

describe('approved-user notification — POST /auth/approve-signup', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let doc: DynamoDBDocumentClient;
  let prevSesEndpoint: string | undefined;

  beforeAll(async () => {
    // Flips `sesEnabled` true for SignupApprovalService (read once at construction) so the send path runs instead of the dev-mode log.
    prevSesEndpoint = process.env.SES_ENDPOINT;
    process.env.SES_ENDPOINT = 'http://localhost:4566';

    await ensureLocalAwsResources(validateEnv());

    const sesFake = {
      send: (cmd: unknown) => {
        if (cmd instanceof SendEmailCommand) {
          sesSends.push(cmd);
        }
        if (sesShouldThrow) {
          return Promise.reject(new Error('SES is down'));
        }
        return Promise.resolve({});
      },
      destroy: () => undefined,
    } as unknown as SESClient;

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SES_CLIENT)
      .useValue(sesFake)
      .compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(false);
    app.use(json({ limit: '5mb' }));
    app.use(urlencoded({ extended: true, limit: '5mb' }));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
    app.useGlobalFilters(new HttpErrorFilter());
    app.use(new CorrelationIdMiddleware().use);
    app.use(new BuildIdMiddleware().use);
    app.setGlobalPrefix('api/v1', { exclude: [] });
    await app.init();

    doc = moduleRef.get<DynamoDBDocumentClient>(DYNAMO_DOC_CLIENT);
  });

  afterAll(async () => {
    await app.close();
    // This suite builds its own app, so the bootstrapTestApp close-patch does not cover the doc pool; destroy it explicitly.
    doc.destroy();
    if (prevSesEndpoint === undefined) {
      delete process.env.SES_ENDPOINT;
    } else {
      process.env.SES_ENDPOINT = prevSesEndpoint;
    }
  });

  beforeEach(() => {
    sesSends = [];
    sesShouldThrow = false;
  });

  async function signupVerifyAwaitingApproval(): Promise<{
    email: string;
    userId: string;
    approvalToken: string;
  }> {
    const email = freshEmail();
    const signup = await request(app.getHttpServer())
      .post('/api/v1/auth/signup')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ email, password: STRONG_PASSWORD });
    expect(signup.status).toBe(202);
    const { userId, verificationToken } = signup.body as {
      userId: string;
      verificationToken: string;
    };
    const verify = await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ token: verificationToken });
    expect(verify.status).toBe(200);

    // The approval token is stored hashed; the raw token comes from the verify-email dev trapdoor.
    expect(typeof verify.body.approvalToken).toBe('string');
    return { email, userId, approvalToken: verify.body.approvalToken as string };
  }

  it('returns 200 and sends the notice to the approved user', async () => {
    const { email, approvalToken } = await signupVerifyAwaitingApproval();

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/approve-signup')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ token: approvalToken });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approved: true, email });

    // The verify-email mail to the same address carries a different subject, so filter on the approval subject.
    const notices = sesSends.filter(
      (cmd) =>
        cmd.input.Message?.Subject?.Data ===
        'Your Retivo account is approved',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].input.Destination?.ToAddresses).toEqual([email]);
    const body = notices[0].input.Message!.Body!.Text!.Data!;
    expect(body).toContain('/login');
  });

  it('returns 200 even when the notification SES send throws', async () => {
    const { email, approvalToken } = await signupVerifyAwaitingApproval();

    sesShouldThrow = true;

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/approve-signup')
      .set('Origin', process.env.WEB_ORIGIN!)
      .send({ token: approvalToken });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approved: true, email });
  });
});
