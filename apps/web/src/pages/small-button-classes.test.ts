// Standalone small button-class strings, guarding the Tailwind-v4 source-order fix ("Buttons and destructive actions" in docs/ui-conventions.md): on equal specificity Tailwind emits utilities in numeric source order, so a role class's `px-4 py-2` would silently beat an appended `px-2.5 py-1`.
// Each standalone string must carry the compact sizing directly and never the full-size padding/text.
import { describe, expect, it } from 'vitest';
import {
  btnPrimarySmClass,
  btnSecondarySmClass,
  btnDangerSmClass,
} from './accounts-page-chrome';
import { btnSuccessSmClass } from './scenarios-page-chrome';

const COMPACT_TOKENS = ['px-2.5', 'py-1', 'text-xs'] as const;
const FULL_SIZE_TOKENS = ['px-4', 'py-2', 'text-sm'] as const;

const STANDALONE_SM_CLASSES: ReadonlyArray<readonly [string, string]> = [
  ['btnPrimarySmClass', btnPrimarySmClass],
  ['btnSecondarySmClass', btnSecondarySmClass],
  ['btnDangerSmClass', btnDangerSmClass],
  ['btnSuccessSmClass', btnSuccessSmClass],
];

describe('standalone small button classes', () => {
  it.each(STANDALONE_SM_CLASSES)(
    '%s carries the compact sizing utilities',
    (_name, value) => {
      for (const token of COMPACT_TOKENS) {
        expect(value.split(/\s+/)).toContain(token);
      }
    },
  );

  it.each(STANDALONE_SM_CLASSES)(
    '%s does not carry full-size padding/text (no silent no-op concat)',
    (_name, value) => {
      const tokens = value.split(/\s+/);
      for (const token of FULL_SIZE_TOKENS) {
        expect(tokens).not.toContain(token);
      }
    },
  );

  it.each(STANDALONE_SM_CLASSES)(
    '%s is a single standalone string (no font-medium weight)',
    (_name, value) => {
      expect(value.split(/\s+/)).not.toContain('font-medium');
    },
  );
});
