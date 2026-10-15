/**
 * React entry point.
 *
 * Provider order:
 *   BrowserRouter
 *     AuthProvider                  (owns access-token + JWT claims)
 *       AuthAwareProviders          (re-keys Theme + Sync with claims after login)
 *         App
 *
 * ThemeProvider lives inside AuthProvider so it can re-key on login
 * (one localStorage namespace per user). SyncProvider needs the JWT's
 * householdId, so it also lives inside AuthProvider.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import { sweepLegacySignupProfileKeys } from './auth/session-storage';
import { AuthAwareProviders } from './AuthAwareProviders';
import { installDiagnostics } from './lib/diagnostics/install';
import { MAX_PERSISTED } from './lib/diagnostics/logger';
import { pruneDiagnosticLogs } from './db/store';
import './styles.css';

// Install the on-device diagnostics capture (console shim + global error
// handlers) BEFORE React mounts so boot-time output/errors are captured too.
installDiagnostics();

// Startup backstop prune: trim the persisted diagnostics store back to the
// cap once on boot. The append-time prune already bounds growth, but a crash
// mid-append or a cross-tab write can leave the store slightly over — a one-shot
// fire-and-forget prune keeps it bounded. Guarded so it never throws into boot
// (IDB unavailable in private mode, etc.).
void pruneDiagnosticLogs(MAX_PERSISTED).catch(() => {
  /* must-not-throw into boot — append-time prune still bounds the store */
});

// Remove the retired signup name/birthdate keys earlier builds left in
// localStorage. Remove-only and must-not-throw, so it runs whether or not
// anyone is signed in.
sweepLegacySignupProfileKeys();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <AuthAwareProviders>
          <App />
        </AuthAwareProviders>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
