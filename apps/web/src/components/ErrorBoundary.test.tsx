import { act, fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ISSUES_URL } from '../lib/brand';
import { expectNoA11yViolations } from '../test/a11y';
import { clear, getEntries } from '../lib/diagnostics/logger';
import { exportDiagnostics } from '../lib/diagnostics/export';

vi.mock('../lib/diagnostics/export', () => ({
  exportDiagnostics: vi.fn().mockResolvedValue(undefined),
}));

const Thrower = () => {
  throw new Error('Test error');
};

describe('ErrorBoundary', () => {
  let origClipboardDescriptor: PropertyDescriptor | undefined;
  let origLocationDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    origClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    origLocationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origClipboardDescriptor !== undefined) {
      Object.defineProperty(navigator, 'clipboard', origClipboardDescriptor);
    } else {
      // cast: restoring a non-enumerable browser property not in the Navigator type
      delete (navigator as any).clipboard;
    }
    if (origLocationDescriptor !== undefined) {
      Object.defineProperty(window, 'location', origLocationDescriptor);
    }
  });

  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <div data-testid="content">Hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('renders fallback when child throws', () => {
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh page/i })).toBeInTheDocument();
  });

  it('points reporting at the GitHub issue tracker, with no support wording', () => {
    const { container } = render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );
    const link = screen.getByRole('link', { name: 'Report an issue on GitHub' });
    expect(link).toHaveAttribute('href', ISSUES_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.textContent).not.toMatch(/support/i);
  });

  it('renders custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom">Custom fallback</div>}>
        <Thrower />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('custom')).toBeInTheDocument();
  });

  it('renders the new-version reload prompt for ChunkLoadError', () => {
    const ChunkThrower = () => {
      const err = new Error('Loading chunk 42 failed');
      err.name = 'ChunkLoadError';
      throw err;
    };
    render(
      <ErrorBoundary>
        <ChunkThrower />
      </ErrorBoundary>,
    );
    const body = screen.getByText(/new version is available/i)
      .nextElementSibling as HTMLElement;
    expect(body).toHaveClass('text-sm');
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('fallback has no a11y violations', async () => {
    const { container } = render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );
    await expectNoA11yViolations(container);
  });

  it('treats Vite "dynamically imported module" failure as a chunk error', () => {
    const ImportFailure = () => {
      throw new Error('Failed to fetch dynamically imported module: /assets/x.js');
    };
    render(
      <ErrorBoundary>
        <ImportFailure />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/new version is available/i)).toBeInTheDocument();
  });

  it('shows all five field labels by default (no toggle required)', () => {
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Message')).toBeInTheDocument();
    expect(screen.getByText('Build ID')).toBeInTheDocument();
    expect(screen.getByText('Time')).toBeInTheDocument();
    expect(screen.getByText('Path')).toBeInTheDocument();
  });

  it('Message value cell carries break-words for long messages', () => {
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );
    const messageDt = screen.getByText('Message');
    const messageDd = messageDt.nextElementSibling;
    expect(messageDd).not.toBeNull();
    expect(messageDd).toHaveClass('break-words');
  });

  it('intro paragraph and detail rows carry text-sm', () => {
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );
    const intro = screen
      .getByText(/An unexpected error occurred/)
      .closest('p');
    expect(intro).toHaveClass('text-sm');

    const typeDt = screen.getByText('Type');
    expect(typeDt).toHaveClass('text-sm');
  });

  it('Path shows pathname only — no query string', () => {
    window.history.pushState({}, '', '/x?token=abc');
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );
    const pathDt = screen.getByText('Path');
    const pathDd = pathDt.nextElementSibling;
    expect(pathDd).not.toBeNull();
    expect(pathDd?.textContent).toBe('/x');
    expect(pathDd?.textContent).not.toContain('token');
    window.history.pushState({}, '', '/');
  });

  it('Copy details — success path writes expected bundle and transitions to Copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    window.history.pushState({}, '', '/test-path');

    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: /copy details/i }));
    await screen.findByRole('button', { name: /copied/i });

    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0]![0] as string;
    expect(payload).toMatch(/^Type:/m);
    expect(payload).toMatch(/^Message:/m);
    expect(payload).toMatch(/^Build ID:/m);
    expect(payload).toMatch(/^Path: \/test-path$/m);
    expect(payload).not.toContain('token');

    window.history.pushState({}, '', '/');
  });

  it('Copy details — success path auto-resets to "Copy details" after 2000ms', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: /copy details/i }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('button', { name: /copy details/i })).toBeInTheDocument();

    vi.useRealTimers();
  });

  it('Copy details — failure path shows "Copy failed"', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: /copy details/i }));
    await screen.findByRole('button', { name: /copy failed/i });
  });

  it('Copy bundle includes Time line once componentDidCatch lands the ISO value', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );

    await act(async () => {});
    const timeDt = screen.getByText('Time');
    const timeDd = timeDt.nextElementSibling;
    expect(timeDd?.textContent).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    fireEvent.click(screen.getByRole('button', { name: /copy details/i }));
    await screen.findByRole('button', { name: /copied/i });

    const payload = writeText.mock.calls[0]![0] as string;
    expect(payload).toMatch(/^Time: \d{4}-\d{2}-\d{2}T/m);
    expect(payload).not.toContain('null');
  });

  it('Go to dashboard calls window.location.assign with /dashboard', () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });

    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: /go to dashboard/i }));
    expect(assignSpy).toHaveBeenCalledWith('/dashboard');
  });

  it('records exactly one boundary entry and re-emits to devtools', async () => {
    clear();
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );
    await act(async () => {});
    const boundary = getEntries().filter((e) => e.source === 'boundary');
    expect(boundary).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
    clear();
  });

  it('Export diagnostics — triggers the export and transitions to Downloaded', async () => {
    vi.mocked(exportDiagnostics).mockClear();
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /export diagnostics/i }));
    await screen.findByRole('button', { name: /downloaded/i });
    expect(exportDiagnostics).toHaveBeenCalledTimes(1);
  });
});
