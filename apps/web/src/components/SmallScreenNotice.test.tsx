import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { SmallScreenNotice } from './SmallScreenNotice';

const PHONE_VIEWPORT_QUERY = '(max-width: 639px)';
const SMALL_SCREEN_NOTICE_DISMISSED_KEY = 'retivo:small-screen-notice-dismissed';

type ChangeHandler = (e: MediaQueryListEvent) => void;

function installMatchMedia(initialMatches: boolean) {
  const handlers = new Set<ChangeHandler>();
  let matches = initialMatches;
  const queries: string[] = [];
  window.matchMedia = ((query: string) => {
    queries.push(query);
    return {
      get matches() {
        return matches;
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_: string, h: ChangeHandler) => handlers.add(h),
      removeEventListener: (_: string, h: ChangeHandler) => handlers.delete(h),
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
  return {
    queries,
    setMatches(next: boolean) {
      matches = next;
      handlers.forEach((h) => h({ matches: next } as MediaQueryListEvent));
    },
  };
}

describe('SmallScreenNotice', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    window.matchMedia = originalMatchMedia;
  });

  it('renders nothing on a tablet or computer width', () => {
    const mm = installMatchMedia(false);
    render(<SmallScreenNotice />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mm.queries).toContain(PHONE_VIEWPORT_QUERY);
  });

  it('shows the advisory dialog on a phone width with a Continue button', () => {
    installMatchMedia(true);
    render(<SmallScreenNotice />);
    const dialog = screen.getByRole('dialog', { name: 'Best on a larger screen' });
    expect(dialog).toHaveTextContent(
      'Retivo works best on a tablet or computer. Some pages may not display properly on a phone.',
    );
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('Continue closes it and remembers the dismissal for this tab session', () => {
    installMatchMedia(true);
    const { unmount } = render(<SmallScreenNotice />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(SMALL_SCREEN_NOTICE_DISMISSED_KEY)).toBe('1');

    unmount();
    render(<SmallScreenNotice />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stays hidden when the session already dismissed it', () => {
    installMatchMedia(true);
    sessionStorage.setItem(SMALL_SCREEN_NOTICE_DISMISSED_KEY, '1');
    render(<SmallScreenNotice />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes when the viewport grows past the phone width without marking it dismissed', () => {
    const mm = installMatchMedia(true);
    render(<SmallScreenNotice />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => mm.setMatches(false));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(SMALL_SCREEN_NOTICE_DISMISSED_KEY)).toBeNull();
  });
});
