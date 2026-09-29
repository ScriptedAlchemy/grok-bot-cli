import { z } from 'zod';

import { outcomeFromError } from '../codex/contract.js';
import { NotImplementedError } from './errors.js';
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
    // status/list may still succeed via HTTP probe or app-server list/deep-read.
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
      adapter.listThreads({ limit: input.limit }),
    );
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
  if (Array.isArray(result.threads)) {
    return `${result.threads.length} threads via ${result.backend ?? 'unknown'}`;
  }
  if (Array.isArray(result.turns)) {
    const mode = result.full ? 'full' : 'visible';
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
