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
      'Probe the local ChatGPT Desktop Chrome DevTools endpoint on 127.0.0.1 (no remote transport). Reports CDP reachability and whether the Codex app-server fallback is available. From the Grok Bot box, run gbot on the user machine via Grok Bot Shell with a machineId.',
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
