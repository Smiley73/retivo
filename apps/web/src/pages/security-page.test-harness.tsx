/**
 * Shared scaffolding for the `SecurityPage.*.test.tsx` suites. TEST-ONLY.
 *
 * `vi.mock` is hoisted, so each test file keeps its own one-line `vi.mock(...)`
 * calls, which defer to the factories below through a dynamic import (a static
 * import would not be initialised when the hoisted factory runs):
 *
 *   vi.mock('../db/store', async () => (await import('./security-page.test-harness')).dbStoreMock());
 *
 * The spies the cases assert on live on `securityMocks`; `renderPage` mounts the
 * page with `useAuth()` returning `securityAuthValue`.
 */
import { render } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';
import { beforeAll, vi } from 'vitest';
import { mfaAuthDefaults } from './profile-test-mfa';

export const securityMocks = {
  useAuth: vi.fn(),
  mockNavigate: vi.fn(),
  notifyPendingMock: vi.fn(),
  syncRoundTripMock: vi.fn().mockResolvedValue({ ok: true }),
  forceRefreshMock: vi.fn().mockResolvedValue({ ok: true, wiped: true }),
  recacheHdkMock: vi.fn().mockResolvedValue(undefined),
};

/** `react-router` with only `useNavigate` replaced. */
export async function reactRouterMock() {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => securityMocks.mockNavigate };
}

export function dbStoreMock() {
  return {
    dropLocalDatabase: vi.fn().mockResolvedValue(undefined),
    listPendingMutations: vi.fn().mockResolvedValue([]),
    clearAllStores: vi.fn().mockResolvedValue(undefined),
    clearSelectedScenario: vi.fn().mockResolvedValue(undefined),
    listAggregates: vi.fn().mockResolvedValue([]),
  };
}

export function localDataMock() {
  return { clearAllLocalData: vi.fn().mockResolvedValue(undefined) };
}

export function monteCarloCacheMock() {
  return { clearMonteCarloCache: vi.fn().mockResolvedValue(undefined) };
}

export function demoDataLoaderMock() {
  return {
    loadDemoData: vi.fn().mockResolvedValue({}),
    wipeWorkspaceForDemoReload: vi.fn().mockResolvedValue({
      deletedAccounts: 0,
      deletedBalances: 0,
      deletedSocialSecurity: 0,
      deletedMembers: 0,
    }),
    DemoDataExistsError: class DemoDataExistsError extends Error {
      constructor() {
        super(
          'Workspace already has household or account data. Demo data can only be loaded into an empty workspace.',
        );
        this.name = 'DemoDataExistsError';
      }
    },
  };
}

/** `../api/client`. `extra` adds exports a particular suite needs (e.g. `getCurrentAccessToken`). */
export function apiClientMock(extra: Record<string, unknown> = {}) {
  return {
    apiRequest: vi.fn(),
    // Full constructor (status + error), so `new ApiRequestError(...)` carries both.
    ApiRequestError: class ApiRequestError extends Error {
      constructor(
        public status: number,
        public error: { code: string; message: string },
      ) {
        super(error?.message);
      }
    },
    configureApi: vi.fn(),
    ...extra,
  };
}

export function authContextMock() {
  return {
    useAuth: securityMocks.useAuth,
    AuthProvider: ({ children }: { children: unknown }) => children,
    DEVICE_ID_STORAGE_KEY: 'retivo.auth.deviceId',
  };
}

export function themeContextMock() {
  return { useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) };
}

export function syncContextMock() {
  return {
    useSync: () => ({
      notifyPending: securityMocks.notifyPendingMock,
      syncRoundTrip: securityMocks.syncRoundTripMock,
      forceRefresh: securityMocks.forceRefreshMock,
    }),
  };
}

export async function dataExportMock() {
  const actual = await vi.importActual<typeof import('../lib/data-export')>('../lib/data-export');
  return { ...actual, exportData: vi.fn().mockResolvedValue(undefined) };
}

export async function dataImportMock() {
  const actual = await vi.importActual<typeof import('../lib/data-import')>('../lib/data-import');
  return {
    ...actual,
    parseImportFile: vi.fn(),
    validateBundle: vi.fn(),
    applyImport: vi.fn(),
  };
}

export function keyEnvelopeClientMock() {
  return {
    resetEncryptedWorkspace: vi.fn().mockResolvedValue(undefined),
    getKeyEnvelopes: vi.fn().mockResolvedValue({
      slots: [],
      envelopeSetVersion: 0,
      envelopeSetTag: '',
    }),
  };
}

/**
 * The default `useAuth()` value. `extra` is merged before the MFA defaults and
 * `overrides` after them, which is the order every suite used inline.
 */
export function securityAuthValue(extra: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    me: { id: 'u-1', email: 'me@local.test', displayName: 'Me', roles: ['member'] },
    householdId: 'hh-1',
    isAuthenticated: true,
    isBooting: false,
    login: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn().mockResolvedValue(undefined),
    verifyPassword: vi.fn().mockResolvedValue(undefined),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
    registerPasskey: vi.fn(),
    listPasskeys: vi.fn().mockResolvedValue([]),
    removePasskey: vi.fn(),
    enrollPasskeyForEncryption: vi.fn().mockResolvedValue(undefined),
    recacheHdk: securityMocks.recacheHdkMock,
    hasRole: () => true,
    ...extra,
    ...mfaAuthDefaults(),
    ...overrides,
  };
}

// The factories above run while the page's modules are still being mocked, so a static import of the page here would cycle. Suites import this file before any mocked module: first loaded from inside the AuthContext factory, it mounted the page on the real AuthContext.
let SecurityPage: ComponentType;
let MemoryRouter: ComponentType<{ children: ReactNode }>;
beforeAll(async () => {
  ({ SecurityPage } = await import('./SecurityPage'));
  ({ MemoryRouter } = await import('react-router'));
});

export function renderPage(extra: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  securityMocks.useAuth.mockReturnValue(securityAuthValue(extra, overrides));
  return render(<MemoryRouter><SecurityPage /></MemoryRouter>);
}
