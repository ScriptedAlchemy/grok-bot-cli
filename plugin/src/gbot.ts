import { z } from 'zod';

import { connectGateway, getTranscriptTail, sendPrompt } from 'grok-bot-cli/src/gateway.js';
import { entryText, transcriptEntries as unwrapEntries } from 'grok-bot-cli/src/transcript.js';
import { redactSecrets } from 'grok-bot-cli/src/url-policy.js';

export { connectGateway, getTranscriptTail, sendPrompt };

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
    id,
    kind,
    ...(role === undefined ? {} : { role }),
    text,
    truncated,
    fullLength: full.length,
    ...(timestampMs === undefined ? {} : { timestampMs }),
  };
};

export const transcriptEntries = (transcript: unknown, opts: { full?: boolean } = {}): Entry[] => {
  const perEntry = opts.full ? ENTRY_FULL_MAX : ENTRY_TEXT_MAX;
  let remaining = TRANSCRIPT_TOTAL_MAX;
  return unwrapEntries(transcript).map((raw) => {
    const entry = threadEntry(raw, Math.min(perEntry, remaining), !opts.full);
    remaining = Math.max(0, remaining - entry.text.length);
    return entry;
  });
};
