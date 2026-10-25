/**
 * Always-expanded bordered group for a labelled control cluster, matching an expanded `AnchorCard`; a WAI-ARIA
 * labelled group, not `<fieldset>`, shared by the non-collapsible income pickers.
 */
import React from 'react';

export const LabelledGroup: React.FC<{
  id: string;
  heading: React.ReactNode;
  children: React.ReactNode;
}> = ({ id, heading, children }) => (
  <div
    role="group"
    aria-labelledby={id}
    className="flex min-w-0 flex-col rounded-xl border border-line"
  >
    <header id={id} className="px-4 py-3 text-sm font-semibold text-ink">
      {heading}
    </header>
    <div className="px-4 pb-4">{children}</div>
  </div>
);
