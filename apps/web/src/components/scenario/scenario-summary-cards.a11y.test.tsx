/**
 * A11y smoke coverage for the scenario summary-card components pulled out
 * of ScenarioDetailPage.tsx to keep that file under the shape limit. Each of these files
 * renders `ConfigureResetActions` (real `<button>` elements), so per
 * AGENTS.md's a11y-smoke rule they are interactive, not purely
 * presentational. One representative instance per file collapses to a
 * single scan (AGENTS.md's "scans multiple variants" allowance) — this
 * file does not exhaustively cover every prop variant of every card.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it } from 'vitest';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../../db/types';
import type { ScenarioAggregate } from '../../lib/scenario-resolution';
import { expectNoA11yViolations } from '../../test/a11y';
import { RetirementAgeSummaryCard } from './SummaryCard';
import { ExpenseOverridesSummaryCard } from './ExpenseOverridesSummary';
import { IncomeOverridesSummaryCard } from './IncomeOverridesSummary';
import { RothConversionsSummaryCard } from './RothConversionsSummary';
import { QcdSummaryCard } from './QcdSummary';
import { AccountContributionsOverridesSummaryCard } from './AccountOverridesSummary';

const HH = 'hh-test';

function makeMember(): Aggregate<HouseholdMemberPayload> {
  return {
    id: 'hm-primary',
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary: true,
      firstName: 'Alex',
      lastName: 'Demo',
      email: 'alex@example.test',
      birthdate: '1960-04-15',
    },
  };
}

function makeAccount(): Aggregate<AccountPayload> {
  return {
    id: 'acct-1',
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Traditional IRA',
      type: 'RETIREMENT_IRA',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'PRE_TAX',
      ownerId: 'hm-primary',
      institution: 'Test Bank',
      notes: '',
      planningReturnPct: 6,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

function makeScenario(): ScenarioAggregate {
  return {
    id: 'scn-1',
    householdId: HH,
    schemaVersion: 1,
    version: 1,
    updatedAt: new Date().toISOString(),
    deviceId: 'dev-1',
    aggregateType: 'scenario',
    payload: {
      name: 'Base',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {},
    },
  } as ScenarioAggregate;
}

describe('scenario summary cards — a11y smoke', () => {
  it('SummaryCard (RetirementAgeSummaryCard) has no a11y violations', async () => {
    const scenario = makeScenario();
    const { container } = render(
      <RetirementAgeSummaryCard
        scenario={scenario}
        scenarios={[scenario]}
        primaryMember={makeMember()}
        secondaryMember={null}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it('ExpenseOverridesSummary has no a11y violations', async () => {
    const scenario = makeScenario();
    const { container } = render(
      <MemoryRouter>
        <ExpenseOverridesSummaryCard
          scenarioId={scenario.id}
          scenario={scenario}
          onResetToInherited={() => {}}
        />
      </MemoryRouter>,
    );
    await expectNoA11yViolations(container);
  });

  it('IncomeOverridesSummary has no a11y violations', async () => {
    const scenario = makeScenario();
    const { container } = render(
      <MemoryRouter>
        <IncomeOverridesSummaryCard
          scenarioId={scenario.id}
          scenario={scenario}
          onResetToInherited={() => {}}
        />
      </MemoryRouter>,
    );
    await expectNoA11yViolations(container);
  });

  it('RothConversionsSummary has no a11y violations', async () => {
    const scenario = makeScenario();
    const { container } = render(
      <MemoryRouter>
        <RothConversionsSummaryCard
          scenarioId={scenario.id}
          scenario={scenario}
          scenarios={[scenario]}
          members={[makeMember()]}
          onResetToInherited={() => {}}
        />
      </MemoryRouter>,
    );
    await expectNoA11yViolations(container);
  });

  it('QcdSummary has no a11y violations', async () => {
    const scenario = makeScenario();
    const { container } = render(
      <MemoryRouter>
        <QcdSummaryCard
          scenarioId={scenario.id}
          scenario={scenario}
          scenarios={[scenario]}
          accounts={[makeAccount()]}
          members={[makeMember()]}
          onResetToInherited={() => {}}
        />
      </MemoryRouter>,
    );
    await expectNoA11yViolations(container);
  });

  it('AccountOverridesSummary (AccountContributionsOverridesSummaryCard) has no a11y violations', async () => {
    const scenario = makeScenario();
    const { container } = render(
      <MemoryRouter>
        <AccountContributionsOverridesSummaryCard
          scenarioId={scenario.id}
          scenario={scenario}
          activeAccountCount={1}
          onResetToInherited={() => {}}
        />
      </MemoryRouter>,
    );
    await expectNoA11yViolations(container);
  });
});
