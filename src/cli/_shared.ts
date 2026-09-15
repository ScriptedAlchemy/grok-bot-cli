import { z } from 'zod';

import { openBackend } from '../core/commands.js';
import { AVATAR_COLORS, AVATAR_SHAPES } from '../core/store.js';
import { withRedactedErrors } from '../gbot.js';

/** Shared backend selection flags (were leading globals on the hand CLI). */
export const backendFlagsSchema = z.object({
  dir: z.string().min(1).optional().describe('Agents directory for --files mode'),
  files: z.boolean().optional().describe('Force the on-disk agents store'),
  gateway: z.boolean().optional().describe('Force the live gateway'),
}).strict();

// The framework prints thrown route errors verbatim; a fetch or proxy failure can echo a credential.
const redactBackendErrors = <T extends object>(backend: T): T =>
  new Proxy(backend, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function'
        ? (...args: unknown[]) => withRedactedErrors(() => value.apply(target, args))
        : value;
    },
  });

export const openBackendFromInput = async (input: {
  readonly dir?: string;
  readonly files?: boolean;
  readonly gateway?: boolean;
}) => withRedactedErrors(async () => redactBackendErrors(await openBackend({
  files: Boolean(input.files),
  gateway: Boolean(input.gateway),
  root: input.dir,
})));

export const avatarShapeSchema = z.enum(AVATAR_SHAPES as unknown as [string, ...string[]]);
export const avatarColorSchema = z.enum(AVATAR_COLORS as unknown as [string, ...string[]]);

export const onOffSchema = z.enum(['on', 'off']);

export const parseOnOff = (value: 'on' | 'off'): boolean => value === 'on';

export const agentSummarySchema = z.object({
  avatarColor: z.string().optional(),
  avatarShape: z.string().optional(),
  description: z.string().optional(),
  hiddenFromSidebar: z.boolean().optional(),
  id: z.string(),
  kind: z.enum(['bot', 'group']),
  members: z.array(z.string()).optional(),
  name: z.string(),
  notifyOnAgentUpdates: z.boolean().optional(),
  title: z.string().optional(),
}).strict();

export const createFieldsSchema = z.object({
  avatarColor: avatarColorSchema.optional(),
  avatarShape: avatarShapeSchema.optional(),
  description: z.string().optional(),
  name: z.string().min(1),
  title: z.string().optional(),
}).strict();

export const updateFieldsSchema = z.object({
  avatarColor: avatarColorSchema.optional(),
  avatarShape: avatarShapeSchema.optional(),
  description: z.string().optional(),
  hidden: onOffSchema.optional(),
  name: z.string().min(1).optional(),
  notify: onOffSchema.optional(),
  title: z.string().optional(),
}).strict();

export const toCreateInput = (fields: z.infer<typeof createFieldsSchema>) => ({
  avatarColor: fields.avatarColor ?? '',
  avatarShape: fields.avatarShape ?? '',
  description: fields.description ?? '',
  name: fields.name,
  title: fields.title ?? '',
});

export const toUpdatePatch = (fields: z.infer<typeof updateFieldsSchema>) => {
  const patch: Record<string, unknown> = {};
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.description !== undefined) patch.description = fields.description;
  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.avatarShape !== undefined) patch.avatarShape = fields.avatarShape;
  if (fields.avatarColor !== undefined) patch.avatarColor = fields.avatarColor;
  if (fields.notify !== undefined) patch.notifyOnAgentUpdates = parseOnOff(fields.notify);
  if (fields.hidden !== undefined) patch.hiddenFromSidebar = parseOnOff(fields.hidden);
  if (Object.keys(patch).length === 0) {
    throw new Error(
      'update needs at least one of --name --description --title --avatar-shape --avatar-color --notify --hidden',
    );
  }
  return patch;
};
