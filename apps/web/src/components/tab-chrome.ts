/**
 * Shared React Aria Tabs class-token vocabulary (`TAB_CLASS` /
 * `TAB_PANEL_CLASS`), used by every scenario tab surface so they look and
 * behave identically (React Aria `Tab` / `TabPanel`). Originally lived in
 * `scenario-withdrawal-strategy-shared.ts` as `MODAL_TAB_CLASS` /
 * `MODAL_TAB_PANEL_CLASS`; hoisted here (01) because the strategy modal's
 * page module was never the right layering home for a token a *page*
 * (not just a modal) also needs, and the names stop saying "modal" now
 * that a page tab strip carries them too.
 */

export const TAB_CLASS =
  'px-3 py-2 text-sm font-medium rounded-t cursor-pointer select-none -mb-px ' +
  'text-muted ' +
  'border-b-2 border-transparent ' +
  'data-[hovered]:text-ink ' +
  'data-[selected]:text-ink ' +
  'data-[selected]:border-accent ' +
  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 ' +
  'outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring';

export const TAB_PANEL_CLASS = 'flex flex-col gap-4 pt-4 focus:outline-none';
