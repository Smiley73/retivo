// Workspace-clear purge ordering: the S3 history purge runs after the sweep, empty-snapshot mint and WorkspaceMeta repoint, so a purge failure never strands the live pointer. The clear still commits (historyErased:false),
// prior snapshots stay restorable, workspace_clear_failed is audited, and the purgeHistoryOnly retry succeeds without re-sweeping. Builds its own Nest app to override AccountSnapshotPurgeService.
import 'reflect-metadata';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import { ValidationPipe, ClassSerializerInterceptor } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
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
import type { AuthEventRow } from '../dynamo/types.js';

interface PurgeCall {
  householdId: string;
  keepKeys: string[] | undefined;
}

describe('workspace clear — erase-history purge ordering + failure', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let doc: DynamoDBDocumentClient;
  let s3: S3Client;
  let bucket: string;
  let purgeCalls: PurgeCall[];
  let purgeShouldFail: boolean;

  beforeAll(async () => {
    await ensureLocalAwsResources(validateEnv());

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AccountSnapshotPurgeService)
      .useValue({
        purge: async (
          householdId: string,
          opts?: { keepKeys?: string[] },
        ): Promise<void> => {
          purgeCalls.push({ householdId, keepKeys: opts?.keepKeys });
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
    bucket = moduleRef
      .get(ConfigService)
      .get('SNAPSHOTS_BUCKET', { infer: true } as never) as unknown as string;
  });

  afterAll(async () => {
    await app.close();
    // This suite builds its own app, so the bootstrapTestApp close-patch does not cover its clients; destroy the resolved pools.
    doc.destroy();
    s3.destroy();
  });

  beforeEach(() => {
    purgeCalls = [];
    purgeShouldFail = false;
  });

  function freshSession(): Promise<Session> {
    return signupVerifyLogin({ app, module: moduleRef, doc });
  }

  function clearWorkspace(s: Session, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post('/api/v1/sync/workspace/clear')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${s.accessToken}`)
      .set('X-CSRF-Token', s.csrfValue)
      .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
      .send(body);
  }

  function tableName(key: string): string {
    return moduleRef
      .get(ConfigService)
      .get(key, { infer: true } as never) as unknown as string;
  }

  async function seedSnapshot(householdId: string, snapshotId: string): Promise<void> {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${householdId}/${snapshotId}.json.gz`,
        Body: Buffer.from('seed'),
      }),
    );
  }

  async function liveSnapshotId(householdId: string): Promise<string> {
    const meta = await doc.send(
      new GetCommand({
        TableName: tableName('TABLE_WORKSPACE_META'),
        Key: { householdId },
      }),
    );
    return meta.Item?.latestSnapshotId as string;
  }

  it('commits the clear with historyErased:false when the purge fails, leaves prior snapshots, and audits the failure', async () => {
    const s = await freshSession();
    await seedSnapshot(s.householdId, '2026-01-01T00-00-00-000Z');

    purgeShouldFail = true;
    const res = await clearWorkspace(s, {
      currentPassword: STRONG_PASSWORD,
      eraseHistory: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.historyErased).toBe(false);

    const liveId = await liveSnapshotId(s.householdId);
    expect(liveId).toBeTruthy();

    // The prior snapshot lingers (the purge threw before deleting anything), so the clear stays undoable via Restore until backups age out.
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${s.householdId}/` }),
    );
    const keys = (list.Contents ?? []).map((o) => o.Key);
    expect(keys).toContain(`${s.householdId}/2026-01-01T00-00-00-000Z.json.gz`);

    // Audited as a failure, reason-tagged so the trail distinguishes it from a rejected password.
    const rows = (await scanAll<AuthEventRow>(doc, tableName('TABLE_AUTH_EVENT')))
      .filter((r) => r.userId === s.userId);
    const events = rows.map((r) => r.eventType);
    expect(events).toContain('workspace_clear_started');
    expect(events).toContain('workspace_clear_failed');
    const failed = rows.find((r) => r.eventType === 'workspace_clear_failed');
    expect(failed?.metadata).toMatchObject({ reason: 'history_purge_failed' });
    // A purge failure emits _failed for the history sub-op; the clear committed but is not reported as _completed.
    expect(events).not.toContain('workspace_clear_completed');
  });
});
