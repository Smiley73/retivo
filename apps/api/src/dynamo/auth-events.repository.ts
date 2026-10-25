import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import KSUID from 'ksuid';
import { DYNAMO_DOC_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import {
  emitOperationalMetric,
  mapAuthEventToMetrics,
} from '../common/operational-metrics.js';
import { BaseRepository } from './base.repository.js';
import type { AuthEventRow, AuthEventType } from './types.js';

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** One page of a user's auth-event history, keyed off an opaque cursor. */
export interface AuthEventPage {
  items: AuthEventRow[];
  /** Opaque cursor for the next page, or `null` when this was the last page. */
  nextCursor: string | null;
}

/**
 * Thrown when an account-export history cursor is malformed or carries a `userId` other than the caller. The cursor
 * is re-asserted to belong to the caller before use as an `ExclusiveStartKey`, so a forged cursor cannot page through
 * another user history. The controller maps it to 400.
 */
export class InvalidAccountExportCursorError extends Error {
  constructor() {
    super('Invalid or expired account-export history cursor.');
    this.name = 'InvalidAccountExportCursorError';
  }
}

// Encode a `{ userId, eventId }` DynamoDB key as an opaque cursor string.
function encodeCursor(key: { userId: string; eventId: string }): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

// Decodes a cursor against `expectedUserId`; undefined for an absent cursor, throws InvalidAccountExportCursorError
// for anything malformed or foreign.
function decodeCursor(
  cursor: string | null | undefined,
  expectedUserId: string,
): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidAccountExportCursorError();
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Record<string, unknown>).userId !== expectedUserId ||
    typeof (parsed as Record<string, unknown>).eventId !== 'string'
  ) {
    throw new InvalidAccountExportCursorError();
  }
  return parsed as Record<string, unknown>;
}

@Injectable()
export class AuthEventsRepository extends BaseRepository {
  private readonly logger = new Logger(AuthEventsRepository.name);
  // Deployment stack (`local` when unset); drives the metric emission policy in `mapAuthEventToMetrics`.
  private readonly stack: string;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_AUTH_EVENT');
    this.stack = config.get('STACK', { infer: true }) ?? 'local';
  }

  /** Fire-and-forget audit append: failures are logged and swallowed, never breaking an auth flow. */
  async record(args: {
    userId: string;
    eventType: AuthEventType;
    ip?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    try {
      const eventId = (await KSUID.random()).string;
      const now = new Date();
      const row: AuthEventRow = {
        userId: args.userId,
        eventId,
        eventType: args.eventType,
        ip: args.ip ?? null,
        userAgent: args.userAgent ?? null,
        metadata: args.metadata ?? null,
        createdAt: now.toISOString(),
        expiresAt: Math.floor(now.getTime() / 1000) + ONE_YEAR_SECONDS,
      };
      await this.doc.send(
        new PutCommand({ TableName: this.tableName, Item: row }),
      );
      // Emit metrics only after the durable write succeeded, so a metric never fires for an unrecorded event. A
      // failed emit is non-fatal and carries no PII.
      for (const metric of mapAuthEventToMetrics(args.eventType, this.stack)) {
        emitOperationalMetric(metric);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to record auth event ${args.eventType} for ${args.userId}: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  /**
   * Pages a user whole retained history by the `userId` PK (Scan is withheld from the api role). `limit` is for tests
   * only: the export passes none, so DynamoDB pages by its ~1 MB cap and a very large history can finish inside the
   * export cookie 5-minute window. A presented cursor is re-validated against `userId`.
   */
  async listForUser(
    userId: string,
    opts: { cursor?: string | null; limit?: number } = {},
  ): Promise<AuthEventPage> {
    const exclusiveStartKey = decodeCursor(opts.cursor, userId);
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ExclusiveStartKey: exclusiveStartKey,
        // Omitted unless a caller opts in, so DynamoDB pages by its ~1 MB cap instead of an artificial row count.
        Limit: opts.limit,
        // Strongly consistent: the export writes `refresh` and `data_export` events just before this read, and a stale
        // replica could omit them while reporting `nextCursor: null`.
        ConsistentRead: true,
      }),
    );
    const items = (r.Items as AuthEventRow[] | undefined) ?? [];
    const lastKey = r.LastEvaluatedKey as
      | { userId: string; eventId: string }
      | undefined;
    return {
      items,
      nextCursor: lastKey ? encodeCursor(lastKey) : null,
    };
  }
}
