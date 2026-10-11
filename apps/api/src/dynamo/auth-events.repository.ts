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

/**
 * {@link AuthEventsRepository.listForUser} takes an OPTIONAL `opts.limit` —
 * used only by tests that need a small, deterministic page size to exercise
 * multi-page paging without seeding an unrealistic row count. The account
 * export itself passes no `limit`, so its
 * `QueryCommand` below carries no `Limit` at all and DynamoDB pages by its
 * own ~1 MB response-size cap instead — "few, large pages" through the
 * export-authorization cookie's 5-minute window. An earlier version of this
 * hard-capped every page at 1,000 rows regardless of caller; combined with
 * the route's 120/min throttle and the 5-minute cookie, that made a very
 * large retained history (reachable within the 1-year retention window, e.g.
 * via repeated `/auth/refresh` calls) mathematically impossible to export
 * before the cookie expired. `Scan` on this table is
 * deliberately withheld from the api role, so this Queries by the
 * `userId` PK — never a Scan. */

/** One page of a user's auth-event history, keyed off an opaque cursor. */
export interface AuthEventPage {
  items: AuthEventRow[];
  /** Opaque cursor for the next page, or `null` when this was the last page. */
  nextCursor: string | null;
}

/**
 * Thrown when a presented account-export history cursor is malformed OR carries a `userId` that
 * does not match the authenticated caller. Decoding never trusts a client-supplied key outright:
 * the cursor is re-asserted to belong to the calling user before it is used as a DynamoDB
 * `ExclusiveStartKey`, so a forged/foreign cursor can never page through another user's history.
 * The controller maps this to `400`.
 */
export class InvalidAccountExportCursorError extends Error {
  constructor() {
    super('Invalid or expired account-export history cursor.');
    this.name = 'InvalidAccountExportCursorError';
  }
}

/** Encode a `{ userId, eventId }` DynamoDB key as an opaque cursor string. */
function encodeCursor(key: { userId: string; eventId: string }): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/**
 * Decode + validate a presented cursor against `expectedUserId`. Returns
 * `undefined` for an absent cursor (first page). Throws
 * {@link InvalidAccountExportCursorError} for anything malformed or whose
 * embedded `userId` disagrees with the caller — never trusts the raw value.
 */
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
  /**
   * Deployment stack (`local` when unset). Drives
   * the event-time metric emission policy in `mapAuthEventToMetrics` — no
   * metrics are emitted for a `local`/unset stack.
   */
  private readonly stack: string;

  constructor(
    @Inject(DYNAMO_DOC_CLIENT) doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
  ) {
    super(doc, config, 'TABLE_AUTH_EVENT');
    this.stack = config.get('STACK', { infer: true }) ?? 'local';
  }

  /**
   * Fire-and-forget audit append. Audit failures must never
   * break an auth flow; we log and swallow.
   */
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
      // Emit event-time EMF metrics ONLY after the durable audit write has
      // succeeded, so a metric can never fire for an event that was not
      // actually recorded. Mapping + prod/dev/local policy live in
      // `mapAuthEventToMetrics`; a failed emit is non-fatal (the writer
      // swallows it) and never carries PII.
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
   * Paged read of a user's WHOLE retained sign-in and security history (no window, unlike
   * {@link FailedLoginAttemptRow}'s
   * 24-hour backoff state). Queries by the `userId` PK — `Scan` on this table is
   * deliberately withheld from the api role; this repository never adds
   * it. `cursor` is the opaque value {@link AuthEventPage.nextCursor} returned by
   * the prior call; a presented cursor is re-validated to belong to `userId`
   * before use (never trusted outright) — see {@link InvalidAccountExportCursorError}.
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
        // Omitted entirely (`undefined`) unless a caller opts into an
        // explicit cap — DynamoDB then pages by its own ~1 MB response-size
        // limit instead of an artificial row count (see this
        // method's doc comment above).
        Limit: opts.limit,
        // Strongly consistent: the account export writes a
        // `refresh` and then a `data_export` AuthEvent immediately before
        // fetching this history's first page. An eventually consistent read
        // could still be racing that replica lag and silently omit either
        // just-committed row while still reporting `nextCursor: null`,
        // contradicting the whole-retained-history contract this endpoint
        // promises. Every page of the export's history read pays this cost.
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
