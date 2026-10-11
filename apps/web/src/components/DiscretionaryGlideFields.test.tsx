/**
 * DiscretionaryGlideFields — a11y smoke + enable/floor toggle behavior,
 * the mode-driven toggle-OFF asymmetry (ND15b), a well-formed onChange
 * payload, and the ui-aria-polish disabled-but-visible layout (sections
 * stay in the DOM when their toggle is off; React Aria `isDisabled`
 * propagates to every interactive control). `components/`-dir, so the
 * AGENTS axe-smoke rule applies (at least one `expectNoA11yViolations`).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DiscretionaryGlideFields } from './DiscretionaryGlideFields';
import { expectNoA11yViolations } from '../test/a11y';
import type {
  Aggregate,
  DiscretionaryGlideOverride,
  HouseholdMemberPayload,
} from '../db/types';

const member = (
  isPrimary: boolean,
  firstName: string,
): Aggregate<HouseholdMemberPayload> => ({
  id: isPrimary ? 'p' : 's',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-01-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'householdMember',
  payload: {
    isPrimary,
    firstName,
    lastName: '',
    email: '',
    birthdate: '1965-01-01',
  },
});

const members = [member(true, 'John'), member(false, 'Jane')];

const enabledGlide = (): DiscretionaryGlideOverride => ({
  endMultiplierPct: 60,
  glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
  glideEnd: { kind: 'age', memberId: 'primary', years: 80, months: 0 },
});

function renderFields(
  value: DiscretionaryGlideOverride | undefined,
  mode: 'canonical' | 'scenario-patch' = 'canonical',
) {
  const onChange = vi.fn();
  const utils = render(
    <DiscretionaryGlideFields
      value={value}
      onChange={onChange}
      members={members}
      mode={mode}
    />,
  );
  return { onChange, ...utils };
}

// Each anchor picker is a collapsible `AnchorCard`; expand it (trigger's
// accessible name is the picker label) before reaching its radios.
function openCard(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('DiscretionaryGlideFields', () => {
  it('renders the group + enable toggle; the config is hidden until the toggle is on', () => {
    renderFields(undefined);
    expect(
      screen.getByRole('group', { name: /spending glide/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: /enable spending glide/i }),
    ).not.toBeChecked();
    // Reveal: with the glide off, the config section is not rendered.
    expect(screen.queryByLabelText('End percentage')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Glide starts' })).toBeNull();
  });

  it('toggling enable ON reveals (enables) end multiplier + the anchor cards', () => {
    renderFields(undefined);
    fireEvent.click(
      screen.getByRole('switch', { name: /enable spending glide/i }),
    );
    expect(screen.getByLabelText('End percentage')).not.toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Glide starts' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Glide ends' }),
    ).toBeInTheDocument();
    // Sensible resolvable defaults (not an invalid age-0 anchor): the
    // glide runs from the start of retirement until the expense's end.
    // ("Start of retirement" is also the floor anchor's default summary,
    // so there are two.)
    expect(screen.getAllByText('Start of retirement').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('When this expense ends').length,
    ).toBeGreaterThan(0);
    // Because glide-end defaults to "when this expense ends", a floor
    // could never apply (it would start after the expense ended) — so the
    // floor toggle, Floor %, and "Floor starts" card all default disabled.
    const floorToggle = screen.getByRole('switch', { name: /hard floor/i });
    expect(floorToggle).toBeDisabled();
    expect(floorToggle).not.toBeChecked();
    expect(screen.getByLabelText('Floor percentage')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Floor starts' })).toBeDisabled();
  });

  it('floor toggle enables the floor multiplier + floor anchor card', () => {
    renderFields(enabledGlide());
    // The Floor % and the "Floor starts" card are disabled until the
    // floor toggle is on.
    expect(screen.getByLabelText('Floor percentage')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Floor starts' })).toBeDisabled();
    fireEvent.click(screen.getByRole('switch', { name: /hard floor/i }));
    expect(screen.getByLabelText('Floor percentage')).not.toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Floor starts' }),
    ).not.toBeDisabled();
    openCard('Floor starts');
    expect(
      screen.getByRole('radio', { name: /start of retirement/i }),
    ).not.toBeDisabled();
  });

  it('scenario-patch mode: seeds the toggle OFF when no glide is inherited (undefined)', () => {
    // A cleared glide arrives `undefined` (the scenario
    // patch carries a `null` clear-marker, never the old neutral object),
    // so absence — not a neutral object — seeds the toggle OFF.
    renderFields(undefined, 'scenario-patch');
    expect(
      screen.getByRole('switch', { name: /enable spending glide/i }),
    ).not.toBeChecked();
  });

  it('scenario-patch mode: a present glide at the default 100% End with no floor seeds the toggle ON', () => {
    // Presence IS enablement in scenario-patch mode too — a
    // value-equivalent no-op glide is still an *enabled* glide (the user
    // configured it); only `undefined` means off.
    const presentAt100: DiscretionaryGlideOverride = {
      endMultiplierPct: 100,
      glideStart: { kind: 'age', memberId: 'primary', years: 0, months: 0 },
      glideEnd: { kind: 'age', memberId: 'primary', years: 0, months: 0 },
    };
    renderFields(presentAt100, 'scenario-patch');
    expect(
      screen.getByRole('switch', { name: /enable spending glide/i }),
    ).toBeChecked();
  });

  it('canonical mode: a present glide at the default 100% End with no floor seeds the toggle ON', () => {
    // A freshly-enabled canonical glide whose End % is still the
    // default 100 with default anchors IS isNeutralGlide-shaped, but in
    // canonical mode presence = enabled. Seeding it OFF here would lose
    // the user's just-saved enablement on reopen.
    const presentAt100: DiscretionaryGlideOverride = {
      endMultiplierPct: 100,
      glideStart: { kind: 'age', memberId: 'primary', years: 0, months: 0 },
      glideEnd: { kind: 'age', memberId: 'primary', years: 0, months: 0 },
    };
    renderFields(presentAt100, 'canonical');
    expect(
      screen.getByRole('switch', { name: /enable spending glide/i }),
    ).toBeChecked();
    // And the editor fields are enabled (the toggle is on).
    expect(screen.getByLabelText('End percentage')).not.toBeDisabled();
  });

  it('canonical mode: toggling OFF from an enabled value calls onChange(undefined)', () => {
    const { onChange } = renderFields(enabledGlide(), 'canonical');
    expect(
      screen.getByRole('switch', { name: /enable spending glide/i }),
    ).toBeChecked();
    fireEvent.click(
      screen.getByRole('switch', { name: /enable spending glide/i }),
    );
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('scenario-patch mode: toggling OFF calls onChange(undefined) (the delta emits a null clear)', () => {
    // Off persists `undefined` in scenario-patch mode too
    // (uniform with canonical). The ExpenseFormPage delta turns the
    // absent-in-built glide into a `null` clear-marker, so the editor no
    // longer emits the old value-equivalent neutral object.
    const { onChange } = renderFields(enabledGlide(), 'scenario-patch');
    fireEvent.click(
      screen.getByRole('switch', { name: /enable spending glide/i }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('emits a well-formed DiscretionaryGlideOverride when the end multiplier changes', () => {
    const { onChange } = renderFields(enabledGlide(), 'canonical');
    fireEvent.change(screen.getByLabelText('End percentage'), {
      target: { value: '40' },
    });
    const last = onChange.mock.calls.at(-1)?.[0] as DiscretionaryGlideOverride;
    expect(last.endMultiplierPct).toBe(40);
    expect(last.glideStart).toEqual({
      kind: 'age',
      memberId: 'primary',
      years: 65,
      months: 0,
    });
    expect(last.glideEnd).toEqual({
      kind: 'age',
      memberId: 'primary',
      years: 80,
      months: 0,
    });
    expect(last.floor).toBeUndefined();
  });

  it('emits a floor block once the floor toggle is on', () => {
    const { onChange } = renderFields(enabledGlide(), 'canonical');
    fireEvent.click(screen.getByRole('switch', { name: /hard floor/i }));
    const last = onChange.mock.calls.at(-1)?.[0] as DiscretionaryGlideOverride;
    expect(last.floor).toBeDefined();
    expect(typeof last.floor?.multiplierPct).toBe('number');
    expect(last.floor?.anchor).toBeDefined();
  });

  it('expenseEnd glide-end disables the floor toggle (floor detail fields disabled)', () => {
    const withExpenseEnd: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      glideEnd: { kind: 'expenseEnd' },
    };
    renderFields(withExpenseEnd, 'canonical');
    const floorToggle = screen.getByRole('switch', { name: /hard floor/i });
    expect(floorToggle).toBeDisabled();
    expect(floorToggle).not.toBeChecked();
    // The floor is off (and can't apply), so its detail fields render
    // disabled.
    expect(screen.getByLabelText('Floor percentage')).toBeDisabled();
  });

  it('selecting expenseEnd glide-end drops a previously-set floor from the emitted value', () => {
    const withFloor: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      glideEnd: { kind: 'age', memberId: 'primary', years: 80, months: 0 },
      floor: {
        multiplierPct: 40,
        anchor: { kind: 'age', memberId: 'primary', years: 85, months: 0 },
      },
    };
    const { onChange } = renderFields(withFloor, 'canonical');
    // Switch the glide-end picker to "When this expense ends".
    openCard('Glide ends');
    fireEvent.click(
      screen.getByRole('radio', { name: /when this expense ends/i }),
    );
    const last = onChange.mock.calls.at(-1)?.[0] as DiscretionaryGlideOverride;
    expect(last.glideEnd).toEqual({ kind: 'expenseEnd' });
    // The floor is dropped — it can never apply past the expense's end.
    expect(last.floor).toBeUndefined();
  });

  it('switching glide-end away from expenseEnd re-enables the floor controls (no auto-restore)', () => {
    const withExpenseEnd: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      glideEnd: { kind: 'expenseEnd' },
    };
    renderFields(withExpenseEnd, 'canonical');
    expect(screen.getByRole('switch', { name: /hard floor/i })).toBeDisabled();
    // Switch glide-end back to a resolvable kind (Start of retirement).
    openCard('Glide ends');
    fireEvent.click(
      screen.getByRole('radio', { name: /start of retirement/i }),
    );
    const floorToggle = screen.getByRole('switch', { name: /hard floor/i });
    expect(floorToggle).not.toBeDisabled();
    // No silent auto-restore — the floor toggle stays OFF until the
    // user re-enables it.
    expect(floorToggle).not.toBeChecked();
    // Floor off ⇒ its detail fields render disabled.
    expect(screen.getByLabelText('Floor percentage')).toBeDisabled();
  });

  it('floor set → expenseEnd drops it → switching glide-end away does NOT auto-restore the floor', () => {
    // The genuine no-auto-restore path: start from a glide that
    // HAS a floor (the earlier no-floor expenseEnd test never exercised
    // the stale-floor re-emit bug).
    const withFloor: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      glideEnd: { kind: 'age', memberId: 'primary', years: 80, months: 0 },
      floor: {
        multiplierPct: 40,
        anchor: { kind: 'age', memberId: 'primary', years: 85, months: 0 },
      },
    };
    const { onChange } = renderFields(withFloor, 'canonical');

    // Select "When this expense ends" — the floor is dropped.
    openCard('Glide ends');
    fireEvent.click(
      screen.getByRole('radio', { name: /when this expense ends/i }),
    );
    const afterExpenseEnd = onChange.mock.calls.at(
      -1,
    )?.[0] as DiscretionaryGlideOverride;
    expect(afterExpenseEnd.glideEnd).toEqual({ kind: 'expenseEnd' });
    expect(afterExpenseEnd.floor).toBeUndefined();

    // Switch glide-end back to a resolvable kind (the card stays open).
    // The floor must NOT be silently re-emitted and the toggle
    // stays unchecked.
    fireEvent.click(
      screen.getByRole('radio', { name: /start of retirement/i }),
    );
    const afterSwitchAway = onChange.mock.calls.at(
      -1,
    )?.[0] as DiscretionaryGlideOverride;
    expect(afterSwitchAway.glideEnd).toEqual({ kind: 'retirementStart' });
    expect(afterSwitchAway.floor).toBeUndefined();

    const floorToggle = screen.getByRole('switch', { name: /hard floor/i });
    expect(floorToggle).not.toBeDisabled();
    expect(floorToggle).not.toBeChecked();
  });

  it('relabels Floor → Ceiling and flips the plateau slider domain when End % rises above 100', () => {
    // Start with a declining glide (floor below the end). Drag End % above
    // 100 so the direction flips to rising — the plateau control relabels
    // to "Ceiling" and its slider domain becomes End % → 200.
    const declining: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      glideEnd: { kind: 'age', memberId: 'primary', years: 80, months: 0 },
    };
    renderFields(declining, 'canonical');
    // Declining: the plateau reads "Floor".
    expect(
      screen.getByRole('switch', { name: /hard floor/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Floor percentage')).toBeInTheDocument();
    // Drag End % up to 150 → rising.
    fireEvent.change(screen.getByLabelText('End percentage'), {
      target: { value: '150' },
    });
    expect(
      screen.getByRole('switch', { name: /hard ceiling/i }),
    ).toBeInTheDocument();
    const ceilingSlider = screen.getByLabelText('Ceiling percentage');
    expect(ceilingSlider).toBeInTheDocument();
    // The slider's max reflects the flipped (rising) domain: 200.
    const thumb = screen.getByRole('slider', { name: 'Ceiling percentage' });
    expect(thumb).toHaveAttribute('max', '200');
    // The plateau ANCHOR sub-control relabels too: "Ceiling starts"
    // for a rising glide, never the stale "Floor starts".
    expect(
      screen.getByRole('button', { name: 'Ceiling starts' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Floor starts' })).toBeNull();
  });

  it('boundary-crossing re-clamps the plateau to the valid side in both directions (c)', () => {
    // Declining glide with a floor below the end. Drag End % above 100:
    // the inherited floor (40) must re-clamp UP to a valid ceiling (≥ end).
    const withFloor: DiscretionaryGlideOverride = {
      endMultiplierPct: 60,
      glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      glideEnd: { kind: 'age', memberId: 'primary', years: 80, months: 0 },
      floor: {
        multiplierPct: 40,
        anchor: { kind: 'age', memberId: 'primary', years: 85, months: 0 },
      },
    };
    const { onChange } = renderFields(withFloor, 'canonical');
    fireEvent.change(screen.getByLabelText('End percentage'), {
      target: { value: '150' },
    });
    let last = onChange.mock.calls.at(-1)?.[0] as DiscretionaryGlideOverride;
    expect(last.endMultiplierPct).toBe(150);
    // The plateau is now a ceiling ≥ end (40 re-clamped up to 150).
    expect(last.floor?.multiplierPct).toBe(150);

    // Now drag End % back down below 100: the ceiling (150) must
    // re-clamp DOWN to a valid floor (≤ end).
    fireEvent.change(screen.getByLabelText('End percentage'), {
      target: { value: '80' },
    });
    last = onChange.mock.calls.at(-1)?.[0] as DiscretionaryGlideOverride;
    expect(last.endMultiplierPct).toBe(80);
    expect(last.floor?.multiplierPct).toBe(80);
  });

  it('a11y smoke: flipped (rising) domain + relabelled ceiling control keeps accessible names', async () => {
    const rising: DiscretionaryGlideOverride = {
      endMultiplierPct: 150,
      glideStart: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      glideEnd: { kind: 'age', memberId: 'primary', years: 80, months: 0 },
      floor: {
        multiplierPct: 180,
        anchor: { kind: 'age', memberId: 'primary', years: 85, months: 0 },
      },
    };
    const { container } = renderFields(rising, 'canonical');
    // The relabelled controls keep an accessible name.
    expect(
      screen.getByRole('slider', { name: 'Ceiling percentage' }),
    ).toHaveAttribute('max', '200');
    expect(
      screen.getByRole('switch', { name: /hard ceiling/i }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('has no a11y violations (enabled with floor on)', async () => {
    const { container } = renderFields(
      {
        ...enabledGlide(),
        floor: {
          multiplierPct: 40,
          anchor: { kind: 'age', memberId: 'primary', years: 85, months: 0 },
        },
      },
      'canonical',
    );
    await expectNoA11yViolations(container);
  });
});
