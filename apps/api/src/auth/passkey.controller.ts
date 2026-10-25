// Passkey controller: WebAuthn register, authenticate, list, remove. User verification is required and counters are monotonic; the two
// authenticate endpoints are CSRF-exempt and set the cookie themselves.
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

// WebAuthn PRF extension input at creation (WebAuthn L3, not yet in the `@simplewebauthn/server` types). `prf: {}` is
// needed here because strict managers (Keeper, 1Password) return PRF only when enabled at creation; applied with a
// narrow cast at the one boundary.
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
      // Omit `transports` when none are recorded: Safari WebAuthn picker has tripped on `transports: []`.
      excludeCredentials: existing.map((p) =>
        p.transports && p.transports.length > 0
          ? { id: p.credentialId, transports: p.transports as never }
          : { id: p.credentialId },
      ),
      authenticatorSelection: {
        // Required so the passkey is discoverable; username-less login depends on the authenticator returning a
        // userHandle.
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      // Enable PRF for zero-knowledge encryption enrollment; narrow-cast because `prf` is not in the simplewebauthn
      // `extensions` type.
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
    // The fresh-proof gate is on the write, not just the /start challenge, so a `finish` replayed against an
    // earlier challenge still needs a verified proof. No `AUTH_MFA_ENFORCED` early-out.
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
    // Resolve whether this write lands in an open password-reset window and stamp the passkey restricted in the
    // same write that creates it.
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
    // Post-commit and best-effort: `notify` never rejects; `noticeSent` tells the card whether the mail went out.
    // The address comes from the User row, since the claims carry no email.
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

  @Public()
  @Post('authenticate/start')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async authenticateStart() {
    // Discoverable, username-less flow: the user is found from the assertion `userHandle` on /finish; the challenge
    // and WebAuthn primitives live in PasskeyAssertionService.
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
    // The one User read this sign-in takes, strongly consistent: its session generation stamps the session, and a
    // replica lagging a bump committed before this sign-in (a reset seconds earlier) would fail the issuance
    // ConditionCheck as a spurious 401.
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

    // Verify and advance the counter via the shared assertion service (UV required, monotonic counter, conditional
    // write), as the MFA passkey factor does.
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
    // Restricted-factor refusal comes after the assertion verifies (a forged one still yields the generic
    // INVALID_CREDENTIALS) and before a session is issued. A distinct code is safe because the caller proved
    // possession of this exact credential, so naming it is no new oracle.
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
      // The generation observed before the assertion was verified, never re-read: a revoke committing after the proof
      // must fail issuance ConditionCheck closed, as in the password login.
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
    return {
      accessToken: session.accessToken,
      expiresIn: session.expiresInSec,
    };
  }

  @Get('list')
  async list(@CurrentUser() me: AccessTokenClaims) {
    const rows = await this.passkeys.listForUser(me.userId);
    return rows.map(toPasskeyInfo);
  }

  /**
   * Removes a passkey via `POST .../remove` (a body-bearing request, so the proof is well-formed). Gate: a password
   * re-verify baseline regardless of the flag, plus a fresh step-up factor when `AUTH_MFA_ENFORCED` is on (Email-OTP
   * is the no-lockout floor). Explicit `@Throttle` bounds brute force. Responds `200 { noticeSent }`; idempotent, an
   * unknown credentialId is `{ noticeSent: false }`.
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
    // Password baseline always, independent of the MFA flag; a wrong password throws 401 before any factor work. A
    // trusted device bypasses the per-address backoff here too.
    const cookies = parseCookies(req.headers.cookie ?? '');
    await this.verifyPasswordSvc.verify({
      userId: me.userId,
      currentPassword: dto.currentPassword,
      ip,
      userAgent,
      deviceId: me.deviceId,
      deviceTrustToken: cookies[DEVICE_TRUST_COOKIE_NAME],
    });
    // Step-up layered on the baseline when the flag is on; a missing factor is 400 before any side effect.
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
    // Notify only on an actual removal: a no-op delete must not mint a notice, which would overwrite a live pending
    // undo for an earlier change (such as a real passkey_add) with a remove token that only ends sessions. A
    // removal undo link never restores the credential.
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
   * Lifts a passkey post-reset restriction. The proof must come from a different, already-enrolled factor whose
   * enrollment predates the reset request that opened the window, checked server-side. When nothing predates it,
   * removal is the escape hatch.
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
  /** True while restricted post-reset; omitted (not false) otherwise. */
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
