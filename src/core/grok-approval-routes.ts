import { z } from 'zod';
import { connectGateway, listGrokApprovals, respondGrokApproval } from './gateway.js';
import { grokApprovalResponseSchema } from './grok-approvals.js';
import { withRedactedErrors } from '../gbot.js';

export const listSchema = z.strictObject({ target: z.string().min(1).max(1024) });
export const respondSchema = grokApprovalResponseSchema;
export const resultSchema = z.record(z.string(), z.json());
export const listOperation = (input: z.infer<typeof listSchema>) => withRedactedErrors(async () =>
  listGrokApprovals(await connectGateway(), listSchema.parse(input).target));
export const respondOperation = (input: z.infer<typeof respondSchema>) => withRedactedErrors(async () => {
  const { target, ...response } = respondSchema.parse(input);
  return respondGrokApproval(await connectGateway(), target, response);
});
