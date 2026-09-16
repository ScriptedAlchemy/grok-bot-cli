import { lineageHostFromClient } from "@agent-bundle/runtime";
import { agent } from "@agent-bundle/runtime";
type AgentRequest = Awaited<ReturnType<typeof agent>>;
import { z } from "zod";
import { managedOperation } from "./managed.js";
import {
  connectGateway,
  sendPrompt,
  summarizeTarget,
  withRedactedErrors,
} from "../../gbot.js";

import { buildEnvelope, withEnvelopeHeader } from "../codex-bridge.js";

const id = z.string().min(1).max(128);
export const routeFields = {
  codexThreadId: id.optional(),
  expectedCwd: z.string().min(1).max(4096).optional(),
  bindingId: z.string().min(1).max(512).optional(),
  requestId: id.optional(),
};
export const grokSendSchema = z
  .object({
    target: z.string().min(1),
    message: z.string().min(1),
    replyMode: z.enum(["auto", "manual"]).optional(),
    hop: z.number().int().min(0).optional(),
    correlationId: id.optional(),
    ...routeFields,
  })
  .strict();
export const bridgeStartSchema = z
  .object({
    grokTarget: z.string().min(1),
    codexThreadId: id.optional(),
    expectedCwd: z.string().min(1).max(4096).optional(),
    busyPolicy: z.enum(["steer", "reject"]).optional(),
    requestId: id.optional(),
  })
  .strict();
export const bridgeStatusSchema = z
  .object({
    bindingId: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export const bridgeStopSchema = z
  .object({
    bindingId: z.string().min(1).max(512).optional(),
    all: z.boolean().optional(),
    worker: z.boolean().optional(),
  })
  .strict()
  .refine(
    (x) => !!x.bindingId || x.all === true || x.worker === true,
    "Specify bindingId, all or worker",
  );
export const respondSchema = z
  .object({
    interactionId: z.string().min(1).max(512),
    generation: id,
    threadId: id,
    turnId: id,
    bindingId: z.string().min(1).max(512).optional(),
    exchangeId: z.string().min(1).max(512).optional(),
    decision: z.enum(["accept", "decline", "cancel"]).optional(),
    answersJson: z.string().min(2).max(65536).optional(),
  })
  .strict()
  .refine(
    (x) => !!x.bindingId || !!x.exchangeId,
    "Binding or exchange scope required",
  )
  .refine(
    (x) => !!x.decision !== !!x.answersJson,
    "Supply decision or answersJson",
  );
const answersSchema = z.record(
  z.string().min(1).max(128),
  z.object({ answers: z.array(z.string().max(8192)).max(20) }).strict(),
);
export const relayResultSchema = z.record(z.string(), z.json());
export function nativeCodexThread(context: AgentRequest) {
  return context.host.state === "available" &&
    lineageHostFromClient(context.host.value.name) === "codex" &&
    context.lineage.state === "available" &&
    context.lineage.source === "native" &&
    context.lineage.value.resolution === "native"
    ? context.lineage.value.conversation
    : undefined;
}
function options(context?: AgentRequest) {
  return {
    pluginRoot:
      context?.plugin.state === "available"
        ? context.plugin.value.root
        : undefined,
    signal: context?.signal,
  };
}
function destination(
  input: { codexThreadId?: string; expectedCwd?: string },
  context?: AgentRequest,
) {
  const codexThreadId =
    input.codexThreadId ?? (context ? nativeCodexThread(context) : undefined);
  // Native workspace evidence belongs to the invocation, not the plugin installation directory.
  const workspace = context?.workspace;
  const expectedCwd =
    input.expectedCwd ??
    (workspace?.state === "available" && workspace.source === "native"
      ? workspace.value.root
      : undefined);
  return { codexThreadId, expectedCwd };
}
export async function grokSendOperation(
  input: z.infer<typeof grokSendSchema>,
  context?: AgentRequest,
) {
  const route = destination(input, input.bindingId ? undefined : context);
  if (input.replyMode !== "manual" && (input.bindingId || route.codexThreadId))
    return withRedactedErrors(() =>
      managedOperation(
        "sendToGrok",
        {
          grokTarget: input.target,
          message: input.message,
          hop: input.hop,
          correlationId: input.correlationId,
          ...route,
          ...(input.bindingId ? { bindingId: input.bindingId } : {}),
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        options(context),
      ),
    );
  if (input.replyMode === "auto")
    throw Error(
      "Automatic reply delivery requires a native Codex source, codexThreadId or bindingId",
    );
  const message =
    input.hop !== undefined || input.correlationId !== undefined
      ? withEnvelopeHeader(input.message, buildEnvelope(input))
      : input.message;
  const sent = await withRedactedErrors(async () =>
    sendPrompt(await connectGateway(), input.target, message),
  );
  return {
    result: sent.result,
    target: summarizeTarget(sent.target),
    delivery: sent.delivery === "accepted" ? "accepted" : "unknown",
    ...(sent.delivery === "accepted" && typeof sent.messageId === "string"
      ? { messageId: sent.messageId }
      : {}),
    replyRoute: {
      mode: "manual",
      reason: input.replyMode === "manual" ? "requested" : "source-unavailable",
    },
  };
}
export async function bridgeOperation(
  method: "startBinding" | "status" | "stop" | "respond",
  input: Record<string, unknown>,
  context?: AgentRequest,
) {
  let routed: Record<string, unknown> =
    method === "startBinding"
      ? { ...input, ...destination(input, context) }
      : input;
  if (method === "respond") {
    const { decision, answersJson, ...scope } = respondSchema.parse(input);
    routed = {
      ...scope,
      result: decision
        ? { decision }
        : { answers: answersSchema.parse(JSON.parse(answersJson!)) },
    };
  }
  if (method === "startBinding" && !routed.codexThreadId)
    throw Error(
      "Specify codexThreadId when native Codex source identity is unavailable",
    );
  return withRedactedErrors(() =>
    managedOperation(method, routed, options(context)),
  );
}
export async function codexReturnOperation(
  input: {
    threadId: string;
    message: string;
    replyToGrok?: string;
    bindingId?: string;
    expectedCwd?: string;
    requestId?: string;
    whenBusy?: string;
    hop?: number;
    correlationId?: string;
  },
  context?: AgentRequest,
) {
  if (input.whenBusy === "queue")
    throw Error(
      "Managed relay supports steer or reject, not experimental queue",
    );
  return withRedactedErrors(() =>
    managedOperation(
      "sendToCodex",
      {
        grokTarget: input.replyToGrok,
        codexThreadId: input.threadId,
        expectedCwd: input.expectedCwd,
        bindingId: input.bindingId,
        message: input.message,
        requestId: input.requestId,
        busyPolicy: input.whenBusy ?? "steer",
        hop: input.hop,
        correlationId: input.correlationId,
      },
      options(context),
    ),
  );
}
