/**
 * `useExternalLabelledBy` — resolves an `aria-labelledby` target for a
 * shared React Aria control that is labelled by an EXTERNAL visible
 * `<label htmlFor={id}>` (the `<Field>` / inline-`<label>` pattern used
 * across the app) rather than an `ariaLabel` string or an internal RA
 * `<Label>` child.
 *
 * Why this is needed: a native
 * `<select id={id}>` / `<input type="date" id={id}>` is implicitly
 * named by `<label htmlFor={id}>`. After the React Aria migration the
 * shared `<Select>` / `<DatePicker>` render their own focusable
 * element and RA wires its own `aria-labelledby` (Select → the selected
 * VALUE text; DatePicker group → itself), which OVERRIDES that
 * implicit native label — so an `id`+external-label field with no
 * `ariaLabel` ends up with the wrong accessible name or none at all.
 * Both components allow exactly that prop combination, so the path has
 * to be reliable, not merely the `ariaLabel` one the tests cover.
 *
 * This hook finds the associated `<label for="{id}">`. It reuses the
 * label's own id when it has one (never clobbering an id another tool
 * may have wired into an `aria-labelledby`); otherwise it assigns a
 * render-stable, document-unique React `useId()` value (never the
 * caller-supplied-`id`-derived `${id}-label`, which could collide with
 * an unrelated element's id and make the accessible name ambiguous). It
 * returns that id for the component to pass as `aria-labelledby` — the
 * React-Aria-supported external-label channel. It is a no-op (returns
 * `undefined`) when the caller already supplies an `ariaLabel` or there
 * is no `id` / no matching external label, so the existing `ariaLabel`
 * path and every current call site are unchanged.
 *
 * First-render seed + pre-paint resolution: React Aria's `useLabel`
 * warns synchronously during render when it sees neither `aria-label`
 * nor `aria-labelledby`, so an effect-only resolution would always miss
 * the first render on the id+external-label path. The initial state is
 * therefore seeded with the same `useId()` value the lookup would
 * eventually assign, so render 1 already carries a non-empty
 * `aria-labelledby` and never trips the warning. A `useLayoutEffect`
 * (not `useEffect`) then resolves the real external `<label>` before
 * the browser paints — reusing the label's own id if it has one,
 * clearing back to `undefined` when there is no matching label (the
 * warning correctly re-fires on the next render for that real gap) — so
 * no painted frame ever shows a dangling `aria-labelledby`.
 */
import { useId, useLayoutEffect, useState } from 'react';

export function useExternalLabelledBy(
  id: string | undefined,
  ariaLabel: string | undefined,
): string | undefined {
  // React-generated, render-stable, document-unique id. Used only when
  // the resolved external `<label>` has no id of its own — never
  // overwrites a label's existing id, and being globally unique it
  // cannot collide with another element's id (the `${id}-label`
  // derivation could, since `id` is caller-supplied). Declared before
  // `useState` so its value is available to seed the initial state.
  const generatedId = useId();
  // The single id+external-label invariant: an `id` with no explicit
  // `ariaLabel` is the path this hook resolves; every other combination
  // is a no-op. Declared once so the seed and the effect's early-return
  // can't drift into two different (De Morgan dual) expressions of the
  // same condition.
  const onExternalLabelPath = Boolean(id) && !ariaLabel;
  // Seed render 1 with the generated id on the id+external-label path
  // so React Aria's render-phase `useLabel` warning never sees an empty
  // `aria-labelledby` — see the first-render note above. Every other
  // path seeds `undefined`, matching today's no-op behavior.
  const [labelledBy, setLabelledBy] = useState<string | undefined>(() =>
    onExternalLabelPath ? generatedId : undefined,
  );

  useLayoutEffect(() => {
    // An explicit `ariaLabel` (or no `id`) needs no external lookup —
    // RA's `aria-label` already provides the accessible name. The `!id`
    // half is redundant with `onExternalLabelPath` at runtime (it's
    // already baked into that boolean) — it's here only so TypeScript
    // narrows `id` to `string` for the querySelector below.
    if (!onExternalLabelPath || !id) {
      setLabelledBy(undefined);
      return;
    }
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(id)
        : id;
    const label = document.querySelector<HTMLLabelElement>(
      `label[for="${escaped}"]`,
    );
    if (!label) {
      setLabelledBy(undefined);
      return;
    }
    // Reuse the label's own id when it has one — never clobber it, so
    // an `aria-labelledby` the caller (or another tool) already set
    // stays intact and points at the right text.
    if (label.id) {
      setLabelledBy(label.id);
      return;
    }
    // Otherwise adopt the React-unique id, but only assign it if no
    // other element already owns it (it shouldn't — `useId` is
    // globally unique — but assigning a duplicate id would make
    // `aria-labelledby` ambiguous, so guard rather than assume).
    const escapedGenerated =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(generatedId)
        : generatedId;
    if (!document.getElementById(generatedId)) {
      label.id = generatedId;
      setLabelledBy(generatedId);
      return;
    }
    // Generated id is somehow taken — fall back to the existing
    // element only if it IS this label (idempotent re-run); otherwise
    // do not point at unrelated text.
    const existing = document.querySelector<HTMLElement>(
      `#${escapedGenerated}`,
    );
    setLabelledBy(existing === label ? generatedId : undefined);
  }, [onExternalLabelPath, id, generatedId]);

  return labelledBy;
}
