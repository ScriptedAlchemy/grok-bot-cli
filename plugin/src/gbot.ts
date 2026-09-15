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

const entryFields = z.object({
  id: z.string().default(''),
  kind: z.string().default('message'),
  role: z.string().optional(),
  timestampMs: z.number().optional(),
});

const threadEntry = (raw: unknown): Entry => {
  const fields = entryFields.safeParse(raw);
  if (!fields.success) return { id: '', kind: 'unknown', text: JSON.stringify(raw) };
  const { id, kind, role, timestampMs } = fields.data;
  return {
    id,
    kind,
    ...(role === undefined ? {} : { role }),
    text: entryText(raw),
    ...(timestampMs === undefined ? {} : { timestampMs }),
  };
};

export const transcriptEntries = (transcript: unknown): Entry[] => unwrapEntries(transcript).map(threadEntry);
