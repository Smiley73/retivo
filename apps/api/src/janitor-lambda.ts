/**
 * AWS Lambda handler for the daily snapshot janitor.
 *
 * Boots `JanitorLambdaModule` (a thin wrapper that registers
 * `ConfigModule.forRoot` + imports `JanitorModule`) once per cold
 * start, caches it, and invokes `JanitorService.runOnce()` on each
 * EventBridge tick.
 *
 * No `loadSecretsFromSsm()` — the janitor doesn't sign JWTs / send
 * SES / enforce edge auth, and its IAM role omits `ssm:GetParameter`
 * by design. Bucket name + retention knobs arrive via Lambda env
 * vars from `infrastructure/src/lambda.ts`.
 *
 * Returns the run summary for CloudWatch — the EventBridge target
 * does not consume the response, but a structured summary helps
 * when inspecting Lambda logs.
 */
import 'reflect-metadata';
import type { Handler, ScheduledEvent } from 'aws-lambda';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SESClient } from '@aws-sdk/client-ses';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { JanitorLambdaModule } from './janitor/janitor-lambda.module.js';
import { JanitorService } from './janitor/janitor.service.js';
import {
  DYNAMO_DOC_CLIENT,
  S3_CLIENT,
  SES_CLIENT,
  LAMBDA_CLIENT,
} from './aws/aws.module.js';

let cachedApp: INestApplicationContext | undefined;

async function bootstrap(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(JanitorLambdaModule, {
    bufferLogs: true,
  });
}

export const handler: Handler<ScheduledEvent> = async () => {
  if (!cachedApp) cachedApp = await bootstrap();
  const svc = cachedApp.get(JanitorService);
  return svc.runOnce();
};

/**
 * Resolve a provider from `app`, returning `undefined` when the symbol is
 * not registered in the bootstrapped module. `JanitorLambdaModule` imports
 * only `JanitorModule`, so AWS clients that module never pulls in are
 * legitimately absent — Nest throws `UnknownElementException` for those,
 * which is the only error swallowed here. Any other resolution failure is
 * rethrown.
 */
function tryGet<T>(app: INestApplicationContext, token: symbol): T | undefined {
  try {
    return app.get<T>(token);
  } catch (err) {
    // UnknownElementException is not exported from @nestjs/core's public
    // surface; identify it by constructor name (the same pattern used in
    // the test suite) so an unregistered provider is the only swallowed
    // case and every other error propagates.
    if (err instanceof Error && err.constructor.name === 'UnknownElementException') {
      return undefined;
    }
    throw err;
  }
}

/**
 * Test-only teardown. Destroys every AWS SDK client held by the cached
 * standalone context — each owns its own HTTP keep-alive pool that
 * `app.close()` does not drain (the clients implement no `OnModuleDestroy`)
 * — then closes the Nest context and clears the module-level cache so the
 * next test boots fresh. Never called in production; the lambda handler
 * keeps `cachedApp` warm across invocations by design.
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
