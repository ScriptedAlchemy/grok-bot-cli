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

test('emitted plugin commands carry description frontmatter for every host (AB6020)', () => {
 // agent-bundle's Cursor commands surface is frontmatter-free and the Claude
 // and Cursor projections must emit identical bytes into the shared commands/
 // directory (AB4103), so the description block is authored as the body's own
 // leading frontmatter after the `targets` block, which agent-bundle peels.
 for (const name of ['codex-send', 'codex-threads', 'codex-wait']) {
  const emitted = readFileSync(join('artifact/commands', `${name}.md`), 'utf8');
  assert.match(emitted, /^---\ndescription: [^\n]+\n---\n/);
  assert.doesNotMatch(emitted, /targets:/);
  assert.match(emitted, /gbot codex/);
 }
});
