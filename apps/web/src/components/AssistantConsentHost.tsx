/**
 * Renders the consent dialog for the running assistant session, mounted once in the authenticated shell so it appears
 * on whatever route the person is on; state lives in `AssistantProvider`.
 */
import React from 'react';
import { useOptionalAssistant } from '../assistant/AssistantContext';
import { resolveIdleConfig } from '../auth/IdleTimer';
import { AssistantConsentDialog } from './AssistantConsentDialog';

function configuredIdleMinutes(): number | null {
  const { enabled, idleMs } = resolveIdleConfig();
  return enabled ? Math.max(1, Math.round(idleMs / 60_000)) : null;
}

export const AssistantConsentHost: React.FC = () => {
  const assistant = useOptionalAssistant();
  if (assistant === null || assistant.pendingConsent === null) return null;
  const { pendingConsent, answerConsent } = assistant;
  return (
    <AssistantConsentDialog
      open
      clientName={pendingConsent.clientName}
      idleMinutes={configuredIdleMinutes()}
      onAllow={answerConsent}
      onDecline={() => answerConsent('declined')}
    />
  );
};
