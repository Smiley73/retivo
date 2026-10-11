/**
 * Shared DI/config boilerplate for the Dynamo repository classes.
 *
 * Each concrete repo passes its TABLE_* env key to `super()` so the
 * resolved table name lives at `this.tableName` and `this.doc` is the
 * shared `DynamoDBDocumentClient`. Subclasses declare their own
 * constructor (Nest reads injection metadata from the subclass) and
 * forward the two injected args plus the table key.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EnvConfig } from '../common/env.config.js';

@Injectable()
export abstract class BaseRepository {
  protected readonly tableName: string;

  constructor(
    protected readonly doc: DynamoDBDocumentClient,
    config: ConfigService<EnvConfig, true>,
    tableNameKey: keyof EnvConfig,
  ) {
    this.tableName = config.get(tableNameKey, { infer: true });
  }
}
