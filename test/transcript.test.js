import assert from "node:assert/strict";
import test from "node:test";

import { entryText } from "../src/transcript.js";

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
