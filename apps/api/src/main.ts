/**
 * API bootstrap.
 *
 * The API runs as a NestJS app — locally on Express or wrapped in a Lambda handler.
 * The SPA is served
 * from CloudFront in production and from the Vite dev server locally;
 * we no longer bundle static assets into the API process.
 */
import 'reflect-metadata';
import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe, ClassSerializerInterceptor } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { generateKeyPairSync } from 'node:crypto';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module.js';
import { HttpErrorFilter } from './common/http-error.filter.js';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware.js';
import { BuildIdMiddleware } from './common/build-id.middleware.js';
import { ensureLocalAwsResources } from './aws/local-bootstrap.js';
import {
  ensureLocalDevUser,
  LOCAL_DEV_EMAIL,
} from './aws/local-dev-user-seed.js';
import { validateEnv } from './common/env.config.js';
import { createCorsPreflightHandler, CORS_EXPOSED_HEADERS } from './common/cors-preflight.js';

/**
 * Local-dev convenience for the RS256 migration.
 * On `pnpm dev` (NODE_ENV != production) with AUTH_JWT_PRIVATE_KEYS still
 * unset or the .env.example placeholder, mint an ephemeral keypair so
 * the developer doesn't have to hand-craft PEMs the moment they pull
 * the change. Mirrors the per-Jest-worker approach in test/jest.setup.ts.
 * Persisted real PEMs (set in `.env`) take precedence and survive
 * restarts; ephemeral keys reset on each boot, but the SPA's normal
 * stale-token recovery handles that.
 */
function ensureDevJwtKeys(): void {
  if (process.env.NODE_ENV === 'production') return;
  const existing = process.env.AUTH_JWT_PRIVATE_KEYS;
  if (existing && !existing.includes('replace-with')) return;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.AUTH_JWT_PRIVATE_KEYS = JSON.stringify({ 'local-dev': privateKey });
  process.env.AUTH_JWT_PUBLIC_KEYS = JSON.stringify({ 'local-dev': publicKey });
  process.env.AUTH_JWT_CURRENT_KID = process.env.AUTH_JWT_CURRENT_KID ?? 'local-dev';
  // Pino is not yet wired this early in bootstrap; a plain console.warn
  // is the only thing that will surface on stdout.
  // eslint-disable-next-line no-console
  console.warn(
    '[auth] AUTH_JWT_PRIVATE_KEYS missing or placeholder — generated an ephemeral RSA-2048 keypair for this dev session. Set AUTH_JWT_PRIVATE_KEYS + AUTH_JWT_PUBLIC_KEYS in .env to persist across restarts.',
  );
}

async function bootstrap() {
  ensureDevJwtKeys();
  // Validate + parse env once up front so the CORS/preflight allowlist and
  // the bind host all read the single zod-validated source.
  const env = validateEnv();
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  const logger = app.get(Logger);

  // Trust the upstream proxy so req.ip is the real client IP behind
  // CloudFront / API Gateway. Required for per-IP rate limiting.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Answer CORS preflight for OPTIONS /api/v1/* with the same explicit
  // 204 + headers the Lambda handler uses, so local dev and AWS behave
  // identically. Uses the parsed WEB_ALLOWED_ORIGINS allowlist.
  app.use(
    '/api/v1',
    createCorsPreflightHandler(env.WEB_ALLOWED_ORIGINS_PARSED),
  );

  // Sync push allows up to 5 MB per request. Auth and
  // simple reads stay tiny; the larger limit is gated by the per-route
  // size check inside the sync controller.
  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ extended: true, limit: '5mb' }));

  // Helmet baseline. CSP for API responses is intentionally tight — no
  // inline anything; the SPA's own CSP comes from CloudFront Functions.
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
      // HSTS is appended at the edge by the CloudFront security-headers
      // function. Disable here to avoid duplicate headers when we re-deploy.
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
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new HttpErrorFilter());

  app.enableCors({
    origin: env.WEB_ALLOWED_ORIGINS_PARSED,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
      'X-Correlation-ID',
    ],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
  });

  app.use(new CorrelationIdMiddleware().use);
  app.use(new BuildIdMiddleware().use);

  app.setGlobalPrefix('api/v1', { exclude: [] });

  // Local emulator only: create missing DynamoDB tables + S3 bucket so a
  // fresh `pnpm emu:up` + `pnpm dev` Just Works. No-op in real AWS.
  const summary = await ensureLocalAwsResources(env);
  if (summary && (summary.tablesCreated.length || summary.bucketCreated)) {
    logger.log(
      `Local emulator bootstrap: created ${summary.tablesCreated.length} table(s)` +
        (summary.bucketCreated ? ' + snapshots bucket' : ''),
      'Bootstrap',
    );
  }

  // Local emulator only: seed a pre-verified, auto-approved dev user
  // (`dev@local.test`) so the developer doesn't have to sign up again
  // every fresh boot. No-op in real AWS or production builds.
  const userResult = await ensureLocalDevUser(env);
  if (userResult === 'created') {
    logger.log(
      `Local dev user seeded: ${LOCAL_DEV_EMAIL} (password is hardcoded; see local-dev-user-seed.ts)`,
      'Bootstrap',
    );
  }

  // Bind to API_HOST (default 127.0.0.1 → loopback only, so the dev API and
  // its seeded credentials are NOT reachable from the LAN); set
  // API_HOST=0.0.0.0 in .env to opt IN to LAN exposure.
  const port = env.API_PORT;
  const host = env.API_HOST;
  await app.listen(port, host);
  logger.log(
    `API listening on http://${host}:${port} (reachable at http://localhost:${port})`,
    'Bootstrap',
  );
}

bootstrap();
