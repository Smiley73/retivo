/**
 * Diagnostics install/shim tests. Original-fired-first console passthrough,
 * single-entry-per-console-routed-event, idempotent install, window
 * error/rejection → source 'window', recursion guard, uninstall restores.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDiagnostics, uninstallDiagnostics } from './install';
import { clear, getEntries } from './logger';
import { clearDiagnosticLogs, listDiagnosticLogs } from '../../db/store';

describe('installDiagnostics', () => {
  beforeEach(async () => {
    clear();
    await clearDiagnosticLogs();
  });
  afterEach(() => {
    uninstallDiagnostics();
    clear();
    vi.restoreAllMocks();
  });

  it('should_call_the_original_console_method_first_then_capture', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    installDiagnostics();
    console.error('boom', { code: 'X' });
    // Original (spied) fired.
    expect(spy).toHaveBeenCalledWith('boom', { code: 'X' });
    // And exactly one entry was captured.
    const entries = getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('console');
    expect(entries[0].level).toBe('error');
  });

  it('should_record_exactly_one_entry_per_console_routed_warn', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    installDiagnostics();
    console.warn('[sync] heads up');
    const entries = getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].namespace).toBe('sync');
  });

  it('should_be_idempotent_on_double_install', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    installDiagnostics();
    installDiagnostics();
    console.error('once');
    // Double install must not double-capture.
    expect(getEntries()).toHaveLength(1);
  });

  it('should_capture_a_window_error_event_with_source_window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    installDiagnostics();
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'global boom', error: new Error('global boom') }),
    );
    const windowEntries = getEntries().filter((e) => e.source === 'window');
    expect(windowEntries).toHaveLength(1);
  });

  it('should_guard_against_logger_internal_console_recursion', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    installDiagnostics();
    // Re-enter the shim from INSIDE the forward path: this arg's toJSON is
    // invoked by the logger's coalesce-key serialization (while inShim===true)
    // and calls the shimmed console.error again. The recursion guard's true
    // branch must short-circuit that nested call so the loop terminates and the
    // nested call is NOT separately captured.
    let nested = false;
    const reentrant = {
      toJSON(): string {
        if (!nested) {
          nested = true;
          // eslint-disable-next-line no-console -- exercising the recursion guard
          console.error('nested from toJSON');
        }
        return 'reentrant';
      },
    };
    expect(() => console.error('outer', reentrant)).not.toThrow();
    expect(nested).toBe(true);
    // Exactly one captured entry — the nested re-entry was swallowed by the
    // guard, never producing a second entry or looping.
    expect(getEntries().filter((e) => e.source === 'console')).toHaveLength(1);
  });

  it('should_capture_an_unhandledrejection_event_with_source_window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    installDiagnostics();
    // jsdom does not synthesize PromiseRejectionEvent end-to-end; dispatch the
    // event shape the handler reads (type + reason).
    const event = new Event('unhandledrejection') as Event & { reason: unknown };
    event.reason = new Error('rejected boom');
    window.dispatchEvent(event);
    const windowEntries = getEntries().filter((e) => e.source === 'window');
    expect(windowEntries).toHaveLength(1);
    expect(windowEntries[0].message).toContain('Unhandled promise rejection');
  });

  it('should_flush_the_queued_batch_to_idb_on_pagehide', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    installDiagnostics();
    console.error('flush on pagehide');
    window.dispatchEvent(new Event('pagehide'));
    // The pagehide handler fires flush() fire-and-forget; await a microtask turn
    // by flushing directly is redundant — instead await the persisted store.
    await vi.waitFor(async () => {
      expect((await listDiagnosticLogs()).some((r) => r.message === 'flush on pagehide')).toBe(true);
    });
  });

  it('should_flush_the_queued_batch_to_idb_on_visibilitychange_hidden', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    installDiagnostics();
    console.error('flush on hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(async () => {
      expect((await listDiagnosticLogs()).some((r) => r.message === 'flush on hidden')).toBe(true);
    });
    visibilitySpy.mockRestore();
  });

  it('uninstall_should_restore_the_original_console', () => {
    const before = console.error;
    installDiagnostics();
    expect(console.error).not.toBe(before);
    uninstallDiagnostics();
    expect(console.error).toBe(before);
  });
});
