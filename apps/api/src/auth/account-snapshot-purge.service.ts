// Snapshot-purge invoker for the `DELETE /auth/account` cascade: invokes the least-privilege purge Lambda synchronously (local runs purge in
// process); a failure throws before any irreversible sweep. See "Background Lambdas" in docs/architecture.md.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InvokeCommand,
  LambdaClient,
  type InvokeCommandOutput,
} from '@aws-sdk/client-lambda';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { LAMBDA_CLIENT, S3_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';

const DELETE_BATCH_SIZE = 1000; // S3 DeleteObjects hard cap.

class SnapshotPurgeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SnapshotPurgeError';
  }
}

@Injectable()
export class AccountSnapshotPurgeService {
  private readonly logger = new Logger(AccountSnapshotPurgeService.name);
  private readonly snapshotsBucket: string;
  private readonly purgeFunctionName: string | undefined;

  constructor(
    @Inject(LAMBDA_CLIENT) private readonly lambda: LambdaClient,
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.snapshotsBucket = config.get('SNAPSHOTS_BUCKET', { infer: true });
    this.purgeFunctionName = config.get('SNAPSHOT_PURGE_FUNCTION_NAME', {
      infer: true,
    });
  }

  /**
   * Deletes every snapshot under `${householdId}/` except `opts.keepKeys` (the erase-history clear keeps the
   * just-minted live snapshot, which `WorkspaceMeta` points at). Throws SnapshotPurgeError on any failure so
   * delete-account aborts before touching DynamoDB. The payload carries only the household id and the keep list, no
   * PII.
   */
  async purge(
    householdId: string,
    opts?: { keepKeys?: string[] },
  ): Promise<void> {
    const keepKeys = opts?.keepKeys ?? [];
    if (this.purgeFunctionName && this.purgeFunctionName.length > 0) {
      await this.invokePurgeLambda(this.purgeFunctionName, householdId, keepKeys);
      return;
    }
    // Local and emulator fallback: no deployed Lambda to call.
    await this.purgeInProcess(householdId, keepKeys);
  }

  private async invokePurgeLambda(
    functionName: string,
    householdId: string,
    keepKeys: string[],
  ): Promise<void> {
    let res: InvokeCommandOutput;
    try {
      res = await this.lambda.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'RequestResponse',
          // Include `keepKeys` only when non-empty, so other callers payload stays exactly `{ householdId }`.
          Payload: Buffer.from(
            JSON.stringify(
              keepKeys.length > 0 ? { householdId, keepKeys } : { householdId },
            ),
          ),
        }),
      );
    } catch (err) {
      throw new SnapshotPurgeError(
        'Snapshot-purge Lambda invocation failed',
        { cause: err },
      );
    }
    // A delivery-level non-2xx or a handler FunctionError both mean the snapshots may not be gone.
    if ((res.StatusCode ?? 0) < 200 || (res.StatusCode ?? 0) >= 300) {
      throw new SnapshotPurgeError(
        `Snapshot-purge Lambda returned status ${res.StatusCode ?? 'unknown'}`,
      );
    }
    if (res.FunctionError) {
      throw new SnapshotPurgeError(
        `Snapshot-purge Lambda reported a function error: ${res.FunctionError}`,
      );
    }
  }

  private async purgeInProcess(
    householdId: string,
    keepKeys: string[],
  ): Promise<void> {
    const prefix = `${householdId}/`;
    const keep = new Set(keepKeys);
    let continuationToken: string | undefined;
    try {
      do {
        const list = await this.s3.send(
          new ListObjectsV2Command({
            Bucket: this.snapshotsBucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        const keys = (list.Contents ?? [])
          .map((o) => o.Key)
          .filter((k): k is string => typeof k === 'string')
          // Never delete a preserved object.
          .filter((k) => !keep.has(k));
        for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
          const slice = keys.slice(i, i + DELETE_BATCH_SIZE);
          const out = await this.s3.send(
            new DeleteObjectsCommand({
              Bucket: this.snapshotsBucket,
              Delete: { Objects: slice.map((Key) => ({ Key })), Quiet: true },
            }),
          );
          // DeleteObjects returns 200 with per-object Errors on partial failure; treat it as a purge failure so the
          // cascade aborts. No object keys in the message.
          if (out.Errors && out.Errors.length > 0) {
            throw new SnapshotPurgeError(
              `In-process snapshot purge failed to delete ${out.Errors.length} object(s)`,
            );
          }
        }
        continuationToken = list.IsTruncated
          ? list.NextContinuationToken
          : undefined;
      } while (continuationToken);
    } catch (err) {
      // Already a typed purge failure: surface as-is.
      if (err instanceof SnapshotPurgeError) throw err;
      throw new SnapshotPurgeError('In-process snapshot purge failed', {
        cause: err,
      });
    }
  }
}
