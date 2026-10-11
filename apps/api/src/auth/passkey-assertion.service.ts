/**
 * Shared WebAuthn assertion primitives for the two passkey verification paths:
 *  - the discoverable passkey LOGIN (`POST /auth/passkey/authenticate/finish`),
 *    which resolves the user from the assertion `userHandle`; and
 *  - the passkey SECOND FACTOR on the MFA challenge
 *    (`POST /auth/mfa/passkey/start` + the `passkey` branch of
 *    `POST /auth/mfa/verify`), which resolves the user SOLELY from the
 *    challenge token and scopes `allowCredentials` to that user.
 *
 * This service is the single bounded context for `@simplewebauthn/server`,
 * `PasskeyChallengeStore`, `PasskeysRepository`, and rpID/origin — neither
 * `AuthController` nor `PasskeyController` imports those directly. It is also the
 * mockable seam for the WebAuthn boundary in tests.
 *
 * The MFA WebAuthn challenge is stored under a distinct userId-scoped namespace
 * `mfa:<userId>:<challenge>`, consumed ONLY by `verifyMfaAssertion` — never by
 * the discoverable `authenticate/finish` path, and the `auth:` login challenges
 * are never consumable here (closes the cross-flow single-factor bypass,
 * CWE-384, and credential substitution, CWE-639).
 *
 * Verification reuses the audited passkey-login rules: `userVerification:
 * 'required'`, strict counter monotonicity, and the conditional counter +
 * `lastUsedAt` update.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PasskeyChallengeStore } from './passkey-challenge-store.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import type { EnvConfig } from '../common/env.config.js';
import type { PasskeyRow } from '../dynamo/types.js';

@Injectable()
export class PasskeyAssertionService {
  private readonly rpID: string;
  private readonly origin: string;

  constructor(
    private readonly challenges: PasskeyChallengeStore,
    private readonly passkeys: PasskeysRepository,
    config: ConfigService<EnvConfig, true>,
  ) {
    const webOrigin = config.get('WEB_ORIGIN', { infer: true });
    const url = new URL(webOrigin);
    this.rpID = url.hostname;
    this.origin = url.origin;
  }

  /** Namespace key for an MFA-scoped WebAuthn challenge. */
  private mfaKey(userId: string, challenge: string): string {
    return `mfa:${userId}:${challenge}`;
  }

  /**
   * Namespace key for a step-up WebAuthn challenge. Scoped by BOTH the session user AND the
   * operation `purpose`, distinct from the login `mfa:` namespace — a challenge minted for one
   * op/purpose is stored under a key no other op/purpose (nor the login path) can consume.
   */
  private stepUpKey(userId: string, purpose: string, challenge: string): string {
    return `stepup:${userId}:${purpose}:${challenge}`;
  }

  /**
   * Generate purpose-scoped step-up authentication options for `userId` (the
   * authenticated session user), for operation `purpose`.
   * `allowCredentials` lists only that user's enrolled passkeys (a step-up, not a
   * discoverable login); the challenge is stored under the purpose-scoped
   * `stepup:<userId>:<purpose>` namespace.
   */
  async generateStepUpOptions(
    userId: string,
    purpose: string,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const enrolled = await this.passkeys.listForUser(userId);
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: 'required',
      allowCredentials: enrolled.map((p) =>
        p.transports && p.transports.length > 0
          ? { id: p.credentialId, transports: p.transports as never }
          : { id: p.credentialId },
      ),
    });
    await this.challenges.set(
      this.stepUpKey(userId, purpose, options.challenge),
      options.challenge,
      userId,
    );
    return options;
  }

  /**
   * Verify a step-up passkey assertion for `userId` bound to operation `purpose`.
   * Identical verification rules to
   * {@link verifyMfaAssertion} (UV required, counter monotonicity, credential
   * resolved SOLELY under the session user), but consumes the challenge from the
   * purpose-scoped `stepup:` namespace — a challenge minted for another op/purpose
   * (or the login `mfa:` path) is not found here and the assertion is rejected.
   * Throws the same passkey-specific failure codes.
   */
  async verifyStepUpAssertion(
    userId: string,
    purpose: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ credentialId: string }> {
    const cdj = parseClientDataJSON(response.response.clientDataJSON);
    const pending = cdj
      ? await this.challenges.consume(this.stepUpKey(userId, purpose, cdj.challenge))
      : null;
    if (!pending) throw this.invalid();

    const passkey = await this.passkeys.find(userId, response.id);
    if (!passkey) throw this.invalid();
    // A restricted factor must refuse a step-up
    // proof — checked here, where the credential is resolved, not by
    // filtering `generateStepUpOptions`'s `allowCredentials`: a caller can
    // name the restricted credential id directly in the assertion.
    if (passkey.restrictedPostReset) throw this.invalid();

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
          counter: passkey.counter,
          transports: (passkey.transports ?? undefined) as never,
        },
        requireUserVerification: true,
      });
    } catch (err) {
      if (isCounterRegressionError(err)) {
        throw new UnauthorizedException({
          code: 'PASSKEY_COUNTER_ANOMALY',
          message: 'This passkey could not be verified. Use another sign-in method.',
        });
      }
      if (isUserVerificationError(err)) {
        throw new UnauthorizedException({
          code: 'PASSKEY_USER_VERIFICATION_REQUIRED',
          message: 'Your device must verify you (PIN, fingerprint, or face) to use this passkey.',
        });
      }
      throw this.invalid();
    }
    if (!verification.verified) throw this.invalid();

    await this.advanceCounter(
      userId,
      passkey.credentialId,
      verification.authenticationInfo.newCounter,
      'This passkey could not be verified. Use another sign-in method.',
    );

    return { credentialId: passkey.credentialId };
  }

  /**
   * Generate scoped MFA authentication options for `userId` (the user named by a
   * verified challenge token). `allowCredentials` lists only that user's
   * enrolled passkeys so the assertion is a step-up, not a discoverable login,
   * and the challenge is stored under the userId-scoped `mfa:` namespace.
   */
  async generateMfaStartOptions(
    userId: string,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const enrolled = await this.passkeys.listForUser(userId);
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: 'required',
      allowCredentials: enrolled.map((p) =>
        p.transports && p.transports.length > 0
          ? { id: p.credentialId, transports: p.transports as never }
          : { id: p.credentialId },
      ),
    });
    await this.challenges.set(this.mfaKey(userId, options.challenge), options.challenge, userId);
    return options;
  }

  /**
   * Verify an MFA passkey assertion against the user named by the challenge
   * token. The credential must be one of `userId`'s enrolled passkeys; the
   * assertion `userHandle` is ignored. On success advances the counter +
   * `lastUsedAt` via the conditional write. Throws an
   * `UnauthorizedException` with a passkey-specific code on every failure mode:
   *  - `PASSKEY_USER_VERIFICATION_REQUIRED` — the authenticator did not perform
   *    user verification.
   *  - `PASSKEY_COUNTER_ANOMALY` — counter regression / lost update.
   *  - `MFA_CODE_INVALID` — no active challenge, unknown/foreign credential, or
   *    a failed signature verification (kept indistinguishable from the
   *    code-factor failure so the verify endpoint surfaces one shape).
   */
  async verifyMfaAssertion(
    userId: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ credentialId: string }> {
    const cdj = parseClientDataJSON(response.response.clientDataJSON);
    const pending = cdj ? await this.challenges.consume(this.mfaKey(userId, cdj.challenge)) : null;
    if (!pending) throw this.invalid();

    // Resolve the credential SOLELY under the challenge user — never from
    // the assertion userHandle. A credential not enrolled to this user is
    // rejected before any cryptographic work.
    const passkey = await this.passkeys.find(userId, response.id);
    if (!passkey) throw this.invalid();
    // A restricted factor must be refused as a
    // login-MFA factor even when a caller names it directly — `buildChallenge`
    // already stops OFFERING it; this is the belt-and-suspenders refusal.
    if (passkey.restrictedPostReset) throw this.invalid();

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
          counter: passkey.counter,
          transports: (passkey.transports ?? undefined) as never,
        },
        requireUserVerification: true,
      });
    } catch (err) {
      // SimpleWebAuthn throws distinct verification failures; map each to its
      // documented code (JSDoc above) instead of
      // collapsing all of them onto the UV code:
      //  - a counter regression (cloned-authenticator signal, emitted only when
      //    both counters are non-zero) → PASSKEY_COUNTER_ANOMALY;
      //  - a user-verification failure → PASSKEY_USER_VERIFICATION_REQUIRED;
      //  - anything else (bad/malformed signature, origin/challenge mismatch) →
      //    MFA_CODE_INVALID, so an unknown failure never masquerades as one of
      //    the two specific signals.
      if (isCounterRegressionError(err)) {
        throw new UnauthorizedException({
          code: 'PASSKEY_COUNTER_ANOMALY',
          message: 'This passkey could not be verified. Use another sign-in method.',
        });
      }
      if (isUserVerificationError(err)) {
        throw new UnauthorizedException({
          code: 'PASSKEY_USER_VERIFICATION_REQUIRED',
          message: 'Your device must verify you (PIN, fingerprint, or face) to use this passkey.',
        });
      }
      throw this.invalid();
    }
    if (!verification.verified) throw this.invalid();

    await this.advanceCounter(
      userId,
      passkey.credentialId,
      verification.authenticationInfo.newCounter,
      'This passkey could not be verified. Use another sign-in method.',
    );

    return { credentialId: passkey.credentialId };
  }

  // ---------- Discoverable LOGIN seam ----------
  // The `auth:`-namespace primitives the `passkey/authenticate/*` endpoints
  // refactor onto, so `PasskeyController` holds no direct `@simplewebauthn`/
  // store imports. The user resolution (via assertion `userHandle`) stays in the
  // controller — that discoverable-login lookup is distinct from the MFA path's
  // token-scoped lookup.

  /** Generate + store the discoverable-login WebAuthn challenge under `auth:`. */
  async generateLoginStartOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: 'required',
      allowCredentials: [],
    });
    await this.challenges.set(`auth:${options.challenge}`, options.challenge);
    return options;
  }

  /**
   * Consume the discoverable-login challenge named inside the assertion's
   * clientDataJSON (`auth:` namespace). Returns the stored challenge or null
   * when absent/expired/unparseable.
   */
  async consumeLoginChallenge(
    response: AuthenticationResponseJSON,
  ): Promise<{ challenge: string } | null> {
    const cdj = parseClientDataJSON(response.response.clientDataJSON);
    if (!cdj) return null;
    const pending = await this.challenges.consume(`auth:${cdj.challenge}`);
    return pending ? { challenge: pending.challenge } : null;
  }

  /**
   * Verify a discoverable-login assertion against an already-resolved passkey
   * row (the controller resolves the user via `userHandle` first), then advance
   * the counter + `lastUsedAt` via the same conditional write the MFA path uses.
   * Throws `PASSKEY_COUNTER_ANOMALY` on a counter regression / lost
   * update. Returns whether the signature verified.
   */
  async verifyLoginAssertion(args: {
    userId: string;
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    passkey: PasskeyRow;
  }): Promise<{ verified: boolean }> {
    const verification = await verifyAuthenticationResponse({
      response: args.response,
      expectedChallenge: args.expectedChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      credential: {
        id: args.passkey.credentialId,
        publicKey: new Uint8Array(Buffer.from(args.passkey.publicKey, 'base64url')),
        counter: args.passkey.counter,
        transports: (args.passkey.transports ?? undefined) as never,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) return { verified: false };
    await this.advanceCounter(
      args.userId,
      args.passkey.credentialId,
      verification.authenticationInfo.newCounter,
      'Could not verify the passkey.',
    );
    return { verified: true };
  }

  /**
   * Advance the credential's signature counter + `lastUsedAt` via the shared
   * conditional write, mapping the conditional-write rejection (a counter
   * regression / lost update on a counter-using authenticator — a possible
   * cloned-credential signal) to `PASSKEY_COUNTER_ANOMALY` with the caller's
   * human-readable `message`. Any other error is re-thrown unchanged. Owns the
   * write + anomaly mapping for both the MFA and the discoverable-login paths.
   */
  private async advanceCounter(
    userId: string,
    credentialId: string,
    newCounter: number,
    message: string,
  ): Promise<void> {
    try {
      await this.passkeys.updateCounterAndLastUsed(
        userId,
        credentialId,
        newCounter,
        new Date().toISOString(),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new UnauthorizedException({ code: 'PASSKEY_COUNTER_ANOMALY', message });
      }
      throw err;
    }
  }

  private invalid(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'MFA_CODE_INVALID',
      message: 'The code is incorrect or no longer valid.',
    });
  }
}

/**
 * True when `err` is the SimpleWebAuthn counter-regression throw — the
 * cloned-authenticator signal it raises when both the stored and the presented
 * counters are non-zero and the presented one did not strictly advance. v13
 * emits `Response counter value <n> was lower than expected <m>` (the message
 * names the counter being lower than expected), so match on that phrasing.
 */
function isCounterRegressionError(err: unknown): boolean {
  return err instanceof Error && /counter value .* was lower than expected/i.test(err.message);
}

/**
 * True when `err` is the SimpleWebAuthn user-verification failure throw, raised
 * when `requireUserVerification` is set but the assertion's UV flag is absent.
 * v13 emits `User verification required, but user could not be verified`.
 */
function isUserVerificationError(err: unknown): boolean {
  return err instanceof Error && /user verification required/i.test(err.message);
}

/**
 * A WebAuthn challenge is a short base64url-encoded nonce
 * (`generateAuthenticationOptions`/`generateRegistrationOptions` default to
 * 32 random bytes, ~43 chars) — 256 chars is generous headroom. `cdj.challenge`
 * is concatenated straight into a DynamoDB partition key
 * (`auth:<challenge>`, `mfa:<userId>:<challenge>`,
 * `stepup:<userId>:<purpose>:<challenge>`) by every caller of
 * `parseClientDataJSON`, and DynamoDB caps a String key at 2048 bytes; the
 * DTO's `MAX_AUTH_FIELD_LENGTH` (4096 base64url chars, ~3072 decoded bytes)
 * bounds only the encoded envelope, not this field, so an oversized-but
 * well-formed challenge would otherwise reach `PasskeyChallengeRepository
 * .consume` and fail as an uncaught `ValidationException` (a 500) instead of
 * the normal invalid/expired-challenge rejection. Rejecting it here, before
 * it becomes a key, keeps every call site on its existing null/invalid path.
 */
const MAX_CHALLENGE_LENGTH = 256;

/** Parse the base64url clientDataJSON to recover the WebAuthn `challenge`. */
function parseClientDataJSON(b64url: string): { challenge: string } | null {
  try {
    const json = Buffer.from(b64url, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { challenge?: unknown };
    return typeof parsed.challenge === 'string' &&
      parsed.challenge.length > 0 &&
      parsed.challenge.length <= MAX_CHALLENGE_LENGTH
      ? { challenge: parsed.challenge }
      : null;
  } catch {
    return null;
  }
}
