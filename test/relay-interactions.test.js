import assert from "node:assert/strict";
import test from "node:test";
import { InteractionRegistry } from "../src/core/relay/interactions.js";
function fixture() {
  const replies = [],
    state = {
      bindings: { binding: { state: "running" } },
      records: {
        own: {
          id: "own",
          kind: "codex",
          threadId: "thread",
          turnId: "turn",
          submission: "accepted",
          bindingId: "binding",
        },
      },
    };
  const i = new InteractionRegistry(() => state);
  i.reset("gen", { respond: (...args) => replies.push(args) });
  return { i, replies };
}
const event = (method, params = {}) => ({
  kind: "interaction",
  id: "ask",
  method,
  params: { threadId: "thread", turnId: "turn", ...params },
});
const response = (result) => ({
  interactionId: "gen:1",
  generation: "gen",
  threadId: "thread",
  turnId: "turn",
  bindingId: "binding",
  result,
});
test("strict response ownership, offered one-time decisions and consumed identity", () => {
  const { i, replies } = fixture();
  i.observe(
    event("item/commandExecution/requestApproval", {
      availableDecisions: ["decline"],
    }),
  );
  for (const input of [
    { ...response({ decision: "decline" }), threadId: "foreign" },
    { ...response({ decision: "decline" }), generation: "old" },
    { ...response({ decision: "decline" }), bindingId: "foreign" },
    response({ decision: "acceptForSession" }),
    response({ decision: "accept" }),
  ])
    assert.throws(() => i.respond(input));
  assert.equal(replies.length, 0);
  i.respond(response({ decision: "decline" }));
  assert.equal(replies.length, 1);
  assert.throws(() => i.respond(response({ decision: "decline" })));
});
test("questions require exact IDs, resolution and disconnect invalidate ownership", () => {
  const { i, replies } = fixture();
  i.observe(
    event("item/tool/requestUserInput", {
      questions: [
        { id: "q", question: "choose", header: "Choice", isSecret: false },
      ],
    }),
  );
  assert.throws(() =>
    i.respond(response({ answers: { wrong: { answers: ["yes"] } } })),
  );
  i.respond(response({ answers: { q: { answers: ["yes"] } } }));
  assert.equal(replies.length, 1);
  i.observe(event("item/commandExecution/requestApproval"));
  i.observe({ method: "serverRequest/resolved", params: { requestId: "ask" } });
  assert.throws(() => i.respond(response({ decision: "accept" })));
  i.observe(event("item/commandExecution/requestApproval"));
  i.reset("next", {});
  assert.equal(i.list().length, 0);
});
test("file grantRoot and secret questions remain visible but require owning UI", () => {
  const { i } = fixture();
  i.observe(event("item/fileChange/requestApproval", { grantRoot: "/" }));
  assert.equal(i.list()[0].supported, false);
  assert.throws(
    () => i.respond(response({ decision: "accept" })),
    /owning Codex UI/,
  );
  i.observe(
    event("item/tool/requestUserInput", {
      questions: [{ id: "secret", isSecret: true, question: "token" }],
    }),
  );
  assert.equal(i.list()[0].supported, false);
  assert.equal(i.list()[0].questions, undefined);
});

test("binding and exchange scopes must both match when supplied", () => {
  const { i } = fixture();
  i.observe(event("item/commandExecution/requestApproval"));
  assert.throws(
    () =>
      i.respond({ ...response({ decision: "accept" }), exchangeId: "foreign" }),
    /ownership/,
  );
});

test("stopped binding cannot answer an old pending interaction", () => {
  const state = {
    bindings: { binding: { state: "stopped" } },
    records: {
      own: {
        id: "own",
        kind: "codex",
        threadId: "thread",
        turnId: "turn",
        bindingId: "binding",
        submission: "accepted",
      },
    },
  };
  const i = new InteractionRegistry(() => state);
  i.reset("gen", {
    respond() {
      assert.fail("must not send");
    },
  });
  i.observe(event("item/commandExecution/requestApproval"));
  assert.equal(i.list().length, 0);
  assert.throws(() => i.respond(response({ decision: "accept" })), /ownership/);
});

test("a reused upstream request ID cannot revive a resolved operator response", () => {
  const { i } = fixture();
  i.observe(event("item/commandExecution/requestApproval"));
  const old = i.list()[0].interactionId;
  i.observe({ method: "serverRequest/resolved", params: { requestId: "ask" } });
  i.observe(event("item/commandExecution/requestApproval"));
  assert.notEqual(i.list()[0].interactionId, old);
});
