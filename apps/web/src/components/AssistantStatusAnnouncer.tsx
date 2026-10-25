/**
 * Single `sr-only` live region announcing assistant connect and disconnect, mounted once and permanently in the
 * shell: the badge exists twice, and a live region must exist before its text changes.
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
