/**
 * The words the shell uses for a running assistant session, in one place so the pill, the status
 * region and the activity viewer say the same thing. The client's name and version come from the
 * bridge, which got them from a local process: they are sanitized here and always presented as
 * self-reported, never as a fact about who is connected.
 */
import { sanitizeClientName } from '../assistant/sharing/sanitize';
import type { ClientInfo } from '../assistant/session-types';

export const CONNECTED_TEXT = 'Assistant connected';
export const DISCONNECTED_TEXT = 'Assistant disconnected';

/** The self-reported name with control and invisible characters stripped and its length capped; `''` when none. */
export function reportedClientName(client: ClientInfo | null): string {
  return sanitizeClientName(client?.name);
}

/** The self-reported version, sanitized the same way; `''` when none. */
export function reportedClientVersion(client: ClientInfo | null): string {
  return sanitizeClientName(client?.version);
}

/** `Assistant connected`, with `, reported as <name>` when the bridge named the assistant. */
export function connectedStatusText(client: ClientInfo | null): string {
  const name = reportedClientName(client);
  return name === '' ? CONNECTED_TEXT : `${CONNECTED_TEXT}, reported as ${name}`;
}
