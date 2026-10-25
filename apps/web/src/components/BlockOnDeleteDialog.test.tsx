/** BlockOnDeleteDialog: the reference-list cap and the optional footer link. */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { BlockOnDeleteDialog } from './BlockOnDeleteDialog';
import { expectNoA11yViolations } from '../test/a11y';

function renderDialog(
  props: Partial<React.ComponentProps<typeof BlockOnDeleteDialog>> = {},
): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <BlockOnDeleteDialog
        title={'Cannot delete "Housing"'}
        lead={
          <>
            It&apos;s used by <strong>1</strong> expense:
          </>
        }
        remediation="Re-categorise these first, then try again."
        labels={['Rent (canonical)']}
        onClose={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('BlockOnDeleteDialog', () => {
  it('renders the title, lead, references and remediation', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Cannot delete "Housing"');
    expect(dialog).toHaveTextContent("It's used by 1 expense:");
    expect(dialog).toHaveTextContent('Rent (canonical)');
    expect(dialog).toHaveTextContent('Re-categorise these first, then try again.');
  });

  it('caps the list at 20 and shows the "+ N more" residual', () => {
    const labels = Array.from({ length: 25 }, (_, i) => `Ref ${i}`);
    renderDialog({ labels });
    const items = screen.getByRole('dialog').querySelectorAll('ul li');
    expect(items).toHaveLength(21); // 20 rows + the residual row
    expect(screen.getByRole('dialog')).toHaveTextContent('+ 5 more');
  });

  it('shows no residual row when the list fits under the cap', () => {
    renderDialog({ labels: ['A', 'B'] });
    expect(screen.getByRole('dialog').querySelectorAll('ul li')).toHaveLength(2);
    expect(screen.getByRole('dialog')).not.toHaveTextContent('more');
  });

  it('omits the footer link by default and renders it when provided', () => {
    const { rerender } = renderDialog();
    expect(screen.queryByRole('link')).toBeNull();
    rerender(
      <MemoryRouter>
        <BlockOnDeleteDialog
          title={'Cannot delete "Acme CBP"'}
          lead={
            <>
              It&apos;s referenced by <strong>1</strong> income source:
            </>
          }
          remediation="Re-point or remove the income source first, then try again."
          labels={['ACME pension (Base)']}
          footerLink={{ to: '/income', label: 'Go to Income →' }}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /Go to Income/ });
    expect(link).toHaveAttribute('href', '/income');
  });

  it('invokes onClose from the Close button', () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no a11y violations', async () => {
    const { container } = renderDialog({
      footerLink: { to: '/income', label: 'Go to Income →' },
    });
    await expectNoA11yViolations(container);
  });
});
