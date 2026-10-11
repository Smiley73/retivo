/**
 * Shared inline text link — the app's single source for link styling.
 *
 * Renders a React Router <Link> in the brand `accent-link` green with a
 * persistent underline (a link never relies on colour alone — WCAG 1.4.1)
 * and a focus-visible ring (keyboard discoverable — WCAG 2.4.7). Extra
 * `className` is appended, so callers can add weight/size (e.g. `text-sm`,
 * `font-semibold`) without losing the link treatment.
 *
 * For a non-navigation trigger (a <button> styled as a link, or an external
 * <a>), import `textLinkClass` and apply it directly — same single source.
 */
import React from 'react';
import { Link, type LinkProps } from 'react-router';

export const textLinkClass =
  'rounded-sm font-medium text-accent-link underline underline-offset-2 ' +
  'hover:no-underline focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-ring focus-visible:ring-offset-2';

export const TextLink: React.FC<LinkProps> = ({ className, ...props }) => (
  <Link
    className={className ? `${textLinkClass} ${className}` : textLinkClass}
    {...props}
  />
);
