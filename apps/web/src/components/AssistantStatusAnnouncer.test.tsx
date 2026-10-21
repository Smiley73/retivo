/**
 * The one status region: empty with no session, one message per transition, silent on everything
 * else, and absent altogether when the build does not offer the assistant.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantValue, auditEntry, createAssistantStore } from '../test/assistant-context';
import { AssistantStatusAnnouncer } from './AssistantStatusAnnouncer';

const store = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../assistant/AssistantContext', async () => {
  const { useSyncExternalStore } = await import('react');
  const current = () => store.current as ReturnType<typeof createAssistantStore>;
  return { useOptionalAssistant: () => useSyncExternalStore(current().subscribe, current().get) };
});

const idle = () => assistantValue({ phase: 'idle', client: null, pairedAt: null });

describe('AssistantStatusAnnouncer', () => {
  beforeEach(() => {
    store.current = createAssistantStore(idle());
  });

  it('exists with empty text while no session runs', () => {
    render(<AssistantStatusAnnouncer />);
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('');
    expect(region).toHaveClass('sr-only');
  });

  it('renders nothing when the build does not offer the assistant, or there is no provider', () => {
    store.current = createAssistantStore(assistantValue({ offered: false, phase: 'idle' }));
    const first = render(<AssistantStatusAnnouncer />);
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    store.current = createAssistantStore(null);
    const second = render(<AssistantStatusAnnouncer />);
    expect(second.container).toBeEmptyDOMElement();
  });

  it('changes on connect and on disconnect, and on nothing else', () => {
    const assistants = createAssistantStore(idle());
    store.current = assistants;
    render(<AssistantStatusAnnouncer />);
    const region = screen.getByRole('status');

    act(() => assistants.set(assistantValue({ phase: 'awaiting-consent' })));
    expect(region).toHaveTextContent('');

    act(() => assistants.set(assistantValue({ phase: 'ready' })));
    expect(region).toHaveTextContent('Assistant connected, reported as Claude Code');

    // A call settling, a new audit entry or a drop count must not announce again.
    const mutations: string[] = [];
    const observer = new MutationObserver((records) => records.forEach((record) => mutations.push(record.type)));
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    act(() => assistants.set(assistantValue({ phase: 'ready', audit: [auditEntry()], auditDropped: 3 })));
    expect(observer.takeRecords()).toEqual([]);
    expect(mutations).toEqual([]);
    observer.disconnect();
    expect(region).toHaveTextContent('Assistant connected, reported as Claude Code');

    act(() => assistants.set(idle()));
    expect(region).toHaveTextContent('Assistant disconnected');
  });

  it('does not announce a disconnect for a pairing that never reached ready', () => {
    const assistants = createAssistantStore(idle());
    store.current = assistants;
    render(<AssistantStatusAnnouncer />);
    act(() => assistants.set(assistantValue({ phase: 'awaiting-consent' })));
    act(() => assistants.set(idle()));
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});
