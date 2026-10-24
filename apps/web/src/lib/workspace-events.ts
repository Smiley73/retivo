/** Dispatched after bulk writes (e.g. the demo loader) so mounted pages re-read IndexedDB; a single Save on the current page reloads locally and does not need it. */
export const WORKSPACE_CHANGED_EVENT = 'retivo.workspace.changed';

export function notifyWorkspaceChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT));
}
