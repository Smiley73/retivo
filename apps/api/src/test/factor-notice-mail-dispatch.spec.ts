// The factor-change notice's SES dispatch: a real enrollment mails the account's own address and reports noticeSent: true, and a failing send neither fails the enrollment nor rolls back the undo token (noticeSent: false).
// The default harness leaves SES disabled, so this suite builds its own app with SES_ENDPOINT set and a capturing SES_CLIENT fake.
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
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SendEmailCommand, type SESClient } from '@aws-sdk/client-ses';
import { ConfigService } from '@nestjs/config';
import { generateSync } from 'otplib';
import { AppModule } from '../app.module.js';
import { HttpErrorFilter } from '../common/http-error.filter.js';
import { CorrelationIdMiddleware } from '../common/correlation-id.middleware.js';
import { BuildIdMiddleware } from '../common/build-id.middleware.js';
import { DYNAMO_DOC_CLIENT, SES_CLIENT } from '../aws/aws.module.js';
import { validateEnv } from '../common/env.config.js';
import { ensureLocalAwsResources } from '../aws/local-bootstrap.js';
import { signupVerifyLogin, STRONG_PASSWORD } from './test-helpers.js';
import type { UserRow } from '../dynamo/types.js';

let sesSends: SendEmailCommand[] = [];
let sesShouldThrow = false;

describe('factor-change notice mail dispatch', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let doc: DynamoDBDocumentClient;
  let prevSesEndpoint: string | undefined;

  beforeAll(async () => {
    prevSesEndpoint = process.env.SES_ENDPOINT;
    process.env.SES_ENDPOINT = 'http://localhost:4566';

    await ensureLocalAwsResources(validateEnv());

    const sesFake = {
      send: (cmd: unknown) => {
        if (cmd instanceof SendEmailCommand) sesSends.push(cmd);
        if (sesShouldThrow) return Promise.reject(new Error('SES is down'));
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
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
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
    doc.destroy();
    if (prevSesEndpoint === undefined) delete process.env.SES_ENDPOINT;
    else process.env.SES_ENDPOINT = prevSesEndpoint;
  });

  beforeEach(() => {
    sesSends = [];
    sesShouldThrow = false;
  });

  async function enrollTotp(): Promise<{ userId: string; email: string; noticeSent: unknown }> {
    const s = await signupVerifyLogin({ app, module: moduleRef, doc });
    const cookie = [s.refreshCookie, s.csrfCookie].join('; ');
    const start = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/totp/enroll/start')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${s.accessToken}`)
      .set('X-CSRF-Token', s.csrfValue)
      .set('Cookie', cookie)
      .send({});
    const secret = start.body.secret as string;
    const confirm = await request(app.getHttpServer())
      .post('/api/v1/auth/mfa/totp/enroll/confirm')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${s.accessToken}`)
      .set('X-CSRF-Token', s.csrfValue)
      .set('Cookie', cookie)
      .send({ code: generateSync({ secret }), stepUp: { currentPassword: STRONG_PASSWORD } });
    expect(confirm.status).toBe(200);
    return { userId: s.userId, email: s.email, noticeSent: confirm.body.noticeSent };
  }

  it('sends the notice to the account address with the expected subject and reports noticeSent: true', async () => {
    const { email, noticeSent } = await enrollTotp();

    const notices = sesSends.filter(
      (cmd) =>
        cmd.input.Message?.Subject?.Data ===
        'An authenticator app was added to your Retivo account',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].input.Destination?.ToAddresses).toEqual([email]);
    expect(noticeSent).toBe(true);
  });

  it('a failing SES send does not fail the enrollment, does not roll back the undo token, and reports noticeSent: false', async () => {
    sesShouldThrow = true;
    const { userId, noticeSent } = await enrollTotp();
    expect(noticeSent).toBe(false);

    const tableName = moduleRef
      .get(ConfigService)
      .get('TABLE_USER', { infer: true } as never) as unknown as string;
    const user = (
      await doc.send(new GetCommand({ TableName: tableName, Key: { userId } }))
    ).Item as UserRow;
    expect(user.pendingFactorUndoKind).toBe('totp_add');
    expect(user.pendingFactorUndoTokenHash).toBeTruthy();
  });
});
