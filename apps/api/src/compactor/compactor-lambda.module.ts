/**
 * Standalone-bootstrap wrapper for the compactor Lambda.
 *
 * `compactor-lambda.ts` calls
 * `NestFactory.createApplicationContext(CompactorLambdaModule)` —
 * that's the entry point for the deployed handler. The wrapper exists
 * so `CompactorModule` itself stays free of `ConfigModule.forRoot`
 * (AppModule already registers ConfigModule globally; registering it
 * twice when AppModule imports CompactorModule would double-register).
 *
 * The `load` factory below is intentionally minimal — the full
 * `envConfigProvider` validates AUTH_JWT_PRIVATE_KEYS /
 * AUTH_JWT_PUBLIC_KEYS as required, but the compactor's Lambda env
 * (lambda.ts:162-169) deliberately does NOT carry them. This loader
 * supplies just the env vars the compactor reads
 * (`TABLE_WORKSPACE_META`, `TABLE_MUTATION_LOG`, `SNAPSHOTS_BUCKET`,
 * `AWS_REGION`, the local-emulator `*_ENDPOINT`s) with the same
 * defaults as the main schema so local tests match production
 * behavior.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CompactorModule } from './compactor.module.js';

function compactorEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',

    DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT,
    S3_ENDPOINT: process.env.S3_ENDPOINT,

    TABLE_WORKSPACE_META:
      process.env.TABLE_WORKSPACE_META ?? 'retirement-local-workspace-meta',
    TABLE_MUTATION_LOG:
      process.env.TABLE_MUTATION_LOG ?? 'retirement-local-mutation-log',
    SNAPSHOTS_BUCKET:
      process.env.SNAPSHOTS_BUCKET ?? 'retirement-local-snapshots',

    STACK: process.env.STACK,
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [compactorEnv] }),
    CompactorModule,
  ],
})
export class CompactorLambdaModule {}
