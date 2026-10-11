/**
 * Account-deletion snapshot-purge ordering + failure tests.
 *
 * Locks the purge-first ordering: the snapshot purge runs
 * BEFORE the irreversible DynamoDB + auth-state sweeps. A purge failure
 * fails the request with the account fully intact (household data,
 * snapshots, and the User/Credential rows all survive — recoverable by
 * re-login); a successful purge is invoked exactly once with only the
 * household id.
 *
 * Builds its own Nest app so it can override AccountSnapshotPurgeService
 * with a spy / failure stub.
 */
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
  SnapshotPurgeError,
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
  // Mutable hooks the overridden purge service reads on each call.
  let purgeCalls: string[];
  let purgeShouldFail: boolean;
  // Records household row presence at the instant purge ran, to prove
  // purge happens before the DynamoDB sweep.
  let mutationLogAtPurge: number | null;

  beforeAll(async () => {
    await ensureLocalAwsResources(validateEnv());

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AccountSnapshotPurgeService)
      .useValue({
        purge: async (householdId: string): Promise<void> => {
          purgeCalls.push(householdId);
          // Snapshot household data presence at purge time so the test
          // can assert the DynamoDB sweep has NOT run yet.
          const rows = (
            await scanAll<MutationLogRow>(doc, tableName('TABLE_MUTATION_LOG'))
          ).filter((r) => r.householdId === householdId);
          mutationLogAtPurge = rows.length;
          if (purgeShouldFail) {
            throw new SnapshotPurgeError('forced purge failure (test)');
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
    // This suite builds its own Nest app (to override the purge service) and
    // resolves `doc` + `s3` directly from its module, so it is not covered by
    // the `app.close()` patch in `bootstrapTestApp`. Destroy their HTTP
    // keep-alive pools explicitly to avoid a leaked-handle teardown warning.
    doc.destroy();
    s3.destroy();
  });

  beforeEach(() => {
    purgeCalls = [];
    purgeShouldFail = false;
    mutationLogAtPurge = null;
  });

  /** This suite builds its own Nest app, so adapt it to the shared helper. */
  function freshSession(): Promise<Session> {
    return signupVerifyLogin({ app, module: moduleRef, doc });
  }

  /**
   * Seed a MutationLog row for the household directly. A plaintext
   * `POST /sync/push` 403s, so the purge-order test seeds the row whose
   * presence-at-purge-time + post-sweep absence it asserts.
   */
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

    // Purge called exactly once, with only the household id.
    expect(purgeCalls).toEqual([s.householdId]);
    // The DynamoDB sweep had not yet run when the purge fired — the
    // household's MutationLog row was still present at that instant.
    expect(mutationLogAtPurge).toBeGreaterThan(0);

    // After completion the DynamoDB sweep did run.
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

    // User + credential rows survive.
    const userRow = await doc.send(
      new GetCommand({ TableName: tableName('TABLE_USER'), Key: { userId: s.userId } }),
    );
    expect((userRow.Item as UserRow | undefined)?.userId).toBe(s.userId);
    const cred = await doc.send(
      new GetCommand({ TableName: tableName('TABLE_CREDENTIAL'), Key: { userId: s.userId } }),
    );
    expect(cred.Item).toBeDefined();

    // Household sync data survives (DynamoDB sweep never ran).
    const muts = (await scanAll<MutationLogRow>(doc, tableName('TABLE_MUTATION_LOG'))).filter(
      (r) => r.householdId === s.householdId,
    );
    expect(muts.length).toBeGreaterThan(0);

    // Snapshots survive (purge failed before deleting them — the stub
    // never touched S3).
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: snapshotsBucket, Prefix: `${s.householdId}/` }),
    );
    expect(list.KeyCount ?? 0).toBeGreaterThan(0);
  });
});
