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
 * Upper bound for `schemaVersion`. Must equal the HIGHEST `current`
 * version across every aggregate in `apps/web/src/db/migrations.ts`'s `REGISTRY`, PLUS ONE. The
 * `+1` is not decorative slack: `ALLOW_SCHEMA_AHEAD=1` legitimately deploys a bundle carrying the
 * NEXT schema version for one aggregate (`scripts/check-schema-not-ahead.mjs` documents the
 * 2026-08-04 dev incident that produced that override) — a push from that bundle must not be
 * rejected here.
 *
 * This is a hand-written constant, not an import: the API cannot import
 * `migrations.ts` (a web-only file), and the API and SPA are built and
 * shipped by the same `deploy-stack.sh` run, so a repo-level constant here
 * cannot drift from the web bundle in a normal deploy. What CAN drift is
 * this constant itself falling behind a REGISTRY bump — that is caught by
 * `scripts/check-schema-version-ceiling.mjs` (run by `pnpm test:scripts`),
 * which parses the REGISTRY block directly and fails when this number no
 * longer equals its maximum + 1. Update BOTH in the same change.
 */
export const SCHEMA_VERSION_CEILING = 10;

/**
 * Tolerable FUTURE clock skew for a mutation `timestamp`. Tight —
 * on purpose: the crash vector is entirely on the far-future side
 * (`PullService.toPulled`'s `new Date(row.timestamp).toISOString()` throws
 * `RangeError` for a value outside JavaScript's representable date range,
 * and once such a row lands, every subsequent pull/bootstrap for that
 * household 500s forever). A device that is minutes ahead is a misconfigured
 * clock, not a legitimate offline gap.
 */
export const TIMESTAMP_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * How far into the PAST a mutation `timestamp` may sit. Generous —
 * on purpose, and for the opposite reason: there is no crash vector on this
 * side (any past millisecond is a valid `Date`), but an offline device that
 * queues edits for weeks before reconnecting must still be able to flush
 * them. A tight past bound would silently destroy that device's queue — a
 * data-loss regression worse than the crash the future-skew bound prevents.
 */
export const TIMESTAMP_MAX_PAST_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * `timestamp` is bound relative to SERVER time. Unlike the other
 * `PushMutationDto` field bounds this is deliberately NOT a class-validator
 * decorator: a violation needs its OWN wire code so the client
 * (`SyncContext.tsx`, `PERMANENT_PUSH_REJECTION_CODES`) can park the batch
 * on purpose, rather than surfacing as the generic `ValidationPipe`
 * `BAD_REQUEST` the client does not park. Parking is the right outcome —
 * a queued mutation's `timestamp` is frozen at enqueue time and never
 * re-stamped, so a rejected batch cannot clear by retry: a stamp behind the
 * past window only drifts further behind, and a far-future one would sit
 * out the whole skew. `sync.controller.ts` calls this directly, before any
 * write, and throws `TIMESTAMP_OUT_OF_SERVER_WINDOW`. Never clamps or
 * rewrites the value — a violation rejects the whole batch, it never
 * silently substitutes server time.
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

  @IsIn(['create', 'update', 'delete'])
  operation!: 'create' | 'update' | 'delete';

  @IsInt()
  @Min(0)
  @Validate(CreateRequiresVersionZeroConstraint)
  version!: number;

  // The SCHEMA_VERSION_CEILING check is NOT a `@Max` decorator here — see
  // `isTimestampWithinServerWindow`'s comment above: like the timestamp
  // bound it is enforced manually, in `sync.controller.ts`, with its own
  // `SCHEMA_VERSION_TOO_NEW` code so the client can park it (it needs a
  // newer app build to ever clear).
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
 * Client-owned freshness head. The server
 * persists both fields opaquely on `WorkspaceMeta` and NEVER verifies the MAC
 * (it holds no household data key). `cursorTag` is
 * `HMAC(HKDF(HDK,"cursor-auth"), canonical(freshnessCounter))` — a 32-byte HMAC
 * rendered as 43 unpadded base64url characters.
 *
 * Deliberately carries ZERO class-validator decorators.
 * All freshness-head validation —
 * shape, exact bounds, AND non-object primitives — is performed manually in
 * `sync.controller.ts` so the global `ValidationPipe` can never pre-empt the
 * custom `FRESHNESS_HEAD_INVALID` discriminator with its generic default-error
 * body. `PushDto.freshnessHead` is `unknown` (not `@ValidateNested()`) precisely
 * so class-validator's nested-validation executor never runs against it — a
 * hand-crafted primitive value reaches the controller untouched. The fields'
 * TypeScript types remain only for the controller's own compile-time narrowing.
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
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PushMutationDto)
  mutations!: PushMutationDto[];

  // `unknown`, and intentionally NOT `@ValidateNested()`/`@Type()`: the
  // global pipe must not touch this so EVERY possible value — well-formed
  // object, malformed object, or bare primitive — reaches `sync.controller.ts`
  // for the single manual validation path that throws `FRESHNESS_HEAD_INVALID`.
  @IsOptional()
  freshnessHead?: unknown;
}
