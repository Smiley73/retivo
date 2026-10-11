/**
 * Standalone-bootstrap wrapper for the janitor Lambda.
 *
 * `janitor-lambda.ts` calls
 * `NestFactory.createApplicationContext(JanitorLambdaModule)` —
 * that's the entry point for the deployed handler. The wrapper exists
 * so `JanitorModule` itself stays free of `ConfigModule.forRoot`
 * (AppModule already registers ConfigModule globally; registering it
 * twice when AppModule imports JanitorModule would double-register).
 *
 * The `load` factory below is intentionally minimal — the full
 * `envConfigProvider` validates AUTH_JWT_PRIVATE_KEYS / etc as
 * required, but the janitor's Lambda env doesn't carry them. This
 * loader supplies just the env vars the janitor reads, with the same
 * defaults as production so local tests behave the same.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JanitorModule } from './janitor.module.js';

function janitorEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',

    S3_ENDPOINT: process.env.S3_ENDPOINT,

    SNAPSHOTS_BUCKET:
      process.env.SNAPSHOTS_BUCKET ?? 'retirement-local-snapshots',
    SNAPSHOT_MIN_KEEP: process.env.SNAPSHOT_MIN_KEEP ?? '10',
    SNAPSHOT_MIN_AGE_DAYS: process.env.SNAPSHOT_MIN_AGE_DAYS ?? '90',

    STACK: process.env.STACK,
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [janitorEnv] }),
    JanitorModule,
  ],
})
export class JanitorLambdaModule {}
