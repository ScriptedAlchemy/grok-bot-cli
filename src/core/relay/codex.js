import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openCodexSession } from "../codex-bridge.js";
import {
  openCodexConversation,
  visitCodexHistory,
} from "../codex/conversation.js";
import { InteractionRegistry } from "./interactions.js";

/** One initialized endpoint generation, with conversation-scoped subscriptions. */
export function createRelayCodex({
  env,
  read,
  signal,
  clock = Date.now,
  openSession = openCodexSession,
  openConversation = openCodexConversation,
}) {
  let session,
    opening,
    generation = null,
    failures = 0,
    nextConnect = 0;
  const conversations = new Map();
  const interactions = new InteractionRegistry(read);
  async function connect() {
    if (session && !session.client.closed) return session;
    if (opening) return opening;
    if (clock() < nextConnect) throw new Error("Codex reconnect backoff");
    opening = (async () => {
      for (const c of conversations.values()) await c.close();
      conversations.clear();
      try {
        session = await openSession(env, { signal });
      } catch (error) {
        nextConnect =
          clock() + Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
        throw error;
      }
      failures = 0;
      nextConnect = 0;
      generation = randomUUID();
      interactions.reset(generation, session.client);
      const connected = session;
      session.client.onClose(() => {
        if (session !== connected) return;
        interactions.reset(null, null);
        nextConnect = clock() + 1000;
      });
      return session;
    })();
    try {
      return await opening;
    } finally {
      opening = null;
    }
  }
  async function conversation(route) {
    const s = await connect(),
      key = JSON.stringify([route.threadId, route.expectedCwd ?? null]);
    if (!conversations.has(key))
      conversations.set(
        key,
        await openConversation(route.threadId, {
          env,
          expectedCwd: route.expectedCwd ?? undefined,
          session: s,
          signal,
          onEvent: (event) => interactions.observe(event),
        }),
      );
    return conversations.get(key);
  }
  return {
    get connection() {
      return {
        state:
          session && !session.client.closed
            ? "connected"
            : nextConnect > clock()
              ? "backoff"
              : "disconnected",
        nextConnect,
      };
    },
    async prepare(record) {
      await conversation(record);
    },
    get generation() {
      return session?.client.closed ? null : generation;
    },
    interactions,
    async verify({ threadId, expectedCwd }) {
      const c = await conversation({ threadId, expectedCwd });
      return { threadId, cwd: realpathSync(c.cwd) };
    },
    async send(record, { signal: deliverySignal } = {}) {
      const submissionSignal =
        signal && deliverySignal
          ? AbortSignal.any([signal, deliverySignal])
          : (deliverySignal ?? signal);
      const cancelled = () => ({
        delivery: "rejected",
        reason: "cancelled",
        threadId: record.threadId,
        messageId: record.clientId,
      });
      let c, s;
      try {
        c = await conversation(record);
        s = await connect();
      } catch (error) {
        if (submissionSignal?.aborted) return cancelled();
        throw error;
      }
      let receipt;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (submissionSignal?.aborted) return cancelled();
        let active = null;
        if (record.busyPolicy === "steer") {
          try {
            await visitCodexHistory(
              s,
              record.threadId,
              "thread/turns/list",
              {},
              (rows) => {
                for (const turn of rows) {
                  if (
                    !turn ||
                    typeof turn.id !== "string" ||
                    typeof turn.status !== "string"
                  )
                    throw new Error("Invalid turn history");
                  if (turn.status === "inProgress") {
                    active = turn.id;
                    return true;
                  }
                }
                return false;
              },
              { signal: submissionSignal },
            );
          } catch (error) {
            if (submissionSignal?.aborted) return cancelled();
            throw error;
          }
        }
        if (submissionSignal?.aborted) return cancelled();
        // Once a steer guard is rejected, retry only another observed guarded steer.
        if (attempt && !active) return receipt;
        receipt = await c.send(record.text, {
          signal: submissionSignal,
          envelope: {
            messageId: record.clientId,
            correlationId: record.correlationId,
            hop: record.hop,
            maxHops: record.maxHops,
            header: false,
          },
          whenBusy: active ? "steer" : "reject",
          ...(active ? { expectedTurnId: active } : {}),
        });
        if (
          !active ||
          receipt.delivery !== "rejected" ||
          receipt.reason !== "rejected" ||
          !/guard|expected.*turn|turn.*mismatch|stale/i.test(
            receipt.error ?? "",
          )
        )
          return receipt;
      }
      return receipt;
    },
    async reconcile(record) {
      await conversation(record);
      const s = await connect();
      let found;
      await visitCodexHistory(
        s,
        record.threadId,
        "thread/items/list",
        { sortDirection: "asc" },
        (rows) => {
          for (const row of rows) {
            if (
              typeof row?.turnId !== "string" ||
              typeof row?.item?.type !== "string"
            )
              throw new Error("Invalid item history wrapper");
            if (
              row.item.type === "userMessage" &&
              row.item.clientId === record.clientId
            ) {
              found = {
                delivery: "accepted",
                turnId: row.turnId,
                messageId: record.clientId,
              };
              return true;
            }
          }
          return false;
        },
        { signal },
      );
      return found;
    },
    async wait(record, group = [record]) {
      const c = await conversation(record);
      return c.wait({
        turnId: record.turnId,
        afterMessageId: group.map((r) => r.clientId),
        timeoutMs: 2000,
        maxOutputBytes: 65536,
        signal,
      });
    },
    async close() {
      for (const c of conversations.values()) await c.close();
      conversations.clear();
      const previous = session;
      session = null;
      generation = null;
      nextConnect = 0;
      previous?.client.close();
      interactions.reset(null, null);
    },
  };
}
