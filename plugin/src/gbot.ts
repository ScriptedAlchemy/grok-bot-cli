import { z } from 'zod';

import { connectGateway, getTranscriptTail, sendPrompt } from 'grok-bot-cli/src/gateway.js';
import { redactSecrets } from 'grok-bot-cli/src/url-policy.js';

export { connectGateway, getTranscriptTail, sendPrompt };

// The same pass `fail()` in src/cli.js applies before printing: MCP hosts show
// the error text, and a fetch or proxy failure can echo a credential.
export const withRedactedErrors = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
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
  timestampMs: z.number().optional(),
});
type Entry = z.infer<typeof entrySchema>;

// The live gateway puts a user message's text on `content` and a bot reply's
// on `message.content`; the other keys and containers are the ones the CLI's
// formatTranscript also accepts.
const rawEntrySchema = z.object({
  content: z.union([z.string(), z.array(z.union([z.string(), z.object({ text: z.string().optional() })]))]).optional(),
  id: z.string().default(''),
  kind: z.string().default('message'),
  message: z.union([z.string(), z.object({ content: z.string().optional() })]).optional(),
  preview: z.string().optional(),
  prompt: z.string().optional(),
  role: z.string().optional(),
  text: z.string().optional(),
  timestampMs: z.number().optional(),
});

const entryText = (raw: z.infer<typeof rawEntrySchema>): string => {
  if (typeof raw.content === 'string') return raw.content;
  if (Array.isArray(raw.content)) {
    return raw.content.map((part) => (typeof part === 'string' ? part : part.text ?? '')).filter(Boolean).join('\n');
  }
  return raw.text ?? raw.prompt ?? raw.preview ?? (typeof raw.message === 'string' ? raw.message : raw.message?.content) ?? '';
};

const threadEntry = (raw: unknown): Entry => {
  const parsed = rawEntrySchema.safeParse(raw);
  if (!parsed.success) return { id: '', kind: 'unknown', text: JSON.stringify(raw) };
  const { id, kind, role, timestampMs } = parsed.data;
  return {
    id,
    kind,
    ...(role === undefined ? {} : { role }),
    text: entryText(parsed.data),
    ...(timestampMs === undefined ? {} : { timestampMs }),
  };
};

const transcriptSchema = z.union([
  z.array(z.unknown()),
  z.object({ entries: z.array(z.unknown()) }).transform((tail) => tail.entries),
  z.object({ messages: z.array(z.unknown()) }).transform((tail) => tail.messages),
  z.object({ items: z.array(z.unknown()) }).transform((tail) => tail.items),
]);

export const transcriptEntries = (transcript: unknown): Entry[] => {
  const entries = transcriptSchema.safeParse(transcript);
  return entries.success ? entries.data.map(threadEntry) : [];
};
