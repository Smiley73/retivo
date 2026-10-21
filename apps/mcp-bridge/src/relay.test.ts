import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CALLS_PER_MINUTE,
  MAX_FRAME_BYTES,
  MAX_IN_FLIGHT_CALLS,
  TOOL_REGISTRY,
  failureResult,
  toolNotSupported,
  type ToolEntry,
} from '@retirement/assistant-protocol';
import type { FakeTab, Frame } from './test-support/fake-tab.js';
import { startHarness, type Harness } from './test-support/harness.js';
import type { RpcMessage, ToolCallResult } from './test-support/mcp-test-client.js';

let h: Harness;
afterEach(async () => {
  vi.useRealTimers();
  await h.close();
});

const ok = (payload: unknown = {}): Frame['result'] => ({ ok: true, payload, disclosure: {} });
const toolResult = (message: RpcMessage): ToolCallResult => message.result as unknown as ToolCallResult;

/** Calls a tool and answers it from the fake tab. */
async function callAndAnswer(tab: FakeTab, result: unknown, tool = 'retivo_status', args: Record<string, unknown> = {}) {
  const call = h.client.callToolRaw(tool, args);
  const frame = await tab.next();
  tab.send({ type: 'result', id: frame.id, result });
  return { frame, response: toolResult(await call.response) };
}

describe('relaying a call', () => {
  it('sends the agent args as a call frame and returns the envelope as the MCP result', async () => {
    h = await startHarness();
    const tab = await h.pairedTab();
    const { frame, response } = await callAndAnswer(tab, ok({ n: 1 }), 'retivo_get_scenario', { scenarioId: 's1' });
    expect(frame).toMatchObject({ type: 'call', tool: 'retivo_get_scenario', args: { scenarioId: 's1' } });
    expect(frame.id).toEqual(expect.any(String));
    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0]!.text)).toEqual({ ok: true, payload: { n: 1 }, disclosure: {} });
    expect(response.structuredContent).toEqual({ ok: true, payload: { n: 1 }, disclosure: {} });
  });

  it('turns result.error into isError with the code and message untouched', async () => {
    h = await startHarness();
    const tab = await h.pairedTab();
    const failure = failureResult('WORKSPACE_LOCKED', 'Unlock the workspace in Retivo first.');
    const { response } = await callAndAnswer(tab, failure);
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toBe('WORKSPACE_LOCKED: Unlock the workspace in Retivo first.');
    expect(response.structuredContent).toEqual(failure);
  });

  it('passes TOOL_NOT_SUPPORTED from an older app through as an ordinary tool error', async () => {
    h = await startHarness();
    const tab = await h.pairedTab();
    const unsupported = toolNotSupported('retivo_explain', 'build-7');
    const { response } = await callAndAnswer(tab, unsupported, 'retivo_explain', { scenarioId: 's1', metric: 'plan_success' });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(unsupported);
    expect(response.content[0]!.text).toBe(`TOOL_NOT_SUPPORTED: ${(unsupported as { error: { message: string } }).error.message}`);
  });

  it('ignores a result for an unknown call id', async () => {
    h = await startHarness();
    const tab = await h.pairedTab();
    tab.send({ type: 'result', id: 'no-such-call', result: ok() });
    await h.waitForLog('result_ignored');
    const { response } = await callAndAnswer(tab, ok({ still: 'working' }));
    expect(response.isError).toBeUndefined();
  });

  it('refuses args too large for a frame with INVALID_ARGS and sends nothing', async () => {
    h = await startHarness();
    const tab = await h.pairedTab();
    const result = await h.client.callTool('retivo_get_plan_data', { junk: 'x'.repeat(MAX_FRAME_BYTES) });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^INVALID_ARGS:/);
    expect(tab.received).toBe(2); // hello and paired only
  });
});

describe('progress', () => {
  it('surfaces tab progress as MCP progress only when the request carried a progressToken', async () => {
    h = await startHarness();
    const tab = await h.pairedTab();
    const withToken = h.client.callToolRaw('retivo_status', {}, 'tok-1');
    const frame = await tab.next();
    tab.send({ type: 'progress', id: frame.id, fraction: 0.25, message: 'Running' });
    tab.send({ type: 'progress', id: frame.id, fraction: 0.25 });
    tab.send({ type: 'result', id: frame.id, result: ok() });
    await withToken.response;
    const progress = h.client.notifications.filter((message) => message.method === 'notifications/progress');
    expect(progress).toHaveLength(2);
    expect(progress[0]!.params).toMatchObject({ progressToken: 'tok-1', progress: 25, total: 100, message: 'Running' });
    expect((progress[1]!.params as { progress: number }).progress).toBeGreaterThan(25);

    const before = h.client.notifications.length;
    const withoutToken = h.client.callToolRaw('retivo_status');
    const second = await tab.next();
    tab.send({ type: 'progress', id: second.id, fraction: 0.5 });
    tab.send({ type: 'result', id: second.id, result: ok() });
    await withoutToken.response;
    expect(h.client.notifications.length).toBe(before);
  });

  it('ignores progress for a call that is not in flight', async () => {
    h = await startHarness();
    const tab = await h.pairedTab();
    tab.send({ type: 'progress', id: 'gone', fraction: 0.5 });
    const { response } = await callAndAnswer(tab, ok());
    expect(response.isError).toBeUndefined();
  });
});

describe('timeout and cancel', () => {
  const SHORT: ToolEntry = { ...TOOL_REGISTRY[0]!, timeoutMs: 1000 };

  it('enforces the registry timeout: cancel reason timeout to the tab, CALL_TIMEOUT to the agent, and a late result changes nothing', async () => {
    h = await startHarness({ tools: [SHORT] });
    const tab = await h.pairedTab();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const call = h.client.callToolRaw('retivo_status');
    const frame = await tab.next();
    await vi.advanceTimersByTimeAsync(1000);
    const response = toolResult(await call.response);
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toMatch(/^CALL_TIMEOUT:/);
    expect(await tab.next()).toEqual({ type: 'cancel', id: frame.id, reason: 'timeout' });
    vi.useRealTimers();
    tab.send({ type: 'result', id: frame.id, result: ok() });
    await h.waitForLog('result_ignored');
    expect(h.logs.filter((entry) => entry.event === 'tool_result')).toHaveLength(1);
  });

  it('forwards a client cancel as cancel reason client', async () => {
    h = await startHarness();
    const tab = await h.pairedTab();
    const call = h.client.callToolRaw('retivo_status');
    const frame = await tab.next();
    h.client.cancel(call.id);
    expect(await tab.next()).toEqual({ type: 'cancel', id: frame.id, reason: 'client' });
    tab.send({ type: 'result', id: frame.id, result: ok() });
    await h.waitForLog('result_ignored');
  });
});

describe('caps', () => {
  it('answers TOO_MANY_IN_FLIGHT without sending a frame', async () => {
    h = await startHarness();
    const tab = await h.pairedTab();
    const pending = Array.from({ length: MAX_IN_FLIGHT_CALLS }, () => h.client.callToolRaw('retivo_status'));
    const frames = await Promise.all(pending.map(() => tab.next()));
    const sent = tab.received;
    const over = await h.client.callTool('retivo_status');
    expect(over.isError).toBe(true);
    expect(over.content[0]!.text).toMatch(/^TOO_MANY_IN_FLIGHT:/);
    expect(tab.received).toBe(sent);
    for (const frame of frames) tab.send({ type: 'result', id: frame.id, result: ok() });
    await Promise.all(pending.map((call) => call.response));
  });

  it('answers RATE_LIMITED past the per-minute cap without sending a frame, and recovers when the window slides', async () => {
    h = await startHarness();
    const tab = await h.pairedTab();
    for (let i = 0; i < MAX_CALLS_PER_MINUTE; i += 1) await callAndAnswer(tab, ok());
    const sent = tab.received;
    const limited = await h.client.callTool('retivo_status');
    expect(limited.content[0]!.text).toMatch(/^RATE_LIMITED:/);
    expect(tab.received).toBe(sent);
    h.clock.advance(60_000);
    const { response } = await callAndAnswer(tab, ok());
    expect(response.isError).toBeUndefined();
  });
});

describe('ending the session', () => {
  it('fails in-flight calls with CANCELLED when the tab closes, and the next call returns a fresh NOT_PAIRED code', async () => {
    h = await startHarness();
    const tab = await h.pairedTab();
    const call = h.client.callToolRaw('retivo_status');
    await tab.next();
    tab.close();
    const response = toolResult(await call.response);
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toMatch(/^CANCELLED:/);
    const next = await h.client.callTool('retivo_status');
    expect(next.isError).toBeUndefined();
    expect(next.structuredContent).toMatchObject({ error: { code: 'NOT_PAIRED', state: 'awaiting-code' } });
  });

  it('closes a second socket with ALREADY_CONNECTED while the first session keeps relaying', async () => {
    h = await startHarness();
    const tab = await h.pairedTab();
    const second = await h.newTab();
    expect((await second.closed).code).toBe(4005);
    expect(second.received).toBe(0);
    const { response } = await callAndAnswer(tab, ok());
    expect(response.isError).toBeUndefined();
  });

  it('logs the call without its arguments or result', async () => {
    h = await startHarness();
    const tab = await h.pairedTab();
    await callAndAnswer(tab, ok({ secret: 'SENTINEL-RESULT' }), 'retivo_get_scenario', { scenarioId: 'SENTINEL-ARGS' });
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain('SENTINEL');
    expect(h.logs.find((entry) => entry.event === 'tool_result')).toMatchObject({ tool: 'retivo_get_scenario', outcome: 'ok' });
  });
});
