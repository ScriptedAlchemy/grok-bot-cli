import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { main } from "../src/cli.js";

function stdinFrom(...chunks) {
  return Readable.from(chunks);
}

function harness(chunks = []) {
  const sent = [];
  let backendOpens = 0;
  const output = [];
  const backend = {
    send: async (ref, message) => {
      sent.push({ ref, message });
      return {
        target: { id: "bot-1", name: ref, isGroup: false },
        result: { ok: true },
      };
    },
    transcript: async (ref) => ({
      target: { id: "bot-1", name: ref, isGroup: false },
      transcript: { entries: [{ id: "m1", message: { type: "assistant", content: "完成" } }] },
      extraRawField: true,
    }),
  };

  return {
    sent,
    output,
    get backendOpens() { return backendOpens; },
    options: {
      stdin: stdinFrom(...chunks),
      openBackendImpl: async () => {
        backendOpens += 1;
        return backend;
      },
      printImpl: (value) => output.push(value),
    },
  };
}

test("send --stdin preserves exact UTF-8 text and treats flag-looking lines as text", async () => {
  const h = harness([Buffer.from("第一行\n--json\n--files\n最後一行", "utf8")]);

  await main(["node", "gbot", "send", "Researcher", "--stdin"], h.options);

  assert.equal(h.backendOpens, 1);
  assert.deepEqual(h.sent, [{
    ref: "Researcher",
    message: "第一行\n--json\n--files\n最後一行",
  }]);
});

test("send --stdin supports the 64 KiB byte boundary", async () => {
  const h = harness([Buffer.alloc(64 * 1024, 0x61)]);

  await main(["node", "gbot", "send", "Researcher", "--stdin"], h.options);

  assert.equal(h.sent[0].message.length, 64 * 1024);
});

test("positional send behavior remains unchanged", async () => {
  const h = harness();

  await main(
    ["node", "gbot", "send", "Researcher", "existing", "positional", "message"],
    h.options,
  );

  assert.deepEqual(h.sent, [{ ref: "Researcher", message: "existing positional message" }]);
});

for (const [name, chunks, pattern] of [
  ["empty input", [], /stdin message must not be empty/i],
  ["invalid UTF-8", [Buffer.from([0xc3, 0x28])], /valid UTF-8/i],
  ["NUL byte", [Buffer.from("hello\0world")], /NUL/i],
  ["leading UTF-8 BOM", [Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("hello")])], /surrounding whitespace/i],
  ["leading whitespace", [Buffer.from(" message")], /surrounding whitespace/i],
  ["trailing whitespace", [Buffer.from("message\n")], /surrounding whitespace/i],
  ["oversized input", [Buffer.alloc(64 * 1024 + 1, 0x61)], /64 KiB/i],
]) {
  test(`send --stdin rejects ${name} before opening a backend`, async () => {
    const h = harness(chunks);

    await assert.rejects(
      main(["node", "gbot", "send", "Researcher", "--stdin"], h.options),
      pattern,
    );

    assert.equal(h.backendOpens, 0);
    assert.deepEqual(h.sent, []);
  });
}

test("send --stdin rejects a positional message before opening a backend", async () => {
  const h = harness([Buffer.from("stdin message")]);

  await assert.rejects(
    main(["node", "gbot", "send", "Researcher", "positional", "--stdin"], h.options),
    /cannot be combined/i,
  );

  assert.equal(h.backendOpens, 0);
});

test("--stdin is rejected for non-send commands before opening a backend", async () => {
  const h = harness([Buffer.from("ignored")]);

  await assert.rejects(
    main(["node", "gbot", "bots", "list", "--stdin"], h.options),
    /only valid with send/i,
  );

  assert.equal(h.backendOpens, 0);
});

test("thread --normalized requires --json before opening a backend", async () => {
  const h = harness();
  await assert.rejects(
    main(["node", "gbot", "thread", "Researcher", "--normalized"], h.options),
    /requires --json/i,
  );
  assert.equal(h.backendOpens, 0);
});

test("--normalized is rejected for non-thread commands before opening a backend", async () => {
  const h = harness();
  await assert.rejects(
    main(["node", "gbot", "--json", "bots", "list", "--normalized"], h.options),
    /only valid with thread or chat/i,
  );
  assert.equal(h.backendOpens, 0);
});

test("thread --json --normalized emits the stable normalized schema", async () => {
  const h = harness();
  await main(
    ["node", "gbot", "--json", "thread", "Researcher", "--normalized"],
    h.options,
  );
  assert.deepEqual(h.output, [{
    target: { id: "bot-1", name: "Researcher", kind: "bot" },
    messages: [{ id: "m1", role: "assistant", text: "完成" }],
  }]);
});

test("thread raw JSON remains unchanged without --normalized", async () => {
  const h = harness();
  await main(["node", "gbot", "--json", "thread", "Researcher"], h.options);
  assert.equal(h.output[0].extraRawField, true);
  assert.ok(h.output[0].transcript);
});

test("malformed normalized transcript emits no partial stdout", async () => {
  const h = harness();
  h.options.openBackendImpl = async () => ({
    transcript: async () => ({
      target: { id: "bot-1", name: "Researcher", isGroup: false },
      transcript: { entries: "bad" },
    }),
  });
  await assert.rejects(
    main(["node", "gbot", "--json", "chat", "Researcher", "--normalized"], h.options),
    /invalid transcript container/i,
  );
  assert.deepEqual(h.output, []);
});
