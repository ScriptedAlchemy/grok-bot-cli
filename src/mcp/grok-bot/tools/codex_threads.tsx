import { Agent, agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { threadsSchema as inputSchema, resultSchema, threadsOperation, resultText } from '../../../core/codex/routes.js';
export { inputSchema };
export default defineTool({
  excludeClients: ['codex'],
  description: 'Discover Codex daemon threads on the user\'s registered machine (local socket, not the Grok Bot box; from the box run gbot there through Shell with a machineId after codex app-server daemon start or bootstrap). Newest activity first by default (sort:"updated"), so old-but-active threads surface; sort:"created" restores creation order. Find one thread with query (case-insensitive substring of name/title, preview or id, so an id prefix works) - it scans every page, not just the first 100. Narrow with activeWithin ("30m", "12h", "7d", "2w") or since (ISO/epoch seconds), cwd, modelProvider, sourceKind, archived. limit is the page size (1-200); pass nextCursor back as cursor for more.', title: 'Codex threads', annotations: { readOnlyHint: true },
  render: { maxElapsedMs: 660000 },
  inputSchema, resultSchema,
  inputJsonSchema: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'number', description: 'Maximum threads in this page: 1-200 (default 20). Every provider is included; use cursor/nextCursor to page.' },
      cursor: { type: 'string', description: 'Opaque nextCursor from a previous page.' },
      sort: { type: 'string', enum: ['updated', 'created', 'recency'], default: 'updated', description: 'updated = last activity (default), created = creation time, recency = daemon recency order.' },
      order: { type: 'string', enum: ['desc', 'asc'], default: 'desc' },
      query: { type: 'string', description: 'Case-insensitive substring of thread name/title, preview or id (id prefix works). Scans all pages.' },
      activeWithin: { type: 'string', description: 'Only threads updated within this long: 90s, 30m, 12h, 7d, 2w.' },
      since: { type: 'string', description: 'Only threads updated at or after this ISO date/time or epoch seconds.' },
      cwd: { type: 'string', description: 'Exact session working directory.' },
      modelProvider: { type: 'string', description: 'Any modelProvider id; omit for all.' },
      sourceKind: { type: 'string', description: 'Any app-server source kind (cli, vscode, exec, appServer, subAgent...); omit for interactive sources.' },
      archived: { type: 'boolean', description: 'true = archived threads only.' },
    }, required: [] },
}, async input => {
  const context = await agent();
  const out = await threadsOperation(input);
  return <Agent.Result value={out}><Agent.Text>{resultText(out)}</Agent.Text></Agent.Result>;
});
