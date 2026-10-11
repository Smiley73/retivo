/**
 * Factor-change notice + single-use undo. The notification half of the
 * defence against a hijacked session enrolling its own permanent factor:
 * whenever a passkey or authenticator app is added or removed, the account's
 * email address gets a one-link, 24-hour, single-use notice that can undo the
 * change and end every session — the detection-and-recovery path for a
 * session that is *already* hijacked (`FactorEnrollmentGuardService` is the
 * gate half).
 *
 * The pending undo lives on the `User` row (only the token's SHA-256 hash is
 * stored) rather than in a dedicated table, so an account has ONE outstanding
 * undo: a newer factor change overwrites the pending token for an older one.
 * The consume endpoint's response is opaque (`{ ok }`), so it reveals nothing
 * about whether a `userId` / `token` pair is real. Consuming runs in three
 * steps, in this order:
 *
 *   1. `UsersRepository.claimFactorUndo` re-validates the presented token
 *      (hash, kind, not expired) and captures the `(kind, credentialId)` it
 *      names in one conditional write — the gate that keeps an unknown,
 *      expired, superseded or mismatched token from ending any session.
 *   2. `SessionRevocationService.revokeAll` ends every session. Idempotent,
 *      and deliberately BEFORE the single-use gate: a failure here (a
 *      transient DynamoDB error, a Lambda timeout mid-sweep) leaves the token
 *      still valid, so the same link, clicked again, safely re-runs the sweep
 *      and completes. Burning the token first would strand the account with
 *      neither the recovery applied nor any way to retry it.
 *   3. `UsersRepository.consumeFactorUndo` commits the kind's action (delete
 *      the passkey / clear TOTP) and the single-use clear in ONE
 *      `TransactWriteItems`, conditioned on the token STILL being the active
 *      one. The claim in step 1 is validation at one instant, not a lock: a
 *      newer factor change can overwrite the pending token at any moment
 *      (ONE outstanding undo per account by design), and an action performed
 *      as a separate write after the claim could land on a factor that token
 *      was never about — e.g. clear an authenticator re-enrolled after the
 *      clicked link's TOTP was already turned off. Committing the action
 *      inside the conditioned transaction means a superseded or already-
 *      consumed token aborts the whole write, action included, and reports
 *      `{ ok: false }` with the factor untouched.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { randomBytes } from 'node:crypto';
import { SES_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import { emailFingerprint } from '../common/email-fingerprint.js';
import { UsersRepository } from '../dynamo/users.repository.js';
import { PasskeysRepository } from '../dynamo/passkeys.repository.js';
import { UserMfaRepository } from '../dynamo/user-mfa.repository.js';
import type { TransactItem } from '../dynamo/transact-write.js';
import { formatMailSource } from './mail-source.js';
import { sha256 } from './refresh-token.service.js';
import { SessionRevocationService } from './session-revocation.service.js';
import { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import {
  bodyIntro,
  buildFactorNoticeMail,
  buildFactorUndoLink,
  type FactorUndoKind,
} from './factor-notice-mail.js';
import { escapeHtml } from '../common/escape-html.js';

/** Undo-link validity (the notice says "expires in 24 hours"). */
const FACTOR_UNDO_TTL_SEC = 24 * 60 * 60;

export interface FactorNoticeArgs {
  userId: string;
  email: string;
  kind: FactorUndoKind;
  /** The passkey this change concerns. Present for both passkey kinds (the
   *  `_add` consume needs it to know which credential to delete; `_remove`
   *  carries it for the audit trail only — the removal is never reversed). */
  credentialId?: string;
}

export interface FactorUndoConsumeResult {
  ok: boolean;
}

@Injectable()
export class FactorNoticeService {
  private readonly logger = new Logger(FactorNoticeService.name);
  private readonly fromAddress: string;
  private readonly webOrigin: string;
  private readonly sesEnabled: boolean;

  constructor(
    @Inject(SES_CLIENT) private readonly ses: SESClient,
    private readonly users: UsersRepository,
    private readonly passkeys: PasskeysRepository,
    private readonly userMfa: UserMfaRepository,
    private readonly sessions: SessionRevocationService,
    private readonly auth: AuthEventsRepository,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.fromAddress = config.get('SES_FROM_ADDRESS', { infer: true });
    this.webOrigin = config.get('WEB_ORIGIN', { infer: true });
    const node = config.get('NODE_ENV', { infer: true });
    this.sesEnabled = node === 'production' || !!config.get('SES_ENDPOINT', { infer: true });
  }

  /**
   * Mint the single-use undo token, persist it on the `User` row
   * (overwrites any earlier pending undo), then send the
   * best-effort notice mail. Returns whether the notice mail was actually
   * handed off — the call sites surface that as `noticeSent` so the UI never
   * tells the person an email went out when it did not.
   *
   * Every call site runs this AFTER its factor change has committed, so
   * nothing here may reject into that response: the persist and the send
   * both sit inside the try/catch. A persist failure (a throttled/transient
   * DynamoDB error on the `User` row) is logged and returns `false` WITHOUT
   * attempting the send — mailing a link whose token was never stored would
   * be worse than no mail. A send failure after a successful persist also
   * returns `false` but leaves the persisted token in place: the undo
   * capability itself is not lost, only the mail. Only the error class is logged, never `err.message` —
   * an SES rejection embeds the raw recipient address in its message.
   */
  async notify(args: FactorNoticeArgs): Promise<boolean> {
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256(rawToken);
    const now = new Date();
    let stage: 'persist' | 'send' = 'persist';
    try {
      await this.users.setPendingFactorUndo({
        userId: args.userId,
        tokenHash,
        expiresAt: Math.floor(now.getTime() / 1000) + FACTOR_UNDO_TTL_SEC,
        kind: args.kind,
        now: now.toISOString(),
        ...(args.credentialId !== undefined ? { credentialId: args.credentialId } : {}),
      });
      stage = 'send';
      await this.sendMail(args.email, args.userId, args.kind, rawToken);
      return true;
    } catch (err) {
      this.logger.warn(
        {
          userId: args.userId,
          emailFingerprint: emailFingerprint(args.email),
          stage,
          reason: err instanceof Error ? err.name : 'unknown',
        },
        stage === 'persist'
          ? 'Factor-change undo token persist failed; notice mail not sent'
          : 'Factor-change notice mail dispatch failed',
      );
      return false;
    }
  }

  private async sendMail(
    toAddress: string,
    userId: string,
    kind: FactorUndoKind,
    token: string,
  ): Promise<void> {
    if (!this.sesEnabled) {
      // Local dev: log only a non-reversible email fingerprint, never the
      // raw recipient, token, or link (CODING_STANDARDS "Never log secrets,
      // tokens, or PII").
      this.logger.log(
        { emailFingerprint: emailFingerprint(toAddress) },
        'Factor-change notice generated (local dev)',
      );
      return;
    }
    const link = buildFactorUndoLink(this.webOrigin, userId, token, kind);
    const mail = buildFactorNoticeMail({ kind, link });
    await this.ses.send(
      new SendEmailCommand({
        Source: formatMailSource(this.fromAddress),
        Destination: { ToAddresses: [toAddress] },
        Message: {
          Subject: { Data: mail.subject },
          Body: {
            Text: { Data: mail.text },
            // Composed INLINE here (not via `mail.html`) so the repo's HTML
            // mail-body escaping regression guard can see this
            // interpolation — a value assigned from a separate builder is
            // invisible to it.
            Html: {
              Data: `<p>${escapeHtml(bodyIntro(kind))}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
            },
          },
        },
      }),
    );
  }

  /**
   * Consume an undo token: opaque `{ ok }` regardless of the token's state,
   * so the response reveals nothing about whether a given `userId` /
   * `token` pair is real. `kind` must match the token's
   * stored kind: the landing page's copy — which action it describes to the
   * person and which button it shows — is chosen from an unauthenticated
   * URL-fragment field the server never saw before, so the server requires
   * it back and refuses to act when it disagrees with the stored kind,
   * rather than silently performing whatever the stored kind says. On a
   * genuine, unexpired, still-active, kind-matching token: revokes every
   * session, then commits the kind's action (an `_add` kind deletes the
   * passkey / disables TOTP; a `_remove` kind does nothing here — it is not
   * reversible) together with the pending-undo clear (the single-use gate)
   * in one transaction, and records `factor_undo_consumed`. See the file
   * header for why the three steps run in that order. Any other token state
   * — unknown user, wrong/expired/superseded token, mismatched kind — is
   * `{ ok: false }` with no side effects; a token superseded between the
   * claim and the commit is `{ ok: false }` with the sessions already ended
   * but the factor untouched.
   */
  async consume(args: {
    userId: string;
    token: string;
    kind: FactorUndoKind;
  }): Promise<FactorUndoConsumeResult> {
    const tokenHash = sha256(args.token);
    const nowSec = Math.floor(Date.now() / 1000);

    const claimed = await this.users.claimFactorUndo({
      userId: args.userId,
      presentedTokenHash: tokenHash,
      presentedKind: args.kind,
      nowSec,
      now: new Date().toISOString(),
    });
    if (!claimed) return { ok: false };
    const { kind, credentialId } = claimed;

    await this.sessions.revokeAll({ userId: args.userId });

    const action = this.undoActionItem(args.userId, kind, credentialId);
    const consumed = await this.users.consumeFactorUndo({
      userId: args.userId,
      presentedTokenHash: tokenHash,
      nowSec,
      now: new Date().toISOString(),
      ...(action ? { action } : {}),
    });
    if (!consumed) return { ok: false };

    if (kind === 'totp_add') {
      // Parity with `MfaService.disable`, which the direct disable path
      // audits through — the undo's clear is the same factor change.
      await this.auth.record({ userId: args.userId, eventType: 'mfa_totp_disabled' });
    }
    await this.auth.record({
      userId: args.userId,
      eventType: 'factor_undo_consumed',
      metadata: { kind, ...(credentialId ? { credentialId } : {}) },
    });
    return { ok: true };
  }

  /**
   * The kind's undo action as a `TransactWriteItems` item, for
   * `UsersRepository.consumeFactorUndo` to commit alongside the single-use
   * clear (see the file header). `undefined` for the `_remove` kinds — the
   * removed factor cannot be restored; only the session
   * revoke applies to those.
   */
  private undoActionItem(
    userId: string,
    kind: FactorUndoKind,
    credentialId: string | undefined,
  ): TransactItem | undefined {
    if (kind === 'passkey_add' && credentialId) {
      return this.passkeys.removeTransactItem(userId, credentialId);
    }
    if (kind === 'totp_add') {
      return this.userMfa.clearTotpTransactItem(userId);
    }
    return undefined;
  }
}
