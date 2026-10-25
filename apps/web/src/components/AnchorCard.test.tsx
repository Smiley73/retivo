/** AnchorCard: collapsed summary, expand behaviour, the disabled lock and the accessible-name and description wiring. */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AnchorCard, AnchorCardGroup } from './AnchorCard';
import { expectNoA11yViolations } from '../test/a11y';

function renderCard(props?: Partial<React.ComponentProps<typeof AnchorCard>>) {
  return render(
    <AnchorCard label="Start" summary="At age 65" {...props}>
      <button type="button">inner control</button>
    </AnchorCard>,
  );
}

describe('AnchorCard', () => {
  it('collapsed by default: shows the summary, hides the body', () => {
    renderCard();
    expect(screen.getByText('At age 65')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'inner control' }),
    ).toBeNull();
  });

  it('expands on trigger click to reveal the body', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(
      screen.getByRole('button', { name: 'inner control' }),
    ).toBeInTheDocument();
  });

  it('starts expanded when defaultExpanded is set', () => {
    renderCard({ defaultExpanded: true });
    expect(
      screen.getByRole('button', { name: 'inner control' }),
    ).toBeInTheDocument();
  });

  it('disabled: the trigger is disabled and cannot expand', () => {
    renderCard({ disabled: true });
    const trigger = screen.getByRole('button', { name: 'Start' });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(
      screen.queryByRole('button', { name: 'inner control' }),
    ).toBeNull();
  });

  it('collapses when it becomes disabled while open (no stuck-open card)', () => {
    const { rerender } = render(
      <AnchorCard label="Start" summary="At age 65" disabled={false}>
        <button type="button">inner control</button>
      </AnchorCard>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(
      screen.getByRole('button', { name: 'inner control' }),
    ).toBeInTheDocument();
    rerender(
      <AnchorCard label="Start" summary="At age 65" disabled>
        <button type="button">inner control</button>
      </AnchorCard>,
    );
    expect(
      screen.queryByRole('button', { name: 'inner control' }),
    ).toBeNull();
  });

  it('AnchorCardGroup keeps only one card open at a time', () => {
    render(
      <AnchorCardGroup>
        <AnchorCard label="Start" summary="At age 65">
          <button type="button">start body</button>
        </AnchorCard>
        <AnchorCard label="End" summary="Until death">
          <button type="button">end body</button>
        </AnchorCard>
      </AnchorCardGroup>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(screen.getByRole('button', { name: 'start body' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(screen.getByRole('button', { name: 'end body' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'start body' })).toBeNull();
  });

  it('the trigger is described by the summary (announced to AT)', () => {
    renderCard();
    const trigger = screen.getByRole('button', { name: 'Start' });
    const describedById = trigger.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById as string)?.textContent).toBe(
      'At age 65',
    );
  });

  it('has no a11y violations (expanded — the richer disclosure tree)', async () => {
    const { container } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await expectNoA11yViolations(container);
  });
});
