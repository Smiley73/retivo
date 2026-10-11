import { Module } from '@nestjs/common';
import { AwsModule } from '../aws/aws.module.js';
import { DynamoModule } from '../dynamo/dynamo.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SyncController } from './sync.controller.js';
import { PushService } from './push.service.js';
import { PullService } from './pull.service.js';
import { BootstrapService } from './bootstrap.service.js';
import { SnapshotsService } from './snapshots.service.js';
import { RestoreService } from './restore.service.js';
import { ClearWorkspaceService } from './clear-workspace.service.js';

@Module({
  imports: [AwsModule, DynamoModule, AuthModule],
  controllers: [SyncController],
  providers: [
    PushService,
    PullService,
    BootstrapService,
    SnapshotsService,
    RestoreService,
    ClearWorkspaceService,
  ],
})
export class SyncModule {}
