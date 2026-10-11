/**
 * Sync HTTP layer (docs/architecture.md, "Sync"). Endpoints:
 *   POST /api/v1/sync/push
 *   GET  /api/v1/sync/pull?since=<cursor>
 *   GET  /api/v1/sync/bootstrap?force=true|false
 *   GET  /api/v1/sync/snapshots
 *   POST /api/v1/sync/restore
 *   POST /api/v1/sync/workspace/clear
 *
 * All require: JwtAuthGuard, household-claim equality, CSRF + Origin
 * (the latter two are enforced by the global middlewares).
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AccessTokenClaims } from '../auth/jwt.service.js';
import { DEVICE_TRUST_COOKIE_NAME } from '../auth/cookie-config.js';
import { parseCookies } from '../auth/session-authority.js';
import { ClearWorkspaceDto } from './dto/clear-workspace.dto.js';
import {
  FreshnessHeadDto,
  isTimestampWithinServerWindow,
  PushDto,
  SCHEMA_VERSION_CEILING,
  TIMESTAMP_MAX_FUTURE_SKEW_MS,
  TIMESTAMP_MAX_PAST_WINDOW_MS,
} from './dto/push.dto.js';
import { RestoreDto } from './dto/restore.dto.js';
import { PushService } from './push.service.js';
import { PullService } from './pull.service.js';
import { BootstrapService } from './bootstrap.service.js';
import { SnapshotsService } from './snapshots.service.js';
import { RestoreService } from './restore.service.js';
import { ClearWorkspaceService } from './clear-workspace.service.js';

@Controller('sync')
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(
    private readonly push: PushService,
    private readonly pull: PullService,
    private readonly bootstrap: BootstrapService,
    private readonly snapshots: SnapshotsService,
    private readonly restore: RestoreService,
    private readonly clearWorkspaceService: ClearWorkspaceService,
  ) {}

  @Post('push')
  @Throttle({ default: { ttl: 60_000, limit: 300 } })
  async pushMutations(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: PushDto,
    @Req() req: Request,
  ) {
    assertHousehold(me, dto.householdId);
    if (dto.deviceId !== me.deviceId) {
      // Not strictly required, but enforces the deviceId
      // claim's intent — a JWT issued for device A cannot be paired
      // with mutations claiming device B.
      throw new ForbiddenException({
        code: 'DEVICE_MISMATCH',
        message: 'Body deviceId does not match the JWT claim.',
      });
    }
    // Inner-mutation deviceId provenance: each mutation must self-tag
    // with the same device the JWT was issued for. A mixed-device batch
    // is a client bug, not a recoverable per-mutation conflict — fail
    // the whole batch before any DB work runs.
    //
    // The `timestamp` / `schemaVersion` ingress bounds are checked here too, manually, rather than
    // as `PushMutationDto` class-validator decorators (mirrors the freshnessHead pattern below):
    // each needs its OWN wire code, not the generic `ValidationPipe` `BAD_REQUEST`, so the client
    // (`SyncContext.tsx`, `PERMANENT_PUSH_REJECTION_CODES`) can park the batch instead of retrying
    // it forever. Neither can clear by retry: `SCHEMA_VERSION_TOO_NEW` needs a newer app build, and
    // `TIMESTAMP_OUT_OF_SERVER_WINDOW` is stamped on a value the client froze at enqueue time and
    // never re-stamps (a past-window stamp only drifts further out).
    for (const m of dto.mutations) {
      if (m.deviceId !== me.deviceId) {
        throw new ForbiddenException({
          code: 'INNER_DEVICE_MISMATCH',
          message: 'Mutation deviceId does not match the authenticated device.',
          details: {
            mutationId: m.id,
            expected: me.deviceId,
            got: m.deviceId,
          },
        });
      }
      if (!isTimestampWithinServerWindow(m.timestamp)) {
        throw new BadRequestException({
          code: 'TIMESTAMP_OUT_OF_SERVER_WINDOW',
          message:
            `Mutation timestamp must be within ${TIMESTAMP_MAX_FUTURE_SKEW_MS}ms of server time ` +
            `in the future and ${TIMESTAMP_MAX_PAST_WINDOW_MS}ms in the past.`,
          details: { mutationId: m.id },
        });
      }
      if (m.schemaVersion > SCHEMA_VERSION_CEILING) {
        throw new BadRequestException({
          code: 'SCHEMA_VERSION_TOO_NEW',
          message: `Mutation schemaVersion exceeds the server's supported ceiling (${SCHEMA_VERSION_CEILING}).`,
          details: { mutationId: m.id, schemaVersion: m.schemaVersion },
        });
      }
    }
    enforceTotalSize(req);
    // Optional zero-knowledge freshness head. When present (any
    // non-undefined value), validate it here — NOT via the DTO's class-validator
    // decorators, which are deliberately absent so the global
    // ValidationPipe can never pre-empt the `FRESHNESS_HEAD_INVALID`
    // discriminator. A malformed/oversized head fails the whole push (400, zero
    // mutations committed); only a buggy or untrusted client ever sends one. The
    // service then persists the validated head opaquely + echoes the stored
    // head. Undefined on the plaintext path.
    const freshnessHead =
      dto.freshnessHead === undefined
        ? undefined
        : validateFreshnessHead(dto.freshnessHead);
    return this.push.push({
      householdId: me.householdId, // authoritative claim
      deviceId: me.deviceId,
      mutations: dto.mutations,
      freshnessHead,
    });
  }

  @Get('pull')
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  async pullChanges(
    @CurrentUser() me: AccessTokenClaims,
    @Query('since') since: string,
  ) {
    if (!since || typeof since !== 'string') {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: '`since` query parameter is required.',
      });
    }
    return this.pull.pull(me.householdId, since);
  }

  @Get('bootstrap')
  @Throttle({ default: { ttl: 3_600_000, limit: 30 } })
  async bootstrapWorkspace(
    @CurrentUser() me: AccessTokenClaims,
    @Query('force') force: string,
  ) {
    // `force=true` is a client-initiated full re-bootstrap (the SPA's
    // "reset local cache" recovery path). The flag does not change the
    // response shape; it is forwarded so BootstrapService can emit the
    // structured log line the forced-bootstrap CloudWatch metric filter
    // matches on.
    return this.bootstrap.bootstrap(me.householdId, force === 'true');
  }

  @Get('snapshots')
  @Throttle({ default: { ttl: 3_600_000, limit: 30 } })
  async listSnapshots(@CurrentUser() me: AccessTokenClaims) {
    // Household-isolated by the JWT claim: SnapshotsService keys S3 by
    // the `${householdId}/` prefix, so a caller only ever sees their own
    // snapshots. Throttled like bootstrap (30/hr) — snapshot metadata
    // reveals activity cadence, so cheap enumeration must be blocked.
    return this.snapshots.list(me.householdId);
  }

  @Post('restore')
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  async restoreSnapshot(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: RestoreDto,
  ) {
    // Destructive sync-state reset → tighter throttle (5/hr) than
    // bootstrap. CSRF + Origin enforced by the global middlewares.
    // Household authority is the JWT claim; the snapshot key is built
    // from it, so a foreign snapshotId 404s rather than crossing
    // households.
    return this.restore.restore(me.householdId, dto.snapshotId);
  }

  @Post('workspace/clear')
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  async clearWorkspace(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: ClearWorkspaceDto,
    @Req() req: Request,
  ): Promise<{ ok: true; historyErased: boolean }> {
    // Server-authoritative "Delete workspace data". CSRF + Origin
    // enforced by the global middlewares; destructive → tight 5/hr throttle
    // like restore. Household authority is the JWT claim — the DTO
    // carries no householdId, so a body field can never widen the clear. The
    // whole use case (password re-verify + backoff + audit sequencing +
    // sweep/mint/repoint/purge dispatch) lives in ClearWorkspaceService so the
    // auth-service coupling stays out of the delivery layer.
    const ip = req.ip ?? null;
    const userAgent =
      (req.headers['user-agent'] as string | undefined) ?? null;
    // Device identity: a trusted device's cookie
    // bypasses the backoff here too, inherited from the shared primitive.
    const cookies = parseCookies(req.headers.cookie ?? '');
    return this.clearWorkspaceService.clearWorkspace(
      me,
      dto,
      ip,
      userAgent,
      cookies[DEVICE_TRUST_COOKIE_NAME],
    );
  }
}

function assertHousehold(me: AccessTokenClaims, bodyHouseholdId: string): void {
  if (me.householdId !== bodyHouseholdId) {
    throw new ForbiddenException({
      code: 'HOUSEHOLD_MISMATCH',
      message:
        'Body householdId does not match the authenticated user\'s household.',
    });
  }
}

/**
 * Exactly 43 base64url characters (no padding) — the wire form of a 32-byte
 * HMAC. Anchored so a 42/44-char, padded (`=`), or non-base64url value is
 * rejected.
 */
const CURSOR_TAG_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Manual, exhaustive freshness-head validation. Runs entirely here rather than on
 * `FreshnessHeadDto`'s decorators so the global `ValidationPipe` never pre-empts the
 * `FRESHNESS_HEAD_INVALID` discriminator — the client's push-catch branch keys on that exact code
 * to park the batch `failed-error` instead of retrying it forever. Throws a `400 {code:
 * 'FRESHNESS_HEAD_INVALID', message}` on ANY violation, including a non-object primitive (`value`
 * is typed `unknown` precisely so a bare string / number reaches this check untouched by the pipe).
 * Deliberately overrides the general "freshness head never blocks a push" invariant for this one
 * field.
 */
function validateFreshnessHead(value: unknown): FreshnessHeadDto {
  const reject = (message: string): never => {
    throw new BadRequestException({ code: 'FRESHNESS_HEAD_INVALID', message });
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reject('freshnessHead must be an object with freshnessCounter and cursorTag.');
  }
  const { freshnessCounter, cursorTag } = value as Record<string, unknown>;
  if (
    typeof freshnessCounter !== 'number' ||
    !Number.isInteger(freshnessCounter) ||
    freshnessCounter < 1 ||
    freshnessCounter > Number.MAX_SAFE_INTEGER
  ) {
    reject('freshnessHead.freshnessCounter must be an integer between 1 and Number.MAX_SAFE_INTEGER.');
  }
  if (typeof cursorTag !== 'string' || !CURSOR_TAG_PATTERN.test(cursorTag)) {
    reject('freshnessHead.cursorTag must be exactly 43 base64url characters.');
  }
  return {
    freshnessCounter: freshnessCounter as number,
    cursorTag: cursorTag as string,
  };
}

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
function enforceTotalSize(req: Request): void {
  // express.json already enforces the global 5 MB cap, so this is just
  // a belt-and-braces check in case the limit is lifted upstream.
  const contentLength = Number(req.headers['content-length'] ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    throw new BadRequestException({
      code: 'REQUEST_TOO_LARGE',
      message: `Request body exceeds 5 MB.`,
    });
  }
}
