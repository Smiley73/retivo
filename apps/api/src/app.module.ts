import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from './logger/logger.module.js';
import { AwsModule } from './aws/aws.module.js';
import { DynamoModule } from './dynamo/dynamo.module.js';
import { ThrottleCounterRepository } from './dynamo/throttle-counter.repository.js';
import { DynamoThrottlerStorage } from './throttle/dynamo-throttler-storage.js';
import { AuthModule } from './auth/auth.module.js';
import { SyncModule } from './sync/sync.module.js';
import { CompactorModule } from './compactor/compactor.module.js';
import { JanitorModule } from './janitor/janitor.module.js';
import { CsrfMiddleware } from './auth/csrf.middleware.js';
import { EdgeAuthMiddleware } from './auth/edge-auth.middleware.js';
import { OriginCheckMiddleware } from './auth/origin-check.middleware.js';
import { HealthController } from './health/health.controller.js';
import { envConfigProvider, type EnvConfig } from './common/env.config.js';

/**
 * Global per-IP request budget. Raised
 * from the old per-process 100/min: with the counter now shared across
 * every warm Lambda instance (see `DynamoThrottlerStorage`), 100 would be a
 * step-function tightening of production overnight with no traffic data
 * behind it — the old figure was never really 100/min, it was 100 × however
 * many instances happened to be warm. 600 covers one heavy client (the
 * largest single-route budget, sync pull at 300/min, plus ordinary auth/page
 * traffic) plus several lighter households sharing one address (CGNAT /
 * corporate NAT), while still capping a single IP at 10 req/s of Lambda
 * invocations. A named constant, not an env var: an env-tunable limit is an unreviewed
 * lever that silently removes protection. Every per-route `@Throttle(...)`
 * limit is unaffected — only this global default moves.
 */
const GLOBAL_THROTTLE_LIMIT_PER_MINUTE = 600;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [envConfigProvider],
    }),
    LoggerModule,
    ThrottlerModule.forRootAsync({
      imports: [DynamoModule],
      inject: [ThrottleCounterRepository, ConfigService],
      useFactory: (
        repo: ThrottleCounterRepository,
        config: ConfigService<EnvConfig, true>,
      ) => ({
        // Process-wide opt-out for integration tests that intentionally fire
        // many requests in quick succession. Evaluated by the guard BEFORE
        // it ever touches storage, so the opt-out costs zero DynamoDB
        // requests — this ordering must not change.
        skipIf: () => process.env.DISABLE_THROTTLE === 'true',
        throttlers: [{ ttl: 60_000, limit: GLOBAL_THROTTLE_LIMIT_PER_MINUTE }],
        storage: new DynamoThrottlerStorage(repo, config),
      }),
    }),
    AwsModule,
    DynamoModule,
    AuthModule,
    SyncModule,
    CompactorModule,
    JanitorModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Order matters: EdgeAuth runs first as the cheapest filter (one
    // header compare; no DB / cookie work) so direct hits to APIGW
    // that bypass CloudFront fail before we burn CPU on JWT lookups,
    // CSRF cookie parsing, or argon2 verification. OriginCheck runs
    // before CSRF so requests with a bogus Origin fail fast before
    // we touch the cookie.
    // path-to-regexp 8.x (used by NestJS 11) requires the named-wildcard
    // syntax — bare `'*'` triggers a LegacyRouteConverter warning on
    // every boot. `'{*path}'` is the documented v6+ replacement and
    // captures the same set of routes (everything under the global
    // prefix `/api/v1`).
    consumer
      .apply(EdgeAuthMiddleware, OriginCheckMiddleware, CsrfMiddleware)
      .forRoutes('{*path}');
  }
}
