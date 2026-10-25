/**
 * The wording for a running assistant session, shared by the pill, status region and activity viewer. Client name and
 * version come from a local process, so they are sanitized and always presented as self-reported.
 */
import { sanitizeClientName } from '../assistant/sharing/sanitize';
import type { ClientInfo } from '../assistant/session-types';

export const CONNECTED_TEXT = 'Assistant connected';
export const DISCONNECTED_TEXT = 'Assistant disconnected';

export function reportedClientName(client: ClientInfo | null): string {
  return sanitizeClientName(client?.name);
}

export function reportedClientVersion(client: ClientInfo | null): string {
  return sanitizeClientName(client?.version);
}

export function connectedStatusText(client: ClientInfo | null): string {
  const name = reportedClientName(client);
  return name === '' ? CONNECTED_TEXT : `${CONNECTED_TEXT}, reported as ${name}`;
}
