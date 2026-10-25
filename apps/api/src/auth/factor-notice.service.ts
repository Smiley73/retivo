// Factor-change notice and single-use undo, the detection-and-recovery half of the defence against a hijacked session enrolling its own factor
// (`FactorEnrollmentGuardService` is the gate half).
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

// Undo-link validity; the notice says it expires in 24 hours.
const FACTOR_UNDO_TTL_SEC = 24 * 60 * 60;

export interface FactorNoticeArgs {
  userId: string;
  email: string;
  kind: FactorUndoKind;
  /**
   * The passkey this change concerns: the `_add` consume deletes it; `_remove` carries it for the audit trail only.
   */
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
   * Mints the single-use undo token, persists it on the User row (overwriting any pending one: one outstanding undo
   * per account), then sends the notice mail best-effort. Returns whether the mail was handed off, so the UI never
   * says an email went out when it did not. Called after the factor change committed, so nothing may reject into that
   * response: a persist failure returns false without sending (a link for an unstored token is worse than no mail),
   * and a send failure keeps the stored token. Only the error class is logged; an SES rejection embeds the recipient
   * address.
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
      // Local dev: log only a non-reversible email fingerprint, never the recipient, token or link (CODING_STANDARDS
      // "Never log secrets, tokens, or PII").
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
            // Composed inline, not via `mail.html`, so the HTML mail-body escaping regression guard can see the
            // interpolation.
            Html: {
              Data: `<p>${escapeHtml(bodyIntro(kind))}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
            },
          },
        },
      }),
    );
  }

  /**
   * Consumes an undo token with an opaque `{ ok }` regardless of state, so it reveals nothing about whether a
   * `userId` and token pair is real. `kind` must match the stored kind: the landing page copy comes from an
   * unauthenticated URL-fragment field, so the server refuses to act on a disagreement. Steps, in this order: (1)
   * `claimFactorUndo` re-validates the token and captures `(kind, credentialId)`, keeping an unknown, expired or
   * superseded token from ending any session; (2) `SessionRevocationService.revokeAll`, idempotent and before the
   * single-use gate, so a failure leaves the token valid and the same link safely re-runs; (3) `consumeFactorUndo`
   * commits the action (an `_add` kind deletes the passkey or disables TOTP; `_remove` does nothing) and the
   * single-use clear in one conditioned transaction. The claim is validation at one instant, not a lock, so a token
   * superseded in between yields `{ ok: false }` with sessions ended but the factor untouched. Records
   * `factor_undo_consumed`.
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
      // Parity with `MfaService.disable`: the undo clear is the same factor change.
      await this.auth.record({ userId: args.userId, eventType: 'mfa_totp_disabled' });
    }
    await this.auth.record({
      userId: args.userId,
      eventType: 'factor_undo_consumed',
      metadata: { kind, ...(credentialId ? { credentialId } : {}) },
    });
    return { ok: true };
  }

  // The kind undo action as a transact item for `consumeFactorUndo`; undefined for `_remove`, which cannot restore the
  // factor.
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
