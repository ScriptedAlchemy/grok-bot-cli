import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { z } from 'zod';

import { connectGateway, sendPrompt, summarizeTarget, targetSchema } from '../../../gbot.js';

export default defineTool(
  {
    description:
      'Send a message to a Grok Bot bot or group by name or id (the same as `gbot send`). The bot answers asynchronously; read its reply later with gbot_thread.',
    inputJsonSchema: {
      additionalProperties: false,
      properties: {
        message: { description: 'Message text. Say who you are and what you need in the first line.', type: 'string' },
        target: { description: 'Bot or group name or id, for example "General".', type: 'string' },
      },
      required: ['target', 'message'],
      type: 'object',
    },
    inputSchema: z.object({ message: z.string().min(1), target: z.string().min(1) }),
    resultSchema: z.object({ result: z.record(z.string(), z.json()), target: targetSchema }),
    title: 'Send a message to Grok Bot',
  },
  async ({ message, target }) => {
    const sent = await sendPrompt(await connectGateway(), target, message);
    const value = { result: sent.result, target: summarizeTarget(sent.target) };
    return (
      <Agent.Result value={value}>
        <Agent.Text>
          {`Sent to ${value.target.kind} ${value.target.name} (${value.target.id}). Read the reply with gbot_thread.`}
        </Agent.Text>
      </Agent.Result>
    );
  },
);
