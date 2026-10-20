/**
 * Holds the AI assistant session for the signed-in tab. Mounted in
 * `AuthAwareProviders` inside `SyncProvider`, so it outlives route changes and
 * the tool rows can read `useSync()` and `useAuth()` when they register
 * handlers. The logic lives in `session.ts`; this file only feeds it the auth
 * state and tears it down.
 *
 * Three gates stand before anything renders or dials: the build carries a
 * bridge port (`bridge-port.ts`), the `ai-assistants` beta feature is visible,
 * and the person opted in on this device (`preference.ts`). A session ends,
 * socket closed, when the sign-in goes away (`householdId` null), the
 * workspace locks (`isUnlocked` false), a different user signs in, the page is
 * hidden (reload, tab close) or a gate closes. Auth does not say why the
 * sign-in ended, so an idle sign-out reads as `sign-out`.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useAuth } from '../auth/AuthContext';
import { recordProgrammaticActivity } from '../auth/IdleTimer';
import { useBetaFeatures } from '../contexts/BetaFeaturesContext';
import { CLIENT_BUILD_ID } from '../lib/build-id';
import { readBridgePort } from './bridge-port';
import { diagnose, readLocalNetworkPermission, type Diagnosis, type PermissionAnswer } from './diagnosis';
import type { ToolHandler } from './dispatcher';
import { readAssistantOptIn, writeAssistantOptIn } from './preference';
import { AssistantSession, type ConnectResult, type SessionSnapshot } from './session';
import type { ConsentRequest, ConsentStep, SocketFactory } from './session-types';
import type { ConsentAnswer, ConsentRecord } from './sharing/consent';

export interface AssistantContextValue {
  /** The build carries a bridge port and the beta feature is visible: the settings card renders. */
  offered: boolean;
  /** The bridge port baked into this build, for the launch commands. */
  port: number | null;
  /** The per-device opt-in; nothing dials while it is off. */
  optedIn: boolean;
  setOptedIn: (on: boolean) => void;
  phase: SessionSnapshot['phase'];
  audit: SessionSnapshot['audit'];
  /** What the person allowed for the running session; `null` while none runs or they have yet to decide. */
  consent: ConsentRecord | null;
  /** Set while the consent dialog is due: the bridge proved itself and the person has yet to answer. */
  pendingConsent: ConsentRequest | null;
  /** The dialog's answer: what the person allowed, or `'declined'`, which ends the session. */
  answerConsent: (answer: ConsentAnswer | 'declined') => void;
  /** Why the last connection ended; `none` while one is running or none has happened. */
  diagnosis: Diagnosis;
  connect: (code: string) => ConnectResult;
  disconnect: () => void;
  /** The tool rows register their handlers here, by registry tool name. */
  registerHandler: (name: string, handler: ToolHandler) => () => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

interface AssistantProviderProps {
  children: React.ReactNode;
  /** Builds the socket; tests pass a double. The browser's `WebSocket` by default. */
  openSocket?: SocketFactory;
  /** Replaces the consent dialog; tests use it to answer without rendering one. */
  requestConsent?: ConsentStep;
}

const openBrowserSocket: SocketFactory = (url) => new WebSocket(url);

interface PendingConsent {
  request: ConsentRequest;
  resolve: (answer: ConsentAnswer | 'declined') => void;
}

interface OptInState {
  readonly forUserId: string | null;
  readonly on: boolean;
}

export const AssistantProvider: React.FC<AssistantProviderProps> = ({
  children,
  openSocket = openBrowserSocket,
  requestConsent,
}) => {
  const { me, householdId, isUnlocked, unlockResolved } = useAuth();
  const { isBetaFeatureVisible } = useBetaFeatures();
  const userId = me?.id ?? null;
  const port = useMemo(() => readBridgePort(), []);
  const offered = port !== null && isBetaFeatureVisible('ai-assistants');

  // Re-read the stored opt-in during the render that sees a new user, like the beta switch does.
  const [stored, setStored] = useState<OptInState>(() => ({ forUserId: userId, on: readAssistantOptIn(userId) }));
  if (stored.forUserId !== userId) setStored({ forUserId: userId, on: readAssistantOptIn(userId) });
  const optedIn = stored.forUserId === userId ? stored.on : readAssistantOptIn(userId);
  const setOptedIn = useCallback(
    (on: boolean) => {
      setStored({ forUserId: userId, on });
      writeAssistantOptIn(userId, on);
    },
    [userId],
  );

  const workspaceReady = householdId !== null && unlockResolved && isUnlocked;
  const workspaceReadyRef = useRef(workspaceReady);
  useLayoutEffect(() => {
    workspaceReadyRef.current = workspaceReady;
  }, [workspaceReady]);

  // The consent step waits here for the dialog the shell host renders; the session holds the promise.
  const [pending, setPending] = useState<PendingConsent | null>(null);

  const [session] = useState(
    () =>
      new AssistantSession({
        port,
        openSocket,
        isWorkspaceReady: () => workspaceReadyRef.current,
        appBuildId: CLIENT_BUILD_ID,
        noteActivity: recordProgrammaticActivity,
        requestConsent:
          requestConsent ??
          ((request) =>
            new Promise((resolve) => {
              setPending({ request, resolve });
            })),
        log: (message) => console.info(`[assistant] ${message}`),
      }),
  );
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);

  // The dialog is due only while the session waits for it: when the session ends first (Disconnect,
  // sign-out, a socket that closed), drop the dialog and settle its promise so nothing waits on it.
  useEffect(() => {
    if (pending !== null && snapshot.phase !== 'awaiting-consent') {
      pending.resolve('declined');
      setPending(null);
    }
  }, [pending, snapshot.phase]);

  const answerConsent = useCallback(
    (answer: ConsentAnswer | 'declined') => {
      if (pending === null) return;
      setPending(null);
      pending.resolve(answer);
    },
    [pending],
  );

  // Sign-out (idle sign-out and device clear included), lock and user switch all end the session.
  const previousUserIdRef = useRef(userId);
  useEffect(() => {
    const previous = previousUserIdRef.current;
    previousUserIdRef.current = userId;
    if (userId !== null && previous !== null && previous !== userId) session.end('user-switch');
    else if (userId === null || householdId === null) session.end('sign-out');
    else if (!isUnlocked) session.end('lock');
  }, [session, userId, householdId, isUnlocked]);

  // Closing a gate ends the session: the switch turned off, or the beta feature hidden.
  useEffect(() => {
    if (!offered || !optedIn) session.end('disconnect');
  }, [session, offered, optedIn]);

  // Reload and tab close both fire `pagehide`.
  useEffect(() => {
    const onPageHide = (): void => session.end('pagehide');
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      session.end('disconnect');
    };
  }, [session]);

  // A socket that never opened is "not running" or "blocked": ask the browser which, if it can say.
  const [permission, setPermission] = useState<{ end: SessionSnapshot['end']; answer: PermissionAnswer }>({
    end: null,
    answer: 'unknown',
  });
  useEffect(() => {
    const { end } = snapshot;
    if (end === null || end.phase !== 'connecting') return;
    let current = true;
    void readLocalNetworkPermission().then((answer) => {
      if (current) setPermission({ end, answer });
    });
    return () => {
      current = false;
    };
  }, [snapshot]);

  const connect = useCallback(
    (code: string): ConnectResult => {
      if (!offered || !optedIn || !workspaceReadyRef.current) return 'unavailable';
      return session.connect(code);
    },
    [session, offered, optedIn],
  );

  const diagnosis = useMemo<Diagnosis>(() => {
    const { end } = snapshot;
    if (end === null) return { kind: 'none' };
    return diagnose(end.phase, end.close, permission.end === end ? permission.answer : 'unknown');
  }, [snapshot, permission]);

  const value = useMemo<AssistantContextValue>(
    () => ({
      offered,
      port,
      optedIn,
      setOptedIn,
      phase: snapshot.phase,
      audit: snapshot.audit,
      consent: snapshot.consent,
      pendingConsent: pending?.request ?? null,
      answerConsent,
      diagnosis,
      connect,
      disconnect: () => session.disconnect(),
      registerHandler: (name, handler) => session.registerHandler(name, handler),
    }),
    [offered, port, optedIn, setOptedIn, snapshot, pending, answerConsent, diagnosis, connect, session],
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
};

/** The assistant context, or `null` outside the provider (the shell host renders nothing there). */
export function useOptionalAssistant(): AssistantContextValue | null {
  return useContext(AssistantContext);
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error('useAssistant must be used within an AssistantProvider');
  return ctx;
}
