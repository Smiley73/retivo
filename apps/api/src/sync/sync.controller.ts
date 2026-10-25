// Sync HTTP layer: push, pull, bootstrap, snapshots, restore and workspace clear (docs/architecture.md, "Sync").
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
      throw new ForbiddenException({
        code: 'DEVICE_MISMATCH',
        message: 'Body deviceId does not match the JWT claim.',
      });
    }
    // Manual rather than PushMutationDto decorators: timestamp and schemaVersion violations need their own wire codes so the client
    // parks the batch; neither clears by retry. A mixed-device batch is a client bug and fails whole before any DB work.
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
    // Validated manually: FreshnessHeadDto has no decorators, so the global ValidationPipe cannot pre-empt FRESHNESS_HEAD_INVALID.
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
    return this.bootstrap.bootstrap(me.householdId, force === 'true');
  }

  @Get('snapshots')
  @Throttle({ default: { ttl: 3_600_000, limit: 30 } })
  async listSnapshots(@CurrentUser() me: AccessTokenClaims) {
    // Throttled like bootstrap: snapshot metadata reveals activity cadence, so cheap enumeration must be blocked.
    return this.snapshots.list(me.householdId);
  }

  @Post('restore')
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  async restoreSnapshot(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: RestoreDto,
  ) {
    // Destructive, so a tighter throttle than bootstrap. The household comes from the JWT claim and the snapshot key is built from it,
    // so a foreign snapshotId 404s.
    return this.restore.restore(me.householdId, dto.snapshotId);
  }

  @Post('workspace/clear')
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  async clearWorkspace(
    @CurrentUser() me: AccessTokenClaims,
    @Body() dto: ClearWorkspaceDto,
    @Req() req: Request,
  ): Promise<{ ok: true; historyErased: boolean }> {
    // The DTO carries no householdId, so a body field can never widen the clear to another household.
    const ip = req.ip ?? null;
    const userAgent =
      (req.headers['user-agent'] as string | undefined) ?? null;
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

// Exactly 43 base64url characters without padding: the wire form of a 32-byte HMAC.
const CURSOR_TAG_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Manual so the global ValidationPipe never pre-empts FRESHNESS_HEAD_INVALID, the code the client keys on to park the batch.
// `value` is unknown so a bare primitive reaches this check untouched by the pipe.
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
  // express.json already caps the body at 5 MB; this is a second check in case that limit is lifted.
  const contentLength = Number(req.headers['content-length'] ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    throw new BadRequestException({
      code: 'REQUEST_TOO_LARGE',
      message: `Request body exceeds 5 MB.`,
    });
  }
}
