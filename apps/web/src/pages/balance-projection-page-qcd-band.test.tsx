// QcdBand: the basis-suffixed heading that owns `qcd-heading`, the single "QCD distributed" tile (RMD-side QCD tiles live on the RMD card), per-year gift bars, the (i) popover with the QCD explainer and none of the split-bar prose, the MC sub-label and the null gate.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { QcdBand, type QcdBandProps } from './balance-projection-page-qcd-band';
import type { QcdChartRow } from '../components/QcdChart';
import { ThemeProvider } from '../contexts/ThemeContext';
import { expectNoA11yViolations } from '../test/a11y';

const QCD: QcdChartRow[] = [
  { year: 2047, dollars: 30_000 },
  { year: 2048, dollars: 18_000 },
];
const BAR = 'rect[name="Charitable distribution (QCD)"]';
const INFO = /About the Qualified Charitable Distributions chart/i;

function renderBand(overrides: Partial<QcdBandProps> = {}) {
  return render(
    <ThemeProvider>
      <QcdBand totalQcd={48_000} rows={QCD} methodLabel="Planned" {...overrides} />
    </ThemeProvider>,
  );
}

async function openInfo(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: INFO }));
  return screen.getByRole('dialog', { name: INFO });
}

describe('QcdBand', () => {
  it('renders the basis-suffixed heading, the QCD distributed tile, and one bar per gift year', async () => {
    const { container } = renderBand();
    expect(
      screen.getByRole('heading', {
        name: 'Qualified Charitable Distributions (QCD) (Planned)',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('QCD distributed')).toBeInTheDocument();
    expect(screen.getByText('$48k')).toBeInTheDocument();
    await waitFor(() =>
      expect(container.querySelectorAll(BAR)).toHaveLength(2),
    );
  });

  it('owns the qcd-heading id exactly once', () => {
    const { container } = renderBand();
    expect(container.querySelectorAll('#qcd-heading')).toHaveLength(1);
    expect(container.querySelectorAll('#rmd-heading')).toHaveLength(0);
  });

  it('does not render the RMD-side QCD tiles (they live on the RMD card)', () => {
    renderBand();
    expect(screen.queryByText('Net taxable IRA RMD')).not.toBeInTheDocument();
    expect(screen.queryByText('RMD covered by QCD')).not.toBeInTheDocument();
  });

  it('surfaces the QCD explainer behind its own (i) and none of the split-bar prose', async () => {
    renderBand();
    expect(
      screen.queryByText(/QCD distributed is the lifetime amount/i),
    ).not.toBeInTheDocument();
    const dialog = await openInfo();
    expect(dialog).toHaveTextContent(
      /QCD distributed is the lifetime amount given directly from a traditional IRA/i,
    );
    expect(dialog).toHaveTextContent(/Each bar is the amount given that year/i);
    expect(dialog).not.toHaveTextContent(/The split bar covers/i);
  });

  it('renders the MC sub-label under the title when given, and omits it otherwise', () => {
    const { unmount } = renderBand({
      methodLabel: 'Typical',
      subLabel: 'Based on one example simulated path.',
    });
    expect(
      screen.getByRole('heading', {
        name: 'Qualified Charitable Distributions (QCD) (Typical)',
      }),
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

  it('renders nothing when total QCD is 0', () => {
    const { container } = renderBand({ totalQcd: 0, rows: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('has no a11y violations', async () => {
    const { container } = renderBand({
      subLabel: 'Based on one example simulated path.',
    });
    await expectNoA11yViolations(container);
  });
});
