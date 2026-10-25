// Compactor module, the source of truth for the hourly compaction, imported by AppModule and CompactorLambdaModule; it has no
// ConfigModule.forRoot.
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
