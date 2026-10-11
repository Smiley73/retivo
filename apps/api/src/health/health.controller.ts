/**
 * Health endpoints. Lambda + API Gateway don't need Kubernetes-style
 * liveness/readiness/startup probes, so we keep two signals:
 *
 *  - `GET /api/v1/health` — PUBLIC, shallow liveness. Returns
 *    `{ status: "ok" }` with no DynamoDB / S3 SDK calls and no secrets.
 *    Safe for an external uptime monitor; falls under the global
 *    ThrottlerGuard (600/min per IP, shared across instances) like every other route.
 *  - `GET /api/v1/health/dependencies` — AUTHENTICATED (the global
 *    JwtAuthGuard APP_GUARD protects it; no `@Public()`). Probes
 *    DynamoDB + S3 reachability and returns
 *    `{ status, dynamodb, s3 }` or `503` if a dependency is unhealthy.
 *
 * The dependency probe issues GetBucketLocation on the snapshots bucket
 * (covered by the api role's narrow `s3:GetBucketLocation` grant) rather
 * than HeadObject or HeadBucket. A HeadObject on a missing key returns
 * `403 AccessDenied` (not 404) when the caller lacks `s3:ListBucket`, so
 * it cannot distinguish "healthy bucket, absent key" from a real
 * permission/reachability failure. GetBucketLocation is a bucket-level
 * metadata read that needs neither `s3:ListBucket` nor object access.
 */
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

  /**
   * Shallow public liveness — "is the process up and serving HTTP". No
   * dependency probes, no secrets, no SDK calls. Dependency health lives
   * behind authentication at `/health/dependencies`.
   */
  @Public()
  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Authenticated dependency probe. DynamoDB DescribeTable + S3
   * GetBucketLocation on the snapshots bucket; `503
   * DEPENDENCY_UNAVAILABLE` if either is unhealthy.
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

  /**
   * Read the snapshots bucket's location metadata. A successful response
   * proves the bucket is reachable and the credentials are valid →
   * healthy. ANY thrown error (AccessDenied, network, 5xx) → unhealthy.
   * Uses GetBucketLocation (covered by the api role's narrow
   * `s3:GetBucketLocation` grant) — it needs neither `s3:ListBucket` nor
   * object access, and unlike HeadObject it doesn't return 403 for a
   * missing key when ListBucket is withheld.
   */
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
