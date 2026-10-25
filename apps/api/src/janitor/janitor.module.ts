// Janitor module, the source of truth for the daily snapshot retention pass, imported by AppModule and JanitorLambdaModule; it has
// no ConfigModule.forRoot.
import { Module } from '@nestjs/common';
import { AwsModule } from '../aws/aws.module.js';
import { JanitorService } from './janitor.service.js';

@Module({
  imports: [AwsModule],
  providers: [JanitorService],
  exports: [JanitorService],
})
export class JanitorModule {}
