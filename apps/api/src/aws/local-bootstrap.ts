/**
 * Dev-only bootstrap for the local emulator stack (DynamoDB Local + Moto).
 * Creates tables + the snapshots bucket if missing so a fresh `pnpm emu:up`
 * + `pnpm dev` Just Works without a parallel infra script.
 *
 * Mirrors the schema in infrastructure/src/dynamo.ts. When that file
 * changes, update both. Idempotent: re-running is a no-op.
 *
 * Runs only when DYNAMODB_ENDPOINT is set (i.e. Scenario 2/3). Real AWS
 * (Scenario 4) is provisioned by Pulumi; this code is a no-op there.
 */
import {
  DynamoDBClient,
  CreateTableCommand,
  UpdateTimeToLiveCommand,
  DescribeTableCommand,
  ResourceInUseException,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import type { EnvConfig } from '../common/env.config.js';

interface TableSpec {
  readonly tableName: string;
  readonly schema: Omit<CreateTableCommandInput, 'TableName' | 'BillingMode'>;
  readonly ttlAttribute?: string;
}

function buildTableSpecs(env: EnvConfig): TableSpec[] {
  const hashOnly = (
    name: string,
    attr: string,
    type: 'S' | 'N' = 'S',
  ): TableSpec => ({
    tableName: name,
    schema: {
      AttributeDefinitions: [{ AttributeName: attr, AttributeType: type }],
      KeySchema: [{ AttributeName: attr, KeyType: 'HASH' }],
    },
  });

  const hashRange = (
    name: string,
    hash: string,
    range: string,
  ): TableSpec => ({
    tableName: name,
    schema: {
      AttributeDefinitions: [
        { AttributeName: hash, AttributeType: 'S' },
        { AttributeName: range, AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: hash, KeyType: 'HASH' },
        { AttributeName: range, KeyType: 'RANGE' },
      ],
    },
  });

  return [
    hashOnly(env.TABLE_WORKSPACE_META, 'householdId'),
    hashRange(env.TABLE_MUTATION_LOG, 'householdId', 'sequenceId'),
    hashRange(env.TABLE_AGGREGATE_VERSION, 'householdId', 'aggregateId'),
    { ...hashOnly(env.TABLE_IDEMPOTENCY_KEY, 'key'), ttlAttribute: 'expiresAt' },
    hashRange(env.TABLE_DEVICE_REGISTRY, 'householdId', 'deviceId'),
    {
      tableName: env.TABLE_USER,
      schema: {
        AttributeDefinitions: [
          { AttributeName: 'userId', AttributeType: 'S' },
          { AttributeName: 'emailLowercase', AttributeType: 'S' },
        ],
        KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'EmailIndex',
            KeySchema: [{ AttributeName: 'emailLowercase', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      },
    },
    hashOnly(env.TABLE_EMAIL_RESERVATION, 'emailLowercase'),
    {
      ...hashOnly(env.TABLE_EMAIL_VERIFICATION, 'verificationToken'),
      ttlAttribute: 'expiresAt',
    },
    {
      ...hashOnly(env.TABLE_PASSWORD_RESET, 'resetToken'),
      ttlAttribute: 'expiresAt',
    },
    hashOnly(env.TABLE_CREDENTIAL, 'userId'),
    hashRange(env.TABLE_PASSKEY, 'userId', 'credentialId'),
    {
      ...hashRange(env.TABLE_REFRESH_TOKEN, 'userId', 'tokenHash'),
      ttlAttribute: 'expiresAt',
    },
    {
      tableName: env.TABLE_REVOKED_TOKEN,
      schema: {
        AttributeDefinitions: [
          { AttributeName: 'jti', AttributeType: 'S' },
          { AttributeName: 'userId', AttributeType: 'S' },
        ],
        KeySchema: [{ AttributeName: 'jti', KeyType: 'HASH' }],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'UserIndex',
            KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
            Projection: {
              ProjectionType: 'INCLUDE',
              NonKeyAttributes: ['kind', 'revokedAt', 'expiresAt'],
            },
          },
        ],
      },
      ttlAttribute: 'expiresAt',
    },
    {
      ...hashOnly(env.TABLE_FAILED_LOGIN_ATTEMPT, 'emailLowercase'),
      ttlAttribute: 'expiresAt',
    },
    {
      ...hashRange(env.TABLE_AUTH_EVENT, 'userId', 'eventId'),
      ttlAttribute: 'expiresAt',
    },
    {
      ...hashOnly(env.TABLE_SIGNUP_APPROVAL, 'approvalToken'),
      ttlAttribute: 'expiresAt',
    },
    {
      ...hashRange(env.TABLE_HOUSEHOLD_KEY_ENVELOPE, 'householdId', 'slotId'),
      ttlAttribute: 'expiresAt',
    },
    // Enforced second-factor (MFA) tables.
    hashOnly(env.TABLE_USER_MFA, 'userId'),
    {
      ...hashOnly(env.TABLE_MFA_EMAIL_OTP, 'userId'),
      ttlAttribute: 'expiresAt',
    },
    {
      ...hashRange(env.TABLE_TRUSTED_DEVICE, 'userId', 'deviceId'),
      ttlAttribute: 'expiresAt',
    },
    // Shared, single-use WebAuthn challenge storage.
    {
      ...hashOnly(env.TABLE_PASSKEY_CHALLENGE, 'key'),
      ttlAttribute: 'expiresAt',
    },
  ];
}

async function ensureTable(
  ddb: DynamoDBClient,
  spec: TableSpec,
): Promise<'created' | 'exists'> {
  try {
    await ddb.send(
      new CreateTableCommand({
        TableName: spec.tableName,
        BillingMode: 'PAY_PER_REQUEST',
        ...spec.schema,
      }),
    );
  } catch (err) {
    if (err instanceof ResourceInUseException) return 'exists';
    throw err;
  }
  if (spec.ttlAttribute) {
    // DynamoDB Local accepts UpdateTimeToLive immediately after create.
    await ddb.send(
      new UpdateTimeToLiveCommand({
        TableName: spec.tableName,
        TimeToLiveSpecification: {
          AttributeName: spec.ttlAttribute,
          Enabled: true,
        },
      }),
    );
  }
  return 'created';
}

async function ensureBucket(s3: S3Client, name: string): Promise<'created' | 'exists'> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: name }));
    return 'exists';
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: name }));
    return 'created';
  }
}

export interface BootstrapSummary {
  tablesCreated: string[];
  bucketCreated: boolean;
}

export async function ensureLocalAwsResources(
  env: EnvConfig,
): Promise<BootstrapSummary | null> {
  if (!env.DYNAMODB_ENDPOINT) return null;

  const credentials = { accessKeyId: 'local', secretAccessKey: 'local' };
  const ddb = new DynamoDBClient({
    region: env.AWS_REGION,
    endpoint: env.DYNAMODB_ENDPOINT,
    credentials,
  });

  const tablesCreated: string[] = [];
  for (const spec of buildTableSpecs(env)) {
    // Some envs already have the table; DescribeTable short-circuits the
    // CreateTable round-trip and avoids the ResourceInUseException churn.
    try {
      await ddb.send(new DescribeTableCommand({ TableName: spec.tableName }));
      continue;
    } catch {
      // fall through to create
    }
    const result = await ensureTable(ddb, spec);
    if (result === 'created') tablesCreated.push(spec.tableName);
  }

  let bucketCreated = false;
  if (env.S3_ENDPOINT) {
    const s3 = new S3Client({
      region: env.AWS_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: true,
      credentials,
    });
    bucketCreated =
      (await ensureBucket(s3, env.SNAPSHOTS_BUCKET)) === 'created';
  }

  return { tablesCreated, bucketCreated };
}
