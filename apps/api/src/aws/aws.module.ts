/**
 * AWS clients module. Provides typed singletons for DynamoDB Document
 * Client, S3, SES, and Lambda — used by the repository layer in `dynamo/`
 * and by the auth services (the Lambda client invokes the dedicated
 * account-deletion snapshot-purge Lambda). Honors DYNAMODB_ENDPOINT /
 * S3_ENDPOINT / SES_ENDPOINT
 * env vars so the same code runs against DynamoDB Local + Moto in dev
 * (Scenario 2/3) and real AWS in dev/prod (Scenario 4).
 */
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
          // Explicit per-call timeouts (repo non-negotiable: every
          // outbound call is bounded; the sync-path DynamoDB budget is <= 5 s).
          // Bounds a hung socket on the synchronous push-response path (the
          // post-commit strand re-append's GetItem + PutItem) so it
          // can never stall an already-committed, acknowledged write toward
          // the ~30 s API Gateway ceiling. requestTimeout sits under 5 s with
          // headroom; connectionTimeout is shorter still.
          requestHandler: {
            requestTimeout: 4_500,
            connectionTimeout: 2_000,
          },
          // Local emulators (DynamoDB Local) require fake credentials.
          // Real AWS uses the default credential chain (IAM role for Lambda).
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
          // Explicit per-call timeouts (repo non-negotiable: every
          // outbound call is bounded). Used by
          // sync bootstrap/pull GetObject + the /health/dependencies
          // GetBucketLocation probe; sized under the API Gateway budget.
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
      // Invokes the dedicated account-deletion snapshot-purge Lambda
      // synchronously (RequestResponse). Explicit socket/connection
      // timeouts sized to tolerate a purge-Lambda cold start while
      // staying within the api's 30s API Gateway budget — the call sits
      // inside DELETE /auth/account, which must return 204.
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
          // Explicit per-call timeouts (repo non-negotiable: every outbound
          // call is bounded).
          // Bounds a hung SES socket on the step-up email-OTP send path
          // (step-up.controller.ts → mfa-email-otp.service.ts sendStepUp) plus
          // the existing MFA/verification sends, so it can never stall a
          // request toward the ~30 s API Gateway ceiling. requestTimeout sits
          // under 5 s with headroom; connectionTimeout is shorter still.
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
