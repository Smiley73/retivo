// AccountHistorySection Reset-button visibility. AccountHistoryCharts is mocked to a div and useChartZoom is mocked so isZoomed can be driven without a real drag.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../components/AccountHistoryCharts', () => ({
  AccountHistoryCharts: () => <div data-testid="account-history-charts" />,
}));

let mockIsZoomed = false;
const mockReset = vi.fn();

vi.mock('../lib/use-chart-zoom', () => ({
  useChartZoom: () => ({
    xDomain: undefined,
    yDomain: null,
    isZoomed: mockIsZoomed,
    isDragging: false,
    dragSelection: null,
    mouseHandlers: {},
    reset: mockReset,
  }),
}));

import { AccountHistorySection } from './account-history-section';
import type { AccountHistoryRow } from '../components/AccountHistoryCharts';

const rows: AccountHistoryRow[] = [
  { year: 2022, endingBalance: 100_000, returnPct: 7.0 },
  { year: 2023, endingBalance: 110_000, returnPct: 10.0 },
];

describe('AccountHistorySection', () => {
  beforeEach(() => {
    mockIsZoomed = false;
    mockReset.mockClear();
  });

  it('reset_visible_when_zoomed', () => {
    mockIsZoomed = true;
    render(<AccountHistorySection rows={rows} />);
    expect(
      screen.getByRole('button', { name: /reset view/i }),
    ).toBeInTheDocument();
  });
});
