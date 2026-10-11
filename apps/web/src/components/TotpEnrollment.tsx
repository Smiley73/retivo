/**
 * Guided TOTP (authenticator-app) enrollment, shown
 * inside the Security 2FA card. A small internal state machine:
 *
 *   1. start    — call `enrollStart()` on mount → pending secret + otpauth URL.
 *   2. scan     — render the QR (rendered CLIENT-SIDE via `qrcode.toDataURL` so
 *                 the secret never round-trips an image service) + the raw
 *                 base32 secret for manual entry, then a Continue button.
 *
 * This screen collects NO code and performs NO write. Continue hands off to
 * `onContinue`, and the parent (`TwoFactorCard`) opens the password (+ step-up,
 * when enforced) gate; the live 6-digit code is typed in whichever of those
 * modals is the LAST step, so it is seconds old when that modal's own submit
 * performs the real `enrollTotpConfirm(code, password, proof)` write
 * A TOTP code is valid for only ~a minute
 * (server tolerance ±30 s), so it must be the last thing collected — an
 * emailed step-up code alone can take longer than that to arrive. Scanning,
 * the slow part, happens here BEFORE any proof is collected, so no proof's
 * TTL is spent on it.
 *
 * React Aria primitives + the shared form chrome; no raw color classes.
 */
import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Alert } from './Alert';
import { Muted } from './Muted';
import { ApiRequestError } from '../api/client';
import { btnPrimarySmClass, btnSecondarySmClass } from '../pages/accounts-page-chrome';

export interface TotpEnrollmentProps {
  /** Back out without enrolling. */
  onCancel: () => void;
  /** Begin enrollment: returns the base32 secret + the otpauth URL for the QR. */
  enrollStart: () => Promise<{ secret: string; otpauthUrl: string }>;
  /**
   * The person has scanned the QR / entered the key and pressed Continue —
   * hands off to the parent to gate + confirm (see the header comment). The
   * code itself is collected by the parent's last gate modal, not here.
   */
  onContinue: () => void;
}

type Phase = 'starting' | 'scan' | 'error';

export const TotpEnrollment: React.FC<TotpEnrollmentProps> = ({
  onCancel,
  enrollStart,
  onContinue,
}) => {
  const [phase, setPhase] = useState<Phase>('starting');
  const [secret, setSecret] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Begin enrollment on mount. The otpauth URL is rendered to a QR client-side
  // (qrcode.toDataURL) so the shared secret never leaves the browser via an
  // image service. A QR-render failure is non-fatal: the manual base32 seed is
  // always shown as the fallback.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { secret: s, otpauthUrl } = await enrollStart();
        if (cancelled) return;
        setSecret(s);
        setPhase('scan');
        try {
          const url = await QRCode.toDataURL(otpauthUrl);
          if (!cancelled) setQrDataUrl(url);
        } catch {
          // QR render failed — leave qrDataUrl null; the manual seed covers it.
        }
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiRequestError
            ? err.error.message
            : 'We could not start authenticator setup. Please try again.',
        );
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enrollStart]);

  if (phase === 'starting') {
    return <Muted as="p">Starting authenticator setup…</Muted>;
  }

  if (phase === 'error') {
    return (
      <div>
        {error && <Alert tone="error">{error}</Alert>}
        <button type="button" className={btnSecondarySmClass} onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="m-0 mb-3 text-sm text-ink">
        Scan this QR code with your authenticator app (such as Google
        Authenticator or 1Password). Once the app shows a 6-digit code,
        continue to confirm.
      </p>

      {qrDataUrl ? (
        <img
          src={qrDataUrl}
          alt="QR code for setting up your authenticator app"
          className="mb-3 size-44 rounded-md border border-line bg-surface p-2"
        />
      ) : (
        <Muted as="p" className="mb-3">
          Couldn&rsquo;t draw the QR code. Enter the setup key below into your
          authenticator app by hand instead.
        </Muted>
      )}

      <div className="mb-3">
        <span className={'mb-1 block text-sm font-medium text-ink'}>
          Or enter this setup key manually
        </span>
        <code className="block break-all rounded-md border border-line-strong bg-surface p-2 font-mono text-sm tracking-wider text-ink">
          {secret}
        </code>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={btnPrimarySmClass} onClick={onContinue}>
          Continue
        </button>
        <button type="button" className={btnSecondarySmClass} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
};
