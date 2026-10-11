/**
 * Trusted-devices management list, shown inside the
 * Profile 2FA card. Each row is a "remember this device" trust that lets that
 * browser skip the MFA challenge for ~30 days; the user can forget any one
 * device (re-challenging it on the next sign-in) or forget all at once.
 *
 * A no-scroll table (see "Tables" in docs/ui-conventions.md) — the trust set is small
 * (one row per remembered browser). The per-row "Forget" action stays always
 * visible (security context: hover-reveal would hide a control the user came
 * here to use). "Forget all devices" sits below the table behind a confirm
 * (`useConfirm`).
 *
 * Field shapes match the API's `GET /auth/mfa/trusted-devices`
 * response (`deviceId` / `createdAt` / `expiresAt` / `lastUsedAt` / `ip` /
 * `userAgent`) — NOT a synthesized `{ id, name }`. The device is labelled from
 * its user-agent (a stable id is not human-meaningful), with the IP as a
 * secondary hint.
 */
import React, { useState } from 'react';
import { Cell, Column, Row, Table, TableBody, TableHeader } from 'react-aria-components';
import type { TrustedDevice } from '../auth/useMfaManagement';
import { useConfirm } from './ConfirmDialog';
import { Muted } from './Muted';
import { formatDate } from '../lib/format-date';
import {
  tableClass,
  thClass,
  tdClass,
  btnDangerSmClass,
} from '../pages/accounts-page-chrome';

export interface TrustedDevicesListProps {
  devices: TrustedDevice[];
  /** Forget a single device by id (re-challenges it next sign-in). */
  onForget: (deviceId: string) => Promise<void>;
  /** Forget every trusted device at once. */
  onForgetAll: () => Promise<void>;
}

/**
 * A short human label for a trusted device from its user-agent. Full UA strings
 * are noisy; pick the most recognizable token (browser / OS family). Falls back
 * to a generic label when the UA is absent or unrecognized.
 */
function deviceLabel(userAgent?: string | null): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua)
      ? 'Mac'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad|iOS/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return 'Unknown device';
}

export const TrustedDevicesList: React.FC<TrustedDevicesListProps> = ({
  devices,
  onForget,
  onForgetAll,
}) => {
  const { confirm, dialog } = useConfirm();
  // The deviceId currently being forgotten, to disable its row action.
  const [forgetting, setForgetting] = useState<string | null>(null);

  if (devices.length === 0) {
    return (
      <Muted as="p">
        No trusted devices yet. When you tick &ldquo;Trust this device&rdquo; at
        sign-in, it&rsquo;ll appear here.
      </Muted>
    );
  }

  const onForgetRow = async (deviceId: string): Promise<void> => {
    setForgetting(deviceId);
    try {
      await onForget(deviceId);
    } finally {
      setForgetting(null);
    }
  };

  const onForgetAllClick = async (): Promise<void> => {
    const ok = await confirm(
      'Forget all devices?',
      'Every device will need a verification code the next time it signs in, including this one.',
      { confirmLabel: 'Forget all', cancelLabel: 'Cancel' },
    );
    if (ok) await onForgetAll();
  };

  return (
    <div>
      <Table className={tableClass} aria-label="Trusted devices">
        <TableHeader>
          <Column className={thClass} isRowHeader>Device</Column>
          <Column className={thClass}>Last used</Column>
          <Column className={thClass}>Expires</Column>
          <Column className={thClass}>
            <span className="sr-only">Forget</span>
          </Column>
        </TableHeader>
        <TableBody>
          {devices.map((d) => (
            <Row key={d.deviceId} id={d.deviceId} className="border-b border-line last:border-0">
              <Cell className={tdClass}>
                <div className="font-medium text-ink">
                  {deviceLabel(d.userAgent)}
                </div>
                {d.ip && <div className="text-xs text-muted">{d.ip}</div>}
              </Cell>
              <Cell className={tdClass}>
                {d.lastUsedAt ? formatDate(d.lastUsedAt) : '—'}
              </Cell>
              <Cell className={tdClass}>{formatDate(d.expiresAt)}</Cell>
              <Cell className={tdClass}>
                <button
                  type="button"
                  className={btnDangerSmClass}
                  onClick={() => onForgetRow(d.deviceId)}
                  disabled={forgetting === d.deviceId}
                >
                  {forgetting === d.deviceId ? 'Forgetting…' : 'Forget'}
                </button>
              </Cell>
            </Row>
          ))}
        </TableBody>
      </Table>

      <div className="mt-3">
        <button
          type="button"
          className={btnDangerSmClass}
          onClick={onForgetAllClick}
        >
          Forget all devices
        </button>
      </div>

      {dialog}
    </div>
  );
};
