/**
 * The "AI assistants" card under Settings → Preferences: the per-device opt-in,
 * and once it is on, the launch commands, the pairing-code field, the
 * connection status and Disconnect. All session logic lives in `assistant/`
 * (which may not import `pages/` or `components/`); this file only renders it.
 *
 * Hidden entirely unless the build carries a bridge port and the `ai-assistants`
 * beta feature is visible. The pairing code is a short-lived secret, not a
 * credential: no autocomplete, password-manager opt-out, not a password input,
 * and it leaves component state the moment Connect is pressed.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { bridgeCommandFor, isWellFormedPairingCode, type AgentName } from '@retirement/assistant-protocol';
import { useAssistant } from '../assistant/AssistantContext';
import { browserFamily, type BrowserFamily, type Diagnosis } from '../assistant/diagnosis';
import { GENEROUS_DEFAULTS_STATEMENT, MODEL_PROVIDER_STATEMENT } from '../assistant/sharing/sentences';
import { Badge } from '../components/Badge';
import { Field } from '../components/Field';
import { Muted } from '../components/Muted';
import { PM_IGNORE_ATTRS } from '../components/password-manager';
import { TextInput } from '../components/TextInput';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { btnPrimaryClass, btnSecondaryClass, btnSecondarySmClass, inputClass, SettingsCard } from './profile-page-chrome';

const AGENTS: readonly { agent: AgentName; label: string }[] = [
  { agent: 'claude', label: 'Claude Code' },
  { agent: 'codex', label: 'Codex' },
];

const COPY_FEEDBACK_MS = 2000;
const CODE_FIELD_ID = 'ai-assistants-pairing-code';

/** What the status line says while a session is running. */
const PHASE_TEXT: Record<string, string> = {
  connecting: 'Connecting to the bridge…',
  'awaiting-hello': 'Waiting for the bridge to answer…',
  'awaiting-paired': 'Checking the pairing code…',
  paired: 'The bridge is verified. Waiting for your approval…',
  'awaiting-consent': 'The bridge is verified. Waiting for your approval…',
  ready: 'Connected. Your assistant can now ask Retivo questions.',
};

const MALFORMED_CODE_TEXT = 'That is not a pairing code. It has 10 letters and digits, like ABCDE-FGHJK.';

function browserRemedy(family: BrowserFamily, kind: 'blocked' | 'unreachable' | 'not-running'): string {
  switch (family) {
    case 'unsupported':
      return 'Safari and browsers on an iPhone or iPad cannot connect to a program on your computer. Use Chrome, Edge, Brave or Firefox on a computer.';
    case 'brave':
      return "Brave blocks this by default. Allow access to localhost for this site in Brave's site settings, then try again.";
    case 'firefox':
      return 'Firefox 151 and later asks before a site may reach your computer. Choose Allow in the prompt, then try again. Older versions cannot connect.';
    case 'chromium':
      return kind === 'not-running'
        ? 'Add the command above to your assistant, ask it a question about your plan, then enter the new code.'
        : 'If your browser asked to let this site reach devices on your network, choose Allow. Then check that the command above has been added to your assistant.';
    case 'other':
      return 'Use a recent version of Chrome, Edge, Brave or Firefox on a computer.';
  }
}

/** The plain-language message for a diagnosis; the browser decides which remedy fits. */
function diagnosisText(diagnosis: Diagnosis, family: BrowserFamily): string | null {
  switch (diagnosis.kind) {
    case 'none':
      return null;
    case 'unreachable':
      return `Retivo could not reach the bridge. It is either not running or blocked by your browser. ${browserRemedy(family, 'unreachable')}`;
    case 'not-running':
      return `The bridge is not running. ${browserRemedy(family, 'not-running')}`;
    case 'blocked':
      return `Your browser blocked the connection to the bridge. ${browserRemedy(family, 'blocked')}`;
    case 'not-the-bridge':
      return 'Something answered, but it is not the Retivo bridge. Close the program using that port, or change the port, and try again.';
    case 'version-mismatch':
      return 'The bridge and this version of Retivo do not speak the same version. Add the command above to your assistant again to update the bridge, then reload this page.';
    case 'bridge-unverified':
      return 'The program on that port could not prove it knows your code, so Retivo disconnected. Nothing was shared. Start the bridge with the command above.';
    case 'already-connected':
      return 'The bridge already has a Retivo tab connected. Disconnect that one (or close it) first, then try again.';
    case 'wrong-code':
      return 'That code is not right. Check it against the one your assistant showed and try again.';
    case 'attempts-exceeded':
      return 'Too many wrong codes. Ask your assistant for a new code.';
    case 'code-expired':
      return 'That code has expired or was already used. Ask your assistant for a new code.';
    case 'frame-too-large':
    case 'protocol-error':
      return 'The connection broke off after an unexpected message. Try again, and update the bridge if it keeps happening.';
    case 'connection-lost':
      return 'The connection to the bridge was lost. Ask your assistant to try again, and enter the new code.';
  }
}

/** Copies text; returns whether the clipboard accepted it. Never throws. */
async function copyText(text: string): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function commandFor(agent: AgentName, port: number): string | null {
  try {
    return bridgeCommandFor(agent, { origin: window.location.origin, port });
  } catch {
    // The origin is not one a shell line may carry (plain http beyond localhost).
    return null;
  }
}

const LaunchCommands: React.FC<{ port: number }> = ({ port }) => {
  const [copied, setCopied] = useState<AgentName | 'failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const commands = AGENTS.map(({ agent, label }) => ({ agent, label, command: commandFor(agent, port) }));
  if (commands.every((entry) => entry.command === null)) {
    return (
      <Muted as="p" className="m-0 mb-4 text-xs">
        The launch commands are available when Retivo is opened over https, or on this computer at localhost.
      </Muted>
    );
  }
  const copy = async (agent: AgentName, command: string): Promise<void> => {
    setCopied((await copyText(command)) ? agent : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);
  };
  return (
    <div className="mb-4">
      <p className="m-0 mb-2 text-sm font-medium text-ink">1. Add the bridge to your assistant</p>
      <Muted as="p" className="m-0 mb-3 text-xs">
        Run one of these where your assistant runs. The bridge stays on your computer.
      </Muted>
      {commands.map(({ agent, label, command }) =>
        command === null ? null : (
          <div key={agent} className="mb-3">
            <p className="m-0 mb-1 text-xs font-medium text-ink">{label}</p>
            <div className="flex flex-wrap items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border border-line bg-surface-sunken px-3 py-2 font-mono text-xs text-ink">
                {command}
              </code>
              <button type="button" className={btnSecondarySmClass} onClick={() => void copy(agent, command)}>
                {copied === agent ? 'Copied' : `Copy ${label} command`}
              </button>
            </div>
          </div>
        ),
      )}
      <span aria-live="polite" className="text-xs text-negative">
        {copied === 'failed' ? 'Could not copy. Select the command and copy it by hand.' : ''}
      </span>
    </div>
  );
};

export const AssistantSettingsCard: React.FC = () => {
  const { offered, port, optedIn, setOptedIn, phase, diagnosis, connect, disconnect } = useAssistant();
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const noteId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const wasRunning = useRef(false);
  const running = phase !== 'idle';
  // The field and Connect are disabled while a session runs and Disconnect only exists then, so the
  // control that held focus disappears or goes inert. Hand focus to the one that takes its place,
  // unless the person has already moved on to something outside the form.
  useEffect(() => {
    if (running === wasRunning.current) return;
    wasRunning.current = running;
    const form = formRef.current;
    if (form === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && !form.contains(active)) return;
    const next = running ? form.querySelector('[data-assistant-disconnect]') : form.querySelector(`#${CODE_FIELD_ID}`);
    if (next instanceof HTMLElement) next.focus();
  }, [running]);
  if (!offered || port === null) return null;

  const family = browserFamily(navigator.userAgent, Boolean((navigator as { brave?: unknown }).brave));

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (running) return;
    if (!isWellFormedPairingCode(code)) {
      setCodeError(MALFORMED_CODE_TEXT);
      return;
    }
    const result = connect(code);
    // The code has done its job in this component; the session keeps it for the handshake only.
    setCode('');
    setCodeError(result === 'unavailable' ? 'Sign in and unlock your workspace first, then try again.' : null);
  };

  const statusText = running
    ? (PHASE_TEXT[phase] ?? '')
    : (diagnosisText(diagnosis, family) ?? 'Not connected. Enter a pairing code to connect.');

  return (
    <SettingsCard
      title={
        <>
          AI assistants{' '}
          <Badge tone="modified" size="sm">
            Beta
          </Badge>
        </>
      }
      subtitle="Let an AI assistant on this computer ask Retivo about your plan, only after you approve it."
    >
      <ToggleSwitch
        id="ai-assistants-opt-in"
        label="Allow AI assistants on this device"
        checked={optedIn}
        onChange={setOptedIn}
        ariaDescribedBy={optedIn ? undefined : noteId}
      />
      {/* Before the opt-in the model-provider sentence sits under the switch; once the commands show, both
          sentences the consent dialog uses sit under them instead. */}
      {!optedIn && (
        <Muted as="p" id={noteId} className="m-0 mb-4 mt-3 text-xs">
          {MODEL_PROVIDER_STATEMENT}
        </Muted>
      )}
      {optedIn && (
        <>
          {family === 'unsupported' && (
            <Muted as="p" className="m-0 mb-4 text-xs">
              {browserRemedy('unsupported', 'unreachable')}
            </Muted>
          )}
          <LaunchCommands port={port} />
          <Muted as="p" className="m-0 mb-4 text-xs">
            {MODEL_PROVIDER_STATEMENT} {GENEROUS_DEFAULTS_STATEMENT}
          </Muted>
          <p className="m-0 mb-2 text-sm font-medium text-ink">2. Enter the pairing code</p>
          <form ref={formRef} onSubmit={submit} noValidate>
            <Field
              htmlFor={CODE_FIELD_ID}
              label="Pairing code"
              hint="Your assistant shows a code like ABCDE-FGHJK the first time it asks for your plan. It works once, for five minutes."
              error={codeError}
            >
              <TextInput
                id={CODE_FIELD_ID}
                name="assistant-pairing-code"
                type="text"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  setCodeError(null);
                }}
                className={inputClass}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={running}
                {...PM_IGNORE_ATTRS}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" className={btnPrimaryClass} disabled={running || code.trim() === ''}>
                Connect
              </button>
              {running && (
                <button type="button" className={btnSecondaryClass} onClick={disconnect} data-assistant-disconnect>
                  Disconnect
                </button>
              )}
            </div>
          </form>
          <Muted as="p" role="status" className="m-0 mt-3 text-sm">
            {statusText}
          </Muted>
        </>
      )}
    </SettingsCard>
  );
};
