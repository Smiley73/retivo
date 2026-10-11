/**
 * Static contract for the Retivo browser favicon.
 *
 * The browser icon shares the PDF cover's solid pine-green dot.
 * Reading the source keeps the transparent-canvas contract explicit: the SVG
 * contains only the dot, with no full-canvas background.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRAND_MARK_URL } from './lib/brand';

const here = dirname(fileURLToPath(import.meta.url));
const faviconSource = readFileSync(join(here, '../public/favicon.svg'), 'utf8');
const indexSource = readFileSync(join(here, '../index.html'), 'utf8');

describe('Retivo favicon', () => {
  it('is one large pine dot on a transparent canvas', () => {
    const document = new DOMParser().parseFromString(faviconSource, 'image/svg+xml');
    const svg = document.documentElement;
    const shapes = Array.from(svg.children);

    expect(svg.getAttribute('viewBox')).toBe('0 0 32 32');
    expect(svg.getAttribute('width')).toBe('32');
    expect(svg.getAttribute('height')).toBe('32');
    expect(svg.getAttribute('fill')).toBeNull();
    expect(svg.getAttribute('style')).toBeNull();
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.tagName).toBe('circle');
    expect(document.querySelector('style, rect, path')).toBeNull();

    const [dot] = shapes;
    // Fill-only is load-bearing: a stroke on this same circle would recreate
    // the white-outline variant while still satisfying the one-shape checks.
    expect(dot?.getAttributeNames().sort()).toEqual(['cx', 'cy', 'fill', 'r']);
    expect(dot?.getAttribute('cx')).toBe('16');
    expect(dot?.getAttribute('cy')).toBe('16');
    expect(dot?.getAttribute('r')).toBe('14');
    expect(dot?.getAttribute('fill')).toBe('#0e6549');
  });

  it('is the SVG favicon linked by the app shell', () => {
    const document = new DOMParser().parseFromString(indexSource, 'text/html');
    const icon = document.querySelector('link[rel="icon"]');

    expect(icon?.getAttribute('type')).toBe('image/svg+xml');
    expect(BRAND_MARK_URL).toBe('/favicon.svg?v=4');
    expect(icon?.getAttribute('href')).toBe(BRAND_MARK_URL);
  });
});
