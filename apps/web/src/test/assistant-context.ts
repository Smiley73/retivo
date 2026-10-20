/**
 * Builders for the shell tests that stand in for `useAssistant()`: a connected session value and
 * an audit entry, with every field the components read given a sensible default.
 */
import { vi } from 'vitest';
import type { AssistantContextValue } from '../assistant/AssistantContext';
import type { AuditEntry } from '../assistant/audit-log';

export function assistantValue(overrides: Partial<AssistantContextValue> = {}): AssistantContextValue {
  return {
    offered: true,
    port: 24580,
    optedIn: true,
    setOptedIn: vi.fn(),
    phase: 'ready',
    audit: [],
    auditDropped: 0,
    client: { name: 'Claude Code', version: '2.1.0' },
    pairedAt: Date.UTC(2026, 0, 5, 14, 30),
    consent: null,
    pendingConsent: null,
    answerConsent: vi.fn(),
    diagnosis: { kind: 'none' },
    connect: vi.fn(),
    disconnect: vi.fn(),
    registerHandler: vi.fn(),
    ...overrides,
  };
}

export function auditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 1,
    at: Date.UTC(2026, 0, 5, 14, 35),
    tool: 'retivo_status',
    argsSummary: '',
    argsText: '{}',
    outcome: 'ok',
    durationMs: 12,
    bytes: 2,
    movedIdleClock: false,
    payload: '{}',
    payloadTruncated: false,
    ...overrides,
  };
}

/**
 * A store behind a mocked `useOptionalAssistant` / `useAssistant`: `set` swaps the value and every
 * subscribed component re-renders, so a test can change the session while a component is mounted.
 */
export function createAssistantStore(initial: AssistantContextValue | null) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: (): AssistantContextValue | null => value,
    set(next: AssistantContextValue | null): void {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
