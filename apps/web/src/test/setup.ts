import '@testing-library/jest-dom';
import { Blob as NodeBlob } from 'node:buffer';
import { setRegisteredDeviceId } from '../sync/device-id';

// vitest 4 ships a stub `localStorage` (and `sessionStorage`) shaped as
// an empty object — `typeof localStorage === 'object'` but `getItem` /
// `setItem` are missing. Real test setups need a working Storage so the
// idle-timer (and any production code that touches localStorage during a
// rendered tree) doesn't blow up. Polyfill with a Map-backed Storage
// before any test imports run.
function installStoragePolyfill(): void {
  class MemoryStorage implements Storage {
    private map = new Map<string, string>();
    get length(): number { return this.map.size; }
    clear(): void { this.map.clear(); }
    getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null; }
    key(index: number): string | null {
      return Array.from(this.map.keys())[index] ?? null;
    }
    removeItem(key: string): void { this.map.delete(key); }
    setItem(key: string, value: string): void { this.map.set(key, String(value)); }
  }

  const needsLocal = typeof globalThis.localStorage?.setItem !== 'function';
  const needsSession = typeof globalThis.sessionStorage?.setItem !== 'function';

  if (needsLocal) {
    const ls = new MemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, 'localStorage', { value: ls, configurable: true, writable: true });
    }
  }
  if (needsSession) {
    const ss = new MemoryStorage();
    Object.defineProperty(globalThis, 'sessionStorage', { value: ss, configurable: true, writable: true });
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, 'sessionStorage', { value: ss, configurable: true, writable: true });
    }
  }
}

installStoragePolyfill();

// jsdom ships no `ResizeObserver`. React Aria's overlay/positioning
// machines instantiate one to
// track anchor element movement; without a stub the popover/listbox
// close path throws an uncaught `ResizeObserver is not defined`. A
// no-op observer is the standard jsdom shim — these tests assert
// ARIA/behavior, not layout. Chart tests still install their own stub
// locally; assigning here only when absent leaves those untouched.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}

// jsdom ships no `Worker`. `MonteCarloProvider`
// instantiates the Monte Carlo engine worker (Vite `?worker` transform) as
// soon as a fully-projected Balance Projection / stress-test view drives a
// run; without a stub that construction throws an uncaught `Worker is not
// defined` which surfaces as an unhandled rejection and fails the whole
// suite. A no-op Worker keeps construction from throwing — these tests
// assert page/ARIA wiring, not Monte Carlo output (the stub never posts a
// result, so the provider stays harmlessly in its pre-result state).
// Assigning only when absent leaves any test that installs its own worker
// mock untouched.
if (typeof globalThis.Worker === 'undefined') {
  class WorkerStub {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onmessageerror: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    postMessage(): void {}
    terminate(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean { return false; }
  }
  (globalThis as unknown as { Worker: typeof WorkerStub }).Worker = WorkerStub;
}

// React Aria's `usePress` / `useMove` (and `@testing-library/user-event`'s
// pointer model) drive interaction through Pointer Events and
// the Element pointer-capture API, neither of which jsdom@29 implements.
// Without these shims a `userEvent.click`/`pointer` on any React Aria
// control (Switch, Radio, Select, Slider, DatePicker, dialog dismiss)
// throws `target.setPointerCapture is not a function` or never fires the
// press. These are inert capability shims — the tests still assert real
// ARIA/behavior, not layout.
//
// The `unit-node` vitest project shares this setup file but runs under the
// `node` environment, where there is no DOM: `MouseEvent` is undefined, so
// `class ... extends MouseEvent` would throw at eval and crash every node
// suite. Gate the whole pointer block on a DOM being present — jsdom has
// `MouseEvent` (behavior unchanged there); node skips it and never needs
// pointer-interaction shims.
if (typeof MouseEvent !== 'undefined' && typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventStub extends MouseEvent {
    public pointerId: number;
    public pointerType: string;
    public isPrimary: boolean;
    public width: number;
    public height: number;
    public pressure: number;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? 'mouse';
      this.isPrimary = params.isPrimary ?? true;
      this.width = params.width ?? 1;
      this.height = params.height ?? 1;
      this.pressure = params.pressure ?? 0;
    }
  }
  (globalThis as unknown as { PointerEvent: typeof PointerEventStub }).PointerEvent =
    PointerEventStub;
}
if (typeof Element !== 'undefined') {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (typeof proto.setPointerCapture !== 'function') proto.setPointerCapture = () => {};
  if (typeof proto.releasePointerCapture !== 'function') proto.releasePointerCapture = () => {};
  if (typeof proto.hasPointerCapture !== 'function') proto.hasPointerCapture = () => false;
  // React Aria measures overlay anchors via getBoundingClientRect +
  // scrollIntoView; jsdom returns zeros / lacks the latter. A zero-rect
  // stub keeps positioning code from throwing in the jsdom runner.
  if (typeof (proto as { scrollIntoView?: unknown }).scrollIntoView !== 'function') {
    proto.scrollIntoView = () => {};
  }
}

// jsdom ships no `window.matchMedia`. `MobileNavDrawer`
// queries it to decide whether it is at the
// desktop breakpoint (where it must NOT be an active focus-trap modal);
// `ThemeProvider` also consults it for the `system` preference. Default
// to a non-matching, listener-capable stub so the drawer behaves as
// "mobile" (mounts) by default — individual tests override
// `window.matchMedia` to drive the desktop breakpoint. Inert shim; the
// tests still assert real ARIA/behavior.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// Most tests render pages in isolation without mounting SyncProvider
// (which is what registers the canonical deviceId in production).
// Pre-register a stable test value so `queueLocalMutation` does not
// throw "called before SyncProvider registered the device id".
setRegisteredDeviceId('dev-test');

// jsdom installs a Blob implementation whose bytes don't survive a
// trip through Node's CompressionStream/DecompressionStream (the gzip
// header arrives mangled). Replace the Blob global with Node's native
// Blob so the data-export/import gzip pipeline runs under tests
// exactly like it does in real browsers, where everything is spec-
// compliant and interop is automatic.
(globalThis as unknown as { Blob: typeof NodeBlob }).Blob = NodeBlob;
