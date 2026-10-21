/**
 * Renders the consent dialog for the running assistant session. Mounted once in
 * the authenticated shell, so the dialog appears on whatever route the person
 * is on when the bridge proves itself, not only on the Settings page they may
 * have left. All state lives in `AssistantProvider`; this only reads it.
 */
import React from 'react';
import { useOptionalAssistant } from '../assistant/AssistantContext';
import { resolveIdleConfig } from '../auth/IdleTimer';
import { AssistantConsentDialog } from './AssistantConsentDialog';

/** The idle timeout `IdleTimer` reads, in whole minutes, or `null` when idle sign-out is off. */
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
