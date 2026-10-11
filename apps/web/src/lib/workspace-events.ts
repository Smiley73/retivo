/**
 * Cross-page workspace-mutation event.
 *
 * Pages that read aggregates from IndexedDB on mount won't see edits
 * that land while they're still mounted (e.g., the demo loader filling
 * the workspace from the FirstRunDemoModal while the user is parked
 * on /dashboard). Bulk operations dispatch this event after the local
 * IDB writes are committed; mounted pages listen and re-read.
 *
 * Single-mutation flows (a user clicking Save on a page they're
 * already on) don't need this — those pages reload locally after the
 * save resolves. The event is for *cross-page* visibility.
 */
export const WORKSPACE_CHANGED_EVENT = 'retivo.workspace.changed';

export function notifyWorkspaceChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT));
}
