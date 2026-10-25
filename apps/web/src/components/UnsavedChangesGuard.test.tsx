/** useUnsavedChangesGuard and useDirtyModalClose, exercised in isolation through small harness components. */
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { useUnsavedChangesGuard, useDirtyModalClose } from './UnsavedChangesGuard';
import { Modal } from './Modal';
import { expectNoA11yViolations } from '../test/a11y';

// MemoryRouter keeps its own stack and never touches window.history, so the navigation tests call pushState directly as BrowserRouter does.

interface GuardHarnessProps {
  initialDirty?: boolean;
}

const GuardHarness: React.FC<GuardHarnessProps> = ({ initialDirty = false }) => {
  const [dirty, setDirty] = useState(initialDirty);
  const { pendingNavModal, navigateUnguarded } = useUnsavedChangesGuard(dirty);
  return (
    <>
      <button onClick={() => setDirty(true)}>make-dirty</button>
      <button onClick={() => setDirty(false)}>make-clean</button>
      <button onClick={() => navigateUnguarded('/explicit-cancel')}>cancel-and-leave</button>
      {pendingNavModal}
    </>
  );
};

describe('useUnsavedChangesGuard', () => {
  let originalPath: string;

  beforeEach(() => {
    originalPath = window.location.pathname;
  });

  afterEach(() => {
    window.history.replaceState({}, '', originalPath);
  });

  it('does not patch pushState when not dirty', () => {
    render(<MemoryRouter><GuardHarness /></MemoryRouter>);
    window.history.pushState({}, '', '/some-path');
    expect(window.location.pathname).toBe('/some-path');
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('blocks pushState to a different pathname while dirty and shows the modal', async () => {
    render(<MemoryRouter><GuardHarness /></MemoryRouter>);
    fireEvent.click(screen.getByText('make-dirty'));

    window.history.pushState({}, '', '/elsewhere');

    await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeInTheDocument());
    expect(window.location.pathname).toBe(originalPath);
  });

  it('lets pushState pass when only the query string changes', async () => {
    render(<MemoryRouter><GuardHarness /></MemoryRouter>);
    fireEvent.click(screen.getByText('make-dirty'));

    window.history.pushState({}, '', `${originalPath}?filter=active`);

    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    expect(window.location.pathname).toBe(originalPath);
    expect(window.location.search).toBe('?filter=active');
    window.history.replaceState({}, '', originalPath);
  });

  it('Stay leaves the URL unchanged and closes the modal', async () => {
    render(<MemoryRouter><GuardHarness /></MemoryRouter>);
    fireEvent.click(screen.getByText('make-dirty'));

    window.history.pushState({}, '', '/elsewhere');
    await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
    expect(window.location.pathname).toBe(originalPath);
  });

  it('removes the patch when isDirty flips back to false', () => {
    render(<MemoryRouter><GuardHarness /></MemoryRouter>);
    fireEvent.click(screen.getByText('make-dirty'));
    fireEvent.click(screen.getByText('make-clean'));

    window.history.pushState({}, '', '/freely');
    expect(window.location.pathname).toBe('/freely');
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('confirm modal has no a11y violations when shown', async () => {
    const { container } = render(<MemoryRouter><GuardHarness /></MemoryRouter>);
    fireEvent.click(screen.getByText('make-dirty'));
    window.history.pushState({}, '', '/elsewhere');
    await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeInTheDocument());
    await expectNoA11yViolations(container);
  });

  it('navigateUnguarded bypasses the prompt even while dirty (used for explicit Cancel buttons)', async () => {
    render(
      <MemoryRouter initialEntries={['/start']}>
        <GuardHarness />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('make-dirty'));

    fireEvent.click(screen.getByText('cancel-and-leave'));
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });
});

interface ModalHarnessProps {
  initialDirty: boolean;
  realClose: () => void;
}

const ModalHarness: React.FC<ModalHarnessProps> = ({ initialDirty, realClose }) => {
  const [dirty, setDirty] = useState(initialDirty);
  const { guardedClose, immediateClose, confirmModal } = useDirtyModalClose(dirty, realClose);
  return (
    <>
      <Modal open onClose={guardedClose} title="Edit thing" size="sm">
        <p>Modal body</p>
        <button onClick={() => setDirty(true)}>make-dirty</button>
        <button onClick={() => setDirty(false)}>make-clean</button>
        <button onClick={immediateClose}>Cancel</button>
      </Modal>
      {confirmModal}
    </>
  );
};

describe('useDirtyModalClose', () => {
  it('calls realClose immediately when guardedClose fires while clean', async () => {
    const user = userEvent.setup();
    const realClose = vi.fn();
    render(<ModalHarness initialDirty={false} realClose={realClose} />);
    // Park focus inside the modal before Esc: React Aria's overlay dismiss keys off the focused element, and a prior suite's portal can leak focus under the parallel runner.
    await user.click(screen.getByRole('button', { name: 'make-clean' }));
    await user.keyboard('{Escape}');
    expect(realClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('opens the confirm modal instead of closing when dirty', async () => {
    const user = userEvent.setup();
    const realClose = vi.fn();
    render(<ModalHarness initialDirty={true} realClose={realClose} />);
    await user.click(screen.getByRole('button', { name: 'make-dirty' }));
    await user.keyboard('{Escape}');
    expect(realClose).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('Leave on the confirm modal calls realClose', async () => {
    const user = userEvent.setup();
    const realClose = vi.fn();
    render(<ModalHarness initialDirty={true} realClose={realClose} />);
    await user.click(screen.getByRole('button', { name: 'make-dirty' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    expect(realClose).toHaveBeenCalledTimes(1);
  });

  it('Stay on the confirm modal does not call realClose and closes the prompt', async () => {
    const user = userEvent.setup();
    const realClose = vi.fn();
    render(<ModalHarness initialDirty={true} realClose={realClose} />);
    await user.click(screen.getByRole('button', { name: 'make-dirty' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Stay' }));
    expect(realClose).not.toHaveBeenCalled();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('immediateClose bypasses the prompt even when dirty (used for explicit Cancel buttons)', () => {
    const realClose = vi.fn();
    render(<ModalHarness initialDirty={true} realClose={realClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(realClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });
});
