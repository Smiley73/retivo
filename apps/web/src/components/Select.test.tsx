/** Select: the native-select-equivalent contract on the React Aria dropdown. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select';
import { expectNoA11yViolations } from '../test/a11y';
import { firedReactAriaMissingLabelWarning } from '../test/react-aria-warnings';

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie', disabled: true },
];

// Module-scope options keep a stable identity, which trips React Aria's identity-keyed item cache when `value` changes
// without `dependencies`.
const STABLE_DESCRIBED_OPTIONS = [
  { value: 'a', label: 'Alpha', description: 'Blocked because it holds a pension.' },
  { value: 'b', label: 'Bravo', description: 'Blocked because it holds a pension.' },
];

const STABLE_DESCRIBED_GROUPS = [
  {
    label: 'Group',
    options: [
      { value: 'a', label: 'Alpha', description: 'Blocked because it holds a pension.' },
      { value: 'b', label: 'Bravo', description: 'Blocked because it holds a pension.' },
    ],
  },
];

describe('Select', () => {
  it('renders a labelled trigger reflecting the controlled value', () => {
    render(
      <Select ariaLabel="Pick one" value="b" onChange={() => {}} options={OPTIONS} />,
    );
    const trigger = screen.getByRole('button', { name: /Pick one/ });
    expect(trigger).toHaveTextContent('Bravo');
  });

  it('renders the trigger at the text-sm page baseline (no size jump on open)', () => {
    // jsdom cannot measure px, so the trigger class is the contract for matching the option size.
    render(
      <Select ariaLabel="Pick one" value="a" onChange={() => {}} options={OPTIONS} />,
    );
    expect(screen.getByRole('button', { name: /Pick one/ })).toHaveClass(
      'text-sm',
    );
  });

  it('opens the listbox and selects an option via pointer', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select ariaLabel="Pick one" value="a" onChange={onChange} options={OPTIONS} />,
    );
    await user.click(screen.getByRole('button', { name: /Pick one/ }));
    await user.click(await screen.findByRole('option', { name: 'Bravo' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('selects via the keyboard (Enter opens, Arrow + Enter chooses)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select ariaLabel="Pick one" value="a" onChange={onChange} options={OPTIONS} />,
    );
    await user.tab();
    expect(screen.getByRole('button', { name: /Pick one/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('includes the external <label htmlFor> in the accessible name when only id is given', () => {
    render(
      <>
        <label htmlFor="freq">Frequency</label>
        <Select id="freq" value="a" onChange={() => {}} options={OPTIONS} />
      </>,
    );
    // React Aria names the trigger by value plus label, so match the label by substring.
    const trigger = screen.getByRole('button', { name: /Frequency/ });
    expect(trigger).toHaveAccessibleName(/Frequency/);
    expect(trigger).toHaveTextContent('Alpha');
  });

  it('reuses the external label own id and never clobbers it', () => {
    render(
      <>
        <label id="my-own-label" htmlFor="freq3">
          Frequency
        </label>
        <Select id="freq3" value="a" onChange={() => {}} options={OPTIONS} />
      </>,
    );
    expect(document.getElementById('my-own-label')?.id).toBe('my-own-label');
    const trigger = screen.getByRole('button', { name: /Frequency/ });
    expect(trigger).toHaveAccessibleName(/Frequency/);
  });

  it('resolves a unique accessible name when a same-named id already exists', () => {
    render(
      <>
        <span id="freq4-label">Some other text</span>
        <label htmlFor="freq4">Frequency</label>
        <Select id="freq4" value="a" onChange={() => {}} options={OPTIONS} />
      </>,
    );
    const trigger = screen.getByRole('button', { name: /Frequency/ });
    expect(trigger).toHaveAccessibleName(/Frequency/);
    expect(trigger).not.toHaveAccessibleName(/Some other text/);
    expect(document.getElementById('freq4-label')?.textContent).toBe(
      'Some other text',
    );
  });

  it('does not trip the React Aria visible-label warning on first render for an id-only external-label Select', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <>
        <label htmlFor="sel-x">Basis</label>
        <Select id="sel-x" value="a" onChange={() => {}} options={OPTIONS} />
      </>,
    );
    expect(firedReactAriaMissingLabelWarning(warn)).toBe(false);
    warn.mockRestore();
  });

  it('still warns for an id-only Select with no external label and no ariaLabel', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Select id="sel-orphan" value="a" onChange={() => {}} options={OPTIONS} />);
    expect(firedReactAriaMissingLabelWarning(warn)).toBe(true);
    warn.mockRestore();
  });

  it('leaves the explicit ariaLabel path untouched (external-label hook is a no-op)', () => {
    render(
      <>
        <label htmlFor="freq2">Visible</label>
        <Select
          id="freq2"
          ariaLabel="Explicit name"
          value="a"
          onChange={() => {}}
          options={OPTIONS}
        />
      </>,
    );
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveAttribute('aria-label', 'Explicit name');
    expect(trigger.getAttribute('aria-labelledby') ?? '').not.toContain(
      'freq2-label',
    );
  });

  it('clears a chosen value back to "" via a selectable empty-string option', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const withEmpty = [{ value: '', label: '— pick an account —' }, ...OPTIONS];
    const { rerender } = render(
      <Select ariaLabel="Target" value="" onChange={onChange} options={withEmpty} />,
    );
    expect(screen.getByRole('button', { name: /Target/ })).toHaveTextContent(
      '— pick an account —',
    );
    await user.click(screen.getByRole('button', { name: /Target/ }));
    await user.click(await screen.findByRole('option', { name: 'Alpha' }));
    expect(onChange).toHaveBeenLastCalledWith('a');

    rerender(
      <Select ariaLabel="Target" value="a" onChange={onChange} options={withEmpty} />,
    );
    await user.click(screen.getByRole('button', { name: /Target/ }));
    await user.click(
      await screen.findByRole('option', { name: '— pick an account —' }),
    );
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('does not open when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        ariaLabel="Pick one"
        value="a"
        onChange={onChange}
        options={OPTIONS}
        disabled
      />,
    );
    await user.click(screen.getByRole('button', { name: /Pick one/ }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders an option row for each depth level 0–5', async () => {
    const user = userEvent.setup();
    const depthOptions = [
      { value: 'd0', label: 'Depth 0', depth: 0 },
      { value: 'd1', label: 'Depth 1', depth: 1 },
      { value: 'd2', label: 'Depth 2', depth: 2 },
      { value: 'd3', label: 'Depth 3', depth: 3 },
      { value: 'd4', label: 'Depth 4', depth: 4 },
      { value: 'd5', label: 'Depth 5', depth: 5 },
    ];
    render(
      <Select ariaLabel="Depth test" value="d0" onChange={() => {}} options={depthOptions} />,
    );
    await user.click(screen.getByRole('button', { name: /Depth test/ }));
    const rows = await screen.findAllByRole('option');
    expect(rows).toHaveLength(6);
  });

  it('renders an option whose depth is beyond the indent scale', async () => {
    const user = userEvent.setup();
    const deepOption = [{ value: 'deep', label: 'Deep', depth: 7 }];
    render(
      <Select ariaLabel="Cap test" value="deep" onChange={() => {}} options={deepOption} />,
    );
    await user.click(screen.getByRole('button', { name: /Cap test/ }));
    expect(await screen.findByRole('option', { name: 'Deep' })).toBeInTheDocument();
  });

  it('renders grouped options with group headers (the optgroup analogue)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        ariaLabel="Grouped"
        value="twr"
        onChange={onChange}
        options={[
          { value: 'planned', label: 'Planned' },
          { value: 'twr', label: 'TWR' },
          { value: 'typical', label: 'Typical' },
        ]}
        groups={[
          {
            label: 'Deterministic',
            options: [
              { value: 'planned', label: 'Planned' },
              { value: 'twr', label: 'TWR' },
            ],
          },
          { label: 'Monte Carlo', options: [{ value: 'typical', label: 'Typical' }] },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: /Grouped/ })).toHaveTextContent('TWR');
    await user.click(screen.getByRole('button', { name: /Grouped/ }));
    expect(await screen.findByText('Deterministic')).toBeInTheDocument();
    expect(screen.getByText('Monte Carlo')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Typical' }));
    expect(onChange).toHaveBeenCalledWith('typical');
  });

  describe('description (opt-in, per-option accessible description)', () => {
    it('gives a non-selected described option an accessible description without folding it into the accessible name', async () => {
      const user = userEvent.setup();
      const described = [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Bravo', description: 'Blocked because it holds a pension.' },
      ];
      render(
        <Select ariaLabel="Pick one" value="a" onChange={() => {}} options={described} />,
      );
      await user.click(screen.getByRole('button', { name: /Pick one/ }));
      const bravo = await screen.findByRole('option', { name: 'Bravo' });
      expect(bravo).toHaveAccessibleDescription('Blocked because it holds a pension.');
      expect(bravo).toHaveAccessibleName('Bravo');
    });

    it('renders the description as a screen-reader-only element that the option points at via aria-describedby', async () => {
      const user = userEvent.setup();
      const described = [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Bravo', description: 'Blocked because it holds a pension.' },
      ];
      render(
        <Select ariaLabel="Pick one" value="a" onChange={() => {}} options={described} />,
      );
      await user.click(screen.getByRole('button', { name: /Pick one/ }));
      const bravo = await screen.findByRole('option', { name: 'Bravo' });
      const describedById = bravo.getAttribute('aria-describedby');
      expect(describedById).toBeTruthy();
      const descriptionEl = document.getElementById(describedById as string);
      expect(descriptionEl).toHaveClass('sr-only');
      expect(descriptionEl).toHaveTextContent('Blocked because it holds a pension.');
    });

    it('suppresses a description on the currently-selected option so it never reaches the closed trigger', async () => {
      const user = userEvent.setup();
      const described = [
        { value: 'a', label: 'Alpha', description: 'Blocked because it holds a pension.' },
        { value: 'b', label: 'Bravo' },
      ];
      render(
        <Select ariaLabel="Pick one" value="a" onChange={() => {}} options={described} />,
      );
      const trigger = screen.getByRole('button', { name: /Pick one/ });
      expect(trigger.querySelector('[slot="description"]')).toBeNull();
      expect(trigger).toHaveTextContent('Alpha');
      expect(trigger).not.toHaveAccessibleName(/Blocked/);
      await user.click(trigger);
      const alpha = await screen.findByRole('option', { name: 'Alpha' });
      expect(alpha).not.toHaveAttribute('aria-describedby');
    });

    it('leaves an option with no description byte-identical to today', async () => {
      const user = userEvent.setup();
      render(
        <Select ariaLabel="Pick one" value="a" onChange={() => {}} options={OPTIONS} />,
      );
      await user.click(screen.getByRole('button', { name: /Pick one/ }));
      const alpha = await screen.findByRole('option', { name: 'Alpha' });
      expect(alpha).not.toHaveAttribute('aria-describedby');
      expect(alpha.querySelector('[slot]')).toBeNull();
    });

    it('carries a description through the grouped (ListBoxSection) render path too', async () => {
      const user = userEvent.setup();
      render(
        <Select
          ariaLabel="Grouped"
          value="twr"
          onChange={() => {}}
          groups={[
            {
              label: 'Deterministic',
              options: [
                { value: 'planned', label: 'Planned', description: 'Not available yet.' },
                { value: 'twr', label: 'TWR' },
              ],
            },
            { label: 'Monte Carlo', options: [{ value: 'typical', label: 'Typical' }] },
          ]}
        />,
      );
      await user.click(screen.getByRole('button', { name: /Grouped/ }));
      const planned = await screen.findByRole('option', { name: 'Planned' });
      expect(planned).toHaveAccessibleDescription('Not available yet.');
    });

    it('re-suppresses the description after a controlled value change reuses the same (referentially-stable) option objects — flat options path', async () => {
      // React Aria caches rendered items by object identity and invalidates only via `dependencies`; without it a described
      // option stays cached after `value` moves onto it and leaks its description into the closed trigger.
      const { rerender } = render(
        <Select
          ariaLabel="Pick one"
          value="a"
          onChange={() => {}}
          options={STABLE_DESCRIBED_OPTIONS}
        />,
      );
      let trigger = screen.getByRole('button', { name: /Pick one/ });
      expect(trigger).not.toHaveAccessibleName(/Blocked/);

      rerender(
        <Select
          ariaLabel="Pick one"
          value="b"
          onChange={() => {}}
          options={STABLE_DESCRIBED_OPTIONS}
        />,
      );
      trigger = screen.getByRole('button', { name: /Pick one/ });
      expect(trigger.querySelector('[slot="description"]')).toBeNull();
      expect(trigger).toHaveTextContent('Bravo');
      expect(trigger).not.toHaveTextContent('Blocked');
      expect(trigger).not.toHaveAccessibleName(/Blocked/);
    });

    it('re-suppresses the description after a controlled value change reuses the same (referentially-stable) option objects — grouped path', async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <Select ariaLabel="Grouped" value="a" onChange={() => {}} groups={STABLE_DESCRIBED_GROUPS} />,
      );

      rerender(
        <Select ariaLabel="Grouped" value="b" onChange={() => {}} groups={STABLE_DESCRIBED_GROUPS} />,
      );
      const trigger = screen.getByRole('button', { name: /Grouped/ });
      expect(trigger.querySelector('[slot="description"]')).toBeNull();
      expect(trigger).not.toHaveAccessibleName(/Blocked/);

      await user.click(trigger);
      const alpha = await screen.findByRole('option', { name: 'Alpha' });
      expect(alpha).toHaveAccessibleDescription('Blocked because it holds a pension.');
    });

    it('lands typeahead on a described option — textValue stays load-bearing once children are elements', async () => {
      // Described options render <Text> children, so type-to-select must resolve through `textValue`.
      const user = userEvent.setup();
      const described = [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Bravo', description: 'Blocked because it holds a pension.' },
      ];
      render(
        <Select ariaLabel="Pick one" value="a" onChange={() => {}} options={described} />,
      );
      await user.click(screen.getByRole('button', { name: /Pick one/ }));
      await screen.findByRole('listbox');
      const bravo = screen.getByRole('option', { name: 'Bravo' });
      await user.keyboard('B');
      // Real DOM focus moves onto the option (roving tabindex), not `aria-activedescendant`.
      expect(bravo).toHaveFocus();
      expect(bravo).toHaveAttribute('data-focused', 'true');
    });
  });

  describe('unavailable (opt-in, visual-only treatment)', () => {
    it('renders an unavailable option with text-muted, not text-ink', async () => {
      const user = userEvent.setup();
      const opts = [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Bravo', unavailable: true },
      ];
      render(<Select ariaLabel="Pick one" value="a" onChange={() => {}} options={opts} />);
      await user.click(screen.getByRole('button', { name: /Pick one/ }));
      const bravo = await screen.findByRole('option', { name: 'Bravo' });
      expect(bravo).toHaveClass('text-muted');
      expect(bravo).not.toHaveClass('text-ink');
    });

    it('renders an ordinary option with text-ink, not text-muted', async () => {
      const user = userEvent.setup();
      render(
        <Select ariaLabel="Pick one" value="a" onChange={() => {}} options={OPTIONS} />,
      );
      await user.click(screen.getByRole('button', { name: /Pick one/ }));
      const alpha = await screen.findByRole('option', { name: 'Alpha' });
      expect(alpha).toHaveClass('text-ink');
      expect(alpha).not.toHaveClass('text-muted');
    });

    it('is not disabled — the row stays focusable and selectable via pointer and keyboard', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const opts = [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Bravo', unavailable: true },
      ];
      render(<Select ariaLabel="Pick one" value="a" onChange={onChange} options={opts} />);
      await user.click(screen.getByRole('button', { name: /Pick one/ }));
      const bravo = await screen.findByRole('option', { name: 'Bravo' });
      expect(bravo).not.toHaveAttribute('aria-disabled');
      await user.click(bravo);
      expect(onChange).toHaveBeenCalledWith('b');

      onChange.mockClear();
      await user.click(screen.getByRole('button', { name: /Pick one/ }));
      await user.keyboard('{ArrowDown}{Enter}');
      expect(onChange).toHaveBeenCalledWith('b');
    });

    it('keeps the depth pl-N class alongside text-muted', async () => {
      const user = userEvent.setup();
      const opts = [{ value: 'a', label: 'Alpha', depth: 2, unavailable: true }];
      render(<Select ariaLabel="Pick one" value="a" onChange={() => {}} options={opts} />);
      await user.click(screen.getByRole('button', { name: /Pick one/ }));
      const alpha = await screen.findByRole('option', { name: 'Alpha' });
      expect(alpha).toHaveClass('pl-10');
      expect(alpha).toHaveClass('text-muted');
    });

    it('leaves an existing disabled option aria-disabled, opacity-50, and not selectable — proving unavailable and disabled stay independent', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <Select ariaLabel="Pick one" value="a" onChange={onChange} options={OPTIONS} />,
      );
      await user.click(screen.getByRole('button', { name: /Pick one/ }));
      const charlie = await screen.findByRole('option', { name: 'Charlie' });
      expect(charlie).toHaveAttribute('aria-disabled', 'true');
      // jsdom never evaluates data-attribute selectors, so the class token itself is the contract.
      expect(charlie.className).toContain('data-[disabled]:opacity-50');
      await user.click(charlie);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('description + unavailable together', () => {
    it('applies both contracts to the same option and still fires onChange', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const opts = [
        { value: 'a', label: 'Alpha' },
        {
          value: 'b',
          label: 'Bravo',
          unavailable: true,
          description: 'Blocked because it holds a pension.',
        },
      ];
      render(<Select ariaLabel="Pick one" value="a" onChange={onChange} options={opts} />);
      await user.click(screen.getByRole('button', { name: /Pick one/ }));
      const bravo = await screen.findByRole('option', { name: 'Bravo' });
      expect(bravo).toHaveClass('text-muted');
      expect(bravo).toHaveAccessibleDescription('Blocked because it holds a pension.');
      await user.click(bravo);
      expect(onChange).toHaveBeenCalledWith('b');
    });

    it('has no a11y violations with the listbox open over ordinary, described+unavailable, and disabled options', async () => {
      const user = userEvent.setup();
      const opts = [
        { value: 'a', label: 'Alpha' },
        {
          value: 'b',
          label: 'Bravo',
          unavailable: true,
          description: 'Blocked because it holds a pension.',
        },
        { value: 'c', label: 'Charlie', disabled: true },
      ];
      render(<Select ariaLabel="Pick one" value="a" onChange={() => {}} options={opts} />);
      await user.click(screen.getByRole('button', { name: /Pick one/ }));
      await screen.findByRole('listbox');
      await expectNoA11yViolations(document.body);
    });
  });
});
