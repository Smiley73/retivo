// AWS Lambda handler: the same Nest app as main.ts bridged by serverless-express, bootstrapped once per cold start. SSM secrets load
// before NestFactory.create; the CORS preflight is answered at the origin.
import 'reflect-metadata';
import type { Handler } from 'aws-lambda';
import { NestFactory, Reflector } from '@nestjs/core';
import {
  ValidationPipe,
  ClassSerializerInterceptor,
  type INestApplication,
} from '@nestjs/common';
import { json, urlencoded } from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
// The CJS-to-ESM interop under NodeNext exposes the callable as a named export.
import { configure as serverlessExpress } from '@codegenie/serverless-express';
import { AppModule } from './app.module.js';
import { HttpErrorFilter } from './common/http-error.filter.js';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware.js';
import { BuildIdMiddleware } from './common/build-id.middleware.js';
import { loadSecretsFromSsm } from './aws/ssm-bootstrap.js';
import { createCorsPreflightHandler } from './common/cors-preflight.js';
import { validateEnv, type EnvConfig } from './common/env.config.js';

let cachedHandler: Handler | undefined;

/**
 * Registers the middleware and security chain (trust proxy, CORS preflight, body parsers, helmet, validation pipe,
 * interceptors, filters, correlation and build-id middleware, global prefix, `app.init()`). Extracted so the
 * structured-logging integration test can drive the real chain via `createApp()`.
 */
export async function configureAppMiddleware(
  app: INestApplication,
  env: EnvConfig,
): Promise<void> {
  // Only CloudFront appends to X-Forwarded-For (API Gateway HTTP API v2 passes it through), so trust exactly one
  // hop; `true` would trust the attacker-controlled leftmost value and let per-IP throttling be bypassed.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Answer the CORS preflight before Nest routing, from the parsed WEB_ALLOWED_ORIGINS allowlist.
  app.use(
    '/api/v1',
    createCorsPreflightHandler(env.WEB_ALLOWED_ORIGINS_PARSED),
  );

  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ extended: true, limit: '5mb' }));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      // The edge appends HSTS.
      hsts: false,
      crossOriginEmbedderPolicy: true,
      crossOriginOpenerPolicy: true,
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(
    new ClassSerializerInterceptor(app.get(Reflector)),
  );
  app.useGlobalFilters(new HttpErrorFilter());
  app.use(new CorrelationIdMiddleware().use);
  app.use(new BuildIdMiddleware().use);
  app.setGlobalPrefix('api/v1', { exclude: [] });

  await app.init();
}

/**
 * Builds the fully initialized Nest application: validate env, create the app, wire the Pino logger so `new
 * Logger(...)` service calls reach CloudWatch, and register the middleware chain. An SSM-free seam for the
 * structured-logging integration test.
 */
export async function createApp(): Promise<INestApplication> {
  // Parse env after any SSM load so the preflight allowlist reads the same zod-validated source as local dev.
  const env = validateEnv();
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  // Bridge `new Logger(name)` service calls onto the nestjs-pino provider, so they reach CloudWatch as redacted
  // JSON.
  app.useLogger(app.get(Logger));
  // Detach the `bufferLogs` startup buffer: `main.ts` gets this from `app.listen()`, but the Lambda path never
  // listens, so service-level logs would sit in the buffer forever. HTTP request logs come from pino-http and were
  // unaffected.
  app.flushLogs();
  await configureAppMiddleware(app, env);
  return app;
}

async function bootstrap(): Promise<Handler> {
  await loadSecretsFromSsm();
  const app = await createApp();
  // Wrap the app Express instance for API Gateway.
  const expressApp = app.getHttpAdapter().getInstance() as Express;
  return serverlessExpress({ app: expressApp });
}

// The Node.js 24 Lambda runtime rejects callback-style handlers (detected by `handler.length >= 3`), so the
// export declares only (event, context).
export const handler: Handler = async (event, context) => {
  if (!cachedHandler) cachedHandler = await bootstrap();
  // Cast the 2-arg promise form to the typed Handler, which @types/aws-lambda models as callback-style.
  return (cachedHandler as (e: unknown, c: unknown) => Promise<unknown>)(event, context);
};
