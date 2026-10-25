/**
 * TOTP enrollment screen: shows the QR and base32 secret, collects no code and writes nothing. The parent's last gate
 * modal collects the code, since it is valid for only about a minute.
 */
import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Alert } from './Alert';
import { Muted } from './Muted';
import { ApiRequestError } from '../api/client';
import { btnPrimarySmClass, btnSecondarySmClass } from '../pages/accounts-page-chrome';

export interface TotpEnrollmentProps {
  onCancel: () => void;
  enrollStart: () => Promise<{ secret: string; otpauthUrl: string }>;
  /** The user scanned the QR and pressed Continue; the parent gates and confirms. */
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

  // The QR renders client-side so the shared secret never goes through an image service; a render
  // failure falls back to the manual seed.
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
