import test from "node:test";
import assert from "node:assert/strict";
import { entryText, sourceEntryId, transcriptDelta, transcriptEntries } from "../src/transcript.js";

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
  assert.equal(entryText({ preview: "short…", content: [{ type: "text", text: "full body" }] }), "full body");
  assert.equal(entryText({ preview: "preview only" }), "preview only");
});

test("transcript containers unwrap to an entry list", () => {
  assert.deepEqual(transcriptEntries({ entries: [1], nextBeforeSeq: 2 }), [1]);
  assert.deepEqual(transcriptEntries({ messages: [2] }), [2]);
  assert.deepEqual(transcriptEntries({ items: [3] }), [3]);
  assert.deepEqual(transcriptEntries([4]), [4]);
  assert.deepEqual(transcriptEntries({ nextBeforeSeq: 2 }), []);
  assert.deepEqual(transcriptEntries(null), []);
});

test("entryText never throws and normalizes malformed content to safe strings", () => {
  assert.equal(entryText({ content: { text: 5 } }), "5");
  assert.equal(entryText({ content: { flag: true } }), '{"flag":true}');
  assert.equal(entryText({ content: { v: 1n } }), "[unserializable]");
  assert.equal(entryText({ text: "a\ud800b" }), "a\ufffdb");
  assert.equal(entryText(null), "");
});

test("transcript delta uses opaque source ids and the true bounded tail", () => {
  const longId = "i".repeat(300);
  const entries = [
    { id: "old", text: "old" },
    { id: longId, kind: 7, text: "middle" },
    { id: "latest", text: "latest" },
  ];
  assert.equal(sourceEntryId(entries[1]), longId);
  assert.deepEqual(transcriptDelta({ entries }, { limit: 2 }), {
    cursor: "latest",
    entries: entries.slice(1),
    entryCount: 2,
    gapReset: false,
  });
});

test("transcript delta filters exclusively after a known cursor and keeps no-op cursor", () => {
  const entries = Array.from({ length: 45 }, (_, index) => ({ id: `m${index + 1}`, text: `message ${index + 1}` }));
  assert.deepEqual(transcriptDelta({ entries }, { after: "m43", limit: 45 }), {
    cursor: "m45",
    entries: entries.slice(43),
    entryCount: 2,
    gapReset: false,
  });
  assert.deepEqual(transcriptDelta({ entries }, { after: "m45", limit: 45 }), {
    cursor: "m45",
    entries: [],
    entryCount: 0,
    gapReset: false,
  });
});

test("transcript delta resets an unknown cursor with one bounded snapshot", () => {
  const entries = Array.from({ length: 45 }, (_, index) => ({ id: `m${index + 1}`, text: `message ${index + 1}` }));
  const delta = transcriptDelta({ entries }, { after: "bogus", limit: 40 });
  assert.equal(delta.gapReset, true);
  assert.equal(delta.entryCount, 40);
  assert.deepEqual(delta.entries, entries.slice(-40));
  assert.equal(delta.cursor, "m45");
});
