import { z } from 'zod';

import { connectGateway, getTranscriptTail, sendPrompt } from './core/gateway.js';
import { entryText, transcriptDelta, transcriptEntries as unwrapEntries } from './core/transcript.js';
import { redactSecrets } from './core/url-policy.js';

export { connectGateway, getTranscriptTail, sendPrompt, transcriptDelta };

// Hosts and the CLI print thrown error text (and stack), and a fetch or proxy failure can echo
// a credential. Rewrap with a redacted message; keep `name` and own fields such as `reason`,
// `delivery`, `mode`, and correlation ids so outcome documents still classify the failure.
export const withRedactedErrors = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    const wrapped = new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
    if (error instanceof Error) Object.assign(wrapped, error, { name: error.name });
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

export const ENTRY_FULL_MAX = 20000;
export const TRANSCRIPT_TOTAL_MAX = 200000;
// Metadata fields are capped too: an uncapped id/kind/role would bypass the total budget.
export const ENTRY_META_MAX = 200;
export const RECEIPT_CURSOR_MAX = 1024;

const entryFields = z.object({
  id: z.string().default(''),
  kind: z.string().default('message'),
  role: z.string().optional(),
  timestampMs: z.number().optional(),
});

const capMeta = (value: string): string => (value.length > ENTRY_META_MAX ? `${value.slice(0, ENTRY_META_MAX)}…` : value);

const threadEntry = (raw: unknown): Entry => {
  const fields = entryFields.safeParse(raw);
  const full = entryText(raw);
  const truncated = full.length > ENTRY_FULL_MAX;
  const text = truncated ? full.slice(0, ENTRY_FULL_MAX) : full;
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

export const transcriptEntries = (transcript: unknown): Entry[] => {
  const rows = unwrapEntries(transcript);
  let remaining = TRANSCRIPT_TOTAL_MAX;
  return rows.map((raw: unknown) => {
    const entry = threadEntry(raw);
    const allowText = Math.max(0, Math.min(entry.text.length, remaining - metaLength(entry)));
    if (allowText < entry.text.length) {
      entry.text = allowText <= 0 ? '' : entry.text.slice(0, allowText);
      entry.truncated = entry.fullLength > entry.text.length;
    }
    remaining = Math.max(0, remaining - metaLength(entry) - entry.text.length);
    return entry;
  });
};
