/**
 * Newest-first log of what the assistant asked for and what Retivo sent back; expanded, a call shows the exact text
 * sent to the bridge, byte for byte. `onDisconnect` closes the modal and ends the session.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';
import { useAssistant } from '../assistant/AssistantContext';
import type { AuditEntry } from '../assistant/audit-log';
import { Badge } from './Badge';
import { EmptyState } from './EmptyState';
import { Modal } from './Modal';
import { reportedClientName, reportedClientVersion } from './assistant-session-text';
import { btnSecondaryClass, btnSecondarySmClass } from './dialog-chrome';

export const DISCONNECT_LABEL = 'Disconnect assistant';

const COPY_RESET_MS = 2000;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

interface AssistantActivityViewerProps {
  open: boolean;
  onClose: () => void;
  onDisconnect: () => void;
}

export const AssistantActivityViewer: React.FC<AssistantActivityViewerProps> = ({ open, onClose, onDisconnect }) => {
  const { audit, auditDropped, client, pairedAt } = useAssistant();
  const name = reportedClientName(client);
  const version = reportedClientVersion(client);
  const reported = name === '' ? 'The assistant did not report a name.' : `Reported by the assistant as ${[name, version].filter((part) => part !== '').join(' ')}. Retivo cannot verify this.`;
  const entries = [...audit].reverse();
  return (
    <Modal open={open} onClose={onClose} title="Assistant activity" size="2xl" scrollBodyLabel="Assistant activity">
      <p className="m-0 mb-1 text-sm text-ink">{reported}</p>
      {pairedAt !== null && <p className="m-0 mb-3 text-sm text-muted">Paired {dateTimeFormat.format(pairedAt)}.</p>}
      <div className="mb-4 flex flex-wrap gap-2">
        <button type="button" className={btnSecondaryClass} onClick={onDisconnect} aria-label={DISCONNECT_LABEL}>
          Disconnect
        </button>
        <button type="button" className={btnSecondaryClass} onClick={onClose}>
          Close
        </button>
      </div>
      {auditDropped > 0 && (
        <p className="m-0 mb-3 text-sm text-muted">
          {plural(auditDropped, 'older call is', 'older calls are')} no longer listed, to keep this list short.
        </p>
      )}
      {entries.length === 0 ? (
        <EmptyState bare>No calls yet. When the assistant asks for something, it is listed here with exactly what Retivo sent back.</EmptyState>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {entries.map((entry) => (
            <li key={entry.id}>
              <ActivityEntry entry={entry} />
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
};

const PRE_CLASS =
  'm-0 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-surface-sunken p-2 ' +
  'font-mono text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring';

const ActivityEntry: React.FC<{ entry: AuditEntry }> = ({ entry }) => {
  const ok = entry.outcome === 'ok';
  const startedAt = timeFormat.format(entry.at - entry.durationMs);
  return (
    <Disclosure className="group/call flex min-w-0 flex-col rounded-md border border-line bg-surface">
      <Heading className="m-0">
        <Button
          slot="trigger"
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-left text-sm outline-none hover:bg-ink/5 data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
        >
          <span className="font-mono text-xs tabular-nums text-muted">{startedAt}</span>
          <span className="min-w-0 break-all font-medium text-ink">{entry.tool}</span>
          <Badge tone={ok ? 'success' : 'negative'}>{entry.outcome}</Badge>
          <span className="text-xs text-muted">{entry.durationMs.toLocaleString()} ms</span>
          {ok && <span className="text-xs text-muted">{plural(entry.bytes, 'byte', 'bytes')} sent</span>}
        </Button>
      </Heading>
      <DisclosurePanel>
        <div className="flex flex-col gap-3 px-3 pb-3">
          <div>
            <p className="m-0 mb-1 text-xs font-medium text-muted">Arguments received</p>
            <pre className={PRE_CLASS} role="region" tabIndex={0} aria-label={`Arguments received for ${entry.tool} at ${startedAt}`}>
              {entry.argsText}
            </pre>
          </div>
          {ok ? <SentText entry={entry} startedAt={startedAt} /> : <p className="m-0 text-xs text-muted">This call failed, so no data was sent back.</p>}
        </div>
      </DisclosurePanel>
    </Disclosure>
  );
};

const SentText: React.FC<{ entry: AuditEntry; startedAt: string }> = ({ entry, startedAt }) => {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // Auto-reset handle for the copy label; cleared on unmount and on each new copy.
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetRef.current !== null) clearTimeout(resetRef.current);
    },
    [],
  );
  const { payload } = entry;
  if (payload === null) {
    return (
      <p className="m-0 text-xs text-muted">
        This result was {plural(entry.bytes, 'byte', 'bytes')}, too large to keep here. It was sent to the assistant in full.
      </p>
    );
  }
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(payload);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (resetRef.current !== null) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => setCopyState('idle'), COPY_RESET_MS);
  };
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-xs font-medium text-muted">Sent to the assistant</p>
        <button type="button" className={btnSecondarySmClass} onClick={() => void onCopy()} aria-label={copyState === 'idle' ? `Copy the sent text for ${entry.tool} at ${startedAt}` : undefined}>
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
        </button>
      </div>
      <pre className={PRE_CLASS} role="region" tabIndex={0} aria-label={`Sent text for ${entry.tool} at ${startedAt}`}>
        {payload}
      </pre>
    </div>
  );
};
