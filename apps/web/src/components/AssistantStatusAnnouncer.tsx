/**
 * The one screen-reader announcement for the assistant session: a permanently mounted `sr-only`
 * status region that reads "Assistant connected" and "Assistant disconnected" on those two
 * transitions and on nothing else (a new audit entry changes no text). It is mounted once in the
 * shell, never per badge: the badge exists twice (sidebar and banner) and the CSS-hidden twin would
 * otherwise announce too, and a live region must exist before its text changes or the first change
 * is swallowed.
 *
 * It renders nothing at all unless the build offers the assistant, so a build without the bridge
 * port keeps the shell's DOM exactly as it was. Once offered it exists even with no session, empty.
 */
import React, { useState } from 'react';
import { useOptionalAssistant } from '../assistant/AssistantContext';
import { DISCONNECTED_TEXT, connectedStatusText } from './assistant-session-text';

export const AssistantStatusAnnouncer: React.FC = () => {
  const assistant = useOptionalAssistant();
  const connected = assistant?.phase === 'ready';
  // Derived during render from the previous value, so the text changes with the transition itself.
  const [announced, setAnnounced] = useState<{ connected: boolean; text: string }>({ connected: false, text: '' });
  if (announced.connected !== connected) {
    setAnnounced({ connected, text: connected ? connectedStatusText(assistant?.client ?? null) : DISCONNECTED_TEXT });
  }
  if (assistant === null || !assistant.offered) return null;
  return (
    <div role="status" className="sr-only">
      {announced.text}
    </div>
  );
};
