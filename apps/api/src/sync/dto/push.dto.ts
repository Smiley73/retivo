import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { MAX_PUSH_MUTATIONS, OPERATIONS, type SyncOperation } from '@retirement/contracts';
import { ACTIVE_AGGREGATE_TYPES_LIST } from '../aggregate-types.js';

@ValidatorConstraint({ name: 'createRequiresVersionZero', async: false })
class CreateRequiresVersionZeroConstraint
  implements ValidatorConstraintInterface
{
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as PushMutationDto;
    if (obj.operation !== 'create') return true;
    return obj.version === 0;
  }

  defaultMessage(): string {
    return "Mutation with operation 'create' must carry version 0.";
  }
}

/**
 * Upper bound for `schemaVersion`: the highest `current` version in `apps/web/src/db/migrations.ts`'s REGISTRY, plus one.
 * The `+1` is deliberate: `ALLOW_SCHEMA_AHEAD=1` deploys a bundle carrying the next schema version for one aggregate,
 * and a push from that bundle must not be rejected here.
 * `scripts/check-schema-version-ceiling.mjs` fails when this number stops matching the REGISTRY maximum + 1.
 */
export const SCHEMA_VERSION_CEILING = 10;

/** Tolerable future clock skew for a mutation `timestamp`: a far-future value makes `PullService.toPulled` throw RangeError and 500 every pull. */
export const TIMESTAMP_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** How far into the past a `timestamp` may sit: generous, because an offline device must still flush weeks of queued edits. */
export const TIMESTAMP_MAX_PAST_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Whether `timestamp` is within the server-time window. Enforced manually in `sync.controller.ts` rather than by a
 * decorator, so a violation carries its own TIMESTAMP_OUT_OF_SERVER_WINDOW code and rejects the batch without clamping.
 */
export function isTimestampWithinServerWindow(value: number): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const now = Date.now();
  return (
    value <= now + TIMESTAMP_MAX_FUTURE_SKEW_MS &&
    value >= now - TIMESTAMP_MAX_PAST_WINDOW_MS
  );
}

export class PushMutationDto {
  @IsUUID()
  id!: string;

  @IsString()
  @MaxLength(80)
  aggregateId!: string;

  @IsIn(ACTIVE_AGGREGATE_TYPES_LIST as readonly string[])
  aggregateType!: string;

  @IsIn(OPERATIONS)
  operation!: SyncOperation;

  @IsInt()
  @Min(0)
  @Validate(CreateRequiresVersionZeroConstraint)
  version!: number;

  // Not a `@Max` decorator: SCHEMA_VERSION_TOO_NEW is thrown manually in `sync.controller.ts` so the client can park the batch.
  @IsInt()
  @Min(1)
  schemaVersion!: number;

  @IsObject()
  payload!: Record<string, unknown>;

  @IsNumber()
  @Min(0)
  timestamp!: number;

  @IsUUID()
  deviceId!: string;
}

/**
 * Client-owned freshness head; the server stores both fields opaquely and never verifies the MAC.
 * Deliberately decorator-free so the global ValidationPipe cannot pre-empt FRESHNESS_HEAD_INVALID; `sync.controller.ts` validates it.
 */
export class FreshnessHeadDto {
  freshnessCounter!: number;
  cursorTag!: string;
}

export class PushDto {
  @IsUUID()
  deviceId!: string;

  @IsString()
  @MaxLength(80)
  householdId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PUSH_MUTATIONS)
  @ValidateNested({ each: true })
  @Type(() => PushMutationDto)
  mutations!: PushMutationDto[];

  // `unknown` and not `@ValidateNested()`, so every value, even a bare primitive, reaches the controller's manual validation.
  @IsOptional()
  freshnessHead?: unknown;
}
