// Live-amount + slider + save + COLA-toggle + survivor-claim-age tests share the
// same modal render setup; splitting would duplicate the helper.
/**
 * SocialSecurityModal — claim-age slider behavior + live-amount
 * display:
 *  - Whole-year-only entry, bounded by SSA's legal range (62 to 70).
 *  - `ageMonths` always 0 on save.
 *  - On first paint, pre-existing stored months collapse to the
 *    nearest whole year via half-away-from-zero rounding + clamp.
 *  - Secondary slider renders only when a secondary member exists.
 *  - Live monthly benefit shown under slider; null PIA → link prompt.
 */
import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SocialSecurityModal,
  claimAgeToSliderYear,
  survivorAgeToSliderYear,
} from './SocialSecurityModal';
import { clearAllStores, listAggregates, listPendingMutations } from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type {
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

describe('claimAgeToSliderYear (first-paint formula)', () => {
  it('rounds 65 years 6 months to 66 (half-away-from-zero)', () => {
    expect(claimAgeToSliderYear(65, 6)).toBe(66);
  });

  it('rounds 64 years 6 months to 65', () => {
    expect(claimAgeToSliderYear(64, 6)).toBe(65);
  });

  it('rounds 68 years 6 months to 69', () => {
    expect(claimAgeToSliderYear(68, 6)).toBe(69);
  });

  it('clamps 61 years 0 months up to 62 (lower bound)', () => {
    expect(claimAgeToSliderYear(61, 0)).toBe(62);
  });

  it('clamps 71 years 0 months down to 70 (upper bound)', () => {
    expect(claimAgeToSliderYear(71, 0)).toBe(70);
  });

  it('clamps a deep low (50 years 0 months) up to 62', () => {
    expect(claimAgeToSliderYear(50, 0)).toBe(62);
  });

  it('clamps a deep high (90 years 6 months) down to 70', () => {
    expect(claimAgeToSliderYear(90, 6)).toBe(70);
  });

  it('passes a whole-year value through unchanged within range', () => {
    expect(claimAgeToSliderYear(67, 0)).toBe(67);
  });

  it('rounds zero months to a no-op', () => {
    expect(claimAgeToSliderYear(65, 0)).toBe(65);
  });

  it('rounds 65 years 5 months down to 65 (half-away rule does not apply at < .5)', () => {
    expect(claimAgeToSliderYear(65, 5)).toBe(65);
  });

  it('rounds 65 years 7 months up to 66', () => {
    expect(claimAgeToSliderYear(65, 7)).toBe(66);
  });
});

describe('survivorAgeToSliderYear (survivor window collapse)', () => {
  it('passes a whole-year value through unchanged within [60, 70]', () => {
    expect(survivorAgeToSliderYear(64, 0)).toBe(64);
  });

  it('rounds months half-away-from-zero (62 years 6 months → 63)', () => {
    expect(survivorAgeToSliderYear(62, 6)).toBe(63);
  });

  it('clamps below the widow(er) floor (58 → 60)', () => {
    expect(survivorAgeToSliderYear(58, 0)).toBe(60);
  });

  it('clamps above the window (72 → 70)', () => {
    expect(survivorAgeToSliderYear(72, 0)).toBe(70);
  });
});

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
    // Baseline stores `65 years 6 months` for the primary. The modal rounds
    // that to 66 on the modal's first paint (half-away-from-zero, then
    // clamp into [62, 70]). The slider's seeded value badge therefore
    // reads "66 years" — proving the first-paint collapse, even before
    // any user edit. It must also hold that whatever year the user lands
    // on Save persists with `ageMonths: 0`.
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

    // Rounding: baseline 65y 6m → 66. The slider surfaces the
    // formatted year in two places — the visible badge + the sr-only
    // value description — so both nodes carry "66 years".
    await waitFor(() =>
      expect(screen.getAllByText('66 years').length).toBeGreaterThan(0),
    );

    // Drive the slider one step UP via the RA Slider's keyboard
    // contract: the thumb has role="slider" and responds to ArrowRight.
    // Step = 1, so 66 → 67. This dirty-fies the modal so Save enables.
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

    // Save fires onClose(true) when the mutation queues successfully.
    // Wait on that signal before reading IndexedDB so we know the
    // mutation persisted.
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    // Save routes through `saveScenario` → `queueLocalMutation`, which
    // (a) writes the optimistic aggregate via `putAggregate` AND (b)
    // queues the mutation. The mutation queue is the relevant
    // contract surface (downstream sync sees what gets pushed), and the
    // aggregate is the inspection surface for the local read path.
    // Assert on both to make the contract clear.
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

describe('SocialSecurityModal — live amount display', () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the live monthly benefit when PIA is provided and slider at 70', async () => {
    // Primary: born 1960-04-15 (FRA 67), PIA $3,000, slider at 70.
    // monthlyBenefitAtAge(3000, 804, 840) = 3000 * 1.24 = $3,720.
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
    // Live-amount line should show age 70 benefit (PIA $3,000 × 1.24 = $3,720).
    await waitFor(() =>
      expect(screen.getByText(/Monthly benefit at age 70/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/\$3,720/)).toBeInTheDocument();
  });

  it('updates the live amount when slider moves from 62 to 70', async () => {
    // Primary: born 1960-04-15 (FRA 67), PIA $3,000, slider starts at 65.
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
    // Slider starts at 65 — live line should show age 65.
    await waitFor(() =>
      expect(screen.getByText(/Monthly benefit at age 65/i)).toBeInTheDocument(),
    );
    // Move slider to 70 via keyboard.
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
    // Changed from <Link> to <button> so clicking fires the dirty-modal guard.
    expect(screen.getByRole('button', { name: /Social Security page/i })).toBeInTheDocument();
  });

  it('navigates to /social-security when the null-PIA button is clicked (clean state)', async () => {
    // Modal is clean (no user edits) — clicking the button must close the
    // modal and navigate without opening any confirm dialog.
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

    // Clean path: no confirm dialog, modal closes immediately, router lands on sentinel.
    await waitFor(() =>
      expect(screen.getByTestId('ss-page-sentinel')).toBeInTheDocument(),
    );
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('opens the dirty guard when the null-PIA button is clicked while dirty', async () => {
    // Slider is moved first so the modal becomes dirty. Clicking the button
    // must open the unsaved-changes confirm (not navigate immediately).
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

    // Make the modal dirty by moving the slider.
    await waitFor(() =>
      expect(screen.getByRole('slider', { name: /Alex Social Security claim age/i })).toBeInTheDocument(),
    );
    const thumb = screen.getByRole('slider', { name: /Alex Social Security claim age/i });
    thumb.focus();
    await userEvent.keyboard('{ArrowRight}');

    // Confirm dirty: Save button is now enabled.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled(),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Social Security page/i }));
    });

    // Dirty path: confirm dialog appears; sentinel page must NOT be visible yet.
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
    // makeScenario stores a fixed colaPct but no colaTracksInflation flag.
    // Default-on: the switch reads checked and the manual COLA slider is
    // disabled until the user opts out.
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
    // The engine compounds a fixed COLA for years after each member's
    // piaAsOfDate statement anchor (age-62 eligibility-year fallback),
    // NOT after the claim age; the helper copy must say so. The fixed-rate
    // description shows only once inflation-tracking is switched off.
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
    // Negative control: the stale claim-age anchor description must not return.
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
    // Scenario-modal copy convention: the modal
    // opens with a `<p className="m-0 text-sm">` plain-English intro before any
    // form control (pinned body-copy size).
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
    // One toggle per member, both off.
    const toggles = screen.getAllByRole('switch', {
      name: /Set survivor claim age for/i,
    });
    expect(toggles).toHaveLength(2);
    for (const t of toggles) expect(t).not.toBeChecked();
    // The withheld state names the missing input and the consequence.
    const notes = screen.getAllByText(
      /the projection leaves out the survivor benefit/i,
    );
    expect(notes).toHaveLength(2);
    // No survivor sliders while unset.
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
    // Slider appears seeded at the FRA-typical 67, range 60–70. React Aria
    // renders the thumb as a native range input — assert on its value/min/max.
    const slider = screen.getByRole('slider', {
      name: 'Blair survivor benefit claim age',
    }) as HTMLInputElement;
    expect(slider.min).toBe('60');
    expect(slider.max).toBe('70');
    expect(slider.value).toBe('67');
    // Step down to 62 via the RA Slider keyboard contract.
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
    // Primary's survivor age stays unset — absence is preserved, never
    // silently defaulted.
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
    // Toggle it off — the withheld note returns and Save persists absence.
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
    // The modal renders through a React Aria portal — scan the document body.
    await expectNoA11yViolations(document.body);
  });
});
