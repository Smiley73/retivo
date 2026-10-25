/** An in-process bridge on an ephemeral port with a capturing logger, an injectable clock and an in-memory MCP client. */
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import { startBridge, type Bridge, type BridgeOptions } from '../bridge.js';
import type { Logger } from '../logger.js';
import { Clock } from './clock.js';
import { FakeTab, TEST_ORIGIN, type TabOptions } from './fake-tab.js';
import { McpTestClient, type RpcMessage } from './mcp-test-client.js';

type LogEvent = Parameters<Logger['log']>[0];

export interface Harness {
  bridge: Bridge;
  port: number;
  client: McpTestClient;
  mcp: McpServer;
  clock: Clock;
  logs: LogEvent[];
  tabs: FakeTab[];
  /** Resolves once at least `count` events named `event` have been logged. */
  waitForLog(event: LogEvent['event'], count?: number): Promise<void>;
  /** Calls a data tool before pairing and returns the grouped pairing code from the structured result. */
  mintCode(): Promise<string>;
  newTab(options?: TabOptions): Promise<FakeTab>;
  /** A tab that has paired and sent `ready`, with the bridge confirmed ready. */
  pairedTab(): Promise<FakeTab>;
  close(): Promise<void>;
}

export type HarnessOptions = Partial<Omit<BridgeOptions, 'port' | 'logger'>> & { initialize?: boolean };

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const logs: LogEvent[] = [];
  const listeners: (() => void)[] = [];
  const logger: Logger = {
    log(event) {
      logs.push(event);
      for (const listener of [...listeners]) listener();
    },
  };
  const clock = new Clock();
  const bridge = await startBridge({
    origin: TEST_ORIGIN,
    port: 0,
    bridgeVersion: '0.0.0-test',
    logger,
    now: clock.now,
    ...options,
  });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const client = new McpTestClient((message) => void clientEnd.send(message as never));
  clientEnd.onmessage = (message) => client.receive(message as unknown as RpcMessage);
  await clientEnd.start();
  const mcp = bridge.createMcpServer();
  await mcp.connect(serverEnd);
  if (options.initialize !== false) await client.initialize();
  const tabs: FakeTab[] = [];

  const harness: Harness = {
    bridge,
    port: bridge.port,
    client,
    mcp,
    clock,
    logs,
    tabs,
    waitForLog(event, count = 1) {
      const reached = (): boolean => logs.filter((entry) => entry.event === event).length >= count;
      if (reached()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for log ${event}`)), 3000);
        const listener = (): void => {
          if (!reached()) return;
          clearTimeout(timer);
          listeners.splice(listeners.indexOf(listener), 1);
          resolve();
        };
        listeners.push(listener);
      });
    },
    async mintCode() {
      const result = await client.callTool('retivo_status');
      const error = (result.structuredContent as { error: { pairingCode: string } }).error;
      return error.pairingCode;
    },
    async newTab(tabOptions) {
      const tab = await FakeTab.connect(bridge.port, tabOptions);
      tabs.push(tab);
      return tab;
    },
    async pairedTab() {
      const code = await harness.mintCode();
      const before = logs.filter((entry) => entry.event === 'session_ready').length;
      const tab = await harness.newTab();
      await tab.connectFully(code);
      await harness.waitForLog('session_ready', before + 1);
      return tab;
    },
    async close() {
      for (const tab of tabs) tab.socket.terminate();
      await clientEnd.close();
      await mcp.close();
      await bridge.close();
    },
  };
  return harness;
}
