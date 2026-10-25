// Shared scaffolding for the `AuthContext.*.test.tsx` suites. `vi.mock` is hoisted into each test file, so each file
// declares its own one-line mocks that defer to a factory here via a dynamic import (a static one is not initialised yet).
// For the same reason `AuthContext` is imported lazily in `renderAuth`: a static import would deadlock the mock factories.
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import type * as AuthContextModule from './AuthContext';

type AnyFn = (...args: unknown[]) => unknown;
// Same shape as a bare `vi.fn()`, so tests may install any implementation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Procedure = (...args: any[]) => any;

export const authMocks = {
  apiRequest: vi.fn(),
  getKeyEnvelopes: vi.fn(),
  upsertKeyEnvelopeSlot: vi.fn(),
  activateKeyEnvelopes: vi.fn(),
  loadCachedHdk: vi.fn(),
  cacheHdk: vi.fn(),
  clearCachedHdk: vi.fn(),
  unwrapSlot: vi.fn(),
  verifyEnvelopeSetTag: vi.fn(),
  unwrapPrfSlot: vi.fn(),
  generateHdk: vi.fn(),
  generatePasswordSlot: vi.fn(),
  generateRecoverySlot: vi.fn(),
  generatePasskeyPrfSlot: vi.fn(),
  computeEnvelopeSetTag: vi.fn(),
  readEnvelopeSetPin: vi.fn<Procedure>(async () => 0),
  writeEnvelopeSetPin: vi.fn<Procedure>(async () => undefined),
  raiseEnvelopeSetPinFloor: vi.fn(),
  maybeResetForNewUser: vi.fn<Procedure>(async () => undefined),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  addPrfEvalToOptions: vi.fn(),
  derivePrfWrapKey: vi.fn(),
  extractPrfResult: vi.fn(),
  generatePrfSalt: vi.fn(),
};

const m = authMocks;
/** Forward to a stub looked up at call time, so `mockReset` etc. still apply. */
const fwd =
  (pick: () => AnyFn): AnyFn =>
  (...a) =>
    pick()(...a);

let tokenGetter: () => string | null = () => null;

/** The access-token getter AuthContext last passed to `configureApi`. */
export function liveAccessToken(): string | null {
  return tokenGetter();
}

export function resetLiveAccessToken(): void {
  tokenGetter = () => null;
}

export function apiClientMock() {
  // Carries `.status`/`.error`, which the SUT branches on.
  class ApiRequestError extends Error {
    constructor(
      public status: number,
      public error: { code: string; message: string },
    ) {
      super(error?.message);
    }
  }
  return {
    apiRequest: fwd(() => m.apiRequest),
    configureApi: (opts: { getAccessToken: () => string | null }) => {
      tokenGetter = opts.getAccessToken;
    },
    ApiRequestError,
  };
}

export function keyEnvelopeClientMock() {
  return {
    getKeyEnvelopes: fwd(() => m.getKeyEnvelopes),
    upsertKeyEnvelopeSlot: fwd(() => m.upsertKeyEnvelopeSlot),
    activateKeyEnvelopes: fwd(() => m.activateKeyEnvelopes),
  };
}

export function keyCacheMock() {
  return {
    loadCachedHdk: fwd(() => m.loadCachedHdk),
    cacheHdk: fwd(() => m.cacheHdk),
    clearCachedHdk: fwd(() => m.clearCachedHdk),
  };
}

/** `../crypto/key-wrapping`. Classes are built inside so they are never in the TDZ. */
export function keyWrappingMock() {
  class KeyWrappingError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'KeyWrappingError';
    }
  }
  class EnvelopeSetRollbackError extends KeyWrappingError {
    constructor(
      public readonly servedVersion: number,
      public readonly pinnedVersion: number,
    ) {
      super(`rollback: served ${servedVersion} < pinned ${pinnedVersion}`);
      this.name = 'EnvelopeSetRollbackError';
    }
  }
  return {
    unwrapSlot: fwd(() => m.unwrapSlot),
    verifyEnvelopeSetTag: fwd(() => m.verifyEnvelopeSetTag),
    unwrapPrfSlot: fwd(() => m.unwrapPrfSlot),
    generateHdk: fwd(() => m.generateHdk),
    generatePasswordSlot: fwd(() => m.generatePasswordSlot),
    generateRecoverySlot: fwd(() => m.generateRecoverySlot),
    generatePasskeyPrfSlot: fwd(() => m.generatePasskeyPrfSlot),
    computeEnvelopeSetTag: fwd(() => m.computeEnvelopeSetTag),
    isEnvelopeSetRollback: (servedVersion: number, pinnedVersion: number) => servedVersion < pinnedVersion,
    isStrictEncryptedEnvelope: () => false,
    readEnvelopeSetPin: fwd(() => m.readEnvelopeSetPin),
    writeEnvelopeSetPin: fwd(() => m.writeEnvelopeSetPin),
    raiseEnvelopeSetPinFloor: fwd(() => m.raiseEnvelopeSetPinFloor),
    KeyWrappingError,
    EnvelopeSetRollbackError,
  };
}

export function userTransitionMock() {
  return {
    clearLastUserId: vi.fn(),
    maybeResetForNewUser: fwd(() => m.maybeResetForNewUser),
    productionDeps: {},
  };
}

export function webauthnBrowserMock() {
  return {
    browserSupportsWebAuthn: () => true,
    startAuthentication: fwd(() => m.startAuthentication),
    startRegistration: fwd(() => m.startRegistration),
  };
}

export function passkeyPrfMock() {
  return {
    addPrfEvalToOptions: fwd(() => m.addPrfEvalToOptions),
    derivePrfWrapKey: fwd(() => m.derivePrfWrapKey),
    extractPrfResult: fwd(() => m.extractPrfResult),
    generatePrfSalt: fwd(() => m.generatePrfSalt),
  };
}

export function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A structurally valid JWT (the SUT only decodes the body, it never verifies). */
export function jwt(claims: { userId: string; householdId: string; deviceId?: string; email?: string }): string {
  const header = b64url({ alg: 'none' });
  const body = b64url({ deviceId: 'dev-1', email: 'u@test.com', ...claims });
  return `${header}.${body}.sig`;
}

export const fakeHdk = { algorithm: { name: 'AES-GCM' } } as unknown as CryptoKey;

let authModule: typeof AuthContextModule;

export let captured: ReturnType<typeof AuthContextModule.useAuth>;

/** Mirrors the latest `useAuth()` value into `captured` and the reactive flags into the DOM. */
export function Probe(): React.ReactElement {
  const auth = authModule.useAuth();
  captured = auth;
  return (
    <div>
      <span data-testid="isAuthenticated">{String(auth.isAuthenticated)}</span>
      <span data-testid="isUnlocked">{String(auth.isUnlocked)}</span>
      <span data-testid="needsKeySetup">{String(auth.needsKeySetup)}</span>
      <span data-testid="unlockResolved">{String(auth.unlockResolved)}</span>
      <span data-testid="lockedEnvelopeSetEmpty">{String(auth.lockedEnvelopeSetEmpty)}</span>
      <span data-testid="householdId">{auth.householdId ?? ''}</span>
    </div>
  );
}

export function flag(id: string): string {
  return screen.getByTestId(id).textContent ?? '';
}

/** Mounts the provider without touching `apiRequest`, for tests whose boot refresh succeeds. */
export async function mountAuth(): Promise<void> {
  authModule = await import('./AuthContext');
  render(
    <authModule.AuthProvider>
      <Probe />
    </authModule.AuthProvider>,
  );
}

/** Mounts the provider with the boot refresh failing, and waits until it settles signed out. */
export async function renderAuth(): Promise<void> {
  authMocks.apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    throw new Error(`unexpected api call ${path}`);
  });
  await mountAuth();
  await waitFor(() => expect(captured.isAuthenticated).toBe(false));
}

/** Sign in as a fresh user with an empty (no-encryption) key-envelope set. */
export async function loginAsU1(): Promise<void> {
  authMocks.apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/auth/refresh') throw new Error('no session');
    if (path === '/api/v1/auth/login') {
      return { accessToken: jwt({ userId: 'u1', householdId: 'hh-1' }), expiresIn: 3600 };
    }
    throw new Error(`unexpected api call ${path}`);
  });
  authMocks.loadCachedHdk.mockResolvedValue(null);
  authMocks.getKeyEnvelopes.mockResolvedValue({ slots: [], envelopeSetVersion: 0, envelopeSetTag: '' });
  await act(async () => {
    await captured.login('u@test.com', 'pw');
  });
  await waitFor(() => expect(flag('isAuthenticated')).toBe('true'));
  expect(liveAccessToken()).toBeTruthy();
}
