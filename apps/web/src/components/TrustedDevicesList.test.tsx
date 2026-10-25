/** TrustedDevicesList: empty state, device rows, per-row forget and the confirm-gated forget-all. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TrustedDevicesList } from './TrustedDevicesList';
import type { TrustedDevice } from '../auth/useMfaManagement';
import { expectNoA11yViolations } from '../test/a11y';

const DEVICES: TrustedDevice[] = [
  {
    deviceId: 'dev-1',
    createdAt: '2026-05-01T00:00:00.000Z',
    expiresAt: '2026-06-01T00:00:00.000Z',
    lastUsedAt: '2026-05-20T00:00:00.000Z',
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120 Safari/537',
  },
];

function renderList(
  props: Partial<React.ComponentProps<typeof TrustedDevicesList>> = {},
): ReturnType<typeof render> {
  return render(
    <TrustedDevicesList
      devices={DEVICES}
      onForget={vi.fn().mockResolvedValue(undefined)}
      onForgetAll={vi.fn().mockResolvedValue(undefined)}
      {...props}
    />,
  );
}

describe('TrustedDevicesList', () => {
  it('renders an empty state when there are no devices', () => {
    renderList({ devices: [] });
    expect(screen.getByText(/no trusted devices yet/i)).toBeInTheDocument();
  });

  it('labels a device from its user-agent and shows the IP', () => {
    renderList();
    expect(screen.getByText('Chrome on Mac')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
  });

  it('calls onForget with the device id from the row action', async () => {
    const onForget = vi.fn().mockResolvedValue(undefined);
    renderList({ onForget });
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(onForget).toHaveBeenCalledWith('dev-1'));
  });

  it('confirms before forgetting all devices, then calls onForgetAll', async () => {
    const onForgetAll = vi.fn().mockResolvedValue(undefined);
    renderList({ onForgetAll });
    fireEvent.click(screen.getByRole('button', { name: 'Forget all devices' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(/forget all devices/i);
    fireEvent.click(screen.getByRole('button', { name: 'Forget all' }));
    await waitFor(() => expect(onForgetAll).toHaveBeenCalledTimes(1));
  });

  it('has no a11y violations', async () => {
    const { container } = renderList();
    await expectNoA11yViolations(container);
  });
});
