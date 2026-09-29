import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, rstest } from '@rstest/core';
import { invokeMcpTool, listMcpSurface } from 'agent-bundle/test';
import { CdpSession } from '../../src/core/chatgpt-desktop/cdp-session.js';
import { CdpChatGptDesktopAdapter } from '../../src/core/chatgpt-desktop/cdp-adapter.js';
import { ARCHIVED_THREAD_EXPRESSION, CONVERSATION_ID_EXPRESSION, FOCUS_COMPOSER_EXPRESSION, LIST_THREADS_EXPRESSION, LOADING_TASK_GONE_EXPRESSION, REPLY_STATE_EXPRESSION, focusComposer, startNewChatExpression } from '../../src/core/chatgpt-desktop/cdp-dom.js';
import { ArchivedThreadError, ComposerDraftError } from '../../src/core/chatgpt-desktop/errors.js';
import { ChatGptDesktopFacade, setChatGptDesktopAdapterForTests } from '../../src/core/chatgpt-desktop/facade.js';
import { appServerUnarchiveThread } from '../../src/core/chatgpt-desktop/app-server-fallback.js';
import { listThreadsOperation, listThreadsSchema, openThreadOperation, openThreadSchema, sendOperation, sendSchema } from '../../src/core/chatgpt-desktop/routes.js';
import type { ChatGptDesktopAdapter } from '../../src/core/chatgpt-desktop/adapter.js';

afterEach(() => { rstest.restoreAllMocks(); setChatGptDesktopAdapterForTests(null); });

function mockCdp(evaluate: (expression: string) => unknown, onSend?: (method: string, params?: Record<string, unknown>) => void) {
  rstest.spyOn(CdpSession.prototype, 'connect').mockResolvedValue({});
  rstest.spyOn(CdpSession.prototype, 'closed', 'get').mockReturnValue(false);
  rstest.spyOn(CdpSession.prototype, 'send').mockImplementation(async (method, params) => {
    onSend?.(method, params);
    return (method === 'Target.getTargets'
      ? { targetInfos: [{ targetId: 'main', type: 'page', url: 'app://-/index.html' }] }
      : { sessionId: 'page' }) as never;
  });
  rstest.spyOn(CdpSession.prototype, 'evaluate').mockImplementation(async (expression) => evaluate(expression) as never);
}

it('returns archived:true after navigating an archived thread route without unarchiving', async () => {
  let navigated = false;
  mockCdp((expression) => {
    if (expression === CONVERSATION_ID_EXPRESSION) return '';
    if (expression.includes('router.navigate')) { navigated = true; return { ok: true }; }
    if (expression.includes('rows.find((el)')) return { ok: false, error: 'thread-not-found' };
    if (expression === ARCHIVED_THREAD_EXPRESSION) return true;
    if (expression === LOADING_TASK_GONE_EXPRESSION) return true;
    return null;
  });
  const adapter = new CdpChatGptDesktopAdapter();
  await adapter.connect({ port: 9222 });
  expect(await adapter.openThread('local:archived', { openTimeoutMs: 1500 })).toMatchObject({ threadId: 'local:archived', archived: true });
  expect(navigated).toBe(true);
});

it('reads an archived thread through app-server and exposes an MCP open operation', async () => {
  const facade = new ChatGptDesktopFacade({
    connect: async () => {}, close: async () => {},
    openThread: async (threadId: string) => ({ threadId, backend: 'cdp', archived: true }),
  } as unknown as ChatGptDesktopAdapter, 9222, {
    readThread: async ({ threadId }: { threadId: string }) => ({ threadId, backend: 'app-server', turns: [], limit: 100, full: false, complete: true }),
  } as never);
  expect(await facade.readThread({ threadId: 'local:archived' })).toMatchObject({ backend: 'app-server', complete: true });
  setChatGptDesktopAdapterForTests(facade);
  expect(await openThreadOperation(openThreadSchema.parse({ threadId: 'local:archived' }))).toMatchObject({ archived: true, exitCode: 0 });
  expect((await listMcpSurface({ server: 'grok-bot' })).tools).toContain('chatgpt_desktop_open_thread');
  const opened = await invokeMcpTool('chatgpt_desktop_open_thread', { server: 'grok-bot', input: { threadId: 'local:archived' } });
  expect(opened.isError).toBe(false);
});

it('rejects archived send with a specific code and unarchives only on explicit opt-in', async () => {
  let archived = true;
  let unarchived = 0;
  let sent = 0;
  const facade = new ChatGptDesktopFacade({
    connect: async () => {}, close: async () => {},
    sendMessage: async ({ threadId }: { threadId?: string }) => {
      if (archived) throw new ArchivedThreadError(threadId!);
      sent++;
      return { threadId: threadId!, backend: 'cdp', delivery: 'accepted', experimental: false };
    },
  } as unknown as ChatGptDesktopAdapter, 9222, {
    unarchiveThread: async () => { unarchived++; archived = false; },
  } as never);
  setChatGptDesktopAdapterForTests(facade);
  expect(await sendOperation(sendSchema.parse({ threadId: 'local:archived', text: 'hello' }))).toMatchObject({
    code: 'ARCHIVED_THREAD', reason: 'archived-thread', delivery: 'rejected', exitCode: 1,
  });
  expect([unarchived, sent]).toEqual([0, 0]);
  expect(await sendOperation(sendSchema.parse({ threadId: 'local:archived', text: 'hello', unarchive: true }))).toMatchObject({
    delivery: 'accepted', exitCode: 0,
  });
  expect([unarchived, sent]).toEqual([1, 1]);
  expect(() => sendSchema.parse({ text: 'new chat', unarchive: true })).toThrow('unarchive requires an existing threadId');
  expect(() => sendSchema.parse({ text: 'ambiguous', threadId: 'local:existing', project: 'core' })).toThrow('project is only for a new thread');
});

it('calls thread/unarchive with the bare id and validates its response', async () => {
  const bridge = await import('../../src/core/codex-bridge.js');
  const calls: Array<[string, unknown]> = [];
  rstest.spyOn(bridge, 'openCodexSession').mockResolvedValue({ client: {
    close() {},
    async request(method: string, params: unknown) { calls.push([method, params]); return { thread: { id: 'archived' } }; },
  } } as never);
  await appServerUnarchiveThread('local:archived');
  expect(calls).toEqual([['thread/unarchive', { threadId: 'archived' }]]);
});

it('rejects an unarchive response for another thread before retrying a send', async () => {
  const bridge = await import('../../src/core/codex-bridge.js');
  rstest.spyOn(bridge, 'openCodexSession').mockResolvedValue({ client: {
    close() {}, async request() { return { thread: { id: 'wrong-thread' } }; },
  } } as never);
  await expect(appServerUnarchiveThread('local:archived')).rejects.toThrow('returned no thread');
});

it('returns a durable id after one new-thread-in-project send while preserving the temporary id', async () => {
  let submitted = false;
  const events: string[] = [];
  mockCdp((expression) => {
    if (expression.includes('projectSel')) return { ok: true, via: 'project', hoverX: 8, hoverY: 10 };
    if (expression.includes('getComputedStyle')) return { x: 12, y: 14, visible: true, disabled: false };
    if (expression.includes('const expected =')) return { ready: true, path: '/', composer: true, scope: 'Change project: core' };
    if (expression === LOADING_TASK_GONE_EXPRESSION) return true;
    if (expression === CONVERSATION_ID_EXPRESSION) return submitted ? 'durable-conversation' : '';
    if (expression === LIST_THREADS_EXPRESSION) return [{ threadId: 'local:client-new-thread:temporary', title: 'new', selected: true, pinned: false, kind: 'local' }];
    if (expression === REPLY_STATE_EXPRESSION) return { stopVisible: false, finalAssistantCount: 0, conversationId: '', reply: '', lastTurnKey: 'before' };
    if (expression === FOCUS_COMPOSER_EXPRESSION) return { ok: true };
    if (expression.includes('return Boolean(composer')) return true;
    return false;
  }, (method, params) => {
    if (method === 'Input.dispatchMouseEvent' || method === 'Input.dispatchKeyEvent') events.push(String(params?.type));
    if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp') submitted = true;
  });
  const adapter = new CdpChatGptDesktopAdapter();
  await adapter.connect({ port: 9222 });
  const receipt = await adapter.sendMessage({ text: 'one message', project: 'core', openTimeoutMs: 1000 });
  expect(receipt).toMatchObject({
    delivery: 'accepted', threadId: 'local:durable-conversation', conversationId: 'durable-conversation',
    temporaryThreadId: 'local:client-new-thread:temporary', project: 'core',
  });
  expect(events.filter((event) => event === 'mousePressed')).toHaveLength(1);
  expect(events.filter((event) => event === 'keyUp')).toHaveLength(1);
});

it('rejects a project whose configured root is missing before touching the composer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbot-unavailable-project-'));
  const previous = process.env.CODEX_HOME;
  let inserted = false;
  try {
    writeFileSync(join(home, '.codex-global-state.json'), JSON.stringify({
      'electron-persisted-atom-state': { 'local-projects': {
        missing: { id: 'missing', name: 'missing-project', rootPaths: ['/no/such/project/root'] },
      } },
    }));
    process.env.CODEX_HOME = home;
    mockCdp(() => false, (method) => { if (method === 'Input.insertText') inserted = true; });
    const adapter = new CdpChatGptDesktopAdapter();
    await adapter.connect({ port: 9222 });
    await expect(adapter.sendMessage({ project: 'missing-project', text: 'must not send' }))
      .rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE', delivery: 'rejected' });
    expect(inserted).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

it('passes the dynamic project filter through the MCP list contract', async () => {
  const calls: string[] = [];
  setChatGptDesktopAdapterForTests({
    connect: async () => {}, close: async () => {},
    listThreads: async (options: { project?: string }) => {
      calls.push(options.project!);
      return { backend: 'app-server', limit: 50, threads: [] };
    },
  } as unknown as ChatGptDesktopAdapter);
  expect(await listThreadsOperation(listThreadsSchema.parse({ project: 'core' }))).toMatchObject({ exitCode: 0 });
  expect(calls).toEqual(['core']);
});

it('selects the generic New chat action when no project is supplied', () => {
  let clicked = 0;
  const document = { querySelectorAll: () => [{ textContent: 'New chat', click: () => { clicked++; } }] };
  const result = new Function('document', `return ${startNewChatExpression()}`)(document);
  expect(result).toEqual({ ok: true, via: 'fallback' });
  expect(clicked).toBe(1);
});

it('returns a typed draft error before any text insertion', async () => {
  const session = { evaluate: async () => ({ ok: false, error: 'composer-has-draft' }) };
  await expect(focusComposer(session as never, 'page')).rejects.toMatchObject({
    code: 'COMPOSER_HAS_DRAFT', reason: 'composer-has-draft', delivery: 'rejected',
  });
  setChatGptDesktopAdapterForTests({ connect: async () => {}, close: async () => {},
    sendMessage: async () => { throw new ComposerDraftError(); } } as unknown as ChatGptDesktopAdapter);
  expect(await sendOperation(sendSchema.parse({ text: 'do not replace draft' }))).toMatchObject({
    code: 'COMPOSER_HAS_DRAFT', reason: 'composer-has-draft', exitCode: 1,
  });
});
