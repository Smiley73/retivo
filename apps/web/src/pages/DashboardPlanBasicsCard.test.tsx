// DashboardPlanBasicsCard: blanking and the methodology trigger; the card takes no view-model.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DashboardPlanBasicsCard } from './DashboardPlanBasicsCard';
import { expectNoA11yViolations } from '../test/a11y';

describe('DashboardPlanBasicsCard', () => {
  it('renders its three rows with populated figures', () => {
    render(
      <DashboardPlanBasicsCard
        netWorth={1_446_030}
        projectedAtRetirement={3_570_000}
        retirementYear={2050}
      />,
    );
    expect(
      screen.getByRole('heading', { level: 2, name: 'Plan basics' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Current net worth')).toBeInTheDocument();
    expect(screen.getByText('$1.4M')).toBeInTheDocument();
    expect(screen.getByText('Projected at retirement')).toBeInTheDocument();
    expect(screen.getByText('$3.6M')).toBeInTheDocument();
    expect(screen.getByText('Retirement year')).toBeInTheDocument();
    expect(screen.getByText('2050')).toBeInTheDocument();
  });

  // The dashboard renders the card even when the stress-test vm is `null` on a config error, so only net worth is guaranteed live.
  it('blanks projectedAtRetirement and retirementYear to "—" when null', () => {
    render(
      <DashboardPlanBasicsCard
        netWorth={1_446_030}
        projectedAtRetirement={null}
        retirementYear={null}
      />,
    );
    expect(screen.getByText('$1.4M')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it("states the today's-dollars basis for the figures", () => {
    render(
      <DashboardPlanBasicsCard
        netWorth={1_446_030}
        projectedAtRetirement={3_570_000}
        retirementYear={2050}
      />,
    );
    expect(
      screen.getByText("Figures shown in today's dollars."),
    ).toBeInTheDocument();
  });

  it('exposes the methodology trigger', () => {
    render(
      <DashboardPlanBasicsCard
        netWorth={1_446_030}
        projectedAtRetirement={3_570_000}
        retirementYear={2050}
      />,
    );
    expect(
      screen.getByRole('button', {
        name: 'How is success probability calculated?',
      }),
    ).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <DashboardPlanBasicsCard
        netWorth={1_446_030}
        projectedAtRetirement={3_570_000}
        retirementYear={2050}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
