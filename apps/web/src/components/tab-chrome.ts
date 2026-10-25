/**
 * Shared React Aria Tabs class tokens (`TAB_CLASS` / `TAB_PANEL_CLASS`) for every scenario tab surface.
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
