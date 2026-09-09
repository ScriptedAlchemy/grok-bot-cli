import assert from "node:assert/strict";
import test from "node:test";

import { entryText, normalizeTranscript } from "../src/transcript.js";

test("reads actual nested send-message and user entry content", () => {
  assert.equal(entryText({
    kind: "send-message",
    message: { type: "assistant", content: "nested assistant text" },
  }), "nested assistant text");
  assert.equal(entryText({
    kind: "user",
    message: { type: "user", content: "nested user text" },
  }), "nested user text");
});

test("reads nested message text and content parts", () => {
  assert.equal(entryText({ message: { text: "nested text" } }), "nested text");
  assert.equal(entryText({
    message: {
      content: ["first", { text: "second" }, { content: "third" }],
    },
  }), "first\nsecond\nthird");
});

test("preserves existing direct and content formats", () => {
  assert.equal(entryText({ text: "direct" }), "direct");
  assert.equal(entryText({ prompt: "prompt" }), "prompt");
  assert.equal(entryText({ message: "message" }), "message");
  assert.equal(entryText({ preview: "preview" }), "preview");
  assert.equal(entryText({ content: "content" }), "content");
  assert.equal(entryText({ content: ["one", { text: "two" }] }), "one\ntwo");
  assert.equal(entryText({ content: { text: "object text" } }), "object text");
  assert.equal(entryText({ content: { type: "image" } }), '{"type":"image"}');
});

test("normalizes actual nested transcript schema with exact text", () => {
  const normalized = normalizeTranscript({
    target: { id: "bot-1", name: "研究員", isGroup: false },
    transcript: {
      entries: [
        {
          id: "message-1",
          kind: "send-message",
          message: { type: "assistant", content: "第一行\n第二行" },
        },
        {
          messageId: "message-2",
          role: "user",
          message: { content: "請繼續" },
        },
      ],
    },
  });

  assert.deepEqual(normalized, {
    target: { id: "bot-1", name: "研究員", kind: "bot" },
    messages: [
      { id: "message-1", role: "assistant", text: "第一行\n第二行" },
      { id: "message-2", role: "user", text: "請繼續" },
    ],
  });
});

test("normalizer only accepts explicit user and assistant roles", () => {
  const normalized = normalizeTranscript({
    target: { id: "group-1", name: "Launch", isGroup: true },
    thread: {
      messages: [
        { id: "1", kind: "send-message", text: "looks sent by user" },
        { id: "2", type: "assistant", text: "answer" },
        { id: "3", message: { role: "user", text: "question" } },
        { id: "4", role: "system", text: "system text" },
      ],
    },
  });

  assert.deepEqual(normalized, {
    target: { id: "group-1", name: "Launch", kind: "group" },
    messages: [
      { id: "1", role: "unknown", text: "looks sent by user" },
      { id: "2", role: "assistant", text: "answer" },
      { id: "3", role: "user", text: "question" },
      { id: "4", role: "unknown", text: "system text" },
    ],
  });
});

test("normalizer marks conflicting explicit roles unknown", () => {
  const normalized = normalizeTranscript({
    target: { id: "bot-1", name: "Bot", isGroup: false },
    transcript: {
      entries: [{
        id: "1",
        role: "assistant",
        message: { type: "user", content: "conflicting echo" },
      }],
    },
  });

  assert.equal(normalized.messages[0].role, "unknown");
});

test("normalizer recognizes explicit sender role", () => {
  const normalized = normalizeTranscript({
    target: { id: "bot-1", name: "Bot", isGroup: false },
    transcript: {
      entries: [
        { id: "1", sender: "user", text: "hello from sender" },
        { id: "2", sender: "assistant", text: "reply from sender" },
      ],
    },
  });
  assert.equal(normalized.messages[0].role, "user");
  assert.equal(normalized.messages[1].role, "assistant");
});

test("normalizer marks conflicting sender and role as unknown", () => {
  const normalized = normalizeTranscript({
    target: { id: "bot-1", name: "Bot", isGroup: false },
    transcript: {
      entries: [{ id: "1", role: "assistant", sender: "user", text: "conflict" }],
    },
  });
  assert.equal(normalized.messages[0].role, "unknown");
});

test("unsupported explicit role vetoes inference from nested carrier", () => {
  const normalized = normalizeTranscript({
    target: { id: "bot-1", name: "Bot", isGroup: false },
    transcript: {
      entries: [{ id: "1", role: "system", message: { type: "assistant", content: "system says hi" } }],
    },
  });
  assert.equal(normalized.messages[0].role, "unknown");
});

test("loose carrier kind does not veto nested role inference", () => {
  const normalized = normalizeTranscript({
    target: { id: "bot-1", name: "Bot", isGroup: false },
    transcript: {
      entries: [{ id: "1", kind: "send-message", message: { type: "assistant", content: "reply" } }],
    },
  });
  assert.equal(normalized.messages[0].role, "assistant");
});

test("malformed non-string strict role carrier vetoes inference", () => {
  for (const role of [42, true, {}]) {
    const normalized = normalizeTranscript({
      target: { id: "bot-1", name: "Bot", isGroup: false },
      transcript: {
        entries: [{ id: "1", role, message: { type: "assistant", content: "hello" } }],
      },
    });
    assert.equal(normalized.messages[0].role, "unknown",
      `role: ${JSON.stringify(role)} should veto assistant inference`);
  }
});

test("normalizer rejects conflicting text evidence without changing display formatting", () => {
  const target = { id: "bot-1", name: "Bot", isGroup: false };
  const conflicting = { id: "1", text: "first", preview: "second" };

  assert.equal(entryText(conflicting), "first");
  assert.throws(
    () => normalizeTranscript({ target, transcript: { entries: [conflicting] } }),
    /conflicting transcript text/i,
  );
});

test("normalizer rejects conflicting nested message text and content", () => {
  const target = { id: "bot-1", name: "Bot", isGroup: false };
  assert.throws(
    () => normalizeTranscript({
      target,
      transcript: {
        entries: [{ id: "1", message: { type: "text", text: "first", content: "second" } }],
      },
    }),
    /conflicting transcript text/i,
  );
});

test("normalizer rejects malformed non-string text carriers", () => {
  const target = { id: "bot-1", name: "Bot", isGroup: false };
  for (const text of [42, true]) {
    assert.throws(
      () => normalizeTranscript({
        target,
        transcript: { entries: [{ id: "1", text, content: "fallback" }] },
      }),
      /malformed transcript text/i,
      `text: ${JSON.stringify(text)} should be rejected`,
    );
  }
});

test("matching text carriers normalize once and content arrays remain intact", () => {
  const target = { id: "bot-1", name: "Bot", isGroup: false };
  const normalized = normalizeTranscript({
    target,
    transcript: {
      entries: [
        { id: "1", text: "same", preview: "same" },
        { id: "2", message: { content: ["first", { text: "second" }] } },
      ],
    },
  });
  assert.equal(normalized.messages[0].text, "same");
  assert.equal(normalized.messages[1].text, "first\nsecond");
});

test("send-message with nested type text stays unknown", () => {
  const normalized = normalizeTranscript({
    target: { id: "bot-1", name: "Bot", isGroup: false },
    transcript: {
      entries: [{ id: "1", kind: "send-message", message: { type: "text", content: "hello" } }],
    },
  });
  assert.equal(normalized.messages[0].role, "unknown");
});

test("normalized evidence never synthesizes JSON from non-text content", () => {
  const normalized = normalizeTranscript({
    target: { id: "bot-1", name: "Bot", isGroup: false },
    transcript: { entries: [{ id: "new", role: "user", content: { type: "image" } }] },
  });
  assert.equal(normalized.messages[0].text, "");
  assert.equal(entryText({ content: { type: "image" } }), '{"type":"image"}');
});

test("normalizer supports items and direct array containers", () => {
  const target = { id: "bot-1", name: "Bot", isGroup: false };
  assert.equal(normalizeTranscript({ target, transcript: { items: [] } }).messages.length, 0);
  assert.equal(normalizeTranscript({ target, transcript: [] }).messages.length, 0);
});

test("normalizer fails closed on malformed containers and entries", () => {
  const target = { id: "bot-1", name: "Bot", isGroup: false };
  assert.throws(
    () => normalizeTranscript({ target, transcript: { entries: "not-an-array" } }),
    /invalid transcript container/i,
  );
  assert.throws(
    () => normalizeTranscript({ target, transcript: { entries: [null] } }),
    /invalid transcript entry/i,
  );
});

test("normalizer fails closed on malformed target and message identities", () => {
  const transcript = { entries: [] };
  for (const target of [
    { id: "", name: "Bot", isGroup: false },
    { id: "bot-1", name: "   ", isGroup: false },
    { id: 7, name: "Bot", isGroup: false },
    { id: "bot-1", name: {}, isGroup: false },
    { id: "bot-1", name: "Bot", isGroup: "false" },
  ]) {
    assert.throws(() => normalizeTranscript({ target, transcript }), /invalid transcript target/i);
  }

  const target = { id: "bot-1", name: "Bot", isGroup: false };
  for (const id of ["", "   ", 42, {}]) {
    assert.throws(
      () => normalizeTranscript({ target, transcript: { entries: [{ id, text: "message" }] } }),
      /invalid transcript message id/i,
    );
  }
  assert.deepEqual(
    normalizeTranscript({ target, transcript: { entries: [{ text: "no id" }] } }).messages[0],
    { id: null, role: "unknown", text: "no id" },
  );
});

test("normalizer rejects conflicting or malformed ID carriers", () => {
  const target = { id: "bot-1", name: "Bot", isGroup: false };
  for (const entry of [
    { id: "first", messageId: "second", text: "message" },
    { id: "first", messageId: {}, text: "message" },
    { id: {}, messageId: "second", text: "message" },
  ]) {
    assert.throws(
      () => normalizeTranscript({ target, transcript: { entries: [entry] } }),
      /invalid transcript message id/i,
    );
  }

  const messages = normalizeTranscript({
    target,
    transcript: {
      entries: [
        { id: "same", messageId: "same", text: "one" },
        { id: null, messageId: "fallback", text: "two" },
      ],
    },
  }).messages;
  assert.equal(messages[0].id, "same");
  assert.equal(messages[1].id, "fallback");
});
