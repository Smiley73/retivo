/** useFocusClearOfPinnedStrip: the measured focus-clearance contract, with the geometry jsdom lacks stubbed. */
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { useRef } from 'react';
import { useFocusClearOfPinnedStrip } from './use-focus-clear-of-pinned-strip';

const STRIP_BOTTOM = 141;

function Harness(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  useFocusClearOfPinnedStrip(containerRef, stripRef);
  return (
    <>
      <div ref={containerRef}>
        <div ref={stripRef} data-testid="strip">
          <button type="button">In strip</button>
        </div>
        <div>
          <button type="button">In panel</button>
          {/* The shape of a `TableScroll` region: a focusable, overflow-
              clipping scroller (inline longhand so jsdom's computed style
              reports it) around a React Aria grid root, which is itself
              tabbable. */}
          <div
            role="region"
            tabIndex={0}
            aria-label="Year-by-year projection table"
            style={{ overflowY: 'auto' }}
          >
            <table role="grid" tabIndex={0} aria-label="Year-by-year projection">
              <tbody>
                <tr>
                  <td>2026</td>
                </tr>
              </tbody>
            </table>
          </div>
          <button type="button">Further down</button>
        </div>
      </div>
      <button type="button">Outside</button>
    </>
  );
}

function rect(top: number, height = 26): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function stubRect(el: HTMLElement, top: number, height?: number): void {
  el.getBoundingClientRect = () => rect(top, height);
}

// Keyboard-style focus that jsdom reads as `:focus-visible` every time: `user.tab()` depends on window-level memory that
// leaks across tests, while a Tab keydown followed by programmatic focus is read as keyboard focus unconditionally.
function keyboardFocus(el: HTMLElement): void {
  fireEvent.keyDown(document.body, { key: 'Tab' });
  el.focus();
}

// Locate the region and grid by label, not role: a `getByRole` lookup leaves jsdom's selector engine holding a cached
// "not `:focus-visible`" answer for the element until the next DOM mutation.
function scrollerParts(): { region: HTMLElement; grid: HTMLElement } {
  return {
    region: screen.getByLabelText('Year-by-year projection table'),
    grid: screen.getByLabelText('Year-by-year projection'),
  };
}

describe('useFocusClearOfPinnedStrip', () => {
  let scrollBy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    render(<Harness />);
    screen.getByTestId('strip').getBoundingClientRect = () =>
      rect(0, STRIP_BOTTOM);
  });

  afterEach(() => {
    scrollBy.mockRestore();
  });

  it('scrolls the window up by exactly the overlap plus clearance when keyboard focus lands under the strip', async () => {
    const user = userEvent.setup();
    const inStrip = screen.getByRole('button', { name: 'In strip' });
    const inPanel = screen.getByRole('button', { name: 'In panel' });
    stubRect(inPanel, 100);
    inStrip.focus();
    scrollBy.mockClear();

    await user.tab();

    expect(inPanel).toHaveFocus();
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith({
      top: -(STRIP_BOTTOM + 8 - 100),
      behavior: 'instant',
    });
  });

  it('does nothing when the focused control is already clear of the strip', async () => {
    const user = userEvent.setup();
    const inStrip = screen.getByRole('button', { name: 'In strip' });
    const inPanel = screen.getByRole('button', { name: 'In panel' });
    stubRect(inPanel, STRIP_BOTTOM + 8);
    inStrip.focus();
    scrollBy.mockClear();

    await user.tab();

    expect(inPanel).toHaveFocus();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("never scrolls for the strip's own controls, even though they sit inside the stuck strip", async () => {
    const user = userEvent.setup();
    const inStrip = screen.getByRole('button', { name: 'In strip' });
    const inPanel = screen.getByRole('button', { name: 'In panel' });
    stubRect(inStrip, 100);
    stubRect(inPanel, 400);
    inPanel.focus();
    scrollBy.mockClear();

    await user.tab({ shift: true });

    expect(inStrip).toHaveFocus();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('ignores focus outside the container', async () => {
    const user = userEvent.setup();
    const outside = screen.getByRole('button', { name: 'Outside' });
    const further = screen.getByRole('button', { name: 'Further down' });
    stubRect(outside, 50);
    stubRect(further, 400);
    further.focus();
    scrollBy.mockClear();

    await user.tab();

    expect(outside).toHaveFocus();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('does nothing while the strip has no laid-out height (it covers nothing)', async () => {
    const user = userEvent.setup();
    const inStrip = screen.getByRole('button', { name: 'In strip' });
    const inPanel = screen.getByRole('button', { name: 'In panel' });
    screen.getByTestId('strip').getBoundingClientRect = () => rect(0, 0);
    stubRect(inPanel, 0);
    inStrip.focus();
    scrollBy.mockClear();

    await user.tab();

    expect(inPanel).toHaveFocus();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('measures a control by its painted band: a grid scrolled deep inside a region that is already clear of the strip is left alone', () => {
    const { region, grid } = scrollerParts();
    stubRect(region, STRIP_BOTTOM + 8, 460);
    stubRect(grid, STRIP_BOTTOM + 8 - 800, 1200);
    scrollBy.mockClear();

    keyboardFocus(grid);

    expect(grid).toHaveFocus();
    expect(grid.matches(':focus-visible')).toBe(true);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("clears a covered region by the region's overlap, not by the inner scroll offset of the grid inside it", () => {
    const { region, grid } = scrollerParts();
    stubRect(region, 100, 460);
    stubRect(grid, 100 - 800, 1200);
    scrollBy.mockClear();

    keyboardFocus(grid);

    expect(grid).toHaveFocus();
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith({
      top: -(STRIP_BOTTOM + 8 - 100),
      behavior: 'instant',
    });
  });

  it('does nothing for a control taller than the band below the strip (its top above the viewport, its bottom past it)', () => {
    const inPanel = screen.getByRole('button', { name: 'In panel' });
    stubRect(inPanel, -651, 1500);
    scrollBy.mockClear();

    keyboardFocus(inPanel);

    expect(inPanel).toHaveFocus();
    expect(inPanel.matches(':focus-visible')).toBe(true);
    expect(window.innerHeight).toBe(768);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('caps the correction at the room left below a control that only nearly fits', () => {
    const inPanel = screen.getByRole('button', { name: 'In panel' });
    stubRect(inPanel, 100, 650);
    scrollBy.mockClear();

    keyboardFocus(inPanel);

    expect(inPanel).toHaveFocus();
    expect(window.innerHeight).toBe(768);
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith({ top: -18, behavior: 'instant' });
  });

  it('does not shift the page under a pointer click on a control at the strip edge', async () => {
    const user = userEvent.setup();
    const inPanel = screen.getByRole('button', { name: 'In panel' });
    stubRect(inPanel, 130);
    scrollBy.mockClear();

    await user.click(inPanel);

    expect(inPanel).toHaveFocus();
    expect(inPanel.matches(':focus-visible')).toBe(false);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
