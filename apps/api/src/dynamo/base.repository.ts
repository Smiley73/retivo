// Shared DI/config base for the Dynamo repositories: each passes its TABLE_* env key to super(), and subclasses declare their own
// constructor because Nest reads injection metadata from the subclass.
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
