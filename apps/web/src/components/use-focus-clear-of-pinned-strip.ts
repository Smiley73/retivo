/**
 * Keeps a keyboard-focused control out from under an opaque sticky strip (WCAG 2.2 2.4.11, Focus Not Obscured).
 */
import { useEffect, type RefObject } from 'react';

/** Room between the strip's bottom edge and the focused control, so its focus ring is visible. */
const CLEARANCE_PX = 8;

// The vertical band of `target` actually painted: its box cut by every clipping ancestor up to
// `container`, so a scrolled table does not scroll the page by its inner offset.
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
    // Measured at focus time rather than via a fixed `scroll-padding-top`: the strip's height
    // varies with wrapping and its progress row. Keyboard focus only (`:focus-visible`), so a
    // pointer click does not shift the page. The listener sits on `document` because the container
    // can mount after this effect.
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
      // No laid-out height (also jsdom) covers nothing.
      if (stripRect.height === 0) return;
      const band = paintedBand(target, container);
      const overlap = stripRect.bottom + CLEARANCE_PX - band.top;
      if (overlap <= 0) return;
      // Never push the band out through the bottom of the viewport.
      const correction = Math.min(overlap, window.innerHeight - band.bottom);
      if (correction <= 0) return;
      window.scrollBy({ top: -correction, behavior: 'instant' });
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [containerRef, stripRef]);
}
