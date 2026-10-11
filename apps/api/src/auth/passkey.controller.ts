/**
 * Passkey controller: WebAuthn enroll + assert flow.
 *
 * Endpoints:
 *   POST /passkey/register/start      (auth) → registration options
 *   POST /passkey/register/finish     (auth) → verifies attestation, stores credential
 *   POST /passkey/authenticate/start  (public, body { email }) → authentication options
 *   POST /passkey/authenticate/finish (public, body { deviceId, response }) → tokens + cookies
 *   GET  /passkey/list                (auth) → user's enrolled passkeys
 *   DELETE /passkey/:credentialId     (auth) → remove a passkey
 *
 * UV is required end-to-end. Counter monotonicity is enforced
 * on assertion. Challenges are single-use, 5-minute TTL. CSRF is exempt
 * for the two authenticate-* endpoints; they set the cookie themselves.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type AuthenticationExtensionsClientInputs,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { Public } from './public.decorator.js';
import { CurrentUser } from './current-user.decorator.js';
import { PasskeyChallengeStore } from './passkey-challenge-store.js';
import { PasskeyAssertionService } from './passkey-assertion.service.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import { LoginService } from './login.service.js';
import { VerifyPasswordService } from './verify-password.service.js';
import { StepUpService } from './step-up.service.js';
import { FactorNoticeService } from './factor-notice.service.js';
import { FactorEnrollmentGuardService } from './factor-enrollment-guard.service.js';
import { resolveOpenResetWindow } from './factor-restriction.js';
import {
  CSRF_COOKIE_NAME,
  DEVICE_TRUST_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  csrfCookieOptions,
  refreshCookieOptions,
} from './cookie-config.js';
import { parseCookies } from './session-authority.js';
import type { AccessTokenClaims } from './jwt.service.js';
import type { EnvConfig } from '../common/env.config.js';
import { resolveSessionGeneration, type PasskeyRow } from '../dynamo/types.js';
import {
  PasskeyAuthenticateFinishDto,
  PasskeyRegisterFinishDto,
} from './dto/passkey.dto.js';
import { PasskeyRemoveDto } from './dto/auth.dto.js';
import { ConfirmRestrictedFactorDto } from './dto/step-up.dto.js';

const RP_NAME = 'Retivo';

/**
 * WebAuthn PRF extension input at credential creation (WebAuthn L3 — not yet in
 * the `@simplewebauthn/server` / DOM `AuthenticationExtensionsClientInputs`
 * type). Requesting `prf: {}` on register enables PRF for the new credential so
 * the authenticator returns PRF results at later assertions; strict third-party
 * managers (Keeper, 1Password) only return PRF when it was enabled here. No
 * eval is supplied at creation — that happens at assertion time. Applied with a
 * narrow cast at the single extension boundary, mirroring the client-side
 * pattern in apps/web/src/crypto/passkey-prf.ts.
 */
interface RegistrationPrfInput {
  prf: Record<string, never>;
}

@Controller('auth/passkey')
export class PasskeyController {
  private readonly rpID: string;
  private readonly origin: string;
  private readonly mfaEnforced: boolean;

  constructor(
    private readonly challenges: PasskeyChallengeStore,
    private readonly assertions: PasskeyAssertionService,
    private readonly passkeys: PasskeysRepository,
    private readonly users: UsersRepository,
    private readonly loginSvc: LoginService,
    private readonly auth: AuthEventsRepository,
    private readonly verifyPasswordSvc: VerifyPasswordService,
    private readonly stepUpSvc: StepUpService,
    private readonly factorNotice: FactorNoticeService,
    private readonly factorEnrollmentGuard: FactorEnrollmentGuardService,
    config: ConfigService<EnvConfig, true>,
  ) {
    const webOrigin = config.get('WEB_ORIGIN', { infer: true });
    const url = new URL(webOrigin);
    this.rpID = url.hostname;
    this.origin = url.origin;
    this.mfaEnforced = config.get('AUTH_MFA_ENFORCED', { infer: true }) === 'true';
  }

  // ---------- Registration ----------

  @Post('register/start')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async registerStart(@CurrentUser() me: AccessTokenClaims) {
    const existing = await this.passkeys.listForUser(me.userId);
    const user = await this.users.findById(me.userId);
    if (!user) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Account not found.',
      });
    }
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: this.rpID,
      userID: new TextEncoder().encode(me.userId),
      userName: user.email,
      userDisplayName: user.email,
      attestationType: 'none',
      // Omit `transports` when we don't have any recorded — Safari's
      // WebAuthn picker has tripped on `transports: []` in the past.
      excludeCredentials: existing.map((p) =>
        p.transports && p.transports.length > 0
          ? { id: p.credentialId, transports: p.transports as never }
          : { id: p.credentialId },
      ),
      authenticatorSelection: {
        // Required so the passkey is discoverable — username-less login
        // depends on the authenticator returning a userHandle.
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      // Enable the PRF extension on the new credential so it is PRF-capable for
      // zero-knowledge encryption enrollment. WebAuthn L3 `prf` is not in the
      // simplewebauthn `extensions` type, so narrow-cast at this one boundary.
      extensions: { prf: {} } satisfies RegistrationPrfInput as AuthenticationExtensionsClientInputs,
    });
    await this.challenges.set(`reg:${me.userId}`, options.challenge, me.userId);
    return options;
  }

  @Post('register/finish')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async registerFinish(
    @CurrentUser() me: AccessTokenClaims,
    @Body() body: PasskeyRegisterFinishDto,
    @Req() req: Request,
  ) {
    const pending = await this.challenges.consume(`reg:${me.userId}`);
    if (!pending) {
      throw new BadRequestException({
        code: 'PASSKEY_CHALLENGE_EXPIRED',
        message: 'No active registration challenge. Start over.',
      });
    }
    const ip = req.ip ?? null;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;
    // Fresh-proof gate on the WRITE, not merely the /start challenge
    // a `finish` replayed against a
    // challenge minted earlier must still carry a verified proof. No
    // AUTH_MFA_ENFORCED early-out — see the guard's own doc.
    await this.factorEnrollmentGuard.enforce({
      userId: me.userId,
      purpose: 'passkey_enroll',
      proof: {
        currentPassword: body.stepUp.currentPassword,
        method: body.stepUp.method,
        code: body.stepUp.code,
        response: body.stepUp.response as unknown as AuthenticationResponseJSON | undefined,
      },
      mfaEnforced: this.mfaEnforced,
      ip,
      userAgent,
    });
    const verification = await verifyRegistrationResponse({
      response: body.response as unknown as RegistrationResponseJSON,
      expectedChallenge: pending.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException({
        code: 'PASSKEY_REGISTRATION_FAILED',
        message: 'Could not verify the passkey.',
      });
    }
    const info = verification.registrationInfo;
    const cred = info.credential;
    const now = new Date().toISOString();
    // Reset-window restriction: resolve whether
    // this write lands inside an open password-reset window and, if so, stamp
    // the passkey restricted in the SAME write that creates it.
    const user = await this.users.findById(me.userId);
    const openWindow = user ? resolveOpenResetWindow(user, Date.now()) : null;
    const row: PasskeyRow = {
      userId: me.userId,
      credentialId: cred.id,
      publicKey: Buffer.from(cred.publicKey).toString('base64url'),
      counter: cred.counter,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      transports: cred.transports ? [...cred.transports] : null,
      createdAt: now,
      lastUsedAt: null,
      ...(openWindow
        ? { restrictedPostReset: true, restrictedByResetRequestedAt: openWindow.requestedAt }
        : {}),
    };
    await this.passkeys.insert(row);
    await this.auth.record({
      userId: me.userId,
      eventType: 'passkey_enroll',
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      metadata: { credentialId: cred.id, deviceType: row.deviceType },
    });
    if (openWindow) {
      await this.auth.record({
        userId: me.userId,
        eventType: 'factor_restriction_applied',
        ip,
        userAgent,
        metadata: { credentialId: cred.id, factorType: 'passkey' },
      });
    }
    // Factor-change notice + undo: post-commit,
    // best-effort — `notify` never rejects, so it can never fail the
    // enrollment; `noticeSent` tells the card whether the mail actually went
    // out. The address comes from the User row (the access-token claims
    // carry no email).
    const noticeSent = user
      ? await this.factorNotice.notify({
          userId: me.userId,
          email: user.email,
          kind: 'passkey_add',
          credentialId: cred.id,
        })
      : false;
    return { ...toPasskeyInfo(row), noticeSent };
  }

  // ---------- Authentication ----------

  @Public()
  @Post('authenticate/start')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async authenticateStart() {
    // Discoverable / username-less flow: the browser shows the picker,
    // the user identifies themselves with the passkey itself, and we
    // look up the user from the assertion's userHandle on /finish. The
    // `auth:`-namespace challenge + WebAuthn primitives live in the shared
    // PasskeyAssertionService so this controller holds no @simplewebauthn deps
    // for the authentication path.
    return this.assertions.generateLoginStartOptions();
  }

  @Public()
  @Post('authenticate/finish')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async authenticateFinish(
    @Body() body: PasskeyAuthenticateFinishDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const pending = await this.assertions.consumeLoginChallenge(
      body.response as unknown as AuthenticationResponseJSON,
    );
    if (!pending) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Could not verify the passkey.',
      });
    }
    const userHandle = body.response.response.userHandle;
    if (!userHandle) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Passkey did not return a user handle. Re-enroll the passkey.',
      });
    }
    const userId = Buffer.from(userHandle, 'base64url').toString('utf8');
    // Strongly consistent: this is the ONE read of the User row this sign-in
    // takes, and the session generation it carries is what the session below
    // is stamped with. A default replica read here could lag a generation
    // bump that committed BEFORE this sign-in even started (a password reset
    // seconds earlier), and the stale value would then fail issuance's
    // generation ConditionCheck — a spurious 401 for a legitimate sign-in.
    const user = await this.users.findByIdConsistent(userId);
    if (!user) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Could not verify the passkey.',
      });
    }
    const passkey = await this.passkeys.find(user.userId, body.response.id);
    if (!passkey) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Could not verify the passkey.',
      });
    }

    // Verify + advance the counter via the shared assertion service (the same
    // UV-required / counter-monotonic / conditional-write posture as the MFA
    // passkey factor). The discoverable-login user resolution above
    // (via the assertion userHandle) is distinct from the MFA path's
    // token-scoped lookup.
    const { verified } = await this.assertions.verifyLoginAssertion({
      userId: user.userId,
      response: body.response as unknown as AuthenticationResponseJSON,
      expectedChallenge: pending.challenge,
      passkey,
    });
    if (!verified) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Could not verify the passkey.',
      });
    }
    // Restricted-factor refusal: AFTER the
    // assertion verifies (so a wrong/forged assertion still surfaces the
    // generic INVALID_CREDENTIALS above, not this factor-specific one) but
    // BEFORE a session is issued. A distinct code + message is safe here —
    // unlike the step-up/login-MFA paths, the caller has already proven
    // physical possession of THIS exact credential, so naming it back is not
    // a new existence oracle.
    if (passkey.restrictedPostReset) {
      throw new UnauthorizedException({
        code: 'PASSKEY_RESTRICTED_POST_RESET',
        message:
          "This passkey was added right after a password reset and hasn't been confirmed yet. Sign in with your email and password instead.",
      });
    }

    const session = await this.loginSvc.issueSession({
      userId: user.userId,
      householdId: user.householdId,
      deviceId: body.deviceId,
      // The generation observed by the read above — taken BEFORE the
      // assertion was verified, never re-read afterwards. This sign-in's proof is the
      // assertion; an account-wide revoke committing after that proof was
      // gathered must fail issuance's generation ConditionCheck closed, not
      // be silently adopted by a later read that happens to see the NEW
      // generation and mints a session surviving the very boundary the
      // revoke drew — the same invariant the password login pins.
      sessionGeneration: resolveSessionGeneration(user),
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
    res.cookie(
      REFRESH_COOKIE_NAME,
      session.refreshToken,
      refreshCookieOptions(session.refreshExpiresInSec * 1000),
    );
    res.cookie(
      CSRF_COOKIE_NAME,
      session.csrfToken,
      csrfCookieOptions(session.refreshExpiresInSec * 1000),
    );
    await this.auth.record({
      userId: user.userId,
      eventType: 'passkey_assert',
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      metadata: { credentialId: passkey.credentialId, deviceId: body.deviceId },
    });
    // Map the new profile fields explicitly (same shape as the password
    // login response) so the SPA can seed the primary HouseholdMember.
    return {
      accessToken: session.accessToken,
      expiresIn: session.expiresInSec,
      firstName: session.firstName,
      lastName: session.lastName,
      birthdate: session.birthdate,
    };
  }

  // ---------- Management ----------

  @Get('list')
  async list(@CurrentUser() me: AccessTokenClaims) {
    const rows = await this.passkeys.listForUser(me.userId);
    return rows.map(toPasskeyInfo);
  }

  /**
   * Remove a passkey. Removal was session-only;
   * it now carries a body-bearing `POST … /remove` (not `DELETE`-with-body, which
   * is discouraged) so the required proof is well-formed. Gate:
   *   - a password re-verify BASELINE, present regardless of the flag — the
   *     one op whose baseline changes, since passkey removal had no gate before;
   *   - PLUS a fresh step-up factor when `AUTH_MFA_ENFORCED` is on. Email-OTP
   *     is the no-lockout floor, so removal stays completable even when the passkey
   *     being removed is the only routine factor.
   * Explicit `@Throttle` bounds password + factor brute force.
   * Responds `200 { noticeSent }` (was a bodiless `204`) so the card can tell
   * whether the factor-change notice mail actually went out; still idempotent — an unknown credentialId is `{ noticeSent: false }`.
   */
  @Post(':credentialId/remove')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async remove(
    @CurrentUser() me: AccessTokenClaims,
    @Param('credentialId') credentialId: string,
    @Body() dto: PasskeyRemoveDto,
    @Req() req: Request,
  ): Promise<{ noticeSent: boolean }> {
    const ip = req.ip ?? null;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;
    // Password baseline — always, independent of the MFA flag. A wrong
    // password throws 401 INVALID_CREDENTIALS before any factor work or removal.
    // Device identity: a trusted device's
    // password re-verify bypasses the per-address backoff here too.
    const cookies = parseCookies(req.headers.cookie ?? '');
    await this.verifyPasswordSvc.verify({
      userId: me.userId,
      currentPassword: dto.currentPassword,
      ip,
      userAgent,
      deviceId: me.deviceId,
      deviceTrustToken: cookies[DEVICE_TRUST_COOKIE_NAME],
    });
    // Fresh second-factor step-up layered on the password baseline when the flag
    // is on. A missing factor is a 400 before any side effect; a bad factor
    // throws via StepUpService (emitting the `step_up_*` audit) before removal.
    if (this.mfaEnforced) {
      if (!dto.method) {
        await this.stepUpSvc.recordMissingProofFailure({
          userId: me.userId,
          purpose: 'passkey_remove',
          ip,
          userAgent,
        });
        throw new BadRequestException({
          code: 'STEP_UP_PROOF_MISSING',
          message: 'A second factor is required to remove a passkey.',
        });
      }
      await this.stepUpSvc.verify({
        userId: me.userId,
        purpose: 'passkey_remove',
        method: dto.method,
        code: dto.code,
        assertion: dto.response as unknown as AuthenticationResponseJSON | undefined,
        ip,
        userAgent,
      });
    }
    const removed = await this.passkeys.remove(me.userId, credentialId);
    await this.auth.record({
      userId: me.userId,
      eventType: 'passkey_remove',
      ip,
      userAgent,
      metadata: { credentialId },
    });
    // Factor-change notice + undo: only on an ACTUAL
    // removal. The endpoint stays idempotent (200 regardless), but a no-op
    // delete of an unknown/already-removed credential must never mint a
    // factor-change notice — it would overwrite a still-live pending undo
    // for a genuine earlier change (e.g. a real passkey_add) with a
    // passkey_remove token that only ends sessions, permanently losing the
    // ability to undo that earlier change. A
    // removal's undo link only ends every session — it can never restore the
    // credential. `notify` never rejects (the removal has already committed).
    if (!removed) return { noticeSent: false };
    const removedBy = await this.users.findById(me.userId);
    const noticeSent = removedBy
      ? await this.factorNotice.notify({
          userId: me.userId,
          email: removedBy.email,
          kind: 'passkey_remove',
          credentialId,
        })
      : false;
    return { noticeSent };
  }

  /**
   * Lift a passkey's post-reset restriction. The
   * proof must come from a DIFFERENT, already-enrolled factor whose own
   * enrollment predates the reset request that opened the window — the
   * server resolves and checks this, never the client. When nothing predates
   * the reset, the escape hatch is removal (already step-up-gated above),
   * not this endpoint.
   */
  @Post(':credentialId/confirm-restriction')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async confirmRestriction(
    @CurrentUser() me: AccessTokenClaims,
    @Param('credentialId') credentialId: string,
    @Body() dto: ConfirmRestrictedFactorDto,
    @Req() req: Request,
  ) {
    await this.stepUpSvc.confirmRestrictedPasskey({
      userId: me.userId,
      credentialId,
      method: dto.method,
      code: dto.code,
      assertion: dto.response as unknown as AuthenticationResponseJSON | undefined,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
    return { restrictedPostReset: false };
  }
}

interface PasskeyInfoView {
  id: string;
  credentialId: string;
  deviceType: string;
  backedUp: boolean;
  transports: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** True while this passkey is restricted post-reset — omitted (not `false`) when not restricted,
   * matching the row's own optional-attribute shape. */
  restrictedPostReset?: boolean;
}

function toPasskeyInfo(row: PasskeyRow): PasskeyInfoView {
  return {
    id: row.credentialId,
    credentialId: row.credentialId,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    transports: row.transports,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    ...(row.restrictedPostReset ? { restrictedPostReset: true } : {}),
  };
}
