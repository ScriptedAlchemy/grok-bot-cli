import { hash, op, records, terminal, MAX_TEXT } from "./records.js";

/** Each target/thread/turn gets one durable return intent, anchored to its associated inputs. */
export function createCompletion({
  state,
  codex,
  update,
  newRecord,
  runnable,
}) {
  let offset = 0;
  async function completions() {
    const groups = new Map();
    for (const r of records(state.read()))
      if (
        r.kind === "codex" &&
        r.submission === "accepted" &&
        r.turnId &&
        !terminal(r) &&
        !["capacity", "hop-limit"].includes(r.reason) &&
        runnable(r)
      ) {
        const key = JSON.stringify([
          r.targetId,
          r.threadId,
          r.turnId,
          r.returnToGrok,
        ]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
    const all = [...groups.values()];
    const selected = Array.from(
      { length: Math.min(20, all.length) },
      (_, i) => all[(offset + i) % all.length],
    );
    offset = all.length ? (offset + selected.length) % all.length : 0;
    for (const group of selected) {
      if (group.length > 200) {
        for (const r of group)
          await update(r.id, { execution: "paused", reason: "capacity" });
        continue;
      }
      const first = group[0];
      let result;
      try {
        result = await codex.wait(first, group);
      } catch {
        continue;
      }
      const execution = result.execution.state;
      if (!["completed", "failed", "interrupted"].includes(execution)) {
        const mapped =
          execution === "waiting-for-input" ? "needs-input" : "pending";
        for (const r of group)
          await update(r.id, {
            execution: mapped,
            reason:
              execution === "unknown"
                ? "reply-coverage-pending"
                : execution === "disconnected"
                  ? "codex-disconnected"
                  : null,
          });
        continue;
      }
      if (
        result.execution.error &&
        /coverage|Invalid|anchor/.test(result.execution.error)
      )
        continue;
      const changes = [];
      let returnId = null;
      if (first.returnToGrok) {
        returnId =
          "return:" + hash([first.targetId, first.threadId, first.turnId]);
        if (!state.read().records[returnId]) {
          if (first.hop + 1 >= first.maxHops || group.length > 200) {
            for (const r of group)
              await update(r.id, {
                execution: "paused",
                reason: group.length > 200 ? "capacity" : "hop-limit",
              });
            continue;
          }
          const sources = group.flatMap((r) => r.sourceIds),
            suffix = result.reply.truncated ? "\n[Output truncated]" : "";
          let output =
            result.reply.text || `Codex turn ${execution} with no final text.`;
          const prefix = `[Codex ${first.threadId}; turn ${first.turnId}; status ${execution}; sources ${sources
            .slice(0, 8)
            .map((id) => id.slice(0, 128))
            .join(
              ", ",
            )}${sources.length > 8 ? " (additional source IDs retained in relay state)" : ""}]\n`;
          // Bound UTF-8 without cutting a code point, and make truncation explicit.
          const budget = MAX_TEXT - Buffer.byteLength(prefix + suffix) - 32;
          let truncated = false;
          while (Buffer.byteLength(output) > budget) {
            output = output
              .slice(0, Math.max(0, output.length - 1024))
              .replace(/[\uD800-\uDBFF]$/, "");
            truncated = true;
          }
          const outgoing = newRecord(
            "grok-return",
            returnId,
            first,
            prefix +
              output +
              suffix +
              (truncated ? "\n[Output truncated]" : ""),
            {
              sourceIds: sources,
              parentId: first.id,
              correlationId: first.correlationId,
              hop: first.hop + 1,
              maxHops: first.maxHops,
            },
          );
          changes.push(op("records", outgoing));
        }
      }
      for (const r of group)
        changes.push(
          op("records", { ...r, execution, reason: null, returnId }),
        );
      await state.commit(changes);
    }
  }
  return completions;
}
