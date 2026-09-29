import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('Claude and Cursor plugin commands are generated from source', () => {
 const cursor = JSON.parse(readFileSync('artifact/.cursor-plugin/plugin.json', 'utf8'));
 assert.equal(cursor.commands, './commands/');
 for (const name of ['codex-send', 'codex-threads', 'codex-wait']) {
  const source = readFileSync(join('src/commands', `${name}.md`), 'utf8');
  const emitted = readFileSync(join('artifact/commands', `${name}.md`), 'utf8');
  assert.match(source, /targets: \[claude, cursor\]/);
  assert.match(emitted, /gbot codex/);
 }
});
