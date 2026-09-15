import test from "node:test";
import assert from "node:assert/strict";
import { entryText, transcriptEntries } from "../src/transcript.js";

test("user messages read content, bot replies read message.content", () => {
  assert.equal(entryText({ kind: "message", role: "user", content: "hello" }), "hello");
  assert.equal(entryText({ kind: "send-message", message: { type: "text", content: "reply" } }), "reply");
  assert.equal(entryText({ kind: "tool-call" }), "");
});

test("direct string keys win over content, then content parts join", () => {
  assert.equal(entryText({ text: "direct", content: "ignored" }), "direct");
  assert.equal(entryText({ message: "plain", content: "ignored" }), "plain");
  assert.equal(entryText({ content: ["a", { text: "b" }, { content: "c" }, 4] }), "a\nb\nc");
  assert.equal(entryText({ content: { text: "obj" } }), "obj");
  assert.equal(entryText({ content: { other: 1 } }), '{"other":1}');
});

test("transcript containers unwrap to an entry list", () => {
  assert.deepEqual(transcriptEntries({ entries: [1], nextBeforeSeq: 2 }), [1]);
  assert.deepEqual(transcriptEntries({ messages: [2] }), [2]);
  assert.deepEqual(transcriptEntries({ items: [3] }), [3]);
  assert.deepEqual(transcriptEntries([4]), [4]);
  assert.deepEqual(transcriptEntries({ nextBeforeSeq: 2 }), []);
  assert.deepEqual(transcriptEntries(null), []);
});
