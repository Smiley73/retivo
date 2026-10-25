// Standalone-bootstrap wrapper for the compactor Lambda, so CompactorModule stays free of ConfigModule.forRoot.
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
