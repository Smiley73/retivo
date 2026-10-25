/**
 * Resolves the `aria-labelledby` for a React Aria control labelled by an external `<label htmlFor={id}>`: RA points
 * it at itself (DatePicker) or at the selected value (Select), which overrides that label. No-op with an `ariaLabel`.
 */
import { useId, useLayoutEffect, useState } from 'react';

export function useExternalLabelledBy(
  id: string | undefined,
  ariaLabel: string | undefined,
): string | undefined {
  // Unique per document; the `${id}-label` derivation could collide because `id` is
  // caller-supplied.
  const generatedId = useId();
  const onExternalLabelPath = Boolean(id) && !ariaLabel;
  // Seeded with the generated id because `useLabel` warns synchronously during render when it sees
  // no `aria-labelledby`; the layout effect below resolves the real label before paint.
  const [labelledBy, setLabelledBy] = useState<string | undefined>(() =>
    onExternalLabelPath ? generatedId : undefined,
  );

  useLayoutEffect(() => {
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
    // A label's own id is never overwritten.
    if (label.id) {
      setLabelledBy(label.id);
      return;
    }
    // Adopt the unique id only if nothing else owns it.
    const escapedGenerated =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(generatedId)
        : generatedId;
    if (!document.getElementById(generatedId)) {
      label.id = generatedId;
      setLabelledBy(generatedId);
      return;
    }
    // Taken: reuse only if it is this label (idempotent re-run), else point at nothing.
    const existing = document.querySelector<HTMLElement>(
      `#${escapedGenerated}`,
    );
    setLabelledBy(existing === label ? generatedId : undefined);
  }, [onExternalLabelPath, id, generatedId]);

  return labelledBy;
}
