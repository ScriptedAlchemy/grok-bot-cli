import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  openThreadOperation,
  openThreadSchema as inputSchema,
  resultSchema,
  resultText,
} from '../../../core/chatgpt-desktop/routes.js';

export { inputSchema };

export default defineTool(
  {
    title: 'ChatGPT Desktop open thread',
    description:
      'Navigate Desktop to an existing local:<conversationId> or bare conversation id, even when the row is absent from the sidebar. Archived routes return archived:true without unarchiving; read them with chatgpt_desktop_read_thread. A remote-control id is owned by its hostId and cannot be opened on this Mac. CDP_UNREACHABLE means Desktop must be reachable locally.',
    annotations: { readOnlyHint: true },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number', description: 'Local CDP port (default 9222 or CHATGPT_DESKTOP_CDP_PORT).' },
        threadId: { type: 'string', description: 'local:<conversationId> or bare durable id. Temporary local:client-new-thread:* works only while selected; remote ids require their owning host.' },
        openTimeoutMs: { type: 'number', description: 'Maximum time to wait for the requested conversation (1-600000 ms).' },
      },
      required: ['threadId'],
    },
  },
  async (input) => {
    const out = await openThreadOperation(input);
    return (
      <Agent.Result value={out}>
        <Agent.Text>{resultText(out)}</Agent.Text>
      </Agent.Result>
    );
  },
);
