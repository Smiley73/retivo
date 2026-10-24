// React entry point. Provider order: BrowserRouter > AuthProvider > AuthAwareProviders > App.
// Theme and Sync sit inside AuthProvider because they re-key on the signed-in user's claims.
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

// Install before React mounts so boot-time output and errors are captured.
installDiagnostics();

// Backstop prune: a crash mid-append or a cross-tab write can leave the store over the cap.
void pruneDiagnosticLogs(MAX_PERSISTED).catch(() => {
  /* must-not-throw into boot — append-time prune still bounds the store */
});

// Sweep legacy signup profile keys from localStorage; runs whether or not anyone is signed in.
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
