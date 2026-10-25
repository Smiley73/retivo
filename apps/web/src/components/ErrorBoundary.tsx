/**
 * Error boundary around the route tree so one broken page does not white-screen the shell. A `ChunkLoadError` (a
 * deploy removed the chunk the SPA still references) gets a dedicated reload prompt instead of the generic fallback.
 */
import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from 'react-aria-components';
import { btnPrimaryClass, btnSecondaryClass } from './dialog-chrome.js';
import { CLIENT_BUILD_ID } from '../lib/build-id.js';
import { recordCaught } from '../lib/diagnostics/logger.js';
import { exportDiagnostics } from '../lib/diagnostics/export.js';
import { RepoLink } from './RepoLink.js';

const RESET_FEEDBACK_MS = 2000;

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  capturedAt: string | null;
  copyState: 'idle' | 'copied' | 'failed';
  exportState: 'idle' | 'exported' | 'failed';
}

function formatErrorReport(state: State): string {
  const lines: string[] = [];
  if (state.error) {
    lines.push(`Type: ${state.error.name}`);
    lines.push(`Message: ${state.error.message}`);
  }
  lines.push(`Build ID: ${CLIENT_BUILD_ID}`);
  if (state.capturedAt !== null) {
    lines.push(`Time: ${state.capturedAt}`);
  }
  lines.push(`Path: ${window.location.pathname}`);
  return lines.join('\n');
}

function isChunkLoadError(err: Error | null): boolean {
  if (!err) return false;
  if (err.name === 'ChunkLoadError') return true;
  // Vite/Rollup surface failed dynamic imports as a TypeError with one of these messages.
  const msg = err.message || '';
  return (
    /dynamically imported module/i.test(msg) ||
    /importing a module script failed/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg)
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div className="flex gap-2.5">
      <dt className="w-20 shrink-0 font-medium text-muted text-sm">
        {label}
      </dt>
      <dd className="m-0 min-w-0 break-words text-ink text-sm">
        {value}
      </dd>
    </div>
  );
}

function FallbackActions({
  copyState,
  exportState,
  onCopy,
  onExport,
}: {
  copyState: 'idle' | 'copied' | 'failed';
  exportState: 'idle' | 'exported' | 'failed';
  onCopy: () => void;
  onExport: () => void;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-3">
      <Button
        className={btnPrimaryClass}
        onPress={() => window.location.reload()}
      >
        Refresh page
      </Button>
      <Button
        className={btnSecondaryClass}
        onPress={() => window.location.assign('/dashboard')}
      >
        Go to dashboard
      </Button>
      <Button className={btnSecondaryClass} onPress={onCopy}>
        {copyState === 'copied'
          ? 'Copied'
          : copyState === 'failed'
            ? 'Copy failed'
            : 'Copy details'}
      </Button>
      <Button className={btnSecondaryClass} onPress={onExport}>
        {exportState === 'exported'
          ? 'Downloaded'
          : exportState === 'failed'
            ? 'Export failed'
            : 'Export diagnostics'}
      </Button>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  private resetTimer: number | null = null;
  private exportResetTimer: number | null = null;

  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      capturedAt: null,
      copyState: 'idle',
      exportState: 'idle',
    };
  }

  static getDerivedStateFromError(error: Error): Pick<State, 'hasError' | 'error'> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Records the catch as exactly one diagnostics entry; `recordCaught` re-emits via the
    // saved-original console.error so the console shim does not double-capture. Never throws into
    // React's lifecycle.
    recordCaught(error, info);
    this.setState({ capturedAt: new Date().toISOString() });
  }

  override componentWillUnmount(): void {
    if (this.resetTimer !== null) window.clearTimeout(this.resetTimer);
    if (this.exportResetTimer !== null) window.clearTimeout(this.exportResetTimer);
  }

  private handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(formatErrorReport(this.state));
      this.setState({ copyState: 'copied' });
    } catch (err) {
      console.warn('ErrorBoundary: clipboard write failed', err);
      this.setState({ copyState: 'failed' });
    }
    if (this.resetTimer !== null) window.clearTimeout(this.resetTimer);
    this.resetTimer = window.setTimeout(() => {
      this.resetTimer = null;
      this.setState({ copyState: 'idle' });
    }, RESET_FEEDBACK_MS);
  };

  private handleExport = async (): Promise<void> => {
    try {
      await exportDiagnostics();
      this.setState({ exportState: 'exported' });
    } catch (err) {
      console.warn('ErrorBoundary: diagnostics export failed', err);
      this.setState({ exportState: 'failed' });
    }
    if (this.exportResetTimer !== null) window.clearTimeout(this.exportResetTimer);
    this.exportResetTimer = window.setTimeout(() => {
      this.exportResetTimer = null;
      this.setState({ exportState: 'idle' });
    }, RESET_FEEDBACK_MS);
  };

  private renderChunkErrorFallback(): ReactNode {
    return (
      <section
        aria-labelledby="chunk-error-heading"
        className="mx-auto max-w-2xl p-8"
      >
        <h1
          id="chunk-error-heading"
          className="mb-3 text-2xl font-semibold text-ink"
        >
          A new version is available
        </h1>
        <p className="text-sm text-muted">
          The page you tried to open isn&apos;t part of the version currently
          running in this tab. Reload to pick up the latest version. Your
          data stays safe locally.
        </p>
        <div className="mt-4">
          <Button
            className={btnPrimaryClass}
            onPress={() => window.location.reload()}
          >
            Reload
          </Button>
        </div>
      </section>
    );
  }

  private renderGenericErrorFallback(): ReactNode {
    const { error, capturedAt, copyState, exportState } = this.state;
    return (
      <section
        aria-labelledby="error-heading"
        className="mx-auto max-w-2xl p-8"
      >
        <h1
          id="error-heading"
          className="mb-3 text-2xl font-semibold text-ink"
        >
          Something went wrong
        </h1>
        <p className="mb-4 text-sm text-muted">
          An unexpected error occurred. Try refreshing the page or go back to
          the dashboard. The details below can include personal information, so
          keep them to yourself: never paste them, or an exported diagnostics
          file, into a public issue. If you need help:{' '}
          <RepoLink kind="issue" />, and describe what happened in your own
          words.
        </p>
        <dl className="mb-6 flex flex-col gap-y-1 rounded-lg border border-line bg-surface-sunken p-4">
          <DetailRow label="Type" value={error?.name ?? '—'} />
          <DetailRow label="Message" value={error?.message ?? '—'} />
          <DetailRow label="Build ID" value={CLIENT_BUILD_ID} />
          <DetailRow label="Time" value={capturedAt ?? '—'} />
          <DetailRow label="Path" value={window.location.pathname} />
        </dl>
        <FallbackActions
          copyState={copyState}
          exportState={exportState}
          onCopy={this.handleCopy}
          onExport={() => void this.handleExport()}
        />
      </section>
    );
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    if (isChunkLoadError(this.state.error)) return this.renderChunkErrorFallback();
    return this.renderGenericErrorFallback();
  }
}
