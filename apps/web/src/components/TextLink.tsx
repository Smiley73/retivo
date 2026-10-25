/**
 * Shared inline link styling on a router `<Link>`: persistent underline (WCAG 1.4.1) and a focus ring (2.4.7). For a
 * button or external `<a>`, apply `textLinkClass` directly.
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
