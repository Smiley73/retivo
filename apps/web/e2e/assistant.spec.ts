/**
 * The AI assistant connector, end to end on the dev origin: the real built
 * bridge is started as a stdio MCP server and driven by a hand-written stdio
 * client (no MCP SDK enters the web workspace). The journey: every tool is
 * declared at start and answers `NOT_PAIRED` with a one-time code before
 * pairing; the code goes into the Settings card, the consent dialog is
 * accepted, `retivo_status` then returns a real envelope, the activity viewer
 * lists the call with its byte size and shows no email or last name in what
 * was sent, and Disconnect ends it.
 *
 * Needs `apps/mcp-bridge/dist` (build the protocol package and the bridge
 * first) and a dev build that carries the bridge port; `playwright.config.ts`
 * hands the web server `VITE_ASSISTANT_BRIDGE_PORT`, so a dev server that was
 * already running without it skips this journey with the reason.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, loadDemo } from './fixtures';

/** The port `playwright.config.ts` bakes into the dev build. */
const BRIDGE_PORT = 24581;
const ORIGIN = 'http://localhost:5173';
const BIN = fileURLToPath(new URL('../../mcp-bridge/dist/bin.js', import.meta.url));
const PLAN_TOOLS = ['retivo_status', 'retivo_get_plan_data', 'retivo_list_scenarios', 'retivo_get_scenario'];

interface RpcMessage {
  id?: number;
  result?: { tools?: { name: string }[]; structuredContent?: any; content?: { text: string }[]; isError?: boolean };
  error?: { message: string };
}

/** The bridge as an MCP client sees it: JSON-RPC lines over its stdio. */
async function startBridge(): Promise<{
  tools(): Promise<string[]>;
  call(name: string, args?: Record<string, unknown>): Promise<{ result: any; text: string }>;
  stop(): void;
}> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [BIN, '--origin', ORIGIN, '--port', String(BRIDGE_PORT)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const pending = new Map<number, (message: RpcMessage) => void>();
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      const message = JSON.parse(line) as RpcMessage;
      if (message.id !== undefined) pending.get(message.id)?.(message);
    }
  });
  let nextId = 1;
  const write = (message: object): void => void child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params: object): Promise<RpcMessage> => {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      write({ jsonrpc: '2.0', id, method, params });
    });
  };
  await expect.poll(() => stderr.includes('"event":"listening"'), { timeout: 15_000 }).toBe(true);
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'playwright', version: '0.0.0' } });
  write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    async tools() {
      const message = await request('tools/list', {});
      return (message.result?.tools ?? []).map((tool) => tool.name);
    },
    async call(name, args = {}) {
      const message = await request('tools/call', { name, arguments: args });
      if (message.result === undefined) throw new Error(`tools/call ${name}: ${message.error?.message ?? 'no result'}`);
      return { result: message.result.structuredContent, text: message.result.content?.[0]?.text ?? '' };
    },
    stop() {
      child.kill('SIGKILL');
    },
  };
}

test.describe('AI assistant connector', () => {
  test('pairs, consents, answers a tool, lists the call in the activity viewer and disconnects', async ({ page }) => {
    test.skip(!existsSync(BIN), 'apps/mcp-bridge/dist/bin.js is missing: build the protocol package and the bridge first');
    await loadDemo(page);
    await page.goto('/profile');
    await page.getByRole('switch', { name: 'Show beta features' }).click();
    const optIn = page.getByRole('switch', { name: 'Allow AI assistants on this device' });
    test.skip(
      (await optIn.count()) === 0,
      `this dev build carries no bridge port: restart the dev server with VITE_ASSISTANT_BRIDGE_PORT=${BRIDGE_PORT}`,
    );
    await optIn.click();

    const bridge = await startBridge();
    try {
      // The whole tool list is declared at start, and each plan tool answers with the one-time code until paired.
      expect(await bridge.tools()).toEqual(expect.arrayContaining(PLAN_TOOLS));
      const first = await bridge.call('retivo_status');
      expect(first.result).toMatchObject({ ok: false, error: { code: 'NOT_PAIRED', state: 'awaiting-code' } });
      const code = first.result.error.pairingCode as string;
      expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
      for (const tool of PLAN_TOOLS.slice(1)) {
        const args = tool === 'retivo_get_scenario' ? { scenarioId: 'demo-scenario-base' } : {};
        expect((await bridge.call(tool, args)).result).toMatchObject({ ok: false, error: { code: 'NOT_PAIRED' } });
      }

      // Pair, and accept the consent dialog with its generous defaults.
      await page.getByLabel('Pairing code').fill(code);
      await page.getByRole('button', { name: 'Connect' }).click();
      const dialog = page.getByRole('dialog', { name: /let this assistant read your plan/i });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await dialog.getByRole('button', { name: 'Allow' }).click();
      await expect(page.getByRole('button', { name: /assistant connected/i }).first()).toBeVisible({ timeout: 15_000 });

      // A real envelope now.
      const status = await bridge.call('retivo_status');
      expect(status.result).toMatchObject({ ok: true, payload: { data: { workspace: { state: 'unlocked' } } } });
      expect(status.result.payload.engineVersion).toEqual(expect.any(Number));
      expect(status.result.payload.disclosure.notFinancialAdvice).toMatch(/not financial/i);
      const planData = await bridge.call('retivo_get_plan_data', { sections: ['members', 'accounts'] });
      expect(planData.result.ok).toBe(true);
      expect(planData.text).not.toMatch(/@/);

      // The activity viewer lists the call with its byte size, and what was sent holds no email or last name.
      await page.getByRole('button', { name: /assistant connected.*view activity/i }).click();
      const viewer = page.getByRole('dialog', { name: 'Assistant activity' });
      await expect(viewer).toBeVisible();
      const bytes = new TextEncoder().encode(JSON.stringify(status.result)).length;
      await expect(viewer.getByText(`${bytes.toLocaleString()} bytes sent`).first()).toBeVisible();
      await viewer.getByRole('button', { name: /retivo_status/ }).first().click();
      await viewer.getByRole('button', { name: /retivo_get_plan_data/ }).first().click();
      const sentPlanData = await viewer.getByRole('region', { name: /^Sent text for retivo_get_plan_data/ }).textContent();
      const sentStatus = await viewer.getByRole('region', { name: /^Sent text for retivo_status/ }).textContent();
      for (const text of [sentPlanData ?? '', sentStatus ?? '']) {
        expect(text).not.toMatch(/@/);
        expect(text.toLowerCase()).not.toContain('"lastname"');
        expect(text).not.toContain('"email"');
      }

      // Disconnect ends the session: the bridge asks for a new code.
      await viewer.getByRole('button', { name: 'Disconnect assistant' }).click();
      await expect(page.getByRole('button', { name: /assistant connected/i })).toHaveCount(0);
      await expect
        .poll(async () => (await bridge.call('retivo_status')).result?.error?.code, { timeout: 15_000 })
        .toBe('NOT_PAIRED');
    } finally {
      bridge.stop();
    }
  });
});
