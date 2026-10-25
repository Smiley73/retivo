/**
 * Step-up re-auth hook with injected API calls; a clean 4xx is retryable, an ambiguous failure (factor possibly
 * consumed) is not. See "Step-up for sensitive actions" in docs/security.md.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  startAuthentication,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { ApiRequestError } from '../api/client';
// Imported from the origin, not the `AuthContext` re-export, which would create a `no-cycles`
// violation via `useZeroKnowledgeKey.ts`.
import type { StepUpPurpose } from '../auth/types';

export type StepUpFactor = 'totp' | 'email_otp' | 'passkey';

export interface StepUpProof {
  method: StepUpFactor;
  code?: string;
  response?: AuthenticationResponseJSON;
}

/**
 * Wire fields a collected proof contributes to a confirm body: `response` for a passkey, `code` for
 * code factors, `{}` when absent.
 */
export function stepUpProofFields(proof?: StepUpProof): Record<string, unknown> {
  if (!proof) return {};
  return proof.method === 'passkey'
    ? { method: proof.method, response: proof.response }
    : { method: proof.method, code: proof.code };
}

export interface UseStepUpOptions {
  purpose: StepUpPurpose;
  methods: string[];
  recoveryMethods?: string[];
  onSendEmailOtp: (purpose: StepUpPurpose) => Promise<void>;
  onPasskeyOptions: (
    purpose: StepUpPurpose,
  ) => Promise<PublicKeyCredentialRequestOptionsJSON>;
  onVerify: (proof: StepUpProof) => Promise<void>;
  onVerified: () => void;
}

export interface UseStepUpResult {
  availableFactors: StepUpFactor[];
  factor: StepUpFactor;
  selectFactor: (f: StepUpFactor) => void;
  code: string;
  setCode: (v: string) => void;
  otpSent: boolean;
  submitting: boolean;
  error: string | null;
  nonRetryable: boolean;
  sendOtp: () => Promise<void>;
  submit: () => Promise<void>;
  reset: () => void;
}

const AMBIGUOUS_MESSAGE =
  "We couldn't confirm it's you — the request didn't complete. Recheck before " +
  'trying again with a fresh code or passkey.';

// A 4xx with a real server error code is a definite rejection; network, timeout, 5xx and envelope
// errors are ambiguous.
function isAmbiguousFailure(err: unknown): boolean {
  if (err instanceof ApiRequestError) {
    if (err.status >= 400 && err.status < 500) {
      return err.error.code === 'UNKNOWN_ERROR' || err.error.code === 'INVALID_RESPONSE';
    }
    return true; // 5xx / status 0 network failure
  }
  return true; // non-Api error thrown mid-confirm — treat as ambiguous
}

function dedupeFactors(methods: string[], recovery: string[]): StepUpFactor[] {
  const all = [...methods, ...recovery].filter((m): m is StepUpFactor =>
    m === 'totp' || m === 'email_otp' || m === 'passkey',
  );
  return Array.from(new Set(all));
}

export function useStepUp(options: UseStepUpOptions): UseStepUpResult {
  const {
    purpose,
    methods,
    recoveryMethods,
    onSendEmailOtp,
    onPasskeyOptions,
    onVerify,
    onVerified,
  } = options;

  const availableFactors = useMemo(
    () => dedupeFactors(methods, recoveryMethods ?? []),
    [methods, recoveryMethods],
  );

  const [factor, setFactor] = useState<StepUpFactor>(
    () => availableFactors[0] ?? 'email_otp',
  );
  const [code, setCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonRetryable, setNonRetryable] = useState(false);

  const reset = useCallback(() => {
    setFactor(availableFactors[0] ?? 'email_otp');
    setCode('');
    setOtpSent(false);
    setSubmitting(false);
    setError(null);
    setNonRetryable(false);
  }, [availableFactors]);

  const selectFactor = useCallback((f: StepUpFactor) => {
    setFactor(f);
    setCode('');
    setOtpSent(false);
    setError(null);
    setNonRetryable(false);
  }, []);

  const sendOtp = useCallback(async () => {
    setError(null);
    setNonRetryable(false);
    setSubmitting(true);
    try {
      await onSendEmailOtp(purpose);
      setOtpSent(true);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.error.message
          : 'Could not send a code. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }, [onSendEmailOtp, purpose]);

  const submit = useCallback(async () => {
    setError(null);
    setNonRetryable(false);
    setSubmitting(true);
    try {
      if (factor === 'passkey') {
        // The prep and WebAuthn prompt precede any factor consumption, so a failure is safe to
        // retry.
        let response: AuthenticationResponseJSON;
        try {
          const optionsJSON = await onPasskeyOptions(purpose);
          response = await startAuthentication({ optionsJSON });
        } catch (err) {
          setError(
            err instanceof ApiRequestError
              ? err.error.message
              : 'Could not use your passkey. Try again or pick another factor.',
          );
          return;
        }
        await onVerify({ method: 'passkey', response });
      } else {
        await onVerify({ method: factor, code: code.trim() });
      }
      onVerified();
    } catch (err) {
      if (isAmbiguousFailure(err)) {
        setNonRetryable(true);
        setError(AMBIGUOUS_MESSAGE);
      } else {
        setError(
          err instanceof ApiRequestError
            ? err.error.message
            : 'Could not verify. Please try again.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  }, [factor, code, onPasskeyOptions, onVerify, onVerified, purpose]);

  return {
    availableFactors,
    factor,
    selectFactor,
    code,
    setCode,
    otpSent,
    submitting,
    error,
    nonRetryable,
    sendOtp,
    submit,
    reset,
  };
}
