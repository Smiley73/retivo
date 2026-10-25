// HTTP layer for zero-knowledge household key envelopes: list, activate, upsert and delete slots. The server stores wrapped key
// material opaquely and only enforces a monotonic `envelopeSetVersion`.
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Param,
  type PipeTransform,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import type { AccessTokenClaims } from './jwt.service.js';
import {
  ActivateKeyEnvelopesDto,
  DeleteKeyEnvelopeMetaDto,
  UpsertKeyEnvelopeDto,
} from './dto/auth.dto.js';
import { assertSingleVersionStep } from './envelope-version-guard.js';
import {
  EnvelopeReadConflictError,
  EnvelopeTransactionConflictError,
  HouseholdKeyEnvelopesRepository,
  SessionCredentialStaleError,
  StaleEnvelopeVersionError,
} from '../dynamo/household-key-envelopes.repository.js';
import { CredentialsRepository } from '../dynamo/credentials.repository.js';
import { RefreshTokensRepository } from '../dynamo/refresh-tokens.repository.js';
import { resolveSessionCredentialRevision } from './session-authority.js';
import { buildKeyEnvelopeSlotRow } from './key-envelope-row.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import {
  ENVELOPE_META_SLOT_ID,
  isArchiveSlotId,
  PASSWORD_SLOT_ID,
  resolveCredentialRevision,
} from '../dynamo/types.js';
import type { HouseholdKeyEnvelopeRow } from '../dynamo/types.js';
import type { EnvConfig } from '../common/env.config.js';
import { StepUpService, type StepUpMethod } from './step-up.service.js';
import { VerifyPasswordService } from './verify-password.service.js';
import {
  resolveEnvelopeWriteExemption,
  type EnvelopeStepUpBranch,
} from './key-envelope-step-up.js';

interface ListEnvelopesResponse {
  slots: HouseholdKeyEnvelopeRow[];
  envelopeSetVersion: number;
  envelopeSetTag: string;
  /**
   * The account credential current revision, read fresh on every call. The client compares it with a `password` slot
   * `credentialRevision` to decide whether a re-wrap is owed; resolved like the write path
   * (`resolveCredentialRevision`), so a legacy row reads the same sentinel as the write ConditionCheck.
   */
  currentCredentialRevision: string;
}

// Upper bound on a client-chosen `:slotId`; matches the DTO cap.
const MAX_SLOT_ID_LEN = 64;

// Validates a client-chosen slot id (a DynamoDB sort key) before any read or write, shared by `SlotIdValidationPipe`
// and `activate` so the two routes cannot drift. Rejects the reserved `ENVELOPE_META` sentinel and the archive
// namespace (a client write there would corrupt or spoof the integrity meta or an archived version), blank ids, and
// over-long ids, with 400 INVALID_SLOT_ID.
function assertValidSlotId(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException({
      code: 'INVALID_SLOT_ID',
      message: 'Slot id must be a non-empty value.',
    });
  }
  if (value.length > MAX_SLOT_ID_LEN) {
    throw new BadRequestException({
      code: 'INVALID_SLOT_ID',
      message: `Slot id must be at most ${MAX_SLOT_ID_LEN} characters.`,
    });
  }
  if (value === ENVELOPE_META_SLOT_ID || isArchiveSlotId(value)) {
    throw new BadRequestException({
      code: 'INVALID_SLOT_ID',
      message: 'Slot id is reserved.',
    });
  }
}

// Validates the `:slotId` path parameter shared by `upsert` and `remove`.
@Injectable()
class SlotIdValidationPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    assertValidSlotId(value);
    return value;
  }
}

@Controller('auth')
@UseGuards(JwtAuthGuard)
export class KeyEnvelopeController {
  private readonly mfaEnforced: boolean;

  constructor(
    private readonly envelopes: HouseholdKeyEnvelopesRepository,
    private readonly auth: AuthEventsRepository,
    private readonly passkeys: PasskeysRepository,
    private readonly credentials: CredentialsRepository,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly stepUpSvc: StepUpService,
    private readonly verifyPasswordSvc: VerifyPasswordService,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.mfaEnforced = config.get('AUTH_MFA_ENFORCED', { infer: true }) === 'true';
  }

  /**
   * Returns the household slot collection and the integrity meta from a bracketed, strongly consistent read
   * (`getStableEnvelopeSet`), so it never returns a torn pair; if concurrent writes outlast the bounded retry it
   * surfaces 503 ENVELOPE_READ_CONFLICT. Read limit 20/min.
   */
  @Get('key-envelopes')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async list(
    @CurrentUser() me: AccessTokenClaims,
  ): Promise<ListEnvelopesResponse> {
    let slots: HouseholdKeyEnvelopeRow[];
    let meta: { envelopeSetVersion: number; envelopeSetTag: string } | null;
    try {
      ({ slots, meta } = await this.envelopes.getStableEnvelopeSet(me.householdId));
    } catch (err) {
      if (err instanceof EnvelopeReadConflictError) {
        throw new ServiceUnavailableException({
          code: 'ENVELOPE_READ_CONFLICT',
          message: 'Could not read the envelope set right now. Try again.',
        });
      }
      throw err;
    }
    // Read fresh and strongly consistent: a replica could show the pre-reset revision, which would falsely equal a
    // stale slot revision and suppress a re-wrap that is owed. A caller with no credential row resolves to the
    // legacy sentinel.
    const credential = await this.credentials.findByUserIdConsistent(me.userId);
    return {
      slots,
      envelopeSetVersion: meta?.envelopeSetVersion ?? 0,
      envelopeSetTag: meta?.envelopeSetTag ?? '',
      currentCredentialRevision: resolveCredentialRevision(credential),
    };
  }

  /**
   * Atomically activates the household entire initial slot set. First-time activation is the only proofless add the
   * step-up matrix allows, so it commits every slot, the meta bump and any meta-only-residue archive in one
   * transaction at a single version bump, never two PUTs with an exempt intermediate state. Refuses with 409
   * ENVELOPE_SET_NOT_EMPTY (distinct from STALE_ENVELOPE_VERSION) when a live slot exists. Emptiness is fenced by the
   * strongly consistent pre-read plus the conditional meta item in the same transaction (a concurrent write must move
   * `envelopeSetVersion` first), so a second read would add nothing. Empty means `existingSlots.length === 0`, never
   * derived from the version: a failed attempt can leave meta-only residue that must still activate at N + 1.
   */
  @Post('key-envelopes/activate')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(204)
  async activate(
    @CurrentUser() me: AccessTokenClaims,
    @Body() body: ActivateKeyEnvelopesDto,
    @Req() req: Request,
  ): Promise<void> {
    // Per-slot invariants as in `upsert`, before any read so a rejected slot touches nothing. Ids must be unique
    // across the body: two Puts on one item in a transaction make DynamoDB throw a ValidationException nothing
    // maps, so a client-controlled body must be a 400 here.
    const seenSlotIds = new Set<string>();
    for (const slot of body.slots) {
      assertValidSlotId(slot.slotId);
      if (seenSlotIds.has(slot.slotId)) {
        throw new BadRequestException({
          code: 'INVALID_SLOT_ID',
          message: 'Each slot id may appear only once in an activation.',
        });
      }
      seenSlotIds.add(slot.slotId);
      if (slot.slotType === 'passkey_prf' && slot.credentialBinding != null) {
        await this.assertCredentialBelongsToUser(me.userId, slot.credentialBinding);
      }
      if (slot.slotType === 'password' && slot.slotId !== PASSWORD_SLOT_ID) {
        throw new BadRequestException({
          code: 'INVALID_SLOT_ID',
          message: `A password-type slot must be written at the canonical "${PASSWORD_SLOT_ID}" id.`,
        });
      }
    }

    assertSingleVersionStep(body.expectedEnvelopeSetVersion, body.envelopeSetVersion);

    const { slots: existingSlots, meta: previousMeta } = await this.readEnvelopeWriteSnapshot(
      me.householdId,
      body.expectedEnvelopeSetVersion,
    );
    if (existingSlots.length > 0) {
      throw new ConflictException({
        code: 'ENVELOPE_SET_NOT_EMPTY',
        message: 'This household already holds a key-envelope slot; activation is for a genuinely empty set only.',
      });
    }

    // A password slot is stamped with the writing session recorded revision, asserted as a ConditionCheck in the
    // same transaction, as in `upsert`.
    const passwordSlot = body.slots.find((s) => s.slotType === 'password');
    const credentialRevision = passwordSlot
      ? await resolveSessionCredentialRevision(req, me.userId, me.jti, this.refreshTokens)
      : undefined;

    const rows = body.slots.map((slot) =>
      buildKeyEnvelopeSlotRow(
        me.householdId,
        slot.slotId,
        slot,
        slot.slotType === 'password' ? credentialRevision : undefined,
      ),
    );

    // Activation is always proofless (the `exempt-activation` branch), so no step-up gate here.
    await this.commitEnvelopeTransaction(() =>
      this.envelopes.transactActivateSlots({
        householdId: me.householdId,
        slots: rows,
        envelopeSetVersion: body.envelopeSetVersion,
        envelopeSetTag: body.envelopeSetTag,
        expectedVersion: body.expectedEnvelopeSetVersion,
        extraConditionItems:
          credentialRevision !== undefined
            ? [this.credentials.conditionCheckRevisionTransactItem(me.userId, credentialRevision)]
            : undefined,
        // Nothing at the slot level is displaced; a stale meta-only residue row still needs archiving.
        archive: { previousSlot: undefined, previousMeta, previousSlotIds: [] },
      }),
    );

    for (const slot of body.slots) {
      await this.auth.record({
        userId: me.userId,
        eventType: 'key_envelope_created',
        metadata: {
          householdId: me.householdId,
          slotId: slot.slotId,
          slotType: slot.slotType,
          envelopeSetVersion: body.envelopeSetVersion,
          stepUp: 'exempt-activation',
        },
      });
    }
  }

  /**
   * Upserts a slot; `wrappedKey` and `envelopeSetTag` are stored verbatim under a monotonic-version guard (409
   * STALE_ENVELOPE_VERSION). The body householdId is overridden by the JWT household. Write limit 5/min. A write into
   * a household that already holds a slot (DELETE, replacing a slot other than an owed password re-wrap, or a new
   * slot id) demands a fresh step-up proof before anything is read or committed: see `resolveEnvelopeWriteExemption`
   * and `enforceEnvelopeStepUp`, which also require the account password for a `passkey_prf` slot.
   */
  @Put('key-envelopes/:slotId')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(204)
  async upsert(
    @CurrentUser() me: AccessTokenClaims,
    @Param('slotId', SlotIdValidationPipe) slotId: string,
    @Body() body: UpsertKeyEnvelopeDto,
    @Req() req: Request,
  ): Promise<void> {
    // A `passkey_prf` slot binds the wrap to a WebAuthn credential; verify it belongs to the caller (the Passkey
    // table is user-keyed) so a slot cannot bind another account credential. A missing one is 422
    // CREDENTIAL_NOT_FOUND, before any write.
    if (
      body.slot.slotType === 'passkey_prf' &&
      body.slot.credentialBinding != null
    ) {
      await this.assertCredentialBelongsToUser(me.userId, body.slot.credentialBinding);
    }

    // A `password` write may only target the literal `password` id, which turns "no password slot" into a single
    // absence condition; a non-canonical id is refused, never moved.
    if (body.slot.slotType === 'password' && slotId !== PASSWORD_SLOT_ID) {
      throw new BadRequestException({
        code: 'INVALID_SLOT_ID',
        message: `A password-type slot must be written at the canonical "${PASSWORD_SLOT_ID}" id.`,
      });
    }

    // Reject a version jump: the proposed version must be exactly the held version + 1.
    assertSingleVersionStep(body.expectedEnvelopeSetVersion, body.envelopeSetVersion);

    // One consistent snapshot feeds both the exemption decision and the archive payload (see
    // `readEnvelopeWriteSnapshot`).
    const { slots: existingSlots, meta: previousMeta } = await this.readEnvelopeWriteSnapshot(
      me.householdId,
      body.expectedEnvelopeSetVersion,
    );
    const existed = existingSlots.some((s) => s.slotId === slotId);
    const householdHasAnySlot = existingSlots.length > 0;

    // The post-reset re-wrap exemption applies only when the re-wrap is owed (stored `credentialRevision` differs
    // from the current one), never on slot type alone, which would give a permanent bypass on every password-slot
    // write.
    let rewrapOwed = false;
    if (body.slot.slotType === 'password' && slotId === PASSWORD_SLOT_ID && existed) {
      const existingPasswordSlot = existingSlots.find((s) => s.slotId === PASSWORD_SLOT_ID);
      // The account current revision, not the writing session (that governs write authority below). Strongly
      // consistent for the same reason as `list()`.
      const currentCredential = await this.credentials.findByUserIdConsistent(me.userId);
      rewrapOwed =
        resolveCredentialRevision(existingPasswordSlot) !==
        resolveCredentialRevision(currentCredential);
    }

    const exemption = resolveEnvelopeWriteExemption({
      action: 'put',
      householdHasAnySlot,
      isCanonicalPasswordRewrapOwed: rewrapOwed,
    });
    const branch = await this.enforceEnvelopeStepUp(
      me,
      req,
      { method: body.method, code: body.code, response: body.response, currentPassword: body.currentPassword },
      exemption,
      'key_envelope_replace',
      // The password floor applies only to a proof-required write of a `passkey_prf` slot; never to a DELETE, the
      // recovery-key regeneration PUT, or the repair `recovery` PUT.
      body.slot.slotType === 'passkey_prf',
    );

    // Write authority: a password slot is stamped with the revision the writing session carries (resolved per
    // request from the refresh cookie, never the body) and that revision is asserted as a ConditionCheck in this
    // transaction, so a session whose credential has since rotated cannot write a slot.
    const credentialRevision =
      body.slot.slotType === 'password'
        ? await resolveSessionCredentialRevision(req, me.userId, me.jti, this.refreshTokens)
        : undefined;

    // Archive what the write displaces (previous slot and meta, and the live slot ids as the membership manifest),
    // all from the same snapshot and written in the same transaction.
    const previousSlot = existed ? existingSlots.find((s) => s.slotId === slotId) : undefined;
    const previousSlotIds = existingSlots.map((s) => s.slotId);

    // Slot and conditional meta PUT commit together or not at all, so a crash cannot strand a slot under a version
    // the set never reached.
    await this.commitEnvelopeTransaction(() =>
      this.envelopes.transactUpsertSlot({
        slot: buildKeyEnvelopeSlotRow(me.householdId, slotId, body.slot, credentialRevision),
        envelopeSetVersion: body.envelopeSetVersion,
        envelopeSetTag: body.envelopeSetTag,
        expectedVersion: body.expectedEnvelopeSetVersion,
        extraConditionItems:
          credentialRevision !== undefined
            ? [this.credentials.conditionCheckRevisionTransactItem(me.userId, credentialRevision)]
            : undefined,
        archive: { previousSlot, previousMeta, previousSlotIds },
      }),
    );

    await this.auth.record({
      userId: me.userId,
      eventType: existed ? 'key_envelope_updated' : 'key_envelope_created',
      metadata: {
        householdId: me.householdId,
        slotId,
        slotType: body.slot.slotType,
        envelopeSetVersion: body.envelopeSetVersion,
        stepUp: branch,
      },
    });
  }

  // Single gate shared by `upsert` and `remove`: applies the `resolveEnvelopeWriteExemption` verdict, then demands
  // the factor only when `AUTH_MFA_ENFORCED` is on. `requiresPasswordFloor` (a proof-required `passkey_prf` write)
  // requires the account password in either flag state: through `StepUpService.verify` when enforced, directly
  // through `VerifyPasswordService` otherwise. A missing password is coerced to an empty string so it fails like a
  // wrong one (401 INVALID_CREDENTIALS) instead of skipping the floor. A missing proof is 400 STEP_UP_PROOF_MISSING,
  // before anything is read for the write.
  private async enforceEnvelopeStepUp(
    me: AccessTokenClaims,
    req: Request,
    proof: {
      method?: StepUpMethod;
      code?: string;
      response?: UpsertKeyEnvelopeDto['response'];
      currentPassword?: string;
    },
    exemption: ReturnType<typeof resolveEnvelopeWriteExemption>,
    purpose: 'key_envelope_replace' | 'key_envelope_delete',
    requiresPasswordFloor = false,
  ): Promise<EnvelopeStepUpBranch> {
    if (!exemption.required) return exemption.branch;
    const ip = req.ip ?? null;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;
    if (!this.mfaEnforced) {
      // The factor requirement degrades to the bare session as for every step-up consumer, but the password floor
      // tightens a write the matrix already requires proof for and applies regardless of the flag.
      if (requiresPasswordFloor) {
        await this.verifyPasswordSvc.verify({
          userId: me.userId,
          currentPassword: proof.currentPassword ?? '',
          ip,
          userAgent,
        });
      }
      return 'not-enforced';
    }
    if (!proof.method) {
      await this.stepUpSvc.recordMissingProofFailure({ userId: me.userId, purpose, ip, userAgent });
      throw new BadRequestException({
        code: 'STEP_UP_PROOF_MISSING',
        message: 'A second factor is required for this change.',
      });
    }
    await this.stepUpSvc.verify({
      userId: me.userId,
      purpose,
      method: proof.method,
      code: proof.code,
      // The passkey factor rides in `response`, validated as the WebAuthn envelope (as in `auth.controller.ts`
      // deleteAccount).
      assertion: proof.response as unknown as AuthenticationResponseJSON | undefined,
      // Verified before any factor work; coerced to an empty string so an omitted field fails rather than skips.
      currentPassword: requiresPasswordFloor ? proof.currentPassword ?? '' : undefined,
      ip,
      userAgent,
    });
    return 'verified';
  }

  // Runs one atomic slot+meta transaction and maps typed failures: a version conflict is 409 STALE_ENVELOPE_VERSION,
  // and a transient conflict past the bounded retry is 503, so a blip never masquerades as another writer edit.
  private async commitEnvelopeTransaction(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      if (err instanceof StaleEnvelopeVersionError) {
        throw new ConflictException({
          code: 'STALE_ENVELOPE_VERSION',
          message: 'Envelope-set version is stale or non-monotonic.',
        });
      }
      // A stale or missing session write authority (credential rotated since, or a session that never recorded a
      // revision) maps to UPGRADE_REQUIRED, the code the change-password commit also uses; the web shows a reload
      // prompt, not a form error.
      if (err instanceof SessionCredentialStaleError) {
        throw new ConflictException({
          code: 'UPGRADE_REQUIRED',
          message: 'Reload the page to continue.',
        });
      }
      if (err instanceof EnvelopeTransactionConflictError) {
        throw new ServiceUnavailableException({
          code: 'ENVELOPE_WRITE_CONFLICT',
          message: 'Could not save the envelope set right now. Try again.',
        });
      }
      throw err;
    }
  }

  // Reads the `{ slots, meta }` snapshot the exemption decision and archive are built from, via
  // `getStableEnvelopeSet`: separate eventually consistent reads could misclassify a replace as `exempt-activation`
  // or drop the displaced slot from the archive. The meta version is also asserted equal to the client
  // `expectedEnvelopeSetVersion`, since a stale snapshot could decide the wrong exemption before the transaction
  // condition runs.
  private async readEnvelopeWriteSnapshot(
    householdId: string,
    expectedEnvelopeSetVersion: number,
  ): ReturnType<HouseholdKeyEnvelopesRepository['getStableEnvelopeSet']> {
    let snapshot: Awaited<ReturnType<HouseholdKeyEnvelopesRepository['getStableEnvelopeSet']>>;
    try {
      snapshot = await this.envelopes.getStableEnvelopeSet(householdId);
    } catch (err) {
      if (err instanceof EnvelopeReadConflictError) {
        throw new ServiceUnavailableException({
          code: 'ENVELOPE_READ_CONFLICT',
          message: 'Could not read the envelope set right now. Try again.',
        });
      }
      throw err;
    }
    if ((snapshot.meta?.envelopeSetVersion ?? 0) !== expectedEnvelopeSetVersion) {
      throw new ConflictException({
        code: 'STALE_ENVELOPE_VERSION',
        message: 'Envelope-set version is stale or non-monotonic.',
      });
    }
    return snapshot;
  }

  // Verifies a `passkey_prf` slot `credentialBinding` references a credential enrolled for the caller (the Passkey
  // table is keyed by userId); otherwise 422 CREDENTIAL_NOT_FOUND.
  private async assertCredentialBelongsToUser(
    userId: string,
    credentialId: string,
  ): Promise<void> {
    const passkey = await this.passkeys.find(userId, credentialId);
    if (!passkey) {
      throw new UnprocessableEntityException({
        code: 'CREDENTIAL_NOT_FOUND',
        message: 'The bound passkey credential is not enrolled for this account.',
      });
    }
  }

  /**
   * Removes a slot and bumps the meta to the client-recomputed version and tag under the same monotonic guard (409
   * STALE_ENVELOPE_VERSION). Write limit 5/min. A DELETE always demands a fresh step-up proof: see
   * `enforceEnvelopeStepUp`.
   */
  @Delete('key-envelopes/:slotId')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(204)
  async remove(
    @CurrentUser() me: AccessTokenClaims,
    @Param('slotId', SlotIdValidationPipe) slotId: string,
    @Body() body: DeleteKeyEnvelopeMetaDto,
    @Req() req: Request,
  ): Promise<void> {
    // Same single-version-step guard as `upsert`.
    assertSingleVersionStep(body.expectedEnvelopeSetVersion, body.envelopeSetVersion);

    const branch = await this.enforceEnvelopeStepUp(
      me,
      req,
      { method: body.method, code: body.code, response: body.response },
      { required: true },
      'key_envelope_delete',
    );

    // Archive the removed slot, previous meta and live slot ids from one consistent snapshot, written in the same
    // transaction as the delete.
    const { slots: existingSlots, meta: previousMeta } = await this.readEnvelopeWriteSnapshot(
      me.householdId,
      body.expectedEnvelopeSetVersion,
    );
    const previousSlot = existingSlots.find((s) => s.slotId === slotId);
    const previousSlotIds = existingSlots.map((s) => s.slotId);

    // Slot delete and meta write commit together, so a stale delete cannot remove a slot while the version fails to
    // advance.
    await this.commitEnvelopeTransaction(() =>
      this.envelopes.transactDeleteSlot({
        householdId: me.householdId,
        slotId,
        envelopeSetVersion: body.envelopeSetVersion,
        envelopeSetTag: body.envelopeSetTag,
        expectedVersion: body.expectedEnvelopeSetVersion,
        archive: { previousSlot, previousMeta, previousSlotIds },
      }),
    );

    await this.auth.record({
      userId: me.userId,
      eventType: 'key_envelope_deleted',
      metadata: {
        householdId: me.householdId,
        slotId,
        envelopeSetVersion: body.envelopeSetVersion,
        stepUp: branch,
      },
    });
  }
}
