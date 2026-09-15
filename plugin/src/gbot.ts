import { z } from 'zod';

import { connectGateway, getTranscriptTail, sendPrompt } from 'grok-bot-cli/src/gateway.js';

export { connectGateway, getTranscriptTail, sendPrompt };

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

// The gateway puts a user message's text on `content` and a bot reply's text
// on `message.content`; every other entry kind is kept with empty text.
const rawEntrySchema = z.object({
  content: z.string().optional(),
  id: z.string().default(''),
  kind: z.string().default('message'),
  message: z.object({ content: z.string().optional() }).optional(),
  role: z.string().optional(),
  timestampMs: z.number().optional(),
});

const threadEntry = (raw: unknown): Entry => {
  const parsed = rawEntrySchema.safeParse(raw);
  if (!parsed.success) return { id: '', kind: 'unknown', text: JSON.stringify(raw) };
  const { content, id, kind, message, role, timestampMs } = parsed.data;
  return {
    id,
    kind,
    ...(role === undefined ? {} : { role }),
    text: content ?? message?.content ?? '',
    ...(timestampMs === undefined ? {} : { timestampMs }),
  };
};

export const transcriptEntries = (transcript: unknown): Entry[] => {
  const tail = z.object({ entries: z.array(z.unknown()).default([]) }).safeParse(transcript);
  return tail.success ? tail.data.entries.map(threadEntry) : [];
};
