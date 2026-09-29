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
    /** `all` (default) | `local` | hostId / friendly name. */
    host: z.string().min(1).max(256).optional(),
    /** Passed through to app-server `modelProviders` (omit = all). */
    modelProvider: z.string().min(1).max(256).optional(),
    groupBy: z.literal('host').optional(),
  })
  .strict();

export const searchThreadsSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
    query: z.string().min(1).max(512),
    limit: z.number().int().min(1).max(200).default(50),
    host: z.string().min(1).max(256).optional(),
    modelProvider: z.string().min(1).max(256).optional(),
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
    limit: z.number().int().min(1).max(2000).default(100),
    full: z.boolean().default(false),
    openTimeoutMs: z.number().int().min(1).max(600_000).default(90_000),
  })
  .strict();

export const sendSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
    threadId: threadId.optional(),
    text: z.string().min(1).max(100_000),
    project: z.string().min(1).max(256).optional(),
    openTimeoutMs: z.number().int().min(1).max(600_000).default(90_000),
  })
  .strict();

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

async function withAdapter<T>(
  port: number | undefined,
  run: (adapter: ReturnType<typeof getChatGptDesktopAdapter>) => Promise<T>,
): Promise<T> {
  const adapter = getChatGptDesktopAdapter();
  const resolved = resolveCdpPort(process.env, port);
  try {
    await adapter.connect({ port: resolved });
  } catch {
    // status/list/search/read may still succeed via HTTP probe or app-server.
  }
  return run(adapter);
}

function asResult(value: object): OperationResult {
  const cleaned = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
  return resultSchema.parse(cleaned);
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
        host: input.host,
        modelProvider: input.modelProvider,
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
        host: input.host,
        modelProvider: input.modelProvider,
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
        limit: input.limit,
        full: input.full,
        openTimeoutMs: input.openTimeoutMs,
      }),
    );
    return asResult({ ...out, exitCode: 0 as const });
  } catch (error) {
    return mapError(error);
  }
}

export async function sendOperation(input: z.infer<typeof sendSchema>): Promise<OperationResult> {
  try {
    const out = await withAdapter(input.port, (adapter) =>
      adapter.sendMessage({
        threadId: input.threadId,
        text: input.text,
        project: input.project,
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
    return `ChatGPT Desktop CDP reachable on 127.0.0.1:${result.port}${backend}`;
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
