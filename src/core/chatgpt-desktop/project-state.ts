/** Resolve Desktop project labels from its persisted project/assignment state. */
import { codexStateEntries, loadCodexGlobalState } from '../codex/remote-control.js';
import { toAppServerThreadId } from './thread-ids.js';
import type { ChatGptDesktopThread } from './types.js';

type Project = { id: string; label: string; rootPath: string; hostId?: string };

export function findLocalProject(
  nameOrId: string,
  env: NodeJS.ProcessEnv = process.env,
): { id: string; label: string; rootPaths: string[] } | null {
  const state = loadCodexGlobalState(env);
  if (!state) return null;
  for (const value of Object.values(record(stateValue(state, 'local-projects')) ?? {})) {
    const row = record(value);
    if (!row || typeof row.id !== 'string' || typeof row.name !== 'string') continue;
    if (row.id !== nameOrId && row.name.toLowerCase() !== nameOrId.toLowerCase()) continue;
    return { id: row.id, label: row.name,
      rootPaths: (Array.isArray(row.rootPaths) ? row.rootPaths : [])
        .filter((path): path is string => typeof path === 'string' && Boolean(path)) };
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stateValue(state: Record<string, unknown>, key: string): unknown {
  for (const source of codexStateEntries(state)) if (key in source) return source[key];
  return undefined;
}

function pathWithin(path: string, root: string): boolean {
  const normalized = root.replace(/\/+$/u, '');
  return path === normalized || path.startsWith(`${normalized}/`);
}

export function resolveThreadProjects(
  threads: readonly ChatGptDesktopThread[],
  env: NodeJS.ProcessEnv = process.env,
): ChatGptDesktopThread[] {
  const state = loadCodexGlobalState(env);
  if (!state) return [...threads];
  const localProjects = Object.values(record(stateValue(state, 'local-projects')) ?? {})
    .flatMap((value): Project[] => {
      const row = record(value);
      if (!row || typeof row.id !== 'string' || typeof row.name !== 'string') return [];
      return (Array.isArray(row.rootPaths) ? row.rootPaths : [])
        .filter((path): path is string => typeof path === 'string' && Boolean(path))
        .map((rootPath) => ({ id: row.id as string, label: row.name as string, rootPath }));
    });
  const remoteProjects = (Array.isArray(stateValue(state, 'remote-projects'))
    ? stateValue(state, 'remote-projects') as unknown[] : []).flatMap((value): Project[] => {
    const row = record(value);
    if (!row || typeof row.id !== 'string' || typeof row.label !== 'string'
      || typeof row.remotePath !== 'string' || typeof row.hostId !== 'string') return [];
    return [{ id: row.id, label: row.label, rootPath: row.remotePath, hostId: row.hostId }];
  });
  const assignments = record(stateValue(state, 'thread-project-assignments')) ?? {};
  const hints = record(stateValue(state, 'thread-workspace-root-hints')) ?? {};
  const projectless = new Set(Array.isArray(stateValue(state, 'projectless-thread-ids'))
    ? stateValue(state, 'projectless-thread-ids') as string[] : []);
  return threads.map((thread) => {
    const bare = toAppServerThreadId(thread.threadId) ?? thread.threadId;
    const assignment = record(assignments[bare]);
    const remote = thread.location === 'remote';
    const projects = remote ? remoteProjects.filter((project) => project.hostId === thread.hostId) : localProjects;
    let project = assignment && typeof assignment.projectId === 'string'
      ? projects.find((entry) => entry.id === assignment.projectId) : undefined;
    if (!project && !projectless.has(bare) && thread.projectId) {
      project = projects.find((entry) => entry.id === thread.projectId);
    }
    if (!project && !assignment && !projectless.has(bare)) {
      const path = typeof hints[bare] === 'string' ? hints[bare] as string
        : typeof thread.cwd === 'string' ? thread.cwd : null;
      if (path) project = projects.filter((entry) => pathWithin(path, entry.rootPath))
        .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
    }
    if (project) return { ...thread, project: project.label, projectId: project.id,
      projectRootPath: project.rootPath };
    if (projectless.has(bare)) return { ...thread, project: null, projectId: null };
    if (remote && typeof thread.project === 'string' && thread.project.startsWith('/')) {
      return { ...thread, project: null };
    }
    return thread;
  });
}
