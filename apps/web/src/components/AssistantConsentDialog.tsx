/**
 * Consent dialog for the AI assistant connector, opened after the bridge proves itself. Allow resolves with the
 * switches as they stand; Don't allow, Esc and scrim click decline.
 */
import React, { useId, useState } from 'react';
import {
  assistantIntroduction,
  CONSENT_CHOICES_FIXED_STATEMENT,
  CONSENT_DIALOG_TITLE,
  GENEROUS_DEFAULTS_STATEMENT,
  MODEL_PROVIDER_STATEMENT,
  NEVER_SHARED_HEADING,
  NEVER_SHARED_ITEMS,
  SESSION_GROUP_HEADING,
  SHARING_GROUP_HEADING,
} from '../assistant/sharing/sentences';
import { ANALYSIS_TOOLS_STATEMENT, CONSENT_SWITCHES, KEEP_SIGNED_IN_ID, SHARING_SWITCHES, type SharingChoices, type SwitchDefinition } from '../assistant/sharing/switches';
import { defaultConsentAnswer, type ConsentAnswer } from '../assistant/sharing/consent';
import { sanitizeClientName } from '../assistant/sharing/sanitize';
import { btnPrimaryClass, btnSecondaryClass } from './dialog-chrome';
import { Modal } from './Modal';
import { Muted } from './Muted';
import { ToggleSwitch } from './ToggleSwitch';

interface AssistantConsentDialogProps {
  open: boolean;
  /** The assistant's self-reported name, untrusted: sanitized here before it is shown. */
  clientName: string | null;
  /** The configured idle timeout in minutes, or `null` when this build has no idle sign-out. */
  idleMinutes: number | null;
  onAllow: (answer: ConsentAnswer) => void;
  onDecline: () => void;
}

const SESSION_SWITCH = CONSENT_SWITCHES.find((definition) => definition.id === KEEP_SIGNED_IN_ID) as SwitchDefinition;

export const AssistantConsentDialog: React.FC<AssistantConsentDialogProps> = ({ open, clientName, idleMinutes, onAllow, onDecline }) => {
  const initial = defaultConsentAnswer();
  const [choices, setChoices] = useState<SharingChoices>(initial.choices);
  const [keepSignedIn, setKeepSignedIn] = useState(initial.keepSignedInWhileActive);
  const sharingHeadingId = useId();
  const sessionHeadingId = useId();
  const neverSharedHeadingId = useId();
  const idPrefix = useId();

  const renderSwitch = (definition: SwitchDefinition, checked: boolean, onChange: (next: boolean) => void): React.ReactElement => {
    const descriptionId = `${idPrefix}-${definition.id}-description`;
    return (
      <div key={definition.id} className="mb-4">
        <ToggleSwitch
          id={`${idPrefix}-${definition.id}`}
          label={definition.label}
          checked={checked}
          onChange={onChange}
          ariaDescribedBy={descriptionId}
        />
        <Muted as="p" id={descriptionId} className="m-0 mt-1 pl-11 text-xs">
          {definition.describe({ idleMinutes })}
        </Muted>
      </div>
    );
  };

  return (
    <Modal open={open} onClose={onDecline} title={CONSENT_DIALOG_TITLE} size="2xl" scrollBodyLabel="Sharing choices">
      <p className="m-0 mb-3 text-sm text-ink">{assistantIntroduction(sanitizeClientName(clientName))}</p>
      <p className="m-0 mb-2 text-sm text-ink">{MODEL_PROVIDER_STATEMENT}</p>
      <p className="m-0 mb-4 text-sm text-ink">{GENEROUS_DEFAULTS_STATEMENT}</p>

      <div role="group" aria-labelledby={sharingHeadingId}>
        <h3 id={sharingHeadingId} className="m-0 mb-3 text-sm font-semibold text-ink">
          {SHARING_GROUP_HEADING}
        </h3>
        {SHARING_SWITCHES.map((definition) =>
          renderSwitch(definition, choices[definition.id], (next) => setChoices((current) => ({ ...current, [definition.id]: next }))),
        )}
        <Muted as="p" className="m-0 mb-4 text-xs">
          {ANALYSIS_TOOLS_STATEMENT}
        </Muted>
      </div>

      <hr className="my-4 border-line" />

      <div role="group" aria-labelledby={sessionHeadingId}>
        <h3 id={sessionHeadingId} className="m-0 mb-3 text-sm font-semibold text-ink">
          {SESSION_GROUP_HEADING}
        </h3>
        {renderSwitch(SESSION_SWITCH, keepSignedIn, setKeepSignedIn)}
      </div>

      <hr className="my-4 border-line" />

      <div role="group" aria-labelledby={neverSharedHeadingId}>
        <h3 id={neverSharedHeadingId} className="m-0 mb-2 text-sm font-semibold text-ink">
          {NEVER_SHARED_HEADING}
        </h3>
        <ul className="m-0 mb-4 list-disc pl-5 text-sm text-ink">
          {NEVER_SHARED_ITEMS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <Muted as="p" className="m-0 mb-4 text-xs">
        {CONSENT_CHOICES_FIXED_STATEMENT}
      </Muted>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={btnPrimaryClass} onClick={() => onAllow({ choices, keepSignedInWhileActive: keepSignedIn })}>
          Allow
        </button>
        <button type="button" className={btnSecondaryClass} onClick={onDecline}>
          Don&rsquo;t allow
        </button>
      </div>
    </Modal>
  );
};
