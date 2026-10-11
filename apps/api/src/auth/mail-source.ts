/**
 * SES `Source` header for every transactional mail the api sends: the product
 * display name in front of the configured sender address, so inboxes show
 * "Retivo" instead of a bare noreply@ address.
 *
 * The address itself stays SES_FROM_ADDRESS (SSM on deployed stacks); only the
 * friendly name is fixed here. Kept as one helper so all senders agree.
 */

/** Product name as shown in the From header. Prose casing, per brand rule. */
export const MAIL_FROM_DISPLAY_NAME = 'Retivo';

/** `Retivo <address>` — RFC 5322 name-addr form SES accepts as `Source`. */
export function formatMailSource(address: string): string {
  return `${MAIL_FROM_DISPLAY_NAME} <${address}>`;
}
