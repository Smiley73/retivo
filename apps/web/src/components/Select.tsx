/**
 * Typed React Aria dropdown replacing the native `<select>`: string `value` / `onChange`, a flat `options` list or
 * `groups` (which wins), named by `id` + `label` or `ariaLabel`.
 */
import React from 'react';
import {
  Button,
  Collection,
  Header,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Popover,
  Select as RACSelect,
  SelectValue,
  Text,
} from 'react-aria-components';
import { ChevronIcon } from '../layout/sidebar-icons';
import { useExternalLabelledBy } from './use-external-label';

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /**
   * Visual indent of the option row in the open popover; 0 = root, 5 and above share the deepest
   * indent.
   */
  depth?: number;
  /**
   * Accessible description (`sr-only`), rendered only when this is not the current `value`:
   * `SelectValue` re-renders the selected option inside the closed trigger and the description
   * would leak into its name.
   */
  description?: string;
  /**
   * Renders the row `text-muted` while it stays focusable and selectable, unlike `disabled`; pair
   * with `description` to say why.
   */
  unavailable?: boolean;
}

const DEPTH_PL_CLASS: readonly string[] = [
  'pl-2',  // depth 0
  'pl-6',  // depth 1
  'pl-10', // depth 2
  'pl-14', // depth 3
  'pl-18', // depth 4
  'pl-22', // depth 5+
];

interface BaseProps {
  value: string;
  onChange: (next: string) => void;
  /** Flat option list; optional only when `groups` is supplied. */
  options?: SelectOption[];
  disabled?: boolean;
  /** Layout-only classes on the root. */
  className?: string;
  placeholder?: string;
  /** Grouped options, mutually exclusive with the flat `options`; wins for rendering. */
  groups?: ReadonlyArray<{ readonly label: string; readonly options: SelectOption[] }>;
}

interface LabelledProps extends BaseProps {
  id: string;
  /** Visible label rendered by the caller via `htmlFor={id}`. */
  ariaLabel?: string;
}

interface AriaOnlyProps extends BaseProps {
  id?: string;
  ariaLabel: string;
}

export type SelectProps = LabelledProps | AriaOnlyProps;

const TRIGGER_CLASS =
  'flex w-full min-w-0 items-center justify-between gap-2 rounded-md ' +
  'border border-input-line bg-surface px-3 py-2 text-left text-sm text-ink ' +
  'data-[focus-visible]:border-accent data-[focus-visible]:outline-none ' +
  'data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring ' +
  'data-[disabled]:cursor-not-allowed data-[disabled]:bg-surface-sunken data-[disabled]:text-muted';

// Sizes to its widest option but never narrower than the trigger, capped so a long scenario name
// does not blow up narrow sidebars.
const LISTBOX_CLASS =
  'max-h-60 w-max [min-width:var(--trigger-width)] max-w-md overflow-auto ' +
  'rounded-md border border-line bg-surface-raised p-1 text-sm shadow-lg ' +
  'outline-none';

// Colour is composed per option: a hard-coded `text-ink` here would leave source order to decide
// against `text-muted`.
const OPTION_BASE_CLASS =
  'cursor-pointer select-none rounded pr-2 py-1.5 outline-none ' +
  'data-[focused]:bg-accent data-[focused]:text-accent-ink ' +
  'data-[selected]:font-semibold ' +
  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

function depthClass(depth: number | undefined): string {
  const clamped = Math.min(depth ?? 0, DEPTH_PL_CLASS.length - 1);
  return DEPTH_PL_CLASS[clamped];
}

const SECTION_HEADER_CLASS =
  'px-2 pb-1 pt-2 font-mono text-xs font-semibold uppercase tracking-wide text-muted';

export const Select: React.FC<SelectProps> = ({
  value,
  onChange,
  options,
  disabled,
  className,
  placeholder,
  id,
  ariaLabel,
  groups,
}) => {
  // React Aria names the select by its selected value, which overrides the external
  // `<label htmlFor>`; wire the label explicitly.
  const labelledBy = useExternalLabelledBy(id, ariaLabel);
  // Closure over `value`: both render paths use it so a description never renders on the selected
  // option (see `SelectOption.description`).
  const renderOption = (opt: SelectOption): React.ReactElement => {
    const showDescription = Boolean(opt.description) && opt.value !== value;
    return (
      <ListBoxItem
        id={opt.value}
        textValue={opt.label}
        isDisabled={opt.disabled}
        className={`${OPTION_BASE_CLASS} ${depthClass(opt.depth)} ${
          opt.unavailable ? 'text-muted' : 'text-ink'
        }`}
      >
        {showDescription ? (
          <>
            <Text slot="label">{opt.label}</Text>
            <Text slot="description" className="sr-only">
              {opt.description}
            </Text>
          </>
        ) : (
          opt.label
        )}
      </ListBoxItem>
    );
  };
  return (
    <RACSelect
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      selectedKey={value}
      isDisabled={disabled}
      onSelectionChange={(key) => onChange(String(key))}
      placeholder={placeholder}
      className={className ? `group ${className}` : 'group'}
    >
      <Button className={TRIGGER_CLASS}>
        <SelectValue className="block min-w-0 flex-1 truncate data-[placeholder]:text-muted" />
        <ChevronIcon className="size-4 shrink-0 rotate-90 text-muted" />
      </Button>
      <Popover className="rounded-md">
        {groups ? (
          <ListBox className={LISTBOX_CLASS}>
            {groups.map((group) => (
              <ListBoxSection key={group.label} id={group.label}>
                <Header className={SECTION_HEADER_CLASS}>{group.label}</Header>
                <Collection items={group.options} dependencies={[value]}>
                  {renderOption}
                </Collection>
              </ListBoxSection>
            ))}
          </ListBox>
        ) : (
          <ListBox className={LISTBOX_CLASS} items={options ?? []} dependencies={[value]}>
            {renderOption}
          </ListBox>
        )}
      </Popover>
    </RACSelect>
  );
};
