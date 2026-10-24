// SocialSecurityModal claim-age slider (whole years, 62 to 70, `ageMonths` 0 on save), first-paint month collapse, secondary slider only with a secondary member, live monthly benefit and the null-PIA link prompt.
import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocialSecurityModal } from './SocialSecurityModal';
import { clearAllStores, listAggregates, listPendingMutations } from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type {
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const HH = 'hh-test';

function makeMember(
  id: string,
  isPrimary: boolean,
  firstName: string,
): Aggregate<HouseholdMemberPayload> {
  return {
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
      lastName: 'Demo',
      email: `${id}@example.test`,
      birthdate: '1960-04-15',
    },
  };
}

function makeScenario(seed: {
  ageYears: number;
  ageMonths: number;
}): ScenarioAggregate {
  const payload: ScenarioPayload = {
    name: 'Base',
    description: '',
    parentScenarioId: null,
    isPrimary: true,
    notes: '',
    overrides: {
      socialSecurity: {
        primary: { ageYears: seed.ageYears, ageMonths: seed.ageMonths },
        benefitReductionPct: 0,
        colaPct: 2,
      },
    },
  };
  return {
    id: 'sc-base',
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload,
  };
}

describe('SocialSecurityModal — Save persists ageMonths: 0', () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('seeds the slider at the rounded year, then persists ageMonths: 0 on Save', async () => {
    // Baseline 65y 6m collapses to 66 on first paint, so the seeded badge reads "66 years" before any edit; whatever year the user lands on, Save persists `ageMonths: 0`.
    const scenario = makeScenario({ ageYears: 65, ageMonths: 6 });
    const primary = makeMember('hm-primary', true, 'Alex');
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <SocialSecurityModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          primaryMember={primary}
          secondaryMember={null}
          benefitsByMemberId={{}}
          householdId={HH}
          onClose={onClose}
        />
      </MemoryRouter>,
    );

    // The slider surfaces the year in the visible badge and the sr-only value description, so both nodes carry "66 years".
    await waitFor(() =>
      expect(screen.getAllByText('66 years').length).toBeGreaterThan(0),
    );

    // Drive the slider one step up through the React Aria Slider keyboard contract (thumb role="slider", ArrowRight, step 1); the edit enables Save.
    const thumb = screen.getByRole('slider', {
      name: /Alex Social Security claim age/i,
    });
    thumb.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() =>
      expect(screen.getAllByText('67 years').length).toBeGreaterThan(0),
    );

    const saveBtn = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Save fires onClose(true) once the mutation queues; wait on it before reading IndexedDB.
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    // Save routes through `saveScenario` → `queueLocalMutation`, which writes the optimistic aggregate and queues the mutation; assert on both (the queue is what sync pushes, the aggregate the local read path).
    const pending = await listPendingMutations();
    const scenarioMut = pending.find(
      (p) => p.aggregateType === 'scenario' && p.aggregateId === 'sc-base',
    );
    expect(scenarioMut).toBeTruthy();
    const persistedMut = scenarioMut!.payload as ScenarioPayload;
    const ssMut = persistedMut.overrides.socialSecurity!;
    expect(ssMut.primary.ageYears).toBe(67);
    expect(ssMut.primary.ageMonths).toBe(0);

    const stored = await listAggregates('scenario');
    const updated = stored.find((s) => s.id === 'sc-base');
    expect(updated).toBeTruthy();
    const ssAgg = (updated!.payload as ScenarioPayload).overrides.socialSecurity!;
    expect(ssAgg.primary.ageYears).toBe(67);
    expect(ssAgg.primary.ageMonths).toBe(0);
  });
});

describe('SocialSecurityModal — first-paint claim-age collapse', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Stored months round half-away-from-zero to a whole year, then clamp into [62, 70].
  it.each([
    [65, 6, 66],
    [65, 5, 65],
    [65, 7, 66],
    [67, 0, 67],
    [61, 0, 62],
    [90, 6, 70],
  ])('seeds a stored %iy %im claim age at %i', (ageYears, ageMonths, expected) => {
    const scenario = makeScenario({ ageYears, ageMonths });
    render(
      <MemoryRouter>
        <SocialSecurityModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          primaryMember={makeMember('hm-primary', true, 'Alex')}
          secondaryMember={null}
          benefitsByMemberId={{}}
          householdId={HH}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    const slider = screen.getByRole('slider', { name: /Alex Social Security claim age/i }) as HTMLInputElement;
    expect(slider.value).toBe(String(expected));
  });
});

describe('SocialSecurityModal — live amount display', () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the live monthly benefit when PIA is provided and slider at 70', async () => {
    // Born 1960-04-15 (FRA 67), PIA $3,000, slider at 70: monthlyBenefitAtAge(3000, 804, 840) = 3000 × 1.24 = $3,720.
    const scenario = makeScenario({ ageYears: 70, ageMonths: 0 });
    const primary = makeMember('hm-primary', true, 'Alex');
    render(
      <MemoryRouter>
        <SocialSecurityModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          primaryMember={primary}
          secondaryMember={null}
          benefitsByMemberId={{ 'hm-primary': { pia: 3000 } }}
          householdId={HH}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText(/Monthly benefit at age 70/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/\$3,720/)).toBeInTheDocument();
  });

  it('updates the live amount when slider moves from 62 to 70', async () => {
    const scenario = makeScenario({ ageYears: 65, ageMonths: 0 });
    const primary = makeMember('hm-primary', true, 'Alex');
    render(
      <MemoryRouter>
        <SocialSecurityModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          primaryMember={primary}
          secondaryMember={null}
          benefitsByMemberId={{ 'hm-primary': { pia: 3000 } }}
          householdId={HH}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText(/Monthly benefit at age 65/i)).toBeInTheDocument(),
    );
    const thumb = screen.getByRole('slider', {
      name: /Alex Social Security claim age/i,
    });
    thumb.focus();
    for (let i = 0; i < 5; i++) {
      await userEvent.keyboard('{ArrowRight}');
    }
    await waitFor(() =>
      expect(screen.getByText(/Monthly benefit at age 70/i)).toBeInTheDocument(),
    );
  });

  it('shows the "enter your benefit" link when PIA is null', async () => {
    const scenario = makeScenario({ ageYears: 67, ageMonths: 0 });
    const primary = makeMember('hm-primary', true, 'Alex');
    render(
      <MemoryRouter>
        <SocialSecurityModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          primaryMember={primary}
          secondaryMember={null}
          benefitsByMemberId={{ 'hm-primary': { pia: null } }}
          householdId={HH}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Enter your monthly benefit at full retirement age/i),
      ).toBeInTheDocument(),
    );
    // A button rather than a Link, so clicking fires the dirty-modal guard.
    expect(screen.getByRole('button', { name: /Social Security page/i })).toBeInTheDocument();
  });

  it('navigates to /social-security when the null-PIA button is clicked (clean state)', async () => {
    const scenario = makeScenario({ ageYears: 67, ageMonths: 0 });
    const primary = makeMember('hm-primary', true, 'Alex');
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <SocialSecurityModal
                open
                scenario={scenario}
                scenarios={[scenario]}
                primaryMember={primary}
                secondaryMember={null}
                benefitsByMemberId={{ 'hm-primary': { pia: null } }}
                householdId={HH}
                onClose={onClose}
              />
            }
          />
          <Route
            path="/social-security"
            element={<div data-testid="ss-page-sentinel" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Social Security page/i })).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Social Security page/i }));
    });

    await waitFor(() =>
      expect(screen.getByTestId('ss-page-sentinel')).toBeInTheDocument(),
    );
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('opens the dirty guard when the null-PIA button is clicked while dirty', async () => {
    const scenario = makeScenario({ ageYears: 67, ageMonths: 0 });
    const primary = makeMember('hm-primary', true, 'Alex');
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <SocialSecurityModal
                open
                scenario={scenario}
                scenarios={[scenario]}
                primaryMember={primary}
                secondaryMember={null}
                benefitsByMemberId={{ 'hm-primary': { pia: null } }}
                householdId={HH}
                onClose={vi.fn()}
              />
            }
          />
          <Route
            path="/social-security"
            element={<div data-testid="ss-page-sentinel" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByRole('slider', { name: /Alex Social Security claim age/i })).toBeInTheDocument(),
    );
    const thumb = screen.getByRole('slider', { name: /Alex Social Security claim age/i });
    thumb.focus();
    await userEvent.keyboard('{ArrowRight}');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled(),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Social Security page/i }));
    });

    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /unsaved changes/i })).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('ss-page-sentinel')).not.toBeInTheDocument();
  });
});

describe('SocialSecurityModal — COLA inflation-tracking toggle', () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('defaults the track-inflation switch on and disables the COLA slider', async () => {
    // makeScenario stores a fixed colaPct but no colaTracksInflation flag; default-on means the switch reads checked and the manual COLA slider is disabled until the user opts out.
    const scenario = makeScenario({ ageYears: 67, ageMonths: 0 });
    const primary = makeMember('hm-primary', true, 'Alex');
    render(
      <MemoryRouter>
        <SocialSecurityModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          primaryMember={primary}
          secondaryMember={null}
          benefitsByMemberId={{}}
          householdId={HH}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    const toggle = await screen.findByRole('switch', {
      name: /Track inflation/i,
    });
    expect(toggle).toBeChecked();
    const colaSlider = screen.getByRole('slider', {
      name: /Annual cost-of-living adjustment percentage/i,
    });
    expect(colaSlider).toBeDisabled();
  });

  it('persists colaTracksInflation: false when the switch is turned off and saved', async () => {
    const scenario = makeScenario({ ageYears: 67, ageMonths: 0 });
    const primary = makeMember('hm-primary', true, 'Alex');
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <SocialSecurityModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          primaryMember={primary}
          secondaryMember={null}
          benefitsByMemberId={{}}
          householdId={HH}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    const toggle = await screen.findByRole('switch', {
      name: /Track inflation/i,
    });
    await userEvent.click(toggle); // turn tracking off → dirties the modal

    const saveBtn = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const pending = await listPendingMutations();
    const scenarioMut = pending.find(
      (p) => p.aggregateType === 'scenario' && p.aggregateId === 'sc-base',
    );
    expect(scenarioMut).toBeTruthy();
    const ssMut = (scenarioMut!.payload as ScenarioPayload).overrides.socialSecurity!;
    expect(ssMut.colaTracksInflation).toBe(false);
  });

  it('describes the fixed COLA as anchored to the SSA statement date, not the claim age', async () => {
    // The engine compounds a fixed COLA for years after each member's piaAsOfDate anchor (age-62 eligibility-year fallback), not after the claim age; the helper copy must say so, shown only once inflation-tracking is off.
    const scenario = makeScenario({ ageYears: 67, ageMonths: 0 });
    const primary = makeMember('hm-primary', true, 'Alex');
    render(
      <MemoryRouter>
        <SocialSecurityModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          primaryMember={primary}
          secondaryMember={null}
          benefitsByMemberId={{}}
          householdId={HH}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    const toggle = await screen.findByRole('switch', {
      name: /Track inflation/i,
    });
    await userEvent.click(toggle); // opt out of tracking → fixed-rate copy
    expect(
      screen.getByText(
        /applied annually for years after each member's SSA statement date \(or after the year they turn 62 when no statement date is on file\)/i,
      ),
    ).toBeDefined();
    expect(screen.queryByText(/after the claim age/i)).toBeNull();
  });
});

describe('SocialSecurityModal — intro copy', () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders a plain-English intro paragraph at text-sm before the controls', () => {
    const scenario = makeScenario({ ageYears: 67, ageMonths: 0 });
    const primary = makeMember('hm-primary', true, 'Alex');
    render(
      <MemoryRouter>
        <SocialSecurityModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          primaryMember={primary}
          secondaryMember={null}
          benefitsByMemberId={{}}
          householdId={HH}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    const intro = screen.getByText(
      /Choose the age each member starts taking Social Security/i,
    );
    expect(intro.tagName).toBe('P');
    expect(intro).toHaveClass('text-sm');
  });
});

describe('SocialSecurityModal — survivor claim age', () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  const renderTwoMember = (
    overrides?: Partial<ScenarioPayload['overrides']>,
    onClose = vi.fn(),
  ) => {
    const scenario = makeScenario({ ageYears: 67, ageMonths: 0 });
    if (overrides) {
      scenario.payload.overrides = {
        ...scenario.payload.overrides,
        ...overrides,
      };
    }
    const primary = makeMember('hm-primary', true, 'Alex');
    const secondary = makeMember('hm-secondary', false, 'Blair');
    render(
      <MemoryRouter>
        <SocialSecurityModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          primaryMember={primary}
          secondaryMember={secondary}
          benefitsByMemberId={{}}
          householdId={HH}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    return { scenario, onClose };
  };

  it('shows the withheld-results note and no slider while a survivor age is unset', () => {
    renderTwoMember();
    const toggles = screen.getAllByRole('switch', {
      name: /Set survivor claim age for/i,
    });
    expect(toggles).toHaveLength(2);
    for (const t of toggles) expect(t).not.toBeChecked();
    const notes = screen.getAllByText(
      /the projection leaves out the survivor benefit/i,
    );
    expect(notes).toHaveLength(2);
    expect(
      screen.queryByRole('slider', { name: /survivor benefit claim age/i }),
    ).toBeNull();
  });

  it('enabling the toggle, adjusting the slider, and saving persists the survivor age', async () => {
    const onClose = vi.fn();
    renderTwoMember(undefined, onClose);
    const toggle = screen.getByRole('switch', {
      name: 'Set survivor claim age for Blair',
    });
    await userEvent.click(toggle);
    // The slider seeds at the FRA-typical 67 over 60–70; React Aria renders a native range input, so assert value/min/max.
    const slider = screen.getByRole('slider', {
      name: 'Blair survivor benefit claim age',
    }) as HTMLInputElement;
    expect(slider.min).toBe('60');
    expect(slider.max).toBe('70');
    expect(slider.value).toBe('67');
    slider.focus();
    await userEvent.keyboard(
      '{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}',
    );
    await waitFor(() => expect(slider.value).toBe('62'));

    const saveBtn = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const pending = await listPendingMutations();
    const scenarioMut = pending.find(
      (p) => p.aggregateType === 'scenario' && p.aggregateId === 'sc-base',
    );
    const persisted = scenarioMut!.payload as ScenarioPayload;
    const survivor = persisted.overrides.socialSecurity!.survivor;
    expect(survivor?.secondary).toEqual({ ageYears: 62, ageMonths: 0 });
    // Absence is preserved, never silently defaulted.
    expect(survivor && 'primary' in survivor).toBe(false);
  });

  it('seeds the slider from a stored survivor age and clears it when toggled off', async () => {
    const onClose = vi.fn();
    renderTwoMember(
      {
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
          survivor: { primary: { ageYears: 64, ageMonths: 0 } },
        },
      },
      onClose,
    );
    const slider = screen.getByRole('slider', {
      name: 'Alex survivor benefit claim age',
    }) as HTMLInputElement;
    expect(slider.value).toBe('64');
    const toggle = screen.getByRole('switch', {
      name: 'Set survivor claim age for Alex',
    });
    await userEvent.click(toggle);
    expect(
      screen.queryByRole('slider', { name: 'Alex survivor benefit claim age' }),
    ).toBeNull();
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    const pending = await listPendingMutations();
    const scenarioMut = pending.find(
      (p) => p.aggregateType === 'scenario' && p.aggregateId === 'sc-base',
    );
    const persisted = scenarioMut!.payload as ScenarioPayload;
    expect(persisted.overrides.socialSecurity!.survivor).toBeUndefined();
  });

  // Same collapse as the member's own claim age, clamped into the survivor window [60, 70].
  it.each([
    [64, 0, 64],
    [62, 6, 63],
    [58, 0, 60],
    [72, 0, 70],
  ])('seeds a stored survivor age of %iy %im at %i', (ageYears, ageMonths, expected) => {
    renderTwoMember({
      socialSecurity: {
        primary: { ageYears: 67, ageMonths: 0 },
        secondary: { ageYears: 67, ageMonths: 0 },
        survivor: { primary: { ageYears, ageMonths } },
      },
    });
    const slider = screen.getByRole('slider', { name: 'Alex survivor benefit claim age' }) as HTMLInputElement;
    expect(slider.value).toBe(String(expected));
  });

  it('shows no survivor control for single-member plans', () => {
    const scenario = makeScenario({ ageYears: 67, ageMonths: 0 });
    const primary = makeMember('hm-primary', true, 'Alex');
    render(
      <MemoryRouter>
        <SocialSecurityModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          primaryMember={primary}
          secondaryMember={null}
          benefitsByMemberId={{}}
          householdId={HH}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole('switch', { name: /Set survivor claim age/i }),
    ).toBeNull();
  });

  it('has no a11y violations with the survivor controls rendered', async () => {
    renderTwoMember({
      socialSecurity: {
        primary: { ageYears: 67, ageMonths: 0 },
        secondary: { ageYears: 67, ageMonths: 0 },
        survivor: {
          primary: { ageYears: 62, ageMonths: 0 },
          secondary: { ageYears: 60, ageMonths: 0 },
        },
      },
    });
    // The modal renders through a React Aria portal, so scan the document body.
    await expectNoA11yViolations(document.body);
  });
});
