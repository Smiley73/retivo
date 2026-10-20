/**
 * Helpers for the assistant tool tests: a handler context under chosen consent
 * choices, a call that runs a registered handler the way the dispatcher does, and
 * the narrowing of a result to its envelope.
 */
import type { ToolResult } from '@retirement/assistant-protocol';
import type { ToolCallContext } from '../assistant/dispatcher';
import { createConsentRecord } from '../assistant/sharing/consent';
import { defaultSharingChoices, type SharingChoices } from '../assistant/sharing/switches';
import { buildShareView } from '../assistant/sharing/view';
import { planToolHandlers } from '../assistant/tools';
import type { ToolEnvelope } from '../assistant/tools/envelope';

/** Mid-June 2026 in the local zone: the tab's "today" for these tests. */
export const TEST_NOW = new Date(2026, 5, 15, 12, 0, 0);

export function choicesWith(overrides: Partial<SharingChoices> = {}): SharingChoices {
  return { ...defaultSharingChoices(), ...overrides };
}

export function toolContext(choices: SharingChoices = defaultSharingChoices(), now: Date = TEST_NOW): ToolCallContext {
  const consent = createConsentRecord({ choices, keepSignedInWhileActive: false }, 0, 1);
  return {
    signal: new AbortController().signal,
    progress: () => undefined,
    share: { consent, buildView: (source) => buildShareView(source, consent.choices, { now }) },
    now,
    connection: { assistantName: 'Test Assistant', pairedAt: Date.UTC(2026, 5, 15, 11, 0, 0) },
  };
}

/** Runs a plan tool's handler directly, the way the dispatcher does once its own gates pass. */
export async function callPlanTool(
  name: string,
  args: Record<string, unknown> = {},
  choices: SharingChoices = defaultSharingChoices(),
  now: Date = TEST_NOW,
): Promise<ToolResult> {
  const handler = planToolHandlers().get(name);
  if (handler === undefined) throw new Error(`no handler for ${name}`);
  return handler(args, toolContext(choices, now));
}

export function envelopeOf(result: ToolResult): ToolEnvelope {
  if (!result.ok) throw new Error(`expected an envelope, got ${result.error.code}: ${result.error.message}`);
  return result.payload as ToolEnvelope;
}
