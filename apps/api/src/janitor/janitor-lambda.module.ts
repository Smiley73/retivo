// Standalone-bootstrap wrapper for the janitor Lambda, so JanitorModule stays free of ConfigModule.forRoot; its loader supplies only
// the env vars the janitor reads.
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
