import { outcomeFromError } from './contract.js';
import { realpathSync } from 'node:fs';
import { assertThreadAllowed, buildEnvelope, experimentalEnabled, openCodexSession, sendToCodexThread } from '../codex-bridge.js';

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const BUDGET = 4 * 1024 * 1024;
function conversationId(value, name = 'threadId') {
  if (typeof value !== 'string' || !ID.test(value)) throw new RangeError(`${name} must be 1-128 identifier characters`);
  return value;
}
function boundedInteger(value, max, name) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new RangeError(`${name} must be an integer 1-${max}`);
  return value;
}
const terminal = status => ['completed', 'failed', 'interrupted'].includes(status);
const namedTurn = p => p?.turnId ?? p?.turn_id ?? p?.turn?.id;

/** Bounded traversal; a coverage failure throws and must never be interpreted as not found. */
export async function visitCodexHistory(session, threadId, method, params, visit, { signal, stopped = () => false } = {}) {
  if (!['thread/turns/list', 'thread/items/list'].includes(method)) throw new RangeError('Unsupported history method');
  conversationId(threadId);
  const client = session.client;
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 20; page++) {
    if (stopped() || signal?.aborted) throw new Error('History coverage incomplete: observation cancelled');
    const result = await client.request(method, { ...params, threadId, limit: 100, ...(cursor ? { cursor } : {}) });
    if (stopped() || signal?.aborted) throw new Error('History coverage incomplete: observation cancelled');
    if (!Array.isArray(result?.data) || result.data.length > 100 || (result.nextCursor != null && (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 4096))) throw new Error(`Invalid ${method} page`);
    if (visit(result.data)) return { complete: false, reason: 'matched', pages: page + 1 };
    if (result.nextCursor == null) return { complete: true, reason: 'exhausted', pages: page + 1 };
    if (seen.has(result.nextCursor)) throw new Error('History coverage incomplete: repeated pagination cursor');
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw new Error('History coverage incomplete: 20 page limit');
}

/** A bounded observer. Cancellation ends observation, never the daemon's turn. */
export async function openCodexConversation(threadId, options = {}) {
  conversationId(threadId);
  const { env = process.env, expectedCwd, signal, onEvent } = options;
  assertThreadAllowed(threadId, env);
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');
  if (signal?.aborted) throw new Error('Observation cancelled');
  const expected = expectedCwd === undefined ? undefined : realpathSync(expectedCwd);
  const session = options.session ?? await openCodexSession(env, { signal, experimental: experimentalEnabled(env) });
  const { client } = session;
  const events = [];
  const acceptedTurns = new Set();
  const wake = new Set();
  let bytes = 0, overflow = false, disconnected = client.closed, closed = false;
  const record = event => {
    const size = Buffer.byteLength(JSON.stringify(event));
    if (size > BUDGET) { overflow = true; } else {
      while (events.length >= 500 || bytes + size > BUDGET) { bytes -= events.shift().bytes; overflow = true; }
      events.push({ event, bytes: size }); bytes += size;
    }
    for (const listener of [...wake]) listener();
    return onEvent?.(event);
  };
  const observe = kind => message => {
    const p = message.params;
    if ((p?.threadId ?? p?.thread_id) !== threadId) return;
    return record({ kind, ...message });
  };
  const unsubs = [client.onNotification(observe('notification')), client.onServerRequest(observe('interaction')),
    client.onClose(error => { disconnected = true; return record({ kind: 'disconnect', error: error?.message }); })];
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const unsubscribe of unsubs) unsubscribe();
    for (const listener of wake) listener();
    if (!options.session) client.close();
  };
  let resumed;
  try {
    resumed = await client.request('thread/resume', { threadId, excludeTurns: true });
    if (resumed?.thread?.id !== threadId) throw new Error('thread/resume returned a different thread ID');
    const cwd = resumed.cwd ?? resumed.thread.cwd;
    if (expected !== undefined && (typeof cwd !== 'string' || realpathSync(cwd) !== expected)) throw new Error('Codex thread cwd does not match expectedCwd');
  } catch (error) { await close(); throw error; }

  /** @param {{turnId: string, messageId?: string, timeoutMs?: number, signal?: AbortSignal, maxOutputBytes?: number}} options */
  async function wait({ turnId, messageId, timeoutMs = 120000, signal: waitSignal, maxOutputBytes = 1048576 }) {
    conversationId(turnId, 'turnId');
    if (messageId !== undefined) conversationId(messageId, 'messageId');
    boundedInteger(timeoutMs, 600000, 'timeoutMs'); boundedInteger(maxOutputBytes, BUDGET, 'maxOutputBytes');
    if (waitSignal !== undefined && !(waitSignal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
    let done = false, status = acceptedTurns.has(turnId) ? 'inProgress' : undefined, error, historyError, itemBytes = 0, truncated = overflow;
    const items = new Map();
    const add = item => {
      if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') throw new Error('Invalid history item');
      if (item.type !== 'agentMessage' || typeof item.text !== 'string' || (item.phase !== 'final_answer' && item.phase != null)) return;
      const normalized = { id: item.id, type: item.type, phase: item.phase ?? null, text: item.text };
      const size = Buffer.byteLength(JSON.stringify(normalized));
      const prior = items.get(item.id);
      if (itemBytes - (prior?.bytes ?? 0) + size > BUDGET || (!prior && items.size >= 2000)) { truncated = true; return; }
      itemBytes += size - (prior?.bytes ?? 0); items.set(item.id, { item: normalized, bytes: size });
    };
    const scan = () => {
      const interactions = new Map();
      for (const { event } of events) {
        const p = event.params;
        if (event.method === 'serverRequest/resolved') { interactions.delete(p.requestId); continue; }
        if (namedTurn(p) !== turnId) continue;
        if (event.kind === 'interaction') interactions.set(event.id, event);
        if (event.method === 'turn/started' && !terminal(status)) status = p.turn?.status;
        if (event.method === 'item/completed') add(p.item);
        if (event.method === 'turn/completed') {
          status = p.turn?.status; error = p.turn?.error;
          for (const item of p.turn?.items ?? []) add(item);
        }
      }
      return [...interactions.values()];
    };
    const result = (state, detail) => {
      const interactions = scan();
      const candidates = [...items.values()].map(x => x.item);
      const finals = candidates.filter(i => i.phase === 'final_answer');
      // Old app-servers omit phase; use their completed agent items only at terminal status.
      const selected = finals.length ? finals : terminal(state) ? candidates : [];
      const reply = { text: '', items: [], truncated: truncated || overflow };
      for (const item of selected) {
        const text = reply.text ? `${reply.text}\n${item.text}` : item.text;
        if (Buffer.byteLength(JSON.stringify({ text, items: [...reply.items, item] })) > maxOutputBytes) { reply.truncated = true; break; }
        reply.text = text; reply.items.push(item);
      }
      return { threadId, turnId, ...(messageId === undefined ? {} : { messageId }), execution: { state, ...(detail ? { error: detail } : {}) }, reply, interactions };
    };
    let timer, notify;
    const abortSignals = [signal, waitSignal].filter(Boolean);
    const stopped = new Promise(resolve => {
      notify = () => {
        if (abortSignals.some(s => s.aborted) || closed) resolve(['unknown', 'Observation cancelled']);
        else if (disconnected) resolve(['disconnected', 'Codex connection closed']);
      };
      timer = setTimeout(() => resolve(['timeout', 'Observation deadline reached']), timeoutMs);
      for (const s of abortSignals) s.addEventListener('abort', notify, { once: true });
      wake.add(notify); notify();
    });
    const collect = async () => {
      scan();
      try {
        let found = false;
        await visitCodexHistory(session, threadId, 'thread/turns/list', {}, data => {
          for (const turn of data) if (!turn || typeof turn.id !== 'string' || typeof turn.status !== 'string') throw new Error('Invalid turn history');
          const turn = data.find(t => t.id === turnId);
          if (!turn) return false;
          found = true; if (!terminal(status)) { status = turn.status; error = turn.error; } return true;
        }, { stopped: () => done });
        if (!found && !status) return ['unknown', 'History coverage incomplete: selected turn not found'];
        await visitCodexHistory(session, threadId, 'thread/items/list', { turnId }, data => {
          for (const row of data) {
            if (!row || row.turnId !== turnId || !row.item) throw new Error('Invalid thread/items/list wrapper');
            add(row.item);
          }
          return false;
        }, { stopped: () => done });
      } catch (err) { historyError = err.message; truncated = true; }
      while (!done) {
        const interactions = scan();
        if (terminal(status)) return [status, error ?? historyError];
        if (historyError || overflow) return ['unknown', historyError ?? 'Notification coverage overflow'];
        if (interactions.length) return ['waiting-for-input'];
        await new Promise(resolve => {
          const listener = () => { wake.delete(listener); resolve(); };
          wake.add(listener);
        });
      }
      return ['unknown', 'Observation ended'];
    };
    try { const [state, detail] = await Promise.race([stopped, collect()]); return result(state, detail); }
    finally { done = true; clearTimeout(timer); wake.delete(notify); for (const s of abortSignals) s.removeEventListener('abort', notify); for (const listener of [...wake]) listener(); }
  }

  /** @param {{timeoutMs?: number, maxEvents?: number, signal?: AbortSignal}} [options] */
  async function watch({ timeoutMs = 30000, maxEvents = 100, signal: watchSignal } = {}) {
    boundedInteger(timeoutMs, 600000, 'timeoutMs'); boundedInteger(maxEvents, 500, 'maxEvents');
    if (watchSignal !== undefined && !(watchSignal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
    const signals = [signal, watchSignal].filter(Boolean);
    let timer, listener;
    const reason = await new Promise(resolve => {
      listener = () => {
        if (signals.some(s => s.aborted) || closed) resolve('cancelled');
        else if (disconnected) resolve('disconnected');
        else if (events.length >= maxEvents) resolve('event-limit');
      };
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      wake.add(listener); for (const s of signals) s.addEventListener('abort', listener, { once: true }); listener();
    });
    clearTimeout(timer); wake.delete(listener); for (const s of signals) s.removeEventListener('abort', listener);
    return { threadId, events: events.slice(0, maxEvents).map(x => x.event), reason, truncated: overflow || events.length > maxEvents };
  }
  return { threadId, cwd: resumed.cwd ?? resumed.thread.cwd, wait, watch, close,
    /** @param {string} text
     * @param {{envelope?: object, whenBusy?: string, expectedTurnId?: string}} [options] */
    async send(text, { envelope = buildEnvelope({ env }), whenBusy = 'reject', expectedTurnId } = {}) {
      if (closed) return outcomeFromError(Object.assign(new Error('Conversation closed'), { delivery: 'rejected', reason: 'closed', threadId, envelope }));
      const receipt = await sendToCodexThread(threadId, text, { env, envelope, whenBusy, expectedTurnId, session, expectedCwd });
      if (receipt.delivery === 'accepted' && receipt.turnId) {
        acceptedTurns.add(receipt.turnId);
        if (acceptedTurns.size > 100) acceptedTurns.delete(acceptedTurns.values().next().value);
      }
      return receipt;
    },
  };
}
