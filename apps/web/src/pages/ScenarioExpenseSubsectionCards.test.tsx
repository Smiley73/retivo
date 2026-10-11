/**
 * Tests for `ScenarioExpenseSubsectionCards` rendering — LifeExpectancyCard.
 *
 * Pins the leading-sentence capitalisation rule: the summary sentence
 * starts with the primary member's name, so when `memberLabel` falls back to
 * its lowercase `primary` / `secondary` slot (empty firstName, or undefined
 * member), the rendered sentence must still read with a capital letter at the
 * leading position.
 *
 * DiscretionaryAdjustmentCard / Modal tests live in the sibling file:
 * ScenarioExpenseSubsectionCards.DiscretionaryAdjustment.test.tsx
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import {
  LifeExpectancyCard,
  LifeExpectancyModal,
} from './ScenarioExpenseSubsectionCards';

const HH = 'hh-test';

const member = (
  id: string,
  isPrimary: boolean,
  firstName: string,
): Aggregate<HouseholdMemberPayload> => ({
  id,
  householdId: HH,
  aggregateType: 'householdMember',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'dev-1',
  payload: {
    isPrimary,
    firstName,
    lastName: '',
    email: '',
    birthdate: '1960-01-01',
  },
});

const scenarioAgg = (
  id: string,
  lifeExpectancyOverride: { primary: number; secondary?: number } | undefined,
): ScenarioAggregate => ({
  id,
  householdId: HH,
  aggregateType: 'scenario',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'dev-1',
  payload: {
    name: 'Base',
    description: '',
    parentScenarioId: null,
    isPrimary: true,
    notes: '',
    overrides: lifeExpectancyOverride
      ? { lifeExpectancy: lifeExpectancyOverride }
      : {},
  },
});

describe('LifeExpectancyCard summary copy', () => {
  it('capitalises the leading-sentence fallback when firstName is blank', () => {
    // Both members have empty firstName → memberLabel returns its
    // lowercase fallback (`primary` / `secondary`). The summary sentence
    // starts with the primary slot, so the rendered text must read
    // "Primary to …" — not "primary to …".
    const scenario = scenarioAgg('s', { primary: 90, secondary: 88 });
    const primary = member('m1', true, '');
    const secondary = member('m2', false, '');
    render(
      <LifeExpectancyCard
        scenario={scenario}
        scenarios={[scenario]}
        primaryMember={primary}
        secondaryMember={secondary}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(
      screen.getByText('Primary to 90 years, secondary to 88 years.'),
    ).toBeInTheDocument();
  });

  it('keeps firstName as-is at leading-sentence position', () => {
    const scenario = scenarioAgg('s', { primary: 92, secondary: 90 });
    const primary = member('m1', true, 'Robert');
    const secondary = member('m2', false, 'Jane');
    render(
      <LifeExpectancyCard
        scenario={scenario}
        scenarios={[scenario]}
        primaryMember={primary}
        secondaryMember={secondary}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(
      screen.getByText('Robert to 92 years, Jane to 90 years.'),
    ).toBeInTheDocument();
  });
});

// The scenario-modal copy convention: each modal
// opens with a `<p className="m-0 text-sm">` plain-English intro before any form
// control, at the pinned body-copy size.
describe('LifeExpectancyModal — intro copy', () => {
  it('renders a plain-English intro paragraph at text-sm', () => {
    const scenario = scenarioAgg('s', undefined);
    const primary = member('m1', true, 'Robert');
    render(
      <LifeExpectancyModal
        scenario={scenario}
        primaryMember={primary}
        secondaryMember={null}
        householdId={HH}
        onClose={() => {}}
      />,
    );
    const intro = screen.getByText(
      /Set how long to plan for each member to live/i,
    );
    expect(intro.tagName).toBe('P');
    expect(intro).toHaveClass('text-sm');
  });
});

