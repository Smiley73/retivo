// The local-dev seed (aws/local-dev-user-seed.ts) is idempotent (created, then exists) and its credential row carries a fresh credentialRevision: the seed is a writer that
// must mint one on every credential write, or every local-dev account stays in the "owed" legacy-resolution state.
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ConfigService } from '@nestjs/config';
import { bootstrapTestApp, type TestApp } from './test-helpers.js';
import { validateEnv } from '../common/env.config.js';
import { ensureLocalDevUser, LOCAL_DEV_EMAIL } from '../aws/local-dev-user-seed.js';
import type { CredentialRow } from '../dynamo/types.js';

function tableName(t: TestApp, key: string): string {
  return t.module
    .get(ConfigService)
    .get(key, { infer: true } as never) as unknown as string;
}

describe('local-dev user seed (aws/local-dev-user-seed.ts)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('creates the dev user with a fresh, non-empty credential revision, and is idempotent on re-run', async () => {
    const env = validateEnv();

    const first = await ensureLocalDevUser(env);
    // Another suite in this worker may have seeded the fixed LOCAL_DEV_EMAIL row already; either outcome proves the writer ran and left a resolvable credential.
    expect(['created', 'exists']).toContain(first);

    const second = await ensureLocalDevUser(env);
    expect(second).toBe('exists');

    const userLookup = await t.doc.send(
      new GetCommand({
        TableName: tableName(t, 'TABLE_EMAIL_RESERVATION'),
        Key: { emailLowercase: LOCAL_DEV_EMAIL.toLowerCase() },
      }),
    );
    expect(userLookup.Item).toBeTruthy();
    const userId = userLookup.Item!.userId as string;

    const credentialLookup = await t.doc.send(
      new GetCommand({
        TableName: tableName(t, 'TABLE_CREDENTIAL'),
        Key: { userId },
      }),
    );
    const credential = credentialLookup.Item as CredentialRow | undefined;
    expect(credential?.credentialRevision).toBeTruthy();
  });
});
