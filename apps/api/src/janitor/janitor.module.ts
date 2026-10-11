/**
 * Janitor module. Source of truth for the daily snapshot retention
 * pass. Imported by `AppModule` (tests / ad-hoc invocation) and by
 * `JanitorLambdaModule` (the standalone Lambda boot).
 *
 * Stays lean: no `ConfigModule.forRoot` here — the standalone-bootstrap
 * concern lives in `JanitorLambdaModule` so AppModule's existing
 * global ConfigModule registration isn't double-loaded.
 */
import { Module } from '@nestjs/common';
import { AwsModule } from '../aws/aws.module.js';
import { JanitorService } from './janitor.service.js';

@Module({
  imports: [AwsModule],
  providers: [JanitorService],
  exports: [JanitorService],
})
export class JanitorModule {}
