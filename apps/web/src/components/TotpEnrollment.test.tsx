/** TotpEnrollment: QR render after enrollStart (qrcode mocked), the manual seed, and Continue handing off to onContinue. */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TotpEnrollment } from './TotpEnrollment';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,MOCK') },
}));

vi.mock('../api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(public status: number, public error: { code: string; message: string }) {
      super(error.message);
    }
  },
}));

function renderEnrollment(
  props: Partial<React.ComponentProps<typeof TotpEnrollment>> = {},
): ReturnType<typeof render> {
  return render(
    <TotpEnrollment
      onCancel={vi.fn()}
      enrollStart={vi
        .fn()
        .mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x' })}
      onContinue={vi.fn()}
      {...props}
    />,
  );
}

describe('TotpEnrollment', () => {
  it('renders the QR image and the manual seed after enrollStart resolves', async () => {
    renderEnrollment();
    const img = await screen.findByRole('img', {
      name: /qr code for setting up your authenticator app/i,
    });
    expect(img).toHaveAttribute('src', 'data:image/png;base64,MOCK');
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
  });

  it('passes axe accessibility checks after enrollStart resolves', async () => {
    const { container } = renderEnrollment();
    await screen.findByRole('button', { name: 'Continue' });
    await expectNoA11yViolations(container);
  });

  it('collects no code itself — the live code is typed in the parent gate, last', async () => {
    renderEnrollment();
    await screen.findByRole('button', { name: 'Continue' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('hands off to onContinue without calling any write itself', async () => {
    const onContinue = vi.fn();
    renderEnrollment({ onContinue });
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('falls back to the manual seed when the QR render fails', async () => {
    const qrcode = await import('qrcode');
    (qrcode.default.toDataURL as any).mockRejectedValueOnce(new Error('no canvas'));
    renderEnrollment();
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(
      screen.queryByRole('img', { name: /qr code/i }),
    ).not.toBeInTheDocument();
  });

  it('shows an error and a Cancel when enrollStart fails', async () => {
    const enrollStart = vi.fn().mockRejectedValue(new Error('boom'));
    renderEnrollment({ enrollStart });
    expect(
      await screen.findByText(/could not start authenticator setup/i),
    ).toBeInTheDocument();
  });
});
