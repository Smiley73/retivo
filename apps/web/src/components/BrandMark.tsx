/**
 * Decorative Retivo mark shared by the sidebar and auth-page lockups.
 */
import React from 'react';
import { BRAND_MARK_URL } from '../lib/brand';

interface BrandMarkProps {
  /** Tailwind sizing and layout utilities supplied by the surrounding lockup. */
  readonly className: string;
}

/** Renders the exact cache-versioned favicon asset beside an accessible wordmark. */
export const BrandMark: React.FC<BrandMarkProps> = ({ className }) => (
  <img
    src={BRAND_MARK_URL}
    width={32}
    height={32}
    alt=""
    aria-hidden="true"
    className={className}
  />
);
