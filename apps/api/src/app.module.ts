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

// Global per-IP request budget, counted across every warm instance (see `DynamoThrottlerStorage`). 600 covers one heavy
// client (sync pull at 300/min plus ordinary traffic) and several households behind one NAT, while capping an IP at
// 10 req/s. A named constant, not an env var: a tunable limit is an unreviewed lever that silently removes protection.
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
        // Evaluated before the guard touches storage, so the opt-out costs zero DynamoDB requests; this ordering must
        // not change.
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
    // Order matters: EdgeAuth runs first as the cheapest filter, so direct API Gateway hits fail before any JWT,
    // CSRF or argon2 work; OriginCheck runs before CSRF so a bogus Origin fails before the cookie is touched.
    // `{*path}` is the path-to-regexp 8 (NestJS 11) wildcard; bare `*` warns on every boot.
    consumer
      .apply(EdgeAuthMiddleware, OriginCheckMiddleware, CsrfMiddleware)
      .forRoutes('{*path}');
  }
}
