// SES `Source` for every transactional mail: the product display name in front of the configured SES_FROM_ADDRESS, in one helper so all
// senders agree.

/** Product name as shown in the From header. Prose casing, per brand rule. */
export const MAIL_FROM_DISPLAY_NAME = 'Retivo';

/** `Retivo <address>` — RFC 5322 name-addr form SES accepts as `Source`. */
export function formatMailSource(address: string): string {
  return `${MAIL_FROM_DISPLAY_NAME} <${address}>`;
}
