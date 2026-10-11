import { describe, expect, it } from 'vitest';
import {
  ISSUES_URL,
  REPO_HOST_PATH,
  REPO_URL,
} from './brand';

describe('brand repo constants', () => {
  // The one test that pins the real address: every other test compares against
  // the constant, which would also pass a mistyped one.
  it('pins the public repo address verbatim', () => {
    expect(REPO_URL).toBe('https://github.com/Smiley73/retivo');
  });

  it('builds the issue tracker from the repo address', () => {
    expect(ISSUES_URL).toBe(`${REPO_URL}/issues`);
  });

  it('derives the scheme-less display form from the repo address', () => {
    expect(REPO_HOST_PATH).toBe('github.com/Smiley73/retivo');
    expect(`https://${REPO_HOST_PATH}`).toBe(REPO_URL);
  });
});
