// Health endpoints: public shallow liveness at `/health`, and an authenticated `/health/dependencies` probe of DynamoDB and S3 (503
// when unhealthy).
import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetBucketLocationCommand, S3Client } from '@aws-sdk/client-s3';
import { DYNAMO_DOC_CLIENT, S3_CLIENT } from '../aws/aws.module.js';
import { Public } from '../auth/public.decorator.js';
import type { EnvConfig } from '../common/env.config.js';

@Controller('health')
export class HealthController {
  private readonly userTable: string;
  private readonly snapshotsBucket: string;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) private readonly doc: DynamoDBDocumentClient,
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.userTable = config.get('TABLE_USER', { infer: true });
    this.snapshotsBucket = config.get('SNAPSHOTS_BUCKET', { infer: true });
  }

  /** Shallow public liveness: no dependency probes, secrets or SDK calls. */
  @Public()
  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Authenticated dependency probe: DynamoDB DescribeTable plus S3 GetBucketLocation; 503 DEPENDENCY_UNAVAILABLE if
   * either is unhealthy.
   */
  @Get('dependencies')
  async dependencies() {
    const [dynamo, s3] = await Promise.allSettled([
      this.doc.send(new DescribeTableCommand({ TableName: this.userTable })),
      this.probeS3(),
    ]);
    const result = {
      status: 'ok' as const,
      dynamodb: dynamo.status === 'fulfilled' ? 'ok' : 'error',
      s3: s3.status === 'fulfilled' && s3.value === 'ok' ? 'ok' : 'error',
    };
    if (result.dynamodb !== 'ok' || result.s3 !== 'ok') {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'A backing dependency is unhealthy.',
        details: result,
      });
    }
    return result;
  }

  // Probes the snapshots bucket with GetBucketLocation, which needs neither `s3:ListBucket` nor object access.
  // HeadObject cannot tell a healthy bucket with an absent key from a permission failure: without ListBucket it
  // returns 403, not 404.
  private async probeS3(): Promise<'ok' | 'error'> {
    try {
      await this.s3.send(
        new GetBucketLocationCommand({ Bucket: this.snapshotsBucket }),
      );
      return 'ok';
    } catch {
      return 'error';
    }
  }
}
