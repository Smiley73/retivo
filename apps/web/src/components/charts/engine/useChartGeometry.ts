/**
 * Sizing hook for the SVG chart engine. Measures the container width
 * via ResizeObserver (height is caller-fixed, matching the old Recharts
 * `<ResponsiveContainer height={...}>`), falling back to a default when
 * no measurement is available yet (jsdom's ResizeObserver stub never
 * fires, so tests render against the fallback width — the same role the
 * old `ResponsiveContainer` test stub played by injecting width=800).
 */
import { useCallback, useEffect, useRef as useReactRef, useState } from 'react';

const DEFAULT_WIDTH = 800;

export interface ChartSizing {
  /** Attach to the outer measuring element. */
  ref: (node: HTMLDivElement | null) => void;
  width: number;
}

export function useChartGeometry(): ChartSizing {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const observerRef = useReactRef<ResizeObserver | null>(null);

  const ref = useCallback((node: HTMLDivElement | null): void => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (node === null) return;
    const measured = node.getBoundingClientRect().width;
    if (measured > 0) setWidth(measured);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(w);
    });
    ro.observe(node);
    observerRef.current = ro;
  }, []);

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  return { ref, width };
}
