/**
 * HTTP layer for zero-knowledge household key envelopes.
 *
 *   GET    /api/v1/auth/key-envelopes            — list slots + envelope-set meta
 *   POST   /api/v1/auth/key-envelopes/activate    — atomic first-slot-set activation
 *   PUT    /api/v1/auth/key-envelopes/:slotId     — upsert a slot
 *   DELETE /api/v1/auth/key-envelopes/:slotId     — remove a slot
 *
 * All routes are JWT-authenticated (the global `JwtAuthGuard` applies),
 * CSRF-protected, and Origin-checked (the global middleware on every
 * state-changing request).
 *
 * The server stores wrapped key material OPAQUELY. It never unwraps,
 * decrypts, validates, or logs `wrappedKey`, and it never recomputes the
 * envelope-set HMAC (it holds no household data key). Its only active role on
 * write is enforcing a monotonic `envelopeSetVersion` so a stale client cannot
 * roll the set version backwards.
 */
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
   * The account credential's CURRENT revision, read fresh on every call — never cached, never
   * derived from the slot set. The client compares this against a `password` slot's own
   * `credentialRevision` to decide whether a re-wrap is owed. Resolved the same way the write path
   * resolves it ({@link resolveCredentialRevision}), so a legacy credential row (no
   * `credentialRevision` yet) reads the same fixed sentinel here as it does on the write's
   * `ConditionCheck`.
   */
  currentCredentialRevision: string;
}

/** Upper bound on a client-chosen `:slotId` — matches the DTO's `slotId` cap. */
const MAX_SLOT_ID_LEN = 64;

/**
 * Validate a client-chosen slot id (a DynamoDB sort key the client controls
 * directly) BEFORE any read/write. Shared by {@link SlotIdValidationPipe}
 * (the single-slot `PUT`/`DELETE` route param) and `activate` (every element
 * of its bulk `slots` array) — one
 * definition, so the two routes can never drift on what a valid slot id is:
 *  - the reserved `ENVELOPE_META` sentinel is rejected — it is the per-household
 *    envelope-set integrity row (envelopeSetVersion/envelopeSetTag). Letting a
 *    client PUT/DELETE it would overwrite or delete the set's integrity meta and
 *    corrupt the household's key-envelope set;
 *  - an id starting with the archive namespace ({@link isArchiveSlotId}) is rejected — same reasoning as the
 *    `ENVELOPE_META` reservation: a client write there would corrupt or spoof
 *    an archived envelope-set version;
 *  - empty / whitespace-only ids are rejected (a blank sort key is meaningless
 *    and would land as an empty-string key);
 *  - an over-long id is rejected (bounds abuse, matches the DTO cap).
 * Throws `400 INVALID_SLOT_ID` at the boundary (fail fast) on any violation.
 */
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

/** Validates the `:slotId` path parameter shared by `upsert` + `remove` — see
 *  {@link assertValidSlotId}. */
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
   * Return the household's key-envelope slot collection plus the
   * envelope-set integrity meta. Modest read limit (20/min): a fresh
   * unlock fetches the set once; this is not a hot path.
   *
   * Reads a CONSISTENT snapshot via {@link HouseholdKeyEnvelopesRepository.getStableEnvelopeSet} —
   * a bracketed, strongly-consistent read that never returns a torn
   * slots/meta pair. If a concurrent atomic slot+meta write keeps landing
   * mid-read past the bounded retry, the read surfaces `503
   * ENVELOPE_READ_CONFLICT` instead of an inconsistent pair the client's HMAC
   * check would fail closed on.
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
    // Server-authored current credential revision: read fresh, alongside the slot set, so the
    // client's owed-ness compare never has to make a second round-trip. A caller with no credential
    // row (should not happen for an authenticated JWT) resolves to the same legacy sentinel
    // `resolveCredentialRevision` gives an absent row. Strongly consistent: an
    // eventually-consistent replica read can still see the pre-reset revision for a moment after a
    // reset commits elsewhere, which would falsely compare equal to a stale slot revision and
    // suppress a re-wrap that is genuinely owed.
    const credential = await this.credentials.findByUserIdConsistent(me.userId);
    return {
      slots,
      envelopeSetVersion: meta?.envelopeSetVersion ?? 0,
      envelopeSetTag: meta?.envelopeSetTag ?? '',
      currentCredentialRevision: resolveCredentialRevision(credential),
    };
  }

  /**
   * Atomically activate a household's ENTIRE initial key-envelope slot set.
   * Genuine first-time activation is the
   * ONLY proofless add the step-up matrix allows, so it must never be
   * reachable via two separate PUTs whose intermediate state (one slot
   * committed, the rest not yet) the OLD matrix used to exempt outright —
   * this route commits every slot, the meta bump, and archive rows for any
   * meta-only residue in ONE transaction at a SINGLE version bump instead.
   *
   * Refuses with a distinct `409 ENVELOPE_SET_NOT_EMPTY` — never
   * `STALE_ENVELOPE_VERSION` — when the household already holds a live slot;
   * the client must be able to tell "someone else already keyed this
   * household" apart from an ordinary version race. Emptiness is fenced
   * against a race even though DynamoDB cannot condition on "no other item
   * exists in this partition": {@link readEnvelopeWriteSnapshot} is a
   * strongly-consistent, torn-read-guarded pre-read, and the conditional
   * `ENVELOPE_META` item this transaction ALSO carries makes that emptiness
   * hold to commit — a concurrent write that made the set non-empty must move
   * `envelopeSetVersion` first, failing this transaction's own meta
   * condition. This is not a TOCTOU gap to "fix" with a second read.
   *
   * Emptiness is `existingSlots.length === 0` — NEVER derived from the
   * envelope-set version. A failed prior attempt can leave meta-only residue
   * (`{ slots: [], envelopeSetVersion: N > 0 }`): such a household is
   * empty and must still activate, at `N + 1`.
   */
  @Post('key-envelopes/activate')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(204)
  async activate(
    @CurrentUser() me: AccessTokenClaims,
    @Body() body: ActivateKeyEnvelopesDto,
    @Req() req: Request,
  ): Promise<void> {
    // Per-slot invariants (mirrors `upsert`): validate every client-chosen
    // slot id, verify passkey_prf credential ownership, and pin the canonical
    // password id — BEFORE any read, so a rejected slot touches nothing.
    // Slot ids must also be unique ACROSS the body:
    // two elements at one id — e.g. two `password`-type slots, each passing
    // the canonical-id pin on its own — would build two `Put`s on the same
    // (householdId, slotId) item inside one transaction, which DynamoDB
    // refuses with a `ValidationException` that nothing in the commit path
    // maps. A client-controlled body must be a 400 here, never a 500 there.
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

    // Write authority: identical to `upsert`'s
    // handling — a `password`-type slot in the activating set is stamped with
    // the writing session's recorded credential revision, asserted as a
    // `ConditionCheck` inside the same transaction.
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

    // Activation is always proofless (see the class doc comment) — no
    // step-up gate call here, matching the exemption matrix's own
    // `exempt-activation` branch.
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
        // Nothing at the slot level is displaced (a genuinely empty set has
        // no live slot to archive); a stale meta-only residue row, when one
        // exists, still needs archiving.
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
   * Upsert a key-envelope slot. The slot metadata shape is validated by the
   * DTO; the `wrappedKey` and `envelopeSetTag` are stored verbatim (never
   * decrypted, never HMAC-recomputed). The slot write + the envelope-set meta
   * bump are applied under a monotonic-version guard: a non-monotonic
   * `envelopeSetVersion` is rejected with `409 STALE_ENVELOPE_VERSION`.
   *
   * `:slotId` is the authoritative slot id; the body's `slot.householdId` is
   * overridden by the JWT household so a tampered body cannot cross households.
   * Tight write limit (5/min): slot mutation is rare.
   *
   * A write into a household that already holds a slot — a DELETE, a PUT
   * replacing any existing slot other than an owed password re-wrap, or a PUT
   * creating a brand-new slot id — demands a fresh step-up proof before
   * anything is read for the write authority or committed:
   * see {@link resolveEnvelopeWriteExemption}
   * for the exemption matrix and {@link enforceEnvelopeStepUp} for the gate.
   * A proof-required write of a `passkey_prf` slot ALSO requires the account
   * password (the password floor), in either `AUTH_MFA_ENFORCED` state —
   * see the `currentPassword` handling in {@link enforceEnvelopeStepUp}.
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
    // Ownership check: a `passkey_prf` slot binds the
    // wrap to a specific WebAuthn credential. Verify that credential ID belongs
    // to the caller (keyed by `me.userId` — the `Passkey` table is user-keyed)
    // so a client cannot bind a slot to another account's credential. Existence
    // is the check; a missing credential is `422 CREDENTIAL_NOT_FOUND`. Run
    // before any write so a rejected binding touches nothing. Other slot types
    // (and a `passkey_prf` slot with no binding) skip this check unchanged.
    if (
      body.slot.slotType === 'passkey_prf' &&
      body.slot.credentialBinding != null
    ) {
      await this.assertCredentialBelongsToUser(me.userId, body.slot.credentialBinding);
    }

    // Canonical slot id: a `password`-type
    // write may only ever target the one literal `password` id — pinning the
    // id is what turns "this household holds no password slot" into a single
    // absence condition. A non-canonical id is refused outright, never moved.
    if (body.slot.slotType === 'password' && slotId !== PASSWORD_SLOT_ID) {
      throw new BadRequestException({
        code: 'INVALID_SLOT_ID',
        message: `A password-type slot must be written at the canonical "${PASSWORD_SLOT_ID}" id.`,
      });
    }

    // Reject a version jump at the boundary: the proposed
    // `envelopeSetVersion` must be exactly the client's currently-held
    // `expectedEnvelopeSetVersion` + 1. No operation may skip versions.
    assertSingleVersionStep(body.expectedEnvelopeSetVersion, body.envelopeSetVersion);

    // Consistent, torn-read-free snapshot —
    // see {@link readEnvelopeWriteSnapshot}. Both the exemption decision below
    // and the archive payload further down are built from this SAME read.
    const { slots: existingSlots, meta: previousMeta } = await this.readEnvelopeWriteSnapshot(
      me.householdId,
      body.expectedEnvelopeSetVersion,
    );
    const existed = existingSlots.some((s) => s.slotId === slotId);
    const householdHasAnySlot = existingSlots.length > 0;

    // The post-reset re-wrap exemption is conditional on the re-wrap being
    // OWED (the stored canonical password slot's `credentialRevision` !== the
    // credential's CURRENT revision) — never on slot type alone, which would
    // hand an attacker a permanent bypass on every password-slot write.
    let rewrapOwed = false;
    if (body.slot.slotType === 'password' && slotId === PASSWORD_SLOT_ID && existed) {
      const existingPasswordSlot = existingSlots.find((s) => s.slotId === PASSWORD_SLOT_ID);
      // The ACCOUNT's current credential revision — same resolution `list()`
      // gives the client for its own owed-ness compare, never the writing
      // session's revision (that governs write authority below, a different
      // question). Strongly consistent for the same reason `list()` is: an
      // eventually-consistent read can still see the pre-reset revision for a
      // moment after a reset commits elsewhere.
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
      // The password floor applies only to a proof-required write of a
      // `passkey_prf` slot — never to a DELETE (which never reaches this call
      // site), the recovery-key regeneration PUT, or the repair branch's
      // `recovery` PUT (out of scope; a separate owner decision).
      body.slot.slotType === 'passkey_prf',
    );

    // Write authority: a `password`-type slot
    // is stamped with the revision the WRITING SESSION carries — resolved
    // per request from the refresh cookie, never the body — and that same
    // revision is asserted, as a `ConditionCheck` INSIDE this same
    // transaction, to still equal the credential row's CURRENT revision. A
    // session whose credential has since been rotated (a reset landing
    // mid-session, an MFA completion carrying a pre-reset revision) cannot
    // write a slot. Other slot types are unaffected — no revision, no
    // condition, exactly today's shape.
    const credentialRevision =
      body.slot.slotType === 'password'
        ? await resolveSessionCredentialRevision(req, me.userId, me.jti, this.refreshTokens)
        : undefined;

    // Archive what this write is about to displace: the previous slot at this id, when one exists,
    // the previous envelope-set meta row, when one exists (every write past first activation), and
    // the id of every live slot at that version (the archived meta's membership manifest) — all
    // from the SAME snapshot read above, written INSIDE the same transaction as the live write,
    // below.
    const previousSlot = existed ? existingSlots.find((s) => s.slotId === slotId) : undefined;
    const previousSlotIds = existingSlots.map((s) => s.slotId);

    // Atomic slot+meta write: the slot PUT and the conditional
    // envelope-set meta PUT commit together or not at all, so a crash/timeout
    // can never strand a slot under a version the set never advanced to.
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

  /**
   * Single, testable gate shared by `upsert` + `remove`: apply the matrix-only {@link
   * resolveEnvelopeWriteExemption} verdict, then — like every other step-up consumer — read
   * `AUTH_MFA_ENFORCED` itself and demand the factor only when it is on. Returns the branch that
   * ran, for the caller's audit metadata; the branch is not a separate decision, only a record of
   * which path this call took.
   *
   * `requiresPasswordFloor` is `true` only for a
   * proof-required write of a `passkey_prf` slot — `upsert` computes it from
   * the written slot's type, `remove` never passes it. When set, the account
   * password is required IN EITHER `AUTH_MFA_ENFORCED` STATE: on the enforced
   * path it rides into {@link StepUpService.verify}'s own `currentPassword`
   * re-verify (audited, backoff-counted, never logged); on the flag-off path —
   * which used to degrade straight to the bare session with nothing left to
   * check — it is verified directly through {@link VerifyPasswordService}. A
   * missing password is coerced to an empty string rather than skipped, so it
   * fails the SAME way a wrong password does (below) instead of silently
   * satisfying an `undefined`-skips-the-check floor.
   *
   * @throws on a missing/invalid proof exactly like every other consumer
   *   (`400 STEP_UP_PROOF_MISSING`, or whatever {@link StepUpService.verify}
   *   throws for a wrong factor) — before the caller reads anything else for
   *   the write, let alone commits it. A missing/wrong password on a
   *   `requiresPasswordFloor` write throws the same `401 INVALID_CREDENTIALS`
   *   {@link VerifyPasswordService.verify} surfaces for every other password
   *   gate in this codebase, before any factor work runs.
   */
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
      // The factor requirement degrades to the bare session, as it does for
      // every other step-up consumer — but the password floor on a
      // passkey-encryption enrollment write is NOT the flow-shaped keying this
      // gate otherwise bans: it tightens a write the matrix already requires a
      // proof for, and applies regardless of the flag.
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
      // Passkey factor rides in `response`, validated as the WebAuthn
      // envelope; the service expects the `@simplewebauthn/server` shape
      // (mirrors `auth.controller.ts`'s `deleteAccount`).
      assertion: proof.response as unknown as AuthenticationResponseJSON | undefined,
      // The password floor: verified BEFORE any factor work when this write
      // requires it. Coerced to `''` (never `undefined`) so a caller that
      // omits the field fails the password check rather than skipping it.
      currentPassword: requiresPasswordFloor ? proof.currentPassword ?? '' : undefined,
      ip,
      userAgent,
    });
    return 'verified';
  }

  /**
   * Run one atomic slot+meta transaction and map the repository's typed
   * failures to the API envelope (shared by `upsert` + `remove`): a real
   * version conflict → `409 STALE_ENVELOPE_VERSION` (the client refetches +
   * retries); a transient transaction conflict that survived the bounded
   * retry → `503` so a throughput/network blip never masquerades as another
   * writer's edit.
   */
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
      // The session's write authority is stale or missing: a `password`-type write from a session
      // whose credential has since been rotated, OR a stale bundle whose session never recorded a
      // revision at all (every session alive before this shipped). Both share the ONE
      // `UPGRADE_REQUIRED` code the change- password commit also uses for its request-shape upgrade
      // case — the web maps it to a reload prompt, never a validation
      // error on a form.
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

  /**
   * Read the `{ slots, meta }` snapshot a write's step-up exemption decision
   * and archive payload are built from.
   * Before this, `upsert`/`remove` each issued an eventually-consistent
   * `listSlots` plus a SEPARATE `getEnvelopeMeta` call: a replica lagging a
   * just-committed first slot could still report `[]`, misclassifying a
   * replace as `exempt-activation`; and because the two reads were not
   * atomic with each other, a write landing between them could leave
   * `previousSlot` missing the row actually being displaced, so the archive
   * silently dropped it while the destructive write still committed.
   *
   * {@link HouseholdKeyEnvelopesRepository.getStableEnvelopeSet} closes both:
   * it is strongly consistent and bracketed so `slots` and `meta` are never
   * torn relative to each other. The snapshot's meta version is additionally
   * asserted here to equal the client's `expectedEnvelopeSetVersion` — the
   * transaction's own `ConditionExpression` enforces the same bound again at
   * commit time, but a stale snapshot could otherwise still decide the wrong
   * exemption/archive before ever reaching it.
   */
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

  /**
   * Verify a `passkey_prf` slot's `credentialBinding` references a WebAuthn
   * credential enrolled for the caller. The `Passkey`
   * table is keyed by `userId`, so this is the correct ownership scope (v1 is
   * 1:1 user↔household). Existence is the check; a binding to a credential the
   * caller does not hold is `422 CREDENTIAL_NOT_FOUND`.
   */
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
   * Remove a key-envelope slot, then bump the envelope-set meta to the
   * client-recomputed version + tag (the client recomputes the HMAC over the
   * remaining slots; the server stores it verbatim). The bump is applied under
   * the same monotonic guard — a non-monotonic version is `409
   * STALE_ENVELOPE_VERSION`. Tight write limit (5/min): slot mutation is rare.
   *
   * A DELETE always demands a fresh step-up proof (no exemption in the matrix) before anything
   * commits — see {@link enforceEnvelopeStepUp}.
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

    // Archive what this delete is about to displace — the slot being removed, the previous meta
    // row, and the live slot-id membership at that version, all read as ONE consistent snapshot
    // (see {@link readEnvelopeWriteSnapshot}) and written INSIDE the same transaction as the
    // delete, below.
    const { slots: existingSlots, meta: previousMeta } = await this.readEnvelopeWriteSnapshot(
      me.householdId,
      body.expectedEnvelopeSetVersion,
    );
    const previousSlot = existingSlots.find((s) => s.slotId === slotId);
    const previousSlotIds = existingSlots.map((s) => s.slotId);

    // Atomic slot-delete + meta write: both commit together or
    // neither does, so a stale delete can never remove a slot while the set
    // version fails to advance to a tag computed over the post-delete set.
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
