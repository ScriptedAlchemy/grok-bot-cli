import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { connectGateway, getTranscriptTail, sendPrompt } from 'grok-bot-cli/src/gateway.js';
import { historyPath } from 'grok-bot-cli/src/history.js';
import { entryText, transcriptDelta, transcriptEntries as unwrapEntries } from 'grok-bot-cli/src/transcript.js';
import { redactSecrets } from 'grok-bot-cli/src/url-policy.js';

export { connectGateway, getTranscriptTail, sendPrompt, transcriptDelta };

// The same pass `fail()` in src/cli.js applies before printing: MCP hosts show
// the error text, and a fetch or proxy failure can echo a credential.
export const withRedactedErrors = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    const wrapped: Error & { delivery?: string; targetId?: string } = new Error(
      redactSecrets(error instanceof Error ? error.message : String(error)),
    );
    if (error instanceof Error) {
      const src = error as Error & { delivery?: unknown; targetId?: unknown };
      if (typeof src.delivery === 'string') wrapped.delivery = src.delivery;
      if (typeof src.targetId === 'string') wrapped.targetId = src.targetId;
    }
    throw wrapped;
  }
};

export const targetSchema = z.object({
  id: z.string(),
  kind: z.enum(['bot', 'group']),
  name: z.string(),
});

export const summarizeTarget = (record: { id: string; isGroup: boolean; name: string }): z.infer<typeof targetSchema> => ({
  id: record.id,
  kind: record.isGroup ? 'group' : 'bot',
  name: record.name,
});

export const entrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  role: z.string().optional(),
  text: z.string(),
  truncated: z.boolean(),
  fullLength: z.number().int().min(0),
  timestampMs: z.number().optional(),
});
type Entry = z.infer<typeof entrySchema>;

/** Match `gbot thread` CLI preview width so MCP hosts are not flooded. */
export const ENTRY_TEXT_MAX = 400;
// ponytail: fixed preview/full budgets; upgrade path is a paged thread resource instead of wider caps.
// When an entry is cut by these budgets it still reports truncated/fullLength, and the
// remainder is retrievable with `gbot thread --full` / `--json` on the machine.
export const ENTRY_FULL_MAX = 20000;
export const TRANSCRIPT_TOTAL_MAX = 200000;
// Metadata fields are capped too: an uncapped id/kind/role would bypass the total budget.
export const ENTRY_META_MAX = 200;
export const RECEIPT_CURSOR_MAX = 1024;
export const RECEIPT_PATH_MAX = 1024;
export const RECEIPT_SUMMARY_MAX = 256;
export const RECEIPT_MAX_BYTES = 4096;
export const THREAD_ARTIFACT_MAX_BYTES = 256 * 1024;

export const truncateEntryText = (text: string, max = ENTRY_TEXT_MAX): string => {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
};

const entryFields = z.object({
  id: z.string().default(''),
  kind: z.string().default('message'),
  role: z.string().optional(),
  timestampMs: z.number().optional(),
});

const capMeta = (value: string): string => (value.length > ENTRY_META_MAX ? `${value.slice(0, ENTRY_META_MAX)}…` : value);

const threadEntry = (raw: unknown, max: number, ellipsis: boolean): Entry => {
  const fields = entryFields.safeParse(raw);
  const full = entryText(raw);
  const truncated = full.length > max;
  const text = !truncated ? full : ellipsis ? truncateEntryText(full, max) : full.slice(0, max);
  if (!fields.success) {
    return { id: '', kind: 'unknown', text, truncated, fullLength: full.length };
  }
  const { id, kind, role, timestampMs } = fields.data;
  return {
    id: capMeta(id),
    kind: capMeta(kind),
    ...(role === undefined ? {} : { role: capMeta(role) }),
    text,
    truncated,
    fullLength: full.length,
    ...(timestampMs === undefined ? {} : { timestampMs }),
  };
};

const metaLength = (entry: Entry): number => entry.id.length + entry.kind.length + (entry.role?.length ?? 0);

export const transcriptEntries = (transcript: unknown, opts: { full?: boolean; limit?: number } = {}): Entry[] => {
  const rows = unwrapEntries(transcript);
  // Enforce the requested count locally: a gateway ignoring `limit` cannot inflate output.
  const wanted =
    typeof opts.limit === 'number' && Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 200) : rows.length;
  const perEntry = opts.full ? ENTRY_FULL_MAX : ENTRY_TEXT_MAX;
  let remaining = TRANSCRIPT_TOTAL_MAX;
  return rows.slice(0, wanted).map((raw) => {
    const entry = threadEntry(raw, perEntry, !opts.full);
    const allowText = Math.max(0, Math.min(entry.text.length, remaining - metaLength(entry)));
    if (allowText < entry.text.length) {
      entry.text = allowText <= 0 ? '' : !opts.full ? truncateEntryText(entry.text, allowText) : entry.text.slice(0, allowText);
      entry.truncated = entry.fullLength > entry.text.length;
    }
    remaining = Math.max(0, remaining - metaLength(entry) - entry.text.length);
    return entry;
  });
};

const artifactEnabled = (): boolean => /^(on|true|1)$/iu.test(process.env.GROK_BOT_HISTORY ?? '');

const boundedMarkdown = (markdown: string): string => {
  const bytes = Buffer.from(markdown);
  if (bytes.length <= THREAD_ARTIFACT_MAX_BYTES) return markdown;
  const marker = Buffer.from('\n\n[artifact truncated]\n');
  const prefix = bytes.subarray(0, THREAD_ARTIFACT_MAX_BYTES - marker.length).toString('utf8').replace(/\uFFFD$/u, '');
  return `${prefix}${marker.toString('utf8')}`;
};

const renderThreadArtifact = (
  target: z.infer<typeof targetSchema>,
  entries: readonly Entry[],
  cursor: string,
): string => {
  const title = `${target.kind} ${capMeta(target.name)} (${capMeta(target.id)})`;
  const sections = entries.map((entry) => {
    const label = entry.role ?? entry.kind;
    return `## ${label}${entry.id ? ` ${entry.id}` : ''}\n\n${entry.text}`;
  });
  return boundedMarkdown(`# ${title}\n\nCursor: ${cursor}\n\n${sections.join('\n\n')}\n`);
};

export const saveThreadArtifact = (
  target: z.infer<typeof targetSchema>,
  entries: readonly Entry[],
  cursor: string,
  update: boolean,
): string | undefined => {
  if (!artifactEnabled()) return undefined;
  try {
    const root = dirname(historyPath());
    const filename = `${createHash('sha256').update(target.id).digest('hex').slice(0, 24)}.md`;
    const path = join(root, 'thread-artifacts', filename);
    if (Buffer.byteLength(path, 'utf8') > RECEIPT_PATH_MAX) return undefined;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!update && existsSync(path)) {
      const stat = lstatSync(path);
      return stat.isFile() && !stat.isSymbolicLink() ? path : undefined;
    }
    const fd = openSync(path, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, renderThreadArtifact(target, entries, cursor), 'utf8');
    } finally {
      closeSync(fd);
    }
    return path;
  } catch {
    return undefined;
  }
};

export const threadSummary = (
  entryCount: number,
  after: string | undefined,
  gapReset: boolean,
  path: string | undefined,
): string => {
  if (after !== undefined && entryCount === 0 && !gapReset) return '0 new';
  const count = after !== undefined && !gapReset ? `${entryCount} new` : `${entryCount} entries`;
  return `${count}${gapReset ? '; gap reset' : ''}; ${path ? 'document updated' : 'artifact unavailable'}`;
};

export const assertReceiptBudget = (receipt: {
  cursor: string;
  path?: string;
  summary: string;
  [key: string]: unknown;
}): void => {
  if (receipt.cursor.length > RECEIPT_CURSOR_MAX) throw new Error('Thread cursor exceeds 1024 characters');
  if (receipt.summary.length > RECEIPT_SUMMARY_MAX) throw new Error('Thread summary exceeds 256 characters');
  if (receipt.path !== undefined && Buffer.byteLength(receipt.path, 'utf8') > RECEIPT_PATH_MAX) {
    throw new Error('Thread artifact path exceeds 1024 bytes');
  }
  if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > RECEIPT_MAX_BYTES) {
    throw new Error('Thread receipt exceeds 4096 bytes');
  }
};
