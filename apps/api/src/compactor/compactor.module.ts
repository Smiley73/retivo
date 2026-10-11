/**
 * Compactor module. Source of truth for the hourly compaction
 * algorithm. Imported by `AppModule` (tests / ad-hoc invocation) and
 * by `CompactorLambdaModule` (the standalone Lambda boot).
 *
 * Stays lean: no `ConfigModule.forRoot` here — that lives one layer
 * up so the standalone-bootstrap concern doesn't leak into the
 * shared module that AppModule already imports (where ConfigModule
 * is registered).
 */
import { Module } from '@nestjs/common';
import { AwsModule } from '../aws/aws.module.js';
import { DynamoModule } from '../dynamo/dynamo.module.js';
import { CompactorService } from './compactor.service.js';

@Module({
  imports: [AwsModule, DynamoModule],
  providers: [CompactorService],
  exports: [CompactorService],
})
export class CompactorModule {}
