import { z } from 'zod';

import { outcomeFromError } from '../codex/contract.js';
import { NotImplementedError, RemoteThreadNotLoadedError } from './errors.js';
import { getChatGptDesktopAdapter } from './facade.js';
import { resolveCdpPort } from './loopback.js';

const threadId = z.string().min(1).max(256);

export const statusSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

export const listThreadsSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(4096).optional(),
    /**
     * Any string. Reserved: `all` (default), `local`. Otherwise a hostId or
     * friendly name discovered at runtime — see `chatgpt_desktop_list_hosts`.
     * Not an enum; new machines appear with no code change.
     */
    host: z.string().min(1).max(256).optional(),
    /**
     * Any modelProvider id string (passed through as app-server
     * `modelProviders`). Omit for all. Discovered values: see
     * `chatgpt_desktop_list_hosts`. Not an enum.
     */
    modelProvider: z.string().min(1).max(256).optional(),
    project: z.string().min(1).max(256).optional(),
    groupBy: z.literal('host').optional(),
  })
  .strict();

export const searchThreadsSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
    query: z.string().min(1).max(512),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(4096).optional(),
    /** Any string; see `chatgpt_desktop_list_hosts`. Not an enum. */
    host: z.string().min(1).max(256).optional(),
    /** Any modelProvider id; see `chatgpt_desktop_list_hosts`. Not an enum. */
    modelProvider: z.string().min(1).max(256).optional(),
    project: z.string().min(1).max(256).optional(),
    groupBy: z.literal('host').optional(),
  })
  .strict();

export const listHostsSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

export const readThreadSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
    threadId,
    limit: z.number().int().min(1).max(2000).optional(),
    full: z.boolean().default(false),
    cursor: z.string().min(1).max(4096).optional(),
    openTimeoutMs: z.number().int().min(1).max(600_000).default(90_000),
  })
  .strict();

export const openThreadSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  threadId,
  openTimeoutMs: z.number().int().min(1).max(600_000).default(90_000),
}).strict();

export const sendSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
    threadId: threadId.optional(),
    text: z.string().trim().min(1).max(100_000),
    project: z.string().min(1).max(256).optional(),
    unarchive: z.boolean().default(false),
    openTimeoutMs: z.number().int().min(1).max(600_000).default(90_000),
  })
  .strict()
  .refine((value) => !value.unarchive || Boolean(value.threadId), {
    message: 'unarchive requires an existing threadId', path: ['unarchive'],
  })
  .refine((value) => !value.threadId || !value.project, {
    message: 'project is only for a new thread; omit threadId', path: ['project'],
  });

export const waitReplySchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
    threadId: threadId.optional(),
    timeoutMs: z.number().int().min(1).max(600_000).default(120_000),
  })
  .strict();

export const resultSchema = z
  .object({
    exitCode: z.union([z.literal(0), z.literal(1)]),
  })
  .catchall(z.json());

export type OperationResult = z.infer<typeof resultSchema>;

// The Desktop has one selected conversation and composer. Keep route calls
// from closing each other's sessions or typing into each other's chats.
let operationQueue: Promise<unknown> = Promise.resolve();

async function withAdapter<T>(
  port: number | undefined,
  run: (adapter: ReturnType<typeof getChatGptDesktopAdapter>) => Promise<T>,
): Promise<T> {
  const operation = operationQueue.then(async () => {
    const adapter = getChatGptDesktopAdapter();
    const resolved = resolveCdpPort(process.env, port);
    try {
      try {
        await adapter.connect({ port: resolved });
      } catch {
        // Reads may still succeed through the app-server.
      }
      return await run(adapter);
    } finally {
      await adapter.close();
    }
  });
  operationQueue = operation.catch(() => {});
  return operation;
}

function asResult(value: object): OperationResult {
  // Match the wire representation, including optional fields nested in turns.
  return resultSchema.parse(JSON.parse(JSON.stringify(value)));
}

function mapError(error: unknown): OperationResult {
  if (error instanceof NotImplementedError) {
    return asResult({
      delivery: 'rejected',
      reason: 'not-implemented',
      code: 'NOT_IMPLEMENTED',
      error: error.message,
      exitCode: 1 as const,
    });
  }
  if (error instanceof RemoteThreadNotLoadedError) {
    return asResult({
      delivery: error.delivery,
      reason: error.reason,
      code: error.code,
      error: error.message,
      threadId: error.threadId,
      hint: error.hint,
      ...(error.hostId ? { hostId: error.hostId } : {}),
      ...(error.hostName ? { hostName: error.hostName } : {}),
      exitCode: 1 as const,
    });
  }
  const base = outcomeFromError(error);
  if (error && typeof error === 'object' && 'code' in error) {
    return asResult({ ...base, code: String((error as { code: unknown }).code) });
  }
  return asResult(base);
}

export async function statusOperation(input: z.infer<typeof statusSchema>): Promise<OperationResult> {
  try {
    const status = await withAdapter(input.port, (adapter) => adapter.status());
    return asResult(status);
  } catch (error) {
    return mapError(error);
  }
}

export async function listThreadsOperation(
  input: z.infer<typeof listThreadsSchema>,
): Promise<OperationResult> {
  try {
    const out = await withAdapter(input.port, (adapter) =>
      adapter.listThreads({
        limit: input.limit,
        cursor: input.cursor,
        host: input.host,
        modelProvider: input.modelProvider,
        project: input.project,
        groupBy: input.groupBy,
      }),
    );
    return asResult({ ...out, exitCode: 0 as const });
  } catch (error) {
    return mapError(error);
  }
}

export async function searchThreadsOperation(
  input: z.infer<typeof searchThreadsSchema>,
): Promise<OperationResult> {
  try {
    const out = await withAdapter(input.port, async (adapter) => {
      if (typeof adapter.searchThreads !== 'function') {
        throw new NotImplementedError('searchThreads', 'adapter does not implement search');
      }
      return adapter.searchThreads({
        query: input.query,
        limit: input.limit,
        cursor: input.cursor,
        host: input.host,
        modelProvider: input.modelProvider,
        project: input.project,
        groupBy: input.groupBy,
      });
    });
    return asResult({ ...out, exitCode: 0 as const });
  } catch (error) {
    return mapError(error);
  }
}

export async function listHostsOperation(
  input: z.infer<typeof listHostsSchema>,
): Promise<OperationResult> {
  try {
    const out = await withAdapter(input.port, async (adapter) => {
      if (typeof adapter.listHosts !== 'function') {
        throw new NotImplementedError('listHosts', 'adapter does not implement listHosts');
      }
      return adapter.listHosts();
    });
    return asResult({ ...out, exitCode: 0 as const });
  } catch (error) {
    return mapError(error);
  }
}

export async function readThreadOperation(
  input: z.infer<typeof readThreadSchema>,
): Promise<OperationResult> {
  try {
    const out = await withAdapter(input.port, (adapter) =>
      adapter.readThread({
        threadId: input.threadId,
        limit: input.limit ?? (input.full ? 2000 : 100),
        full: input.full,
        cursor: input.cursor,
        openTimeoutMs: input.openTimeoutMs,
      }),
    );
    return asResult({ ...out, exitCode: 0 as const });
  } catch (error) {
    return mapError(error);
  }
}

export async function openThreadOperation(input: z.infer<typeof openThreadSchema>): Promise<OperationResult> {
  try {
    const out = await withAdapter(input.port, (adapter) => adapter.openThread(input.threadId, { openTimeoutMs: input.openTimeoutMs }));
    return asResult({ ...out, exitCode: 0 as const });
  } catch (error) {
    return mapError(error);
  }
}

export async function sendOperation(input: z.infer<typeof sendSchema>): Promise<OperationResult> {
  try {
    input = sendSchema.parse(input);
    const out = await withAdapter(input.port, (adapter) =>
      adapter.sendMessage({
        threadId: input.threadId,
        text: input.text,
        project: input.project,
        unarchive: input.unarchive,
        openTimeoutMs: input.openTimeoutMs,
      }),
    );
    return asResult({
      ...out,
      exitCode: out.delivery === 'accepted' ? (0 as const) : (1 as const),
    });
  } catch (error) {
    return mapError(error);
  }
}

export async function waitReplyOperation(
  input: z.infer<typeof waitReplySchema>,
): Promise<OperationResult> {
  try {
    const out = await withAdapter(input.port, (adapter) =>
      adapter.waitForReply({ threadId: input.threadId, timeoutMs: input.timeoutMs }),
    );
    return asResult({
      ...out,
      exitCode: out.delivery === 'replied' ? (0 as const) : (1 as const),
    });
  } catch (error) {
    return mapError(error);
  }
}

export function resultText(result: OperationResult): string {
  if (result.error) return String(result.error);
  if (result.reachable === true) {
    const backend = result.appServerFallback && typeof result.appServerFallback === 'object'
      ? ` cdp + app-server probe`
      : '';
    return result.message ? String(result.message) : `ChatGPT Desktop CDP reachable on 127.0.0.1:${result.port}${backend}`;
  }
  if (result.reachable === false) return String(result.message ?? 'ChatGPT Desktop CDP unreachable');
  if (Array.isArray(result.hosts)) {
    const providers = Array.isArray(result.modelProviders)
      ? ` providers=${result.modelProviders.length} (${String(result.modelProvidersSource ?? '')})`
      : '';
    return `${result.hosts.length} hosts via ${String(result.hostsSource ?? result.backend ?? 'unknown')}${providers}`;
  }
  if (Array.isArray(result.threads)) {
    const via = result.query ? ` matching ${JSON.stringify(result.query)}` : '';
    const host = result.host && result.host !== 'all' ? ` host=${result.host}` : '';
    const provider = result.modelProvider ? ` provider=${result.modelProvider}` : '';
    return `${result.threads.length} threads${via}${host}${provider} via ${result.backend ?? 'unknown'}`;
  }
  if (Array.isArray(result.turns)) {
    const mode = result.full ? 'full' : 'page';
    return `${result.turns.length} turns (${mode}) on ${result.threadId} via ${result.backend ?? 'unknown'}`;
  }
  if (result.delivery === 'accepted') {
    return `Sent on ${result.threadId} via ${result.backend}` +
      (result.conversationId ? ` (conversation ${result.conversationId})` : '');
  }
  if (result.delivery === 'replied') {
    const id = result.conversationId ? ` [${result.conversationId}]` : '';
    return `${String(result.reply ?? 'replied')}${id}`;
  }
  if (result.delivery) return `delivery ${result.delivery}`;
  return JSON.stringify(result);
}
