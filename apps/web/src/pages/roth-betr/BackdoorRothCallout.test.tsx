/**
 * BackdoorRothCallout — informational render. Asserts the callout
 * uses current-balance wording, not "projected".
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { withTheme } from '../../test/theme-render';
import { BackdoorRothCallout } from './BackdoorRothCallout';

describe('BackdoorRothCallout', () => {
  it('renders the backdoor-available callout with current-balance wording', () => {
    render(withTheme('light', <BackdoorRothCallout />));
    expect(screen.getByText(/Backdoor Roth might be available\./i)).toBeInTheDocument();
    expect(screen.getByText(/current pre-tax IRA balance is \$0/i)).toBeInTheDocument();
    expect(screen.queryByText(/projected/i)).not.toBeInTheDocument();
  });

  it('names no profession in its consult-a-professional instruction', () => {
    // Every consult instruction in current copy reads "an appropriately
    // qualified professional"; no profession is enumerated anywhere. Nothing
    // else catches a revert here — no other check bans
    // profession names.
    const { container } = render(withTheme('light', <BackdoorRothCallout />));
    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain(
      'Consult an appropriately qualified professional for Form 8606 guidance before acting.',
    );
    expect(text).not.toContain('tax professional');
  });
});
