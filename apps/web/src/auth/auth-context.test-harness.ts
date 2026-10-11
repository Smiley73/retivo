/**
 * Shared scaffolding for the `AuthContext.*.test.tsx` suites. TEST-ONLY.
 *
 * `vi.mock` is hoisted, so every test file must still declare its own
 * `vi.mock(...)` calls. Each is one line and defers to a factory exported
 * here, via a dynamic import of this module (a static import would not be
 * initialised yet when the hoisted factory runs):
 *
 *   vi.mock('../crypto/key-cache', async () => (await import('./auth-context.test-harness')).keyCacheMock());
 *
 * The `vi.fn()` stubs live on `authMocks`; test files destructure the ones
 * they drive (`const { apiRequest, loadCachedHdk } = authMocks;`). The module
 * graph is per test file, so no state leaks between suites.
 */
import { vi } from 'vitest';

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

/** `../api/client`. `onConfigure` receives the options AuthContext passes to `configureApi`. */
export function apiClientMock(onConfigure?: (opts: { getAccessToken: () => string | null }) => void) {
  // Full constructor (status + error) so `new ApiRequestError(400, {...})`
  // carries `.status`/`.error`, which the SUT branches on.
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
    configureApi: (opts: { getAccessToken: () => string | null }) => onConfigure?.(opts),
    ApiRequestError,
  };
}

/** `./key-envelope-client`. */
export function keyEnvelopeClientMock() {
  return {
    getKeyEnvelopes: fwd(() => m.getKeyEnvelopes),
    upsertKeyEnvelopeSlot: fwd(() => m.upsertKeyEnvelopeSlot),
    activateKeyEnvelopes: fwd(() => m.activateKeyEnvelopes),
  };
}

/** `../crypto/key-cache`. */
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

/** `./user-transition` (touches IndexedDB in production; stubbed to a no-op). */
export function userTransitionMock() {
  return {
    clearLastUserId: vi.fn(),
    maybeResetForNewUser: fwd(() => m.maybeResetForNewUser),
    productionDeps: {},
  };
}

/** `@simplewebauthn/browser`. */
export function webauthnBrowserMock() {
  return {
    browserSupportsWebAuthn: () => true,
    startAuthentication: fwd(() => m.startAuthentication),
    startRegistration: fwd(() => m.startRegistration),
  };
}

/** `../crypto/passkey-prf`. */
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
