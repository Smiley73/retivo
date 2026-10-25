// AWS Lambda handler for the hourly compactor: boots CompactorLambdaModule once per cold start and runs
// `CompactorService.runOnce()`. No SSM load, since its IAM role deliberately omits ssm:GetParameter.
import 'reflect-metadata';
import type { Handler, ScheduledEvent } from 'aws-lambda';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SESClient } from '@aws-sdk/client-ses';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CompactorLambdaModule } from './compactor/compactor-lambda.module.js';
import { CompactorService } from './compactor/compactor.service.js';
import {
  DYNAMO_DOC_CLIENT,
  S3_CLIENT,
  SES_CLIENT,
  LAMBDA_CLIENT,
} from './aws/aws.module.js';

let cachedApp: INestApplicationContext | undefined;

async function bootstrap(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(CompactorLambdaModule, {
    bufferLogs: true,
  });
}

export const handler: Handler<ScheduledEvent> = async (_event, context) => {
  if (!cachedApp) cachedApp = await bootstrap();
  const svc = cachedApp.get(CompactorService);
  // Thread the Lambda remaining time so the run deadline tracks the real budget; `context` is a bare `{}` in some
  // tests, hence the optional chaining.
  return svc.runOnce(context?.getRemainingTimeInMillis?.());
};

// Resolves a provider, returning undefined when it is not registered: the lambda module imports only CompactorModule,
// so Nest throws UnknownElementException for the AWS clients it never pulls in. Any other error is rethrown.
function tryGet<T>(app: INestApplicationContext, token: symbol): T | undefined {
  try {
    return app.get<T>(token);
  } catch (err) {
    // UnknownElementException is not exported from the public surface, so it is identified by constructor name.
    if (err instanceof Error && err.constructor.name === 'UnknownElementException') {
      return undefined;
    }
    throw err;
  }
}

/**
 * Test-only teardown: destroys every AWS SDK client in the cached context (each keeps an HTTP keep-alive pool that
 * `app.close()` does not drain), then closes the context and clears the cache. Never called in production.
 */
export async function closeForTests(): Promise<void> {
  const app = cachedApp;
  if (!app) return;
  const doc = tryGet<DynamoDBDocumentClient>(app, DYNAMO_DOC_CLIENT);
  const s3 = tryGet<S3Client>(app, S3_CLIENT);
  const ses = tryGet<SESClient>(app, SES_CLIENT);
  const lambda = tryGet<LambdaClient>(app, LAMBDA_CLIENT);
  doc?.destroy();
  s3?.destroy();
  ses?.destroy();
  lambda?.destroy();
  await app.close();
  cachedApp = undefined;
}
