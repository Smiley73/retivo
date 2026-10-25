/** The activity viewer: newest call first, verbatim sent text, UTF-8 byte counts, Copy, live updates, dropped note and empty state. */
import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantValue, auditEntry, createAssistantStore } from '../test/assistant-context';
import { expectNoA11yViolations } from '../test/a11y';
import { AssistantActivityViewer } from './AssistantActivityViewer';

const store = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../assistant/AssistantContext', async () => {
  const { useSyncExternalStore } = await import('react');
  const current = () => store.current as ReturnType<typeof createAssistantStore>;
  return { useAssistant: () => useSyncExternalStore(current().subscribe, current().get) };
});

// A body a re-serializer would change: `1.0` becomes `1`, and the spacing after the colons and
// the escaped solidus would not survive `JSON.stringify(JSON.parse(...))`.
const VERBATIM = '{"b": 1.0,\n  "a":"caf\\u00e9 \\/ x"}';
// Multi-byte: 4 two-byte letters and one four-byte emoji inside the JSON quotes.
const MULTIBYTE = '{"t":"éééé😀"}';

function setup(overrides: Parameters<typeof assistantValue>[0] = {}) {
  const assistants = createAssistantStore(assistantValue(overrides));
  store.current = assistants;
  const onClose = vi.fn();
  const onDisconnect = vi.fn();
  const utils = render(<AssistantActivityViewer open onClose={onClose} onDisconnect={onDisconnect} />);
  return { ...utils, assistants, onClose, onDisconnect };
}

async function expand(user: ReturnType<typeof userEvent.setup>, tool: string) {
  const trigger = screen.getAllByRole('button', { name: new RegExp(tool) })[0]!;
  await user.click(trigger);
  return trigger;
}

describe('AssistantActivityViewer', () => {
  beforeEach(() => {
    store.current = createAssistantStore(assistantValue());
  });

  it('shows the client as reported and when pairing completed, with the empty state and no calls', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Assistant activity' });
    expect(within(dialog).getByText(/Reported by the assistant as Claude Code 2\.1\.0/)).toBeInTheDocument();
    expect(within(dialog).getByText(/^Paired /)).toBeInTheDocument();
    expect(within(dialog).getByText(/No calls yet/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('list')).not.toBeInTheDocument();
  });

  it('says so when the assistant reported no name', () => {
    setup({ client: null });
    expect(screen.getByText('The assistant did not report a name.')).toBeInTheDocument();
  });

  it('lists calls newest first', () => {
    setup({
      audit: [
        auditEntry({ id: 1, tool: 'first_tool' }),
        auditEntry({ id: 2, tool: 'second_tool' }),
        auditEntry({ id: 3, tool: 'third_tool' }),
      ],
    });
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items.map((item) => /(first|second|third)_tool/.exec(item.textContent!)![0])).toEqual(['third_tool', 'second_tool', 'first_tool']);
  });

  it('summarizes a call collapsed: time, tool, outcome, duration and bytes sent', () => {
    setup({ audit: [auditEntry({ tool: 'retivo_status', durationMs: 1234, bytes: 56, payload: 'x'.repeat(56) })] });
    const trigger = screen.getByRole('button', { name: /retivo_status/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('ok');
    expect(trigger).toHaveTextContent('1,234 ms');
    expect(trigger).toHaveTextContent('56 bytes sent');
  });

  it('shows the sent text exactly as captured, not re-serialized', async () => {
    const user = userEvent.setup();
    setup({ audit: [auditEntry({ payload: VERBATIM, bytes: new TextEncoder().encode(VERBATIM).length })] });
    expect(JSON.stringify(JSON.parse(VERBATIM))).not.toBe(VERBATIM);
    await expand(user, 'retivo_status');
    const sent = screen.getByRole('region', { name: /^Sent text for retivo_status/ });
    expect(sent.tagName).toBe('PRE');
    expect(sent.textContent).toBe(VERBATIM);
  });

  it('counts the bytes column in UTF-8 bytes, not characters', () => {
    const bytes = new TextEncoder().encode(MULTIBYTE).length;
    expect(bytes).not.toBe(MULTIBYTE.length);
    setup({ audit: [auditEntry({ payload: MULTIBYTE, bytes })] });
    expect(screen.getByRole('button', { name: /retivo_status/ })).toHaveTextContent(`${bytes} bytes sent`);
  });

  it('shows the arguments received', async () => {
    const user = userEvent.setup();
    setup({ audit: [auditEntry({ argsText: '{"scenarioId":"abc"}' })] });
    await expand(user, 'retivo_status');
    expect(screen.getByRole('region', { name: /^Arguments received for retivo_status/ }).textContent).toBe('{"scenarioId":"abc"}');
  });

  it('shows the code for an error call and offers no body or Copy', async () => {
    const user = userEvent.setup();
    setup({ audit: [auditEntry({ tool: 'bad_tool', outcome: 'INVALID_ARGS', payload: '{"ok":false}', bytes: 12 })] });
    const trigger = await expand(user, 'bad_tool');
    expect(trigger).toHaveTextContent('INVALID_ARGS');
    expect(trigger).not.toHaveTextContent('bytes sent');
    expect(screen.queryByRole('region', { name: /^Sent text/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Copy/ })).not.toBeInTheDocument();
    expect(screen.getByText(/no data was sent back/)).toBeInTheDocument();
  });

  it('says a result too large to keep was still sent in full', async () => {
    const user = userEvent.setup();
    setup({ audit: [auditEntry({ payload: null, payloadTruncated: true, bytes: 70_000 })] });
    await expand(user, 'retivo_status');
    expect(screen.getByText(/70,000 bytes, too large to keep here/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Copy/ })).not.toBeInTheDocument();
  });

  it('copies the verbatim text, then resets the label', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    setup({ audit: [auditEntry({ payload: VERBATIM })] });
    await expand(user, 'retivo_status');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await user.click(screen.getByRole('button', { name: /^Copy the sent text/ }));
      expect(writeText).toHaveBeenCalledExactlyOnceWith(VERBATIM);
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.getByRole('button', { name: /^Copy the sent text/ })).toHaveTextContent('Copy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed copy', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    setup({ audit: [auditEntry()] });
    await expand(user, 'retivo_status');
    await user.click(screen.getByRole('button', { name: /^Copy the sent text/ }));
    expect(screen.getByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
  });

  it('shows a call that arrives while it is open, without reopening', () => {
    const { assistants } = setup({ audit: [auditEntry({ id: 1, tool: 'old_tool' })] });
    expect(screen.queryByText('new_tool')).not.toBeInTheDocument();
    act(() => assistants.set(assistantValue({ audit: [auditEntry({ id: 1, tool: 'old_tool' }), auditEntry({ id: 2, tool: 'new_tool' })] })));
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('new_tool');
    expect(items).toHaveLength(2);
  });

  it('notes dropped older calls only when the log reports drops', () => {
    const { assistants } = setup({ audit: [auditEntry()] });
    expect(screen.queryByText(/no longer listed/)).not.toBeInTheDocument();
    act(() => assistants.set(assistantValue({ audit: [auditEntry()], auditDropped: 1 })));
    expect(screen.getByText('1 older call is no longer listed, to keep this list short.')).toBeInTheDocument();
    act(() => assistants.set(assistantValue({ audit: [auditEntry()], auditDropped: 1200 })));
    expect(screen.getByText('1,200 older calls are no longer listed, to keep this list short.')).toBeInTheDocument();
  });

  it('routes Disconnect and Close to their handlers', async () => {
    const user = userEvent.setup();
    const { onClose, onDisconnect } = setup();
    await user.click(screen.getByRole('button', { name: 'Disconnect assistant' }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations with one entry expanded', async () => {
    const user = userEvent.setup();
    setup({ audit: [auditEntry({ payload: VERBATIM }), auditEntry({ id: 2, tool: 'bad_tool', outcome: 'TOOL_NOT_SUPPORTED' })] });
    await expand(user, 'retivo_status');
    await expectNoA11yViolations(document.body);
  });
});
