/**
 * Step-up re-auth orchestration hook (see "Step-up for sensitive actions"
 * in docs/security.md).
 *
 * Owns the client-side flow for proving "it's really you" with a fresh second
 * factor before a sensitive operation: pick a factor → (email-OTP send /
 * passkey options) → verify. Presentational only — kept OUT of `AuthContext`;
 * the actual API calls are INJECTED so the one hook serves change-email
 * (its own send/verify endpoints) and, later, the destructive / factor-
 * management ops (the generic prep endpoints).
 *
 * Retry-safety: a clean 4xx factor rejection is retryable (re-enter a
 * fresh code); an AMBIGUOUS failure — a dropped/timed-out confirm whose factor
 * the server may already have consumed — is surfaced as a NON-retryable error
 * ("recheck before retrying with a fresh code") instead of silently
 * re-submitting a consumed factor.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  startAuthentication,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { ApiRequestError } from '../api/client';
// Import from the origin (`auth/types.ts`), not `auth/AuthContext.tsx`'s
// re-export: `AuthContext.tsx` → `useZeroKnowledgeKey.ts` → this module, so
// importing the re-export would create a dependency-cruiser `no-cycles`
// violation (`useZeroKnowledgeKey.ts` needs `stepUpProofFields` from here).
import type { StepUpPurpose } from '../auth/types';

export type StepUpFactor = 'totp' | 'email_otp' | 'passkey';

/** A verified factor proof handed to the op's confirm/verify endpoint. */
export interface StepUpProof {
  method: StepUpFactor;
  code?: string;
  response?: AuthenticationResponseJSON;
}

/**
 * The wire fields a collected step-up proof contributes to an op's confirm body.
 * Passkey carries `response` and no `code`; the
 * code factors carry `code` only — matching the server DTO's XOR so an unused
 * proof field never rides along. Absent proof (flag-off degrade floor) → `{}`.
 */
export function stepUpProofFields(proof?: StepUpProof): Record<string, unknown> {
  if (!proof) return {};
  return proof.method === 'passkey'
    ? { method: proof.method, response: proof.response }
    : { method: proof.method, code: proof.code };
}

export interface UseStepUpOptions {
  purpose: StepUpPurpose;
  /** Routine factors from the server (strongest first). */
  methods: string[];
  /** Recovery factors from the server. */
  recoveryMethods?: string[];
  /** Email a code for this op (change-email's own send, or the generic prep). */
  onSendEmailOtp: (purpose: StepUpPurpose) => Promise<void>;
  /** Fetch purpose-scoped WebAuthn options for the passkey factor. */
  onPasskeyOptions: (
    purpose: StepUpPurpose,
  ) => Promise<PublicKeyCredentialRequestOptionsJSON>;
  /** Verify the collected proof against the op's confirm/verify endpoint. */
  onVerify: (proof: StepUpProof) => Promise<void>;
  /** Called once after a successful verify. */
  onVerified: () => void;
}

export interface UseStepUpResult {
  /** Every eligible factor (routine + recovery), de-duplicated, order-preserved. */
  availableFactors: StepUpFactor[];
  /** The currently-selected factor. */
  factor: StepUpFactor;
  selectFactor: (f: StepUpFactor) => void;
  code: string;
  setCode: (v: string) => void;
  /** True once an Email-OTP has been requested for this attempt. */
  otpSent: boolean;
  submitting: boolean;
  /** Human error message, or null. */
  error: string | null;
  /** True when `error` is a non-retryable ambiguous failure. */
  nonRetryable: boolean;
  /** Request an Email-OTP (email_otp factor only). */
  sendOtp: () => Promise<void>;
  /** Run the selected factor (passkey prompts WebAuthn; code factors submit `code`). */
  submit: () => Promise<void>;
  /** Reset all transient state (on modal open/close). */
  reset: () => void;
}

const AMBIGUOUS_MESSAGE =
  "We couldn't confirm it's you — the request didn't complete. Recheck before " +
  'trying again with a fresh code or passkey.';

/**
 * True when a verify failure is AMBIGUOUS (the factor may have been consumed
 * server-side) rather than a clean, safe-to-retry factor rejection. A 4xx
 * with a real server error code is a definite rejection; a network/timeout /
 * 5xx / envelope error (the codes `apiRequest` synthesizes) is ambiguous.
 */
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
      // A send failure never consumed a factor — always safe to retry.
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
        // The prep + WebAuthn prompt precede any factor consumption; a failure
        // here is safe to retry.
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
