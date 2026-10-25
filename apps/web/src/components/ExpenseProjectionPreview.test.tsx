/** ExpenseProjectionPreview: the live single-expense form preview. */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Records the props but delegates to the real chart, so the lazy-chart legend text still resolves.
const chartPropsSpy = vi.fn();
vi.mock('./ExpensesProjectionChart', async () => {
  const actual = await vi.importActual<typeof import('./ExpensesProjectionChart')>('./ExpensesProjectionChart');
  const RealExpensesProjectionChart = actual.ExpensesProjectionChart;
  return {
    ...actual,
    ExpensesProjectionChart: (props: unknown) => {
      chartPropsSpy(props);
      return React.createElement(
        RealExpensesProjectionChart as React.ComponentType<unknown>,
        props as React.Attributes & Record<string, unknown>,
      );
    },
  };
});

import { ExpenseProjectionPreview } from './ExpenseProjectionPreview';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type {
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
} from '../db/types';
import { expectNoA11yViolations } from '../test/a11y';
import { ThemeWrapper, renderWithTheme } from '../test/theme-render';
import { CHART_COLORS } from '../lib/tokens';

const member = (): Aggregate<HouseholdMemberPayload> => ({
  id: 'hm-1',
  householdId: 'hh',
  aggregateType: 'householdMember',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'dev-1',
  payload: {
    isPrimary: true,
    firstName: 'Alex',
    lastName: 'P',
    email: 'a@x.test',
    birthdate: '1965-04-15',
  },
});

const scenario = (
  id: string,
  isPrimary: boolean,
  overrides: ScenarioAggregate['payload']['overrides'],
  parentScenarioId: string | null = null,
): ScenarioAggregate => ({
  id,
  householdId: 'hh',
  aggregateType: 'scenario',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'dev-1',
  payload: {
    name: id,
    description: '',
    parentScenarioId,
    isPrimary,
    notes: '',
    overrides,
  },
});

const DRAFT: ExpensePayload = {
  name: 'Travel',
  amount: 1000,
  frequency: 'monthly',
  classification: 'discretionary',
  categoryId: 'cat-1',
  start: { kind: 'retirementStart' },
  end: { kind: 'lifetime', whose: 'primary' },
};

const PRIMARY_SCN = scenario('scn-base', true, {});
const TARGET_SCN = scenario(
  'scn-target',
  false,
  { retirementAge: { primary: { ageYears: 60, ageMonths: 2 } } },
  'scn-base',
);

// The lazy chart import crosses a Suspense boundary and the default findBy timeout is too tight under full-suite load,
// so every lazy-chart wait gets the same explicit budget.
const LAZY_CHART_WAIT = { timeout: 5000 } as const;
const findThisExpense = (): Promise<HTMLElement> =>
  screen.findByText('This expense', undefined, LAZY_CHART_WAIT);
const findAllThisExpense = (): Promise<HTMLElement[]> =>
  screen.findAllByText('This expense', undefined, LAZY_CHART_WAIT);

describe('ExpenseProjectionPreview', () => {
  it('renders the reused projection chart for a valid draft (after Suspense resolves)', async () => {
    const { container } = render(
      <ExpenseProjectionPreview
        draft={DRAFT}
        members={[member()]}
        scenarios={[PRIMARY_SCN, TARGET_SCN]}
        targetScenarioId={TARGET_SCN.id}
      />,
      { wrapper: ThemeWrapper },
    );
    expect(await findThisExpense()).toBeInTheDocument();
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
    expect(screen.queryByText('Essential')).not.toBeInTheDocument();
    expect(screen.queryByText('Discretionary')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Projection preview' }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('shows the no-amount guard line for a zero-amount draft', () => {
    render(
      <ExpenseProjectionPreview
        draft={{ ...DRAFT, amount: 0 }}
        members={[member()]}
        scenarios={[PRIMARY_SCN, TARGET_SCN]}
        targetScenarioId={TARGET_SCN.id}
      />,
      { wrapper: ThemeWrapper },
    );
    expect(
      screen.getByText('Enter an amount to preview this expense.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('This expense')).not.toBeInTheDocument();
  });

  it('shows the no-amount guard line when no draft is available yet', () => {
    render(
      <ExpenseProjectionPreview
        draft={null}
        members={[member()]}
        scenarios={[PRIMARY_SCN, TARGET_SCN]}
        targetScenarioId={null}
      />,
      { wrapper: ThemeWrapper },
    );
    expect(
      screen.getByText('Enter an amount to preview this expense.'),
    ).toBeInTheDocument();
  });

  it('resolves under the target scenario, not the primary', async () => {
    const { rerender } = render(
      <ExpenseProjectionPreview
        draft={DRAFT}
        members={[member()]}
        scenarios={[PRIMARY_SCN, TARGET_SCN]}
        targetScenarioId={null}
      />,
      { wrapper: ThemeWrapper },
    );
    expect(
      screen.getByText('Add a retirement age and birthdate to preview.'),
    ).toBeInTheDocument();

    rerender(
      <ExpenseProjectionPreview
        draft={DRAFT}
        members={[member()]}
        scenarios={[PRIMARY_SCN, TARGET_SCN]}
        targetScenarioId={TARGET_SCN.id}
      />,
    );
    expect(await findThisExpense()).toBeInTheDocument();
  });

  it('re-projects live when the draft prop changes', async () => {
    const { rerender } = render(
      <ExpenseProjectionPreview
        draft={DRAFT}
        members={[member()]}
        scenarios={[PRIMARY_SCN, TARGET_SCN]}
        targetScenarioId={TARGET_SCN.id}
      />,
      { wrapper: ThemeWrapper },
    );
    expect(await findThisExpense()).toBeInTheDocument();

    rerender(
      <ExpenseProjectionPreview
        draft={{ ...DRAFT, amount: 0 }}
        members={[member()]}
        scenarios={[PRIMARY_SCN, TARGET_SCN]}
        targetScenarioId={TARGET_SCN.id}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText('Enter an amount to preview this expense.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('This expense')).not.toBeInTheDocument();
  });

  it('re-themes the life-expectancy marker color on a live theme toggle (no data change)', async () => {
    expect(CHART_COLORS.light.lifeMarkerPrimary).not.toBe(
      CHART_COLORS.dark.lifeMarkerPrimary,
    );
    const lifeMarkerStroke = (
      container: HTMLElement,
      theme: 'light' | 'dark',
    ): string => {
      const retirementStroke = CHART_COLORS[theme].retirementMarker;
      const lines = Array.from(
        container.querySelectorAll<SVGLineElement>('line[data-marker-label]'),
      );
      const line = lines.find(
        (l) => l.getAttribute('stroke') !== retirementStroke,
      );
      if (!line) throw new Error('life-expectancy marker not found');
      return line.getAttribute('stroke') ?? '';
    };
    const props = {
      draft: DRAFT,
      members: [member()],
      scenarios: [PRIMARY_SCN, TARGET_SCN],
      targetScenarioId: TARGET_SCN.id,
    };

    const lightContainer = renderWithTheme(
      'light',
      <ExpenseProjectionPreview {...props} />,
    );
    await findThisExpense();
    await waitFor(() =>
      expect(lifeMarkerStroke(lightContainer, 'light')).toBe(
        CHART_COLORS.light.lifeMarkerPrimary,
      ),
    );

    const darkContainer = renderWithTheme(
      'dark',
      <ExpenseProjectionPreview {...props} />,
    );
    await findAllThisExpense();
    await waitFor(() =>
      expect(lifeMarkerStroke(darkContainer, 'dark')).toBe(
        CHART_COLORS.dark.lifeMarkerPrimary,
      ),
    );
  });

  it('warns (no chart) when the glide starts before the expense does', () => {
    const draft: ExpensePayload = {
      ...DRAFT,
      classification: 'discretionary',
      start: { kind: 'retirementStart' },
      discretionaryGlide: {
        endMultiplierPct: 60,
        glideStart: { kind: 'year', year: 1990 },
        glideEnd: { kind: 'year', year: 2050 },
      },
    };
    render(
      <ExpenseProjectionPreview
        draft={draft}
        members={[member()]}
        scenarios={[PRIMARY_SCN, TARGET_SCN]}
        targetScenarioId={TARGET_SCN.id}
      />,
      { wrapper: ThemeWrapper },
    );
    expect(
      screen.getByText(/spending glide starts before the expense/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('This expense')).not.toBeInTheDocument();
  });
});

describe('ExpenseProjectionPreview — enableZoom=false regression', () => {
  it('passes enableZoom=false and no zoom props to ExpensesProjectionChart', () => {
    chartPropsSpy.mockClear();
    render(
      <ExpenseProjectionPreview
        draft={DRAFT}
        members={[member()]}
        scenarios={[PRIMARY_SCN, TARGET_SCN]}
        targetScenarioId={TARGET_SCN.id}
      />,
      { wrapper: ThemeWrapper },
    );
    expect(chartPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ enableZoom: false }),
    );
    const receivedProps = chartPropsSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(receivedProps).not.toHaveProperty('mouseHandlers');
    expect(receivedProps).not.toHaveProperty('dragSelection');
    expect(receivedProps).not.toHaveProperty('xDomain');
    expect(receivedProps).not.toHaveProperty('yDomain');
    expect(screen.queryByRole('button', { name: /reset view/i })).toBeNull();
  });
});
