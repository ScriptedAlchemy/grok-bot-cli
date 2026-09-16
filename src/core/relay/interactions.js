import { z } from "zod";
const approvals = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
];
const questionMethod = "item/tool/requestUserInput";
const bound = (s) => (typeof s === "string" ? s.slice(0, 4096) : undefined);
const answerSchema = z.strictObject({
  answers: z.record(
    z.string().min(1).max(128),
    z.strictObject({ answers: z.array(z.string().max(4096)).max(10) }),
  ),
});

/** Volatile connection ownership: requests never survive a connection generation. */
export class InteractionRegistry {
  constructor(read) {
    this.read = read;
    this.pending = new Map();
    this.reset(null, null);
  }
  reset(generation, client) {
    this.generation = generation;
    this.client = client;
    this.pending.clear();
    this.sequence = 0;
    this.overflow = false;
  }
  observe(event) {
    if (event.method === "serverRequest/resolved") {
      this.pending.delete(event.params?.requestId);
      return;
    }
    if (event.kind !== "interaction" || !this.generation) return;
    const p = event.params,
      threadId = p?.threadId ?? p?.thread_id,
      turnId = p?.turnId ?? p?.turn_id;
    if (typeof threadId !== "string" || typeof turnId !== "string") return;
    if (this.pending.has(event.id)) return;
    if (this.pending.size >= 100) {
      this.overflow = true;
      return;
    }
    let supported =
      (approvals.includes(event.method) && p.grantRoot == null) ||
      (event.method === questionMethod &&
        Array.isArray(p.questions) &&
        p.questions.length <= 10 &&
        !p.questions.some((q) => q.isSecret));
    let fields = {};
    for (const key of ["reason", "command", "cwd"])
      if (typeof p[key] === "string") fields[key] = bound(p[key]);
    if (Array.isArray(p.availableDecisions))
      fields.availableDecisions = p.availableDecisions.filter((d) =>
        ["accept", "decline", "cancel"].includes(d),
      );
    if (supported && event.method === questionMethod)
      fields.questions = p.questions.map((q) => ({
        id: bound(q.id),
        header: bound(q.header),
        question: bound(q.question),
        options: Array.isArray(q.options)
          ? q.options.slice(0, 10).map((o) => ({
              label: bound(o.label),
              description: bound(o.description),
            }))
          : null,
      }));
    if (Buffer.byteLength(JSON.stringify(fields)) > 8192) {
      fields = {
        reason: "Interaction details exceed relay bounds; use owning Codex UI",
      };
      supported = false;
    }
    this.pending.set(event.id, {
      interactionId: this.generation + ":" + ++this.sequence,
      rpcId: event.id,
      generation: this.generation,
      threadId,
      turnId,
      method: event.method,
      supported,
      ...fields,
    });
  }
  owners(item) {
    return Object.values(this.read().records).filter(
      (r) =>
        r.kind === "codex" &&
        r.threadId === item.threadId &&
        r.turnId === item.turnId &&
        r.submission === "accepted" &&
        (!r.bindingId ||
          this.read().bindings[r.bindingId]?.state === "running"),
    );
  }
  list() {
    return [...this.pending.values()].flatMap(({ rpcId, ...item }) => {
      const owners = this.owners(item);
      return owners.length
        ? [
            {
              ...item,
              exchangeIds: owners.map((r) => r.id),
              bindingIds: [
                ...new Set(owners.map((r) => r.bindingId).filter(Boolean)),
              ],
            },
          ]
        : [];
    });
  }
  respond({
    interactionId,
    generation,
    threadId,
    turnId,
    bindingId,
    exchangeId,
    result,
  }) {
    const item = [...this.pending.values()].find(
      (item) => item.interactionId === interactionId,
    );
    if (
      !item ||
      generation !== this.generation ||
      generation !== item.generation ||
      threadId !== item.threadId ||
      turnId !== item.turnId
    )
      throw new Error("Stale or foreign Codex interaction");
    const owners = this.owners(item);
    if (
      !owners.some(
        (r) =>
          (bindingId || exchangeId) &&
          (!bindingId || r.bindingId === bindingId) &&
          (!exchangeId || r.id === exchangeId),
      )
    )
      throw new Error("Response requires exact binding or exchange ownership");
    if (!item.supported)
      throw new Error("Interaction requires the owning Codex UI");
    let response;
    if (approvals.includes(item.method)) {
      response = z
        .strictObject({ decision: z.enum(["accept", "decline", "cancel"]) })
        .parse(result);
      if (
        item.availableDecisions &&
        !item.availableDecisions.includes(response.decision)
      )
        throw new Error("Decision not offered by Codex");
    } else {
      response = answerSchema.parse(result);
      const ids = item.questions.map((q) => q.id);
      if (
        Object.keys(response.answers).length !== ids.length ||
        !ids.every((id) => Object.hasOwn(response.answers, id))
      )
        throw new Error("Answers must match exact pending question IDs");
    }
    this.pending.delete(item.rpcId);
    this.client.respond(item.rpcId, response);
    return { resolved: true, interactionId, generation };
  }
}
