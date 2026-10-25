// Typed AWS client singletons (DynamoDB Document Client, S3, SES, Lambda); the *_ENDPOINT env vars point them at DynamoDB Local and
// Moto in dev.
import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SESClient } from '@aws-sdk/client-ses';
import { LambdaClient } from '@aws-sdk/client-lambda';
import type { EnvConfig } from '../common/env.config.js';

export const DYNAMO_DOC_CLIENT = Symbol('DYNAMO_DOC_CLIENT');
export const S3_CLIENT = Symbol('S3_CLIENT');
export const SES_CLIENT = Symbol('SES_CLIENT');
export const LAMBDA_CLIENT = Symbol('LAMBDA_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: DYNAMO_DOC_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => {
        const region = config.get('AWS_REGION', { infer: true });
        const endpoint = config.get('DYNAMODB_ENDPOINT', { infer: true });
        const client = new DynamoDBClient({
          region,
          // Every outbound call is bounded, and this one sits on the synchronous push-response path (the strand
          // re-append), so a hung socket must not stall an acknowledged write toward the ~30 s API Gateway ceiling.
          // requestTimeout is under 5 s; connectionTimeout is shorter.
          requestHandler: {
            requestTimeout: 4_500,
            connectionTimeout: 2_000,
          },
          // Local emulators need fake credentials; real AWS uses the default chain.
          ...(endpoint
            ? {
                endpoint,
                credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
              }
            : {}),
        });
        return DynamoDBDocumentClient.from(client, {
          marshallOptions: {
            removeUndefinedValues: true,
            convertEmptyValues: false,
          },
        });
      },
    },
    {
      provide: S3_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => {
        const region = config.get('AWS_REGION', { infer: true });
        const endpoint = config.get('S3_ENDPOINT', { infer: true });
        return new S3Client({
          region,
          // Bounded, sized under the API Gateway budget; used by sync GetObject and the /health/dependencies probe.
          requestHandler: {
            requestTimeout: 25_000,
            connectionTimeout: 3_000,
          },
          ...(endpoint
            ? {
                endpoint,
                forcePathStyle: true, // Required by Moto.
                credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
              }
            : {}),
        });
      },
    },
    {
      // Invokes the snapshot-purge Lambda synchronously inside `DELETE /auth/account`, so the timeouts tolerate its
      // cold start within the 30 s API Gateway budget.
      provide: LAMBDA_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => {
        const region = config.get('AWS_REGION', { infer: true });
        return new LambdaClient({
          region,
          requestHandler: {
            requestTimeout: 25_000,
            connectionTimeout: 3_000,
          },
        });
      },
    },
    {
      provide: SES_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => {
        const region = config.get('AWS_REGION', { infer: true });
        const endpoint = config.get('SES_ENDPOINT', { infer: true });
        return new SESClient({
          region,
          // Bounded so a hung SES socket on the OTP and verification send paths cannot stall a request toward the ~30 s
          // ceiling; requestTimeout is under 5 s.
          requestHandler: {
            requestTimeout: 4_500,
            connectionTimeout: 2_000,
          },
          ...(endpoint
            ? {
                endpoint,
                credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
              }
            : {}),
        });
      },
    },
  ],
  exports: [DYNAMO_DOC_CLIENT, S3_CLIENT, SES_CLIENT, LAMBDA_CLIENT],
})
export class AwsModule {}
