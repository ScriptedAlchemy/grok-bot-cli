import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  resultSchema,
  resultText,
  statusOperation,
  statusSchema as inputSchema,
} from '../../../core/chatgpt-desktop/routes.js';

export { inputSchema };

export default defineTool(
  {
    title: 'ChatGPT Desktop status',
    description:
      'Check local ChatGPT Desktop CDP before send, wait, or open. reachable:false and exitCode:1 mean CDP is down even if appServerFallback.reachable is true; list/search/read may still work through app-server. There is no remote CDP transport.',
    annotations: { readOnlyHint: true },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: {
          type: 'number',
          description: 'Local CDP port (default 9222 or CHATGPT_DESKTOP_CDP_PORT).',
        },
      },
      required: [],
    },
  },
  async (input) => {
    const out = await statusOperation(input);
    return (
      <Agent.Result value={out}>
        <Agent.Text>{resultText(out)}</Agent.Text>
      </Agent.Result>
    );
  },
);
