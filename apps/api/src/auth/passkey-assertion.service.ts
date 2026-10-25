// The bounded context for WebAuthn (passkey login and the passkey second factor). MFA challenges use `mfa:<userId>:<challenge>`, so
// login and MFA flows cannot consume each other (CWE-384, CWE-639).
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

  private mfaKey(userId: string, challenge: string): string {
    return `mfa:${userId}:${challenge}`;
  }

  // Step-up challenge key, scoped by session user and operation `purpose`, so no other operation or the login `mfa:`
  // path can consume it.
  private stepUpKey(userId: string, purpose: string, challenge: string): string {
    return `stepup:${userId}:${purpose}:${challenge}`;
  }

  /**
   * Generates purpose-scoped step-up options for the session user, listing only that user enrolled passkeys, stored
   * under `stepup:<userId>:<purpose>`.
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
   * Verifies a step-up passkey assertion bound to `purpose` under the same rules as `verifyMfaAssertion`; a challenge
   * minted for another purpose or the login path is not found, so the assertion is rejected.
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
    // A restricted factor refuses a step-up proof; checked where the credential is resolved, because a caller can
    // name its id directly.
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
   * Generates MFA options for the user a verified challenge token names, listing only that user passkeys, stored
   * under the userId-scoped `mfa:` namespace.
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
   * Verifies an MFA passkey assertion against the challenge-token user; the credential must be enrolled to `userId`
   * and the assertion `userHandle` is ignored. Failure codes: PASSKEY_USER_VERIFICATION_REQUIRED,
   * PASSKEY_COUNTER_ANOMALY, and MFA_CODE_INVALID for everything else, kept indistinguishable from a code-factor
   * failure.
   */
  async verifyMfaAssertion(
    userId: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ credentialId: string }> {
    const cdj = parseClientDataJSON(response.response.clientDataJSON);
    const pending = cdj ? await this.challenges.consume(this.mfaKey(userId, cdj.challenge)) : null;
    if (!pending) throw this.invalid();

    // Resolve the credential solely under the challenge user, never from `userHandle`; a foreign credential is
    // rejected before any cryptographic work.
    const passkey = await this.passkeys.find(userId, response.id);
    if (!passkey) throw this.invalid();
    // A restricted factor is refused as a login-MFA factor even when named directly (`buildChallenge` already stops
    // offering it).
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
      // Map each SimpleWebAuthn failure to its code: a counter regression (cloned-authenticator signal, only when
      // both counters are non-zero) to PASSKEY_COUNTER_ANOMALY, a user-verification failure to
      // PASSKEY_USER_VERIFICATION_REQUIRED, and anything else to MFA_CODE_INVALID so an unknown failure never
      // masquerades as a specific signal.
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
  // The `auth:`-namespace primitives for `passkey/authenticate/*`; user resolution via `userHandle` stays in the
  // controller.

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
   * Consumes the discoverable-login challenge named in the assertion `clientDataJSON` (`auth:` namespace); null when
   * absent, expired or unparseable.
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
   * Verifies a discoverable-login assertion against the resolved passkey row, then advances the counter and
   * `lastUsedAt` through the same conditional write. Throws PASSKEY_COUNTER_ANOMALY on a regression; returns whether
   * the signature verified.
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

  // Advances the counter and `lastUsedAt` via the shared conditional write, mapping its rejection (a possible
  // cloned-credential signal) to PASSKEY_COUNTER_ANOMALY; any other error is rethrown.
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

// True for the SimpleWebAuthn counter-regression throw (both counters non-zero, presented did not advance); matches
// the v13 message `Response counter value <n> was lower than expected <m>`.
function isCounterRegressionError(err: unknown): boolean {
  return err instanceof Error && /counter value .* was lower than expected/i.test(err.message);
}

// True for the SimpleWebAuthn user-verification failure; v13 message `User verification required, but user could not
// be verified`.
function isUserVerificationError(err: unknown): boolean {
  return err instanceof Error && /user verification required/i.test(err.message);
}

// A challenge is a short nonce (~43 chars); 256 is headroom. It is concatenated into a DynamoDB partition key capped
// at 2048 bytes, and the DTO limit bounds only the encoded envelope, so an oversized well-formed challenge would
// reach `consume` and 500. Reject it before it becomes a key.
const MAX_CHALLENGE_LENGTH = 256;

// Parse the base64url clientDataJSON to recover the WebAuthn `challenge`.
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
