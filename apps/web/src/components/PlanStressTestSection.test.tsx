/**
 * Composed axe smoke check across the stress-test display slots.
 */
import { describe, it } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { PlanStressTestHorizonCards, PlanStressTestRetirementCards, PlanStressTestChart } from './PlanStressTestSection';
import { vm } from './__fixtures__/plan-stress-test-vm';
import { expectNoA11yViolations } from '../test/a11y';
import { withTheme } from '../test/theme-render';


// AGENTS.md (Testing setup) — every test file under apps/web/src/components
// must run at least one axe smoke check. Exercise the three top-level slots
// rendered by this suite (retirement cards, horizon cards, chart) in one
// composed tree so the assertion covers the same surface the suite tests.
describe('PlanStressTestSection — a11y smoke', () => {
  it('renders the retirement + horizon cards and chart without axe violations', async () => {
    const composed = vm();
    const { container } = render(
      withTheme(
        'light',
        <MemoryRouter>
          <PlanStressTestRetirementCards vm={composed} />
          <PlanStressTestHorizonCards vm={composed} />
          <PlanStressTestChart
            vm={composed}
            dataTableOpen={false}
            onToggleDataTable={() => undefined}
          />
        </MemoryRouter>,
      ),
    );
    await expectNoA11yViolations(container);
  });
});
