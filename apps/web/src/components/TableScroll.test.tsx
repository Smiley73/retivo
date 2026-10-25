/** TableScroll: keyboard-scrollable region landmark around React Aria tables, and the non-scrolling variant. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { describe, expect, it } from 'vitest';
import { TableScroll } from './TableScroll';
import { expectNoA11yViolations } from '../test/a11y';

function renderTable(label = 'Year-by-year projection table', scroll = true) {
  return render(
    <TableScroll label={label} scroll={scroll}>
      <Table aria-label="year-by-year">
        <TableHeader>
          <Column isRowHeader>Year</Column>
          <Column>Balance</Column>
        </TableHeader>
        <TableBody>
          <Row id="2026">
            <Cell>2026</Cell>
            <Cell>$1,000</Cell>
          </Row>
        </TableBody>
      </Table>
    </TableScroll>,
  );
}

describe('TableScroll', () => {
  it('renders the keyboard-scrollable landmark trio', () => {
    renderTable();
    const region = screen.getByRole('region', {
      name: 'Year-by-year projection table',
    });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveAttribute(
      'aria-label',
      'Year-by-year projection table',
    );
  });

  it('wraps a React Aria Table child unchanged (grid landmark survives)', () => {
    renderTable();
    expect(
      screen.getByRole('grid', { name: 'year-by-year' }),
    ).toBeInTheDocument();
  });

  it('carries the 60vh scroll cap + border / shadow box on the wrapper', () => {
    const { container } = renderTable();
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('max-h-[60vh]');
    expect(wrapper.className).toContain('overflow-auto');
    expect(wrapper.className).toContain('rounded-lg');
    expect(wrapper.className).toContain('border');
    expect(wrapper.className).toContain('shadow-sm');
  });

  it('has no a11y violations', async () => {
    const { container } = renderTable('Multi-year balance history');
    await expectNoA11yViolations(container);
  });

  // scroll={false}: hover-action tables opt out of the overflow context that leaves a row's :hover stuck in WebKit.
  describe('scroll={false} (non-scrolling variant)', () => {
    it('drops the overflow scroll context and the scroll-region landmark', () => {
      const { container } = renderTable('Household account balances', false);
      expect(
        screen.queryByRole('region', { name: 'Household account balances' }),
      ).toBeNull();
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper).not.toHaveAttribute('tabindex');
      expect(wrapper.className).not.toContain('overflow-auto');
      expect(wrapper.className).not.toContain('max-h-[60vh]');
      expect(wrapper.className).toContain('rounded-lg');
      expect(wrapper.className).toContain('border');
      expect(wrapper.className).toContain('shadow-sm');
    });

    it('still renders the React Aria Table grid landmark', () => {
      renderTable('Household account balances', false);
      expect(
        screen.getByRole('grid', { name: 'year-by-year' }),
      ).toBeInTheDocument();
    });
  });
});
