/**
 * `useFocusClearOfPinnedStrip` — keeps a keyboard-focused control out from
 * under an opaque `position: sticky` strip (WCAG 2.2 AA 2.4.11, Focus Not
 * Obscured).
 *
 * The browser's own focus scroll takes no account of a sticky overlay: it
 * scrolls only when the newly focused element is not already inside the
 * scrollport, and then aligns it to the scrollport edge or centres it
 * depending on the browser — so a control that is inside the scrollport but
 * painted over by the strip is left exactly there, with no focus ring
 * visible anywhere (measured in Chromium: a Shift+Tabbed control at y=129
 * under a 141px strip stays put).
 *
 * Why this is measured at focus time rather than reserved with a fixed
 * `scroll-padding-top` on the document: the strip's height depends on how its
 * controls wrap (measured on the Balance Projection page: 141px at a 1024px
 * viewport, 97px at 1280px) and on whether its in-flight progress row is
 * showing (175px at 1024px while a stress run is in flight), so any fixed
 * reserve is too small in one state or too large in another. Worse, a
 * reserve that covers the stuck strip puts the strip's OWN
 * controls inside the "not in view" band, so every time focus enters a tab or
 * the Basis select the browser scrolls the document to chase a sticky element
 * that cannot move (measured: 221–721px jumps on Shift+Tab from the first
 * panel control into the tab row).
 *
 * Behaviour: on every `focusin` whose target lies inside `containerRef` but
 * outside `stripRef`, and only when that target matches `:focus-visible`
 * (keyboard / script focus — a pointer click on a control at the strip's
 * edge must not shift the page under the pointer), read the strip's rect
 * and the target's PAINTED band — its own box cut down by every ancestor
 * inside the container that clips its overflow. A `<table>` scrolled 800px
 * down inside a `TableScroll` region (`overflow-auto`, 60vh) has a box that
 * starts 800px above the region, but only the region's band of it is on
 * screen, and only that band can be under the strip; measuring the box
 * itself would scroll the page by the whole inner scroll offset. If the
 * band's top edge is above the strip's bottom edge, scroll the window up by
 * exactly that overlap plus a small clearance, capped at the room left
 * below the band in the viewport: a band taller than the space under the
 * strip has no scroll that shows all of it (and is not entirely hidden,
 * which is 2.4.11's bar), so it is left where it is rather than shoved
 * out through the bottom of the viewport. It works in either order relative
 * to the browser's own focus scroll: if the browser scrolled first the
 * correction moves the control from the edge to just below the strip; if
 * it runs first the control is already fully visible afterwards and the
 * browser's "if needed" pass does nothing. Where the strip is not sticky it
 * sits in normal flow above the container's content, so no painted band
 * below it can start above its bottom edge and the handler does not scroll
 * — the most it could do there is nudge, by at most the clearance, a
 * control butted right up against the strip's border.
 *
 * The listener sits on `document` (not on the container) and reads both refs
 * lazily, because a page that renders a guard ladder before its content
 * mounts the container after this effect has already run.
 */
import { useEffect, type RefObject } from 'react';

/** Room kept between the strip's bottom edge and the focused control's top,
 *  so the control's focus ring (`ring-2`) is fully visible, not just its box. */
const CLEARANCE_PX = 8;

/**
 * The vertical band of `target` that is actually painted: its own box, cut
 * down by every ancestor up to and including `container` whose overflow
 * clips (`overflow-y` other than `visible` — `auto`, `scroll`, `hidden`,
 * `clip`). A target scrolled entirely out of its scroller comes back
 * inverted (bottom above top); that is harmless below, where the correction
 * only ever brings `top` down to the clearance line and the cap can only
 * shrink it.
 */
function paintedBand(
  target: HTMLElement,
  container: HTMLElement,
): { top: number; bottom: number } {
  const own = target.getBoundingClientRect();
  let top = own.top;
  let bottom = own.bottom;
  for (let el = target.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).overflowY !== 'visible') {
      const clip = el.getBoundingClientRect();
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
    if (el === container) break;
  }
  return { top, bottom };
}

export function useFocusClearOfPinnedStrip(
  containerRef: RefObject<HTMLElement | null>,
  stripRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      const container = containerRef.current;
      const strip = stripRef.current;
      const target = event.target;
      if (
        !container ||
        !strip ||
        !(target instanceof HTMLElement) ||
        !container.contains(target) ||
        strip.contains(target) ||
        !target.matches(':focus-visible')
      ) {
        return;
      }
      const stripRect = strip.getBoundingClientRect();
      // A strip with no laid-out height covers nothing (also the case in
      // jsdom, where every rect is zero), so there is nothing to clear.
      if (stripRect.height === 0) return;
      const band = paintedBand(target, container);
      const overlap = stripRect.bottom + CLEARANCE_PX - band.top;
      if (overlap <= 0) return;
      // Never push the painted band out through the bottom of the viewport:
      // a band taller than the space under the strip gets no correction, one
      // that nearly fits gets only as much as the room below it allows.
      const correction = Math.min(overlap, window.innerHeight - band.bottom);
      if (correction <= 0) return;
      window.scrollBy({ top: -correction, behavior: 'instant' });
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [containerRef, stripRef]);
}
