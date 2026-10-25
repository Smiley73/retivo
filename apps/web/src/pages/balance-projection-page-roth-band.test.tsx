// RothConversionsBand: the basis-suffixed heading that owns `roth-conversions-heading`, the "Total Roth converted" tile, per-year bars, the (i) popover with the per-bar caption and federal-only disclosure (planned working-years and Fill conversions), the MC sub-label and the null gate.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  RothConversionsBand,
  type RothConversionsBandProps,
} from './balance-projection-page-roth-band';
import type { RothConversionsChartRow } from '../components/RothConversionsChart';
import { ThemeProvider } from '../contexts/ThemeContext';
import { expectNoA11yViolations } from '../test/a11y';

const CONVERSIONS: RothConversionsChartRow[] = [
  { year: 2039, dollars: 27_992 },
  { year: 2040, dollars: 18_500 },
];
const BAR = 'rect[name="Roth converted"]';
const INFO = /About the Roth conversions chart/i;

function renderBand(overrides: Partial<RothConversionsBandProps> = {}) {
  return render(
    <ThemeProvider>
      <RothConversionsBand
        totalRothConverted={46_492}
        rows={CONVERSIONS}
        methodLabel="Planned"
        {...overrides}
      />
    </ThemeProvider>,
  );
}

async function openInfo(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: INFO }));
  return screen.getByRole('dialog', { name: INFO });
}

describe('RothConversionsBand', () => {
  it('renders the basis-suffixed heading, the Total Roth converted tile, and one bar per conversion year', async () => {
    const { container } = renderBand();
    expect(
      screen.getByRole('heading', { name: 'Roth conversions (Planned)' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Total Roth converted')).toBeInTheDocument();
    expect(screen.getByText('$46k')).toBeInTheDocument();
    await waitFor(() =>
      expect(container.querySelectorAll(BAR)).toHaveLength(2),
    );
  });

  it('owns the roth-conversions-heading id exactly once', () => {
    const { container } = renderBand();
    expect(container.querySelectorAll('#roth-conversions-heading')).toHaveLength(1);
    expect(container.querySelectorAll('#rmd-heading')).toHaveLength(0);
  });

  it('renders the MC sub-label under the title when given, and omits it otherwise', () => {
    const { unmount } = renderBand({
      methodLabel: 'Typical',
      subLabel: 'Based on one example simulated path.',
    });
    expect(
      screen.getByRole('heading', { name: 'Roth conversions (Typical)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Based on one example simulated path.'),
    ).toBeInTheDocument();
    unmount();
    renderBand();
    expect(
      screen.queryByText('Based on one example simulated path.'),
    ).not.toBeInTheDocument();
  });

  it('keeps the caption + disclosure out of the inline DOM and surfaces both behind the (i)', async () => {
    renderBand();
    expect(
      screen.queryByText(/Total Roth converted is the lifetime amount/i),
    ).not.toBeInTheDocument();
    const dialog = await openInfo();
    expect(dialog).toHaveTextContent(
      /Each bar is the amount converted from pre-tax savings to Roth that year/i,
    );
    expect(dialog).toHaveTextContent(
      /Total Roth converted is the lifetime amount moved from your pre-tax accounts/i,
    );
    expect(dialog).toHaveTextContent(
      /conversions you planned during your working years/i,
    );
    expect(dialog).toHaveTextContent(/income cap's Fill mode/i);
    expect(dialog).toHaveTextContent(
      /state taxes may also apply and are not modeled here/i,
    );
  });

  it('renders the tile without a chart when the series is empty', () => {
    const { container } = renderBand({ rows: [] });
    expect(screen.getByText('Total Roth converted')).toBeInTheDocument();
    expect(container.querySelectorAll(BAR)).toHaveLength(0);
  });

  it('renders nothing when total converted is 0', () => {
    const { container } = renderBand({ totalRothConverted: 0, rows: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('has no a11y violations', async () => {
    const { container } = renderBand({
      subLabel: 'Based on one example simulated path.',
    });
    await expectNoA11yViolations(container);
  });
});
