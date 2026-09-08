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
