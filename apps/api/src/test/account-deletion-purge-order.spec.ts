// Account-deletion purge-first ordering: the snapshot purge runs before the irreversible DynamoDB and auth-state sweeps, a purge failure leaves the account fully intact,
// and a successful purge is invoked once with only the household id. Builds its own Nest app to override AccountSnapshotPurgeService.
import 'reflect-metadata';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import KSUID from 'ksuid';
import { Reflector } from '@nestjs/core';
import { ValidationPipe, ClassSerializerInterceptor } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { AppModule } from '../app.module.js';
import { HttpErrorFilter } from '../common/http-error.filter.js';
import { CorrelationIdMiddleware } from '../common/correlation-id.middleware.js';
import { BuildIdMiddleware } from '../common/build-id.middleware.js';
import { DYNAMO_DOC_CLIENT, S3_CLIENT } from '../aws/aws.module.js';
import { validateEnv } from '../common/env.config.js';
import { ensureLocalAwsResources } from '../aws/local-bootstrap.js';
import {
  AccountSnapshotPurgeService,
} from '../auth/account-snapshot-purge.service.js';
import {
  scanAll,
  signupVerifyLogin,
  STRONG_PASSWORD,
  type Session,
} from './test-helpers.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { MutationLogRow, UserRow } from '../dynamo/types.js';

describe('account deletion — snapshot purge ordering + failure', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let doc: DynamoDBDocumentClient;
  let s3: S3Client;
  let snapshotsBucket: string;
  let purgeCalls: string[];
  let purgeShouldFail: boolean;
  // Records household row presence at purge time to prove the purge precedes the DynamoDB sweep.
  let mutationLogAtPurge: number | null;

  beforeAll(async () => {
    await ensureLocalAwsResources(validateEnv());

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AccountSnapshotPurgeService)
      .useValue({
        purge: async (householdId: string): Promise<void> => {
          purgeCalls.push(householdId);
          const rows = (
            await scanAll<MutationLogRow>(doc, tableName('TABLE_MUTATION_LOG'))
          ).filter((r) => r.householdId === householdId);
          mutationLogAtPurge = rows.length;
          if (purgeShouldFail) {
            throw new Error('forced purge failure (test)');
          }
        },
      })
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
    s3 = moduleRef.get<S3Client>(S3_CLIENT);
    snapshotsBucket = moduleRef
      .get(ConfigService)
      .get('SNAPSHOTS_BUCKET', { infer: true } as never) as unknown as string;
  });

  afterAll(async () => {
    await app.close();
    // This suite builds its own app, so the `app.close()` patch in bootstrapTestApp does not cover its clients; destroy their keep-alive pools to avoid a leaked-handle warning.
    doc.destroy();
    s3.destroy();
  });

  beforeEach(() => {
    purgeCalls = [];
    purgeShouldFail = false;
    mutationLogAtPurge = null;
  });

  function freshSession(): Promise<Session> {
    return signupVerifyLogin({ app, module: moduleRef, doc });
  }

  // A plaintext push 403s, so the purge-order test seeds the row whose presence at purge time and absence after the sweep it asserts.
  async function seedHouseholdMutation(s: Session): Promise<void> {
    await doc.send(
      new PutCommand({
        TableName: tableName('TABLE_MUTATION_LOG'),
        Item: {
          householdId: s.householdId,
          sequenceId: (await KSUID.random()).string,
          deviceId: s.deviceId,
          aggregateId: randomUUID(),
          aggregateType: 'household',
          operation: 'create',
          payload: JSON.stringify({ name: 'Doomed', currency: 'USD' }),
          version: 1,
          timestamp: Date.now(),
          schemaVersion: 1,
        },
      }),
    );
  }

  function deleteAccount(s: Session, password: string): request.Test {
    return request(app.getHttpServer())
      .delete('/api/v1/auth/account')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${s.accessToken}`)
      .set('X-CSRF-Token', s.csrfValue)
      .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
      .send({ currentPassword: password });
  }

  function tableName(key: string): string {
    return moduleRef
      .get(ConfigService)
      .get(key, { infer: true } as never) as unknown as string;
  }

  it('invokes the purge once with only the householdId, before the DynamoDB sweep', async () => {
    const s = await freshSession();
    await seedHouseholdMutation(s);

    const res = await deleteAccount(s, STRONG_PASSWORD);
    expect(res.status).toBe(204);

    expect(purgeCalls).toEqual([s.householdId]);
    expect(mutationLogAtPurge).toBeGreaterThan(0);

    const muts = (await scanAll<MutationLogRow>(doc, tableName('TABLE_MUTATION_LOG'))).filter(
      (r) => r.householdId === s.householdId,
    );
    expect(muts).toHaveLength(0);
  });

  it('fails the request and leaves the account fully intact when the purge fails', async () => {
    const s = await freshSession();
    await seedHouseholdMutation(s);
    await s3.send(
      new PutObjectCommand({
        Bucket: snapshotsBucket,
        Key: `${s.householdId}/seed.json.gz`,
        Body: Buffer.from('seed'),
      }),
    );

    purgeShouldFail = true;
    const res = await deleteAccount(s, STRONG_PASSWORD);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(purgeCalls).toEqual([s.householdId]);

    const userRow = await doc.send(
      new GetCommand({ TableName: tableName('TABLE_USER'), Key: { userId: s.userId } }),
    );
    expect((userRow.Item as UserRow | undefined)?.userId).toBe(s.userId);
    const cred = await doc.send(
      new GetCommand({ TableName: tableName('TABLE_CREDENTIAL'), Key: { userId: s.userId } }),
    );
    expect(cred.Item).toBeDefined();

    const muts = (await scanAll<MutationLogRow>(doc, tableName('TABLE_MUTATION_LOG'))).filter(
      (r) => r.householdId === s.householdId,
    );
    expect(muts.length).toBeGreaterThan(0);

    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: snapshotsBucket, Prefix: `${s.householdId}/` }),
    );
    expect(list.KeyCount ?? 0).toBeGreaterThan(0);
  });
});
