/**
 * Snapshot-purge invoker for the `DELETE /auth/account` cascade.
 *
 * On a deployed stack (SNAPSHOT_PURGE_FUNCTION_NAME set) this invokes the
 * dedicated least-privilege snapshot-purge Lambda synchronously
 * (RequestResponse) so the api role no longer needs bucket-wide
 * s3:DeleteObject. A
 * non-2xx status code or a `FunctionError` payload is surfaced as a
 * thrown SnapshotPurgeError so the caller fails the deletion request
 * before any irreversible DynamoDB / auth-state sweep (purge-first
 * ordering).
 *
 * In local / emulator runtime (function name unset) it runs the same S3
 * list+delete in-process so `pnpm dev` and the emulator test suite don't
 * require a deployed Lambda. The invocation payload carries ONLY the
 * household id (+ an optional keep-key list) — no email, token, password,
 * or other PII.
 *
 * Optional keep-key mode: the
 * erase-history workspace clear passes `{ keepKeys }` so the just-minted
 * live empty snapshot is EXCLUDED from the delete — otherwise the purge
 * would delete the very object `WorkspaceMeta` was just repointed at,
 * re-creating the dangling pointer purge-last exists to avoid. When
 * `keepKeys` is absent/empty the behaviour is UNCHANGED (delete every
 * `${householdId}/` object), so delete-account + encrypted-reset are
 * untouched. IAM is unchanged — same `s3:DeleteObject` on the prefix; the
 * keep-key is only a delete-list filter.
 */
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

/** Thrown when the snapshot purge fails; the caller aborts the deletion. */
export class SnapshotPurgeError extends Error {
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
   * Delete every snapshot under `${householdId}/`, EXCLUDING any
   * `opts.keepKeys` (the keep-key mode used by the erase-history workspace
   * clear). Throws SnapshotPurgeError on any failure so a caller that
   * needs purge-first ordering (delete-account) aborts before touching
   * DynamoDB / auth state. When `keepKeys` is absent/empty the behaviour is
   * unchanged (delete everything under the prefix).
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
    // Local / emulator fallback — no deployed Lambda to call.
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
          // Include `keepKeys` ONLY when non-empty so the delete-account /
          // encrypted-reset payload stays exactly `{ householdId }`
          // (unchanged); the erase-history clear adds the keep list.
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
    // A delivery-level non-2xx (throttling, permissions) or a handler
    // exception (FunctionError) both mean the snapshots may not be gone.
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
          // Keep-key mode: never delete a preserved object (the live
          // empty snapshot the workspace clear just repointed to).
          .filter((k) => !keep.has(k));
        for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
          const slice = keys.slice(i, i + DELETE_BATCH_SIZE);
          const out = await this.s3.send(
            new DeleteObjectsCommand({
              Bucket: this.snapshotsBucket,
              Delete: { Objects: slice.map((Key) => ({ Key })), Quiet: true },
            }),
          );
          // DeleteObjects returns HTTP 200 with a per-object Errors[] on
          // partial failure. Treat any error as a purge failure so the
          // deletion cascade aborts before the irreversible sweeps —
          // never report success with orphaned snapshots left behind.
          // No object keys in the message (no PII / no key leakage).
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
      // Already a typed purge failure (e.g. a partial-delete Errors[]
      // thrown above) → surface it as-is; don't double-wrap.
      if (err instanceof SnapshotPurgeError) throw err;
      throw new SnapshotPurgeError('In-process snapshot purge failed', {
        cause: err,
      });
    }
  }
}
