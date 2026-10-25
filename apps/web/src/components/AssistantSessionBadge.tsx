/**
 * The shell's "Assistant connected" pill (`desktop` and `banner` variants) with a no-confirm Disconnect. Disconnect
 * moves focus first, since React Aria's focus restore has nothing to return to once the opener is gone.
 */
import React, { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button } from 'react-aria-components';
import { useOptionalAssistant } from '../assistant/AssistantContext';
import { AssistantActivityViewer, DISCONNECT_LABEL } from './AssistantActivityViewer';
import { CONNECTED_TEXT, connectedStatusText } from './assistant-session-text';
import { LinkIcon, XIcon } from './icons';
import { btnSecondarySmClass } from './dialog-chrome';

export type AssistantSessionBadgeVariant = 'sidebar' | 'banner';

const PILL_CLASS =
  'inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-positive/40 bg-surface-sunken ' +
  'px-2.5 py-0.5 text-xs font-medium text-positive outline-none transition-colors ' +
  'data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring';

function focusHome(root: HTMLElement | null, variant: AssistantSessionBadgeVariant): HTMLElement | null {
  if (root === null) return null;
  return variant === 'banner'
    ? (root.closest('[role="banner"]')?.querySelector<HTMLElement>('button') ?? null)
    : (root.closest('aside')?.querySelector<HTMLElement>('nav button') ?? null);
}

export const AssistantSessionBadge: React.FC<{ variant: AssistantSessionBadgeVariant }> = ({ variant }) => {
  const assistant = useOptionalAssistant();
  const rootRef = useRef<HTMLDivElement>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const connected = assistant !== null && assistant.phase === 'ready';
  // A session that ended while the viewer was open must not reopen it on the next pairing.
  if (!connected && viewerOpen) setViewerOpen(false);
  if (!connected) return null;
  const { client, disconnect } = assistant;
  const banner = variant === 'banner';
  // On the narrow banner the visible words give way to the icon; the accessible name stays whole.
  const wordsClass = banner ? 'sr-only sm:not-sr-only' : '';

  const endSession = (): void => {
    focusHome(rootRef.current, variant)?.focus();
    disconnect();
  };
  const endSessionFromViewer = (): void => {
    // The modal traps focus and would pull it back, so it has to be gone before focus moves.
    flushSync(() => setViewerOpen(false));
    endSession();
  };

  return (
    <div ref={rootRef} className={`flex flex-wrap items-center gap-1.5${banner ? '' : ' mt-2'}`}>
      <Button
        className={PILL_CLASS}
        aria-label={`${connectedStatusText(client)}. View activity`}
        aria-haspopup="dialog"
        onPress={() => setViewerOpen(true)}
      >
        <LinkIcon />
        <span className={wordsClass}>{CONNECTED_TEXT}</span>
      </Button>
      <Button className={`${btnSecondarySmClass} gap-1.5`} aria-label={DISCONNECT_LABEL} onPress={endSession}>
        <XIcon />
        <span className={wordsClass}>Disconnect</span>
      </Button>
      <AssistantActivityViewer open={viewerOpen} onClose={() => setViewerOpen(false)} onDisconnect={endSessionFromViewer} />
    </div>
  );
};
