/**
 * AWS Lambda handler for the API.
 *
 * Wraps the same NestJS app `main.ts` builds for local dev, but uses
 * `@codegenie/serverless-express` to bridge API Gateway HTTP API v2
 * events to the Express adapter. The Nest app is bootstrapped once per
 * cold start and cached in module scope so subsequent warm invocations
 * skip the ~500 ms init.
 *
 * Scope decisions:
 *  - CORS preflight (`OPTIONS /api/v1/*`) is answered by an early Express
 *    middleware below, before Nest routing. Live testing showed the API
 *    Gateway HTTP API `corsConfiguration` is not consuming preflights for
 *    this distribution, so we handle them at the origin: an allowed
 *    `Origin` gets a `204` with the credentialed-CORS headers; a missing
 *    or disallowed `Origin` gets a bare `204` with no permissive headers.
 *    Non-preflight requests still flow through `OriginCheckMiddleware`,
 *    which enforces Origin/Referer at the API layer.
 *  - Local-emulator bootstrap (`ensureLocalAwsResources`) is skipped —
 *    real AWS already has the tables. The same module is imported in
 *    main.ts; we just don't call the helper here.
 *  - SSM secrets are loaded *before* `NestFactory.create` so Zod env
 *    validation sees the production values.
 */
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
// Default export is the `configure` function under the hood — but the
// CJS-to-ESM interop in TypeScript NodeNext exposes it as a named
// export under the package's `configure` field. Both shapes resolve to
// the same callable.
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
 * Register the middleware/security chain currently inline in the old
 * `bootstrap()`: trust-proxy hop, CORS preflight, body parsers, helmet, the
 * global validation pipe, global interceptors/filters, correlation/build-id
 * middleware, the global prefix, and `app.init()`. Extracted so the Lambda
 * bootstrap path stays under the 60-line function limit and so the
 * structured-logging integration test can drive the real chain via
 * `createApp()`. Pure extraction — order and behavior are unchanged.
 */
export async function configureAppMiddleware(
  app: INestApplication,
  env: EnvConfig,
): Promise<void> {
  // Behind API Gateway HTTP API v2 + CloudFront. Only CloudFront appends
  // to X-Forwarded-For (HTTP API v2 passes through unchanged), so trust
  // exactly one hop. `true` would trust the leftmost (attacker-controlled)
  // header value and let per-IP throttling be bypassed.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Answer CORS preflight for OPTIONS /api/v1/* before Nest routing.
  // Uses the parsed WEB_ALLOWED_ORIGINS allowlist (default WEB_ORIGIN on
  // prod → single-origin, matching the prior contract).
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
      // CloudFront's security-headers function appends HSTS at the edge.
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
 * Build the fully-initialized Nest application: validate env, create the app,
 * wire the Pino logger (so `new Logger(ClassName.name)` service calls reach
 * CloudWatch in the deployed JSON shape), and register the middleware chain.
 * Exported as an SSM-free seam onto the real Lambda bootstrap path for the
 * structured-logging integration test.
 */
export async function createApp(): Promise<INestApplication> {
  // Parse env after any SSM load so the preflight allowlist reads the same
  // zod-validated WEB_ALLOWED_ORIGINS source as local dev. On prod
  // WEB_ALLOWED_ORIGINS is unset, so this resolves to a single-entry list
  // (WEB_ORIGIN) — identical to the prior single-origin behavior.
  const env = validateEnv();
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  // Bridge every `new Logger(name)` (@nestjs/common) service call onto the
  // nestjs-pino provider, so warnings/errors reach CloudWatch as redacted JSON.
  app.useLogger(app.get(Logger));
  // Detach the `bufferLogs: true` startup buffer. `main.ts` gets this for free
  // when it calls `app.listen()`, but the Lambda path never listens (it wraps
  // the Express instance in serverless-express instead), so without this every
  // `new Logger(...).log/warn/error` service call would sit in the static log
  // buffer forever and never reach CloudWatch — the production defect this
  // repairs. HTTP request logs come straight from pino-http and were
  // unaffected, which is why only service-level markers went missing.
  app.flushLogs();
  await configureAppMiddleware(app, env);
  return app;
}

async function bootstrap(): Promise<Handler> {
  await loadSecretsFromSsm();
  const app = await createApp();
  // Wrap the app's underlying Express instance (the same one the previous
  // `serverlessExpress({ app: expressApp })` call used) for API Gateway.
  const expressApp = app.getHttpAdapter().getInstance() as Express;
  return serverlessExpress({ app: expressApp });
}

// Node.js 24 Lambda runtime rejects callback-style handlers. Lambda
// detects them by `handler.length >= 3`, so the exported function
// declares only (event, context). serverless-express's `configure()`
// returns an `async (event, context)` handler — promise-based, no
// callback needed.
export const handler: Handler = async (event, context) => {
  if (!cachedHandler) cachedHandler = await bootstrap();
  // The cached handler is the 2-arg promise form; cast to the typed
  // Handler so the call site type-checks under @types/aws-lambda which
  // models callback-style.
  return (cachedHandler as (e: unknown, c: unknown) => Promise<unknown>)(event, context);
};
