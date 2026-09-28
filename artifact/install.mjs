#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginName = "gbot";
const pluginVersion = "0.10.0";
const receiptFile = ".agent-bundle-install.json";
const receiptFormat = "agent-bundle-install-receipt/2";
const preservedEntries = ["state"];
// Runtime roots match case-insensitively: on case-insensitive filesystems State/ is state/.
const isPreservedRoot = (name) => preservedEntries.includes(String(name).toLowerCase());
const source = resolve(fileURLToPath(new URL('.', import.meta.url)));
const artifactManifest = await (async () => {
  try {
    const value = JSON.parse(await readFile(join(source, 'agent-bundle.manifest.json'), 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.files) || !Array.isArray(value.projections)) {
      throw new Error('agent-bundle.manifest.json has no files or projections array.');
    }
    return value;
  } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
})();
const installProjection = artifactManifest?.projections.find((projection) => projection?.builtInHost === 'cursor') ??
  artifactManifest?.projections.find((projection) => projection?.builtInHost === 'portable');
const declaredDocument = (name) => typeof installProjection?.documents?.[name] === 'string' ? installProjection.documents[name] : undefined;
const cursorPluginDocument = declaredDocument('plugin') ?? '.cursor-plugin/plugin.json';
const cursorRoot = join(homedir(), '.cursor');
const installRoot = join(cursorRoot, 'plugins', 'local');
const destination = join(installRoot, pluginName);
const marketplaceRoot = join(cursorRoot, 'agent-bundle', 'marketplaces');
const marketplaceRepo = join(marketplaceRoot, pluginName);
const marketplacePlugin = join(marketplaceRepo, 'plugins', pluginName);
// Agent Plugins 1.0.0 §9.1 PLUGIN_DATA for the Cursor copy: a writable, install-independent directory the installer creates.
const pluginData = join(cursorRoot, 'agent-bundle', 'plugin-data', pluginName);
const receiptsRoot = join(cursorRoot, 'agent-bundle', 'receipts');
const marketplaceReceipt = join(receiptsRoot, `${pluginName}.marketplace.json`);
const usage = 'Usage: node install.mjs [--mode local|marketplace] [--replace] [--help]\n       node install.mjs --uninstall [--mode local|marketplace] [--keep-data | --purge-data --confirm-purge] [--force] [--plan]';

let replace = false;
let force = false;
let uninstall = false;
let plan = false;
let keepData = false;
let purgeData = false;
let confirmPurge = false;
let mode = 'local';
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === '--replace') { replace = true; continue; }
  if (argument === '--force') { force = true; continue; }
  if (argument === '--uninstall') { uninstall = true; continue; }
  if (argument === '--plan') { plan = true; continue; }
  if (argument === '--keep-data') { keepData = true; continue; }
  if (argument === '--purge-data') { purgeData = true; continue; }
  if (argument === '--confirm-purge') { confirmPurge = true; continue; }
  if (argument === '--mode') {
    mode = argv[index + 1];
    if (mode !== 'local' && mode !== 'marketplace') { console.error(`Install mode must be local or marketplace.\n${usage}`); process.exit(2); }
    index += 1;
    continue;
  }
  if (argument === '--help' || argument === '-h') { console.log(usage); process.exit(0); }
  console.error(`Unknown installer argument ${JSON.stringify(argument)}.\n${usage}`);
  process.exit(2);
}
if (!uninstall && force) { console.error(`--force applies to --uninstall only. Use --replace to replace an install.\n${usage}`); process.exit(2); }
if (uninstall && replace) { console.error(`--replace applies to installation only. Use --force to override uninstall ownership checks.\n${usage}`); process.exit(2); }
if (!uninstall && (plan || keepData || purgeData || confirmPurge)) {
  console.error(`--plan, --keep-data, --purge-data, and --confirm-purge apply to --uninstall only.\n${usage}`);
  process.exit(2);
}
if (uninstall && purgeData && keepData) { console.error(`--keep-data and --purge-data are mutually exclusive.\n${usage}`); process.exit(2); }
if (uninstall && purgeData && !confirmPurge) {
  console.error(`--purge-data deletes the plugin's durable runtime state (state kernel, notices journal) and requires --confirm-purge; omit both flags to keep the data.\n${usage}`);
  process.exit(2);
}

const exists = async (path) => {
  try { await lstat(path); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
};
const unsupported = (relative) => new Error(`Refusing unsupported filesystem entry ${JSON.stringify(relative || '.')}.`);
const toPosix = (path) => path.replaceAll('\\', '/');
const short = (hash) => hash.slice(0, 12);
const sortNames = (names) => [...names].sort((left, right) => left.localeCompare(right));
const compareTreePaths = (left, right) => {
  const leftSegments = left.split('/');
  const rightSegments = right.split('/');
  for (let index = 0; index < Math.min(leftSegments.length, rightSegments.length); index += 1) {
    const compared = leftSegments[index].localeCompare(rightSegments[index]);
    if (compared !== 0) return compared;
  }
  return leftSegments.length - rightSegments.length;
};
// Every ancestor directory of the given POSIX-relative files, deduplicated and sorted.
const directoriesOf = (files) => {
  const directories = new Set();
  for (const file of files) {
    let directory = dirname(file);
    while (directory !== '.' && directory !== '') { directories.add(directory); directory = dirname(directory); }
  }
  return sortNames(directories);
};

// path\0mode\0bytes\0 per file; mode is x for an executable and - otherwise.
const hashEntry = (hash, relative, metadata, bytes) => {
  hash.update(toPosix(relative));
  hash.update('\0');
  hash.update((metadata.mode & 0o111) === 0 ? '-' : 'x');
  hash.update('\0');
  hash.update(bytes);
  hash.update('\0');
};

// Deterministic tree walk: symlinks and special files refused, the root receipt skipped. `transform`
// maps a file's bytes to what the Cursor copy will hold (the Agent Plugins mcp.json expansion below), so
// the artifact hash describes the installed form and reruns compare like for like.
const readTree = async (root, transform, selectedPaths) => {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw unsupported('.');
  const hash = createHash('sha256');
  const files = [];
  const visit = async (relative) => {
    const absolute = join(root, relative);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) throw unsupported(relative);
    if (metadata.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort((left, right) => left.localeCompare(right))) await visit(join(relative, entry));
      return;
    }
    // Every inventoried path must round-trip through a receipt unchanged (no backslash in a POSIX
    // name, nothing the receipt reader rejects); refuse the rest up front.
    const posixPath = toPosix(relative);
    if ((sep === '/' && relative.includes('\\')) || !safeRelative(posixPath)) throw unsupported(sep === '/' ? relative : posixPath);
    files.push(posixPath);
    const bytes = await readFile(absolute);
    hashEntry(hash, relative, metadata, transform === undefined ? bytes : transform(posixPath, bytes));
  };
  if (selectedPaths !== undefined) {
    for (const file of selectedPaths) {
      if (!(await exists(join(root, file)))) throw new Error(`bundle does not match its manifest: ${file} is missing.`);
      await visit(file);
    }
    return { files, hash: hash.digest('hex') };
  }
  for (const entry of (await readdir(root)).sort((left, right) => left.localeCompare(right))) {
    if (entry === receiptFile) {
      // The receipt is deletion authority: skipped from the hash, must be a regular file.
      if (!(await lstat(join(root, entry))).isFile()) throw unsupported(entry);
      continue;
    }
    // Runtime-owned roots (state/) are never plugin content: not hashed, not installed, not owned.
    if (isPreservedRoot(entry)) continue;
    await visit(entry);
  }
  return { files, hash: hash.digest('hex') };
};
const inventory = (root, transform) => readTree(root, transform, undefined);
const artifactInventory = async (root, transform) => {
  if (artifactManifest === undefined) return inventory(root, transform);
  const selected = new Set(['agent-bundle.manifest.json', ...artifactManifest.files.map((file) => file.path)]);
  for (const file of ['.env', '.env.local']) if (await exists(join(root, file))) selected.add(file);
  return readTree(root, transform, [...selected].sort(compareTreePaths));
};

const treeHash = async (root) => (await inventory(root)).hash;

// An existing entry is one of ours when its exact name is owned, or when the filesystem proves it a case
// alias of an owned name (both spellings realpath to the same on-disk path). Inode equality is not used.
const isOwnedEntry = async (root, owned, relative) => {
  if (owned.has(relative)) return true;
  const alias = relative.toLowerCase();
  let canonical;
  for (const candidate of owned) {
    if (candidate.toLowerCase() !== alias) continue;
    try {
      canonical ??= await realpath(join(root, relative));
      if ((await realpath(join(root, candidate))) === canonical) return true;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return false;
};

// Every directory on the way to a listed path must be a real directory (no symlinked ancestors);
// an owned regular file that a rebuild turns into a directory leaves as stale first, so it is tolerated.
const assertRealAncestors = async (root, files, ownedFiles = new Set()) => {
  const checked = new Set();
  for (const file of files) {
    let directory = dirname(file);
    while (directory !== '.' && directory !== '') {
      if (!checked.has(directory)) {
        checked.add(directory);
        try {
          const metadata = await lstat(join(root, directory));
          if (metadata.isSymbolicLink()) throw unsupported(directory);
          if (!metadata.isDirectory() && !(metadata.isFile() && await isOwnedEntry(root, ownedFiles, directory))) {
            throw unsupported(directory);
          }
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
      directory = dirname(directory);
    }
  }
};

// Hashes exactly the owned files; a missing owned file simply changes the digest.
const hashOwned = async (root, files) => {
  await assertRealAncestors(root, files);
  const hash = createHash('sha256');
  for (const relative of files) {
    const absolute = join(root, relative);
    let metadata;
    try { metadata = await lstat(absolute); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw unsupported(relative);
    hashEntry(hash, relative, metadata, await readFile(absolute));
  }
  return hash.digest('hex');
};

// Receipt paths drive deletions: POSIX-relative only, no backslashes, no empty/./.. segments, and no
// segment Windows would normalise onto another entry (reserved characters, colons, trailing dot/space)
// or resolve as a DOS device (NUL, CON.txt, COM1, LPT1.json, ...).
const windowsDeviceName = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu;
// The receipt name is reserved as a top-level entry in every spelling, file or directory (a case alias
// resolves to the receipt itself on case-insensitive filesystems).
const safeRelative = (value) => typeof value === 'string' && value.length > 0 &&
  value.split('/')[0].toLowerCase() !== receiptFile.toLowerCase() &&
  !value.includes('\\') && !value.startsWith('/') && !isPreservedRoot(value.split('/')[0]) &&
  value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' &&
    !/[<>:"|?*]/u.test(segment) && !windowsDeviceName.test(segment) &&
    [...segment].every((character) => character.charCodeAt(0) >= 0x20) &&
    !segment.endsWith('.') && !segment.endsWith(' '));

const registrationKinds = ["amp-project-plugin","amp-system-plugin","claude-marketplace","claude-plugin","codex-marketplace","codex-plugin","cursor-local-plugin","cursor-marketplace-staging"];
const isScope = (value) => value === 'local' || value === 'project' || value === 'user';
const isRegistration = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  registrationKinds.includes(value.kind) &&
  (value.commit === undefined || typeof value.commit === 'string') && (value.id === undefined || typeof value.id === 'string') &&
  (value.name === undefined || typeof value.name === 'string') && (value.scope === undefined || isScope(value.scope));
const isStateOwnership = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && (
  value.kind === 'derived' ||
  (value.kind === 'marker' && typeof value.marker === 'string' && isAbsolute(value.marker)) ||
  (value.kind === 'unowned' && ['foreign-marker', 'pre-existing', 'unproven'].includes(value.reason)));
const isReceiptState = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  value.owner !== null && typeof value.owner === 'object' && !Array.isArray(value.owner) &&
  typeof value.owner.id === 'string' && value.owner.id.length > 0 && typeof value.owner.host === 'string' &&
  ['host-cli', 'local', 'marketplace'].includes(value.owner.mode) && typeof value.owner.plugin === 'string' && isScope(value.owner.scope) &&
  Array.isArray(value.roots) && value.roots.every((root) => root !== null && typeof root === 'object' && !Array.isArray(root) &&
    typeof root.root === 'string' && isAbsolute(root.root) && typeof root.canonicalRoot === 'string' && isAbsolute(root.canonicalRoot) &&
    ['declared', 'derived'].includes(root.source) && Array.isArray(root.servers) && root.servers.every((server) => typeof server === 'string') &&
    isStateOwnership(root.ownership));
// Same shape check as the core reader: a receipt missing any field, or of any other format, reads as absent.
const readReceiptFile = async (path) => {
  let value;
  try {
    if (!(await lstat(path)).isFile()) throw unsupported(basename(path));
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (value.format !== receiptFormat ||
    typeof value.plugin !== 'string' || typeof value.version !== 'string' ||
    typeof value.host !== 'string' || typeof value.contentHash !== 'string' || typeof value.installedAt !== 'string' ||
    !Array.isArray(value.files) || !value.files.every(safeRelative) ||
    !Array.isArray(value.directories) || !value.directories.every(safeRelative) ||
    (value.state !== undefined && !isReceiptState(value.state)) ||
    (value.webDataRoot !== undefined && typeof value.webDataRoot !== 'string')) return undefined;
  if (!['host-cli', 'local', 'marketplace'].includes(value.mode) || !isScope(value.scope) || typeof value.updatedAt !== 'string' ||
    !Array.isArray(value.hostDirectories) || !value.hostDirectories.every(safeRelative) ||
    !Array.isArray(value.registrations) || !value.registrations.every(isRegistration)) return undefined;
  if (value.state !== undefined && (value.state.owner.host !== value.host || value.state.owner.mode !== value.mode ||
    value.state.owner.plugin !== value.plugin || value.state.owner.scope !== value.scope ||
    value.state.owner.projectRoot !== value.projectRoot)) { value = { ...value }; delete value.state; }
  return value;
};
const readReceipt = (root) => readReceiptFile(join(root, receiptFile));
// Atomic receipt write: an exclusively created random sibling (never follows a link) renamed into place.
const writeReceiptFile = async (path, text) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.close();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};
const rmdirIfEmpty = async (path) => {
  try { await rmdir(path); return true; }
  catch (error) { if (['ENOTEMPTY', 'ENOENT', 'EEXIST', 'ENOTDIR'].includes(error?.code)) return false; throw error; }
};

const readManifest = async (root) => {
  for (const manifest of declaredDocument('plugin') === undefined ? ['.cursor-plugin/plugin.json', 'plugin.json'] : [declaredDocument('plugin')]) {
    try {
      const value = JSON.parse(await readFile(join(root, manifest), 'utf8'));
      if (value !== null && typeof value === 'object' && typeof value.name === 'string') {
        return { name: value.name, ...(typeof value.version === 'string' ? { version: value.version } : {}) };
      }
    } catch (error) { if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  return undefined;
};

// Agent Plugins packs (root plugin.json with an agent-plugins.org $schema, no .cursor-plugin/plugin.json).
// Observed on Cursor 3.18.25 (docs/audits/2026-09-03-agent-plugins-cursor-ide-proof.md): the loader spawns their
// stdio servers without expanding ${PLUGIN_ROOT}/${PLUGIN_DATA} in args, env values or cwd, without providing
// the reserved PLUGIN_ROOT/PLUGIN_DATA variables (spec 9.1), with an omitted cwd defaulting to the home directory
// and with ./ commands resolved against the workspace folder (spec 7.2.1). The installer therefore expands those
// forms itself in the Cursor copy of mcp.json and records the expansion in the receipt (provenance: derived).
const agentPluginsSchemaPrefix = 'https://agent-plugins.org/schemas/';
const isAgentPluginsPack = async (root) => {
  if (artifactManifest !== undefined) {
    const plugin = declaredDocument('plugin');
    if (plugin === undefined) throw new Error('agent-bundle.manifest.json has no Cursor-compatible plugin document.');
    try {
      const manifest = JSON.parse(await readFile(join(root, plugin), 'utf8'));
      return manifest !== null && typeof manifest === 'object' && typeof manifest.$schema === 'string' && manifest.$schema.startsWith(agentPluginsSchemaPrefix);
    } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return false; throw error; }
  }
  if (await exists(join(root, '.cursor-plugin', 'plugin.json'))) return false;
  try {
    const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
    return manifest !== null && typeof manifest === 'object' && typeof manifest.$schema === 'string' && manifest.$schema.startsWith(agentPluginsSchemaPrefix);
  } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'EISDIR' || error instanceof SyntaxError) return false; throw error; }
};
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const expandPlaceholders = (value) => value.replaceAll('${PLUGIN_ROOT}', destination).replaceAll('${PLUGIN_DATA}', pluginData);
// A plugin-relative ./ path resolves against the plugin root (spec 7.2.1); anything else is expanded in place.
const expandPath = (value) => value.startsWith('./') ? join(destination, value.slice(2)) : expandPlaceholders(value);
// Every stdio server rewritten into the form Cursor launches; undefined when the document has none to expand
// (skills-only or remote-only packs stay byte-identical to the bundle). Doctor recomputes this exact output
// from the receipt (install/cursor-agent-plugins-launch.ts expandAgentPluginsMcpForCursor); keep the two in step.
const expandAgentPluginsMcp = (text) => {
  let document;
  try { document = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(document) || !isRecord(document.mcpServers)) return undefined;
  let expanded = false;
  const servers = {};
  for (const [name, server] of Object.entries(document.mcpServers)) {
    if (!isRecord(server) || server.type !== 'stdio' || typeof server.command !== 'string') { servers[name] = server; continue; }
    expanded = true;
    const env = {};
    for (const [key, value] of Object.entries(isRecord(server.env) ? server.env : {})) env[key] = typeof value === 'string' ? expandPlaceholders(value) : value;
    env.PLUGIN_ROOT = destination;
    env.PLUGIN_DATA = pluginData;
    servers[name] = {
      ...server,
      command: expandPath(server.command),
      ...(Array.isArray(server.args) ? { args: server.args.map((argument) => typeof argument === 'string' ? expandPlaceholders(argument) : argument) } : {}),
      cwd: typeof server.cwd === 'string' ? expandPath(server.cwd) : destination,
      env,
    };
  }
  if (!expanded) return undefined;
  return `${JSON.stringify({ ...document, mcpServers: servers }, null, 2)}\n`;
};
const agentPluginsPack = await isAgentPluginsPack(source);
const expansion = await (async () => {
  if (!agentPluginsPack) return undefined;
  let text;
  const mcpDocument = declaredDocument('mcp') ?? 'mcp.json';
  try { text = await readFile(join(source, mcpDocument), 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return undefined; throw error; }
  const expanded = expandAgentPluginsMcp(text);
  return expanded === undefined ? undefined : { documents: { [mcpDocument]: text }, expanded, mcpDocument, pluginData, pluginRoot: destination };
})();
// The Cursor copy differs from the bundle in exactly that one file; the artifact inventory hashes the expanded
// form so receipts, no-op reruns and replacement compare the bundle with what the copy must hold.
const cursorTransform = expansion === undefined ? undefined : (relativePath, bytes) => relativePath === expansion.mcpDocument ? Buffer.from(expansion.expanded, "utf8") : bytes;

// directories: the ones the installer created (all of them on a fresh install); only those are ever pruned.
// hostDirectories: the ones created under ~/.cursor on the way to the plugin root; installedAt carries over from a
// replaced receipt; mode/registrations describe the delivery so --uninstall reverses exactly that.
const receiptFor = (tree, options = {}) => {
  const now = new Date().toISOString();
  const mode = options.mode ?? 'local';
  return JSON.stringify({
    contentHash: tree.hash,
    // The pre-expansion document bytes and the values substituted, so Doctor validates the Agent Plugins
    // contract against what the bundle shipped and proves the expansion against what Cursor spawns. Only a
    // local copy that owns files carries it: marketplace staging holds no mcp.json, and a remnant receipt carries
    // it only when --uninstall --keep-data preserved a written PLUGIN_DATA directory (options.cursorExpansion).
    ...(options.cursorExpansion !== undefined ? { cursorExpansion: options.cursorExpansion } : expansion === undefined || mode !== 'local' || tree.files.length === 0 ? {} : { cursorExpansion: { documents: expansion.documents, pluginData: expansion.pluginData, pluginRoot: expansion.pluginRoot } }),
    directories: options.directories ?? directoriesOf(tree.files),
    files: tree.files,
    format: receiptFormat,
    host: 'cursor',
    hostDirectories: sortNames(options.hostDirectories ?? []),
    installedAt: options.installedAt ?? now,
    mode,
    plugin: pluginName,
    registrations: options.registrations ?? [{ kind: 'cursor-local-plugin' }],
    scope: 'user',
    ...(options.state === undefined ? {} : { state: options.state }),
    updatedAt: now,
    version: pluginVersion,
    ...(options.webDataRoot === undefined ? {} : { webDataRoot: options.webDataRoot }),
  }, null, 2) + '\n';
};

const stateMarkerFile = ".agent-bundle-state-owner.json";
const expandStatePath = (value, root) => value.replaceAll('${CURSOR_PLUGIN_ROOT}', root).replaceAll('${PLUGIN_ROOT}', root);
const canonicalPath = async (path) => {
  try { return await realpath(path); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; const parent = dirname(path); return parent === path ? resolve(path) : join(await canonicalPath(parent), basename(path)); }
};
const stateLocations = async () => {
  const canonical = await realpath(destination);
  let servers = [];
  for (const manifest of declaredDocument('mcp') === undefined ? ['.cursor-plugin/mcp.json', 'mcp.json'] : [declaredDocument('mcp')]) {
    let document;
    try { document = JSON.parse(await readFile(join(canonical, manifest), 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
    if (document?.mcpServers !== null && typeof document?.mcpServers === 'object' && !Array.isArray(document.mcpServers)) {
      servers = Object.entries(document.mcpServers).filter(([, server]) => server !== null && typeof server === 'object' && !Array.isArray(server)).sort(([left], [right]) => left.localeCompare(right));
      break;
    }
  }
  const xdg = process.env.XDG_STATE_HOME ?? '';
  const stateHome = isAbsolute(xdg) ? join(xdg, 'agent-bundle') : join(homedir(), '.agent-bundle', 'state');
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  const name = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u.test(basename(canonical)) ? basename(canonical) : 'plugin';
  const derived = join(stateHome, `${name}-${digest}`);
  if (servers.length === 0) {
    const inherited = process.env.AGENT_BUNDLE_STATE_ROOT;
    if (typeof inherited !== 'string' || inherited.trim() === '') return [{ root: derived, server: 'default', source: 'derived' }];
    const expanded = expandStatePath(inherited, canonical);
    if (/\$\{[^}]*\}/u.test(expanded)) return [{ root: derived, server: 'default', source: 'derived' }];
    return isAbsolute(expanded) ? [{ root: resolve(expanded), server: 'default', source: 'declared' }] : [];
  }
  const locations = [];
  for (const [server, definition] of servers) {
    const value = definition?.env?.AGENT_BUNDLE_STATE_ROOT ?? process.env.AGENT_BUNDLE_STATE_ROOT;
    if (typeof value !== 'string' || value.trim() === '') { locations.push({ root: derived, server, source: 'derived' }); continue; }
    const expanded = expandStatePath(value, canonical);
    if (/\$\{[^}]*\}/u.test(expanded)) { locations.push({ root: derived, server, source: 'derived' }); continue; }
    if (isAbsolute(expanded)) { locations.push({ root: resolve(expanded), server, source: 'declared' }); continue; }
    if (typeof definition?.cwd !== 'string') continue;
    const expandedCwd = expandStatePath(definition.cwd, canonical);
    if (/\$\{[^}]*\}/u.test(expandedCwd)) continue;
    const cwd = isAbsolute(expandedCwd) ? resolve(expandedCwd) : resolve(canonical, expandedCwd);
    locations.push({ root: resolve(cwd, expanded), server, source: 'declared' });
  }
  return locations;
};
const attachStateOwnership = async (previousState) => {
  const receipt = await readReceipt(destination);
  if (receipt === undefined) throw new Error(`Installed receipt is missing at ${destination}.`);
  const owner = previousState?.owner ?? { host: 'cursor', id: randomUUID(), mode: 'local', plugin: pluginName, scope: 'user' };
  const grouped = new Map();
  for (const location of await stateLocations()) {
    const current = grouped.get(location.root);
    if (current === undefined) grouped.set(location.root, { ...location, servers: [location.server] });
    else current.servers.push(location.server);
  }
  const roots = [];
  const created = [];
  const markerOwns = async (marker) => {
    let document;
    try { document = JSON.parse(await readFile(marker, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    const actual = document?.owner;
    return document?.format === 1 && actual?.id === owner.id && actual?.host === owner.host && actual?.mode === owner.mode &&
      actual?.plugin === owner.plugin && actual?.scope === owner.scope && actual?.projectRoot === owner.projectRoot;
  };
  const rollbackCreated = async () => {
    for (const root of [...created].reverse()) {
      await rm(join(root, stateMarkerFile), { force: true });
      try { await rmdir(root); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error; }
    }
  };
  try {
  for (const location of grouped.values()) {
    if (location.source === 'derived') { roots.push({ canonicalRoot: await canonicalPath(location.root), ownership: { kind: 'derived' }, root: location.root, servers: location.servers, source: 'derived' }); continue; }
    try {
    const marker = join(location.root, stateMarkerFile);
    let existed = true;
    try { await lstat(location.root); } catch (error) { if (error?.code !== 'ENOENT') throw error; existed = false; }
    let ownership;
    if (!existed) {
      await mkdir(dirname(location.root), { recursive: true });
      try {
        await mkdir(location.root);
        created.push(location.root);
        const handle = await open(marker, 'wx');
        try { await handle.writeFile(`${JSON.stringify({ format: 1, owner }, null, 2)}\n`, 'utf8'); } finally { await handle.close(); }
        ownership = { kind: 'marker', marker };
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          if (created.at(-1) === location.root) {
            created.pop();
            try { await rmdir(location.root); } catch (rollbackError) { if (!['ENOENT', 'ENOTEMPTY'].includes(rollbackError?.code)) throw rollbackError; }
          }
          throw error;
        }
        if (created.at(-1) === location.root) created.pop();
        ownership = await markerOwns(marker) ? { kind: 'marker', marker } : { kind: 'unowned', reason: 'foreign-marker' };
      }
    } else if (await markerOwns(marker)) ownership = { kind: 'marker', marker };
    else {
      let markerExists = true;
      try { await lstat(marker); } catch (error) { if (error?.code !== 'ENOENT') throw error; markerExists = false; }
      ownership = { kind: 'unowned', reason: markerExists ? 'foreign-marker' : 'pre-existing' };
    }
    roots.push({ canonicalRoot: await canonicalPath(location.root), ownership, root: location.root, servers: location.servers, source: 'declared' });
    } catch (error) {
      if (!['EACCES', 'ENOTDIR', 'EPERM', 'EROFS'].includes(error?.code)) throw error;
      if (created.at(-1) === location.root) {
        created.pop();
        await rm(join(location.root, stateMarkerFile), { force: true });
        try { await rmdir(location.root); } catch (rollbackError) { if (!['ENOENT', 'ENOTEMPTY'].includes(rollbackError?.code)) throw rollbackError; }
      }
      roots.push({ canonicalRoot: resolve(location.root), ownership: { kind: 'unowned', reason: 'unproven' }, root: location.root, servers: location.servers, source: 'declared' });
    }
  }
  } catch (error) { await rollbackCreated(); throw error; }
  try {
    await writeReceiptFile(join(destination, receiptFile), `${JSON.stringify({ ...receipt, state: { owner, roots }, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  } catch (error) {
    await rollbackCreated();
    throw error;
  }
};

// Staged sibling copy on the destination filesystem so every later rename is atomic.
const stage = async (tree, receiptOptions = {}) => {
  const parent = await mkdtemp(join(installRoot, `.${basename(destination)}.stage-`));
  const root = join(parent, 'bundle');
  try {
    // Exactly the inventoried content is copied: runtime roots, a stray receipt, and empty directories
    // (no plugin content: not hashed, not installed, not owned) never are.
    const content = new Set([...tree.files, ...directoriesOf(tree.files)]);
    const filter = (path) => {
      const relativePath = relative(source, path);
      return relativePath === '' || content.has(toPosix(relativePath));
    };
    await cp(source, root, { errorOnExist: true, filter, force: false, recursive: true, verbatimSymlinks: true });
    if (expansion !== undefined) await writeFile(join(root, expansion.mcpDocument), expansion.expanded, 'utf8');
    const staged = await artifactInventory(root);
    await writeFile(join(root, receiptFile), receiptFor(staged, receiptOptions), 'utf8');
    return { inventory: staged, parent, root };
  } catch (error) {
    await rm(parent, { force: true, recursive: true });
    throw error;
  }
};

// Prunes the now-empty ancestors of removed files, deepest first, but only installer-created ones:
// a pre-existing directory that merely became an ancestor of an owned file is not ours to delete.
const pruneEmptyDirectories = async (removed, ownedDirectories) => {
  const pruned = new Set();
  const candidates = directoriesOf(removed).filter((directory) => ownedDirectories.has(directory));
  for (const directory of candidates.sort((left, right) => right.length - left.length)) {
    try { await rmdir(join(destination, directory)); pruned.add(directory); }
    catch (error) { if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error?.code)) throw error; }
  }
  return pruned;
};
// Creates missing ancestors one level at a time and records the ones this run created.
const ensureAncestors = async (file, created) => {
  const ancestors = [];
  let directory = dirname(file);
  while (directory !== '.' && directory !== '') { ancestors.unshift(directory); directory = dirname(directory); }
  for (const ancestor of ancestors) {
    if (created.has(ancestor)) continue;
    try { await mkdir(join(destination, ancestor)); created.add(ancestor); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
};

// Unowned entries under root that survive the uninstall, POSIX-relative: files that are not owned (symlinks listed,
// never followed) plus unowned directories holding nothing retained (`name/`), which the prune never touches.
const listRetained = async (root, owned, ownedDirectories) => {
  const retained = [];
  const visit = async (relativePath) => {
    let entries;
    try { entries = (await readdir(join(root, relativePath))).sort((left, right) => left.localeCompare(right)); }
    catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
    let kept = 0;
    for (const name of entries) {
      const child = relativePath === '' ? name : `${relativePath}/${name}`;
      if (relativePath === '' && name === receiptFile) continue;
      const metadata = await lstat(join(root, child));
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        const below = await visit(child);
        if (below === 0 && !ownedDirectories.has(child)) retained.push(`${child}/`);
        kept += below === 0 && !ownedDirectories.has(child) ? 1 : below;
        continue;
      }
      if (!owned.has(child)) { retained.push(child); kept += 1; }
    }
    return kept;
  };
  await visit('');
  return retained;
};
// HEAD of a staged repository from its ref text (no git needed): the commit Cursor imports.
const readHead = async (repoRoot) => {
  try {
    const head = (await readFile(join(repoRoot, '.git', 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref: ')) return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(head) ? head : undefined;
    const ref = head.slice('ref: '.length);
    let resolved;
    try { resolved = (await readFile(join(repoRoot, '.git', ref), 'utf8')).trim(); }
    catch { resolved = (await readFile(join(repoRoot, '.git', 'packed-refs'), 'utf8')).split('\n').find((line) => line.endsWith(` ${ref}`))?.split(' ')[0]; }
    return resolved !== undefined && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(resolved) ? resolved : undefined;
  } catch { return undefined; }
};
const printPaths = (label, paths) => {
  console.log(`${label} ${paths.length} ${paths.length === 1 ? "entry" : "entries"}:`);
  for (const path of paths) console.log(`  ${path}`);
};
const runtimeStateRoots = async () => {
  const canonical = await realpath(destination);
  const inherited = process.env.AGENT_BUNDLE_STATE_ROOT ?? '';
  const inheritedStateRoot = inherited.trim() === '' || /\$\{[^}]*\}/u.test(inherited)
    ? undefined
    : isAbsolute(inherited) ? resolve(inherited) : resolve(canonical, inherited);
  let declared;
  for (const manifest of declaredDocument('mcp') === undefined ? ['.cursor-plugin/mcp.json', 'mcp.json'] : [declaredDocument('mcp')]) {
    let document;
    try { document = JSON.parse(await readFile(join(canonical, manifest), 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
    const servers = document !== null && typeof document === 'object' && !Array.isArray(document) ? document.mcpServers : undefined;
    if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const server of Object.values(servers)) {
      const env = server !== null && typeof server === 'object' && !Array.isArray(server) ? server.env : undefined;
      const value = env !== null && typeof env === 'object' && !Array.isArray(env) ? env.AGENT_BUNDLE_STATE_ROOT : undefined;
      if (typeof value !== 'string' || value.trim() === '') continue;
      const expanded = value.replaceAll('${CURSOR_PLUGIN_ROOT}', canonical).replaceAll('${PLUGIN_ROOT}', canonical);
      if (!/\$\{[^}]*\}/u.test(expanded)) declared = isAbsolute(expanded) ? resolve(expanded) : resolve(canonical, expanded);
      if (declared !== undefined) break;
    }
    if (declared !== undefined) break;
  }
  const xdg = process.env.XDG_STATE_HOME ?? '';
  const stateHome = isAbsolute(xdg) ? join(xdg, 'agent-bundle') : join(homedir(), '.agent-bundle', 'state');
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  const name = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u.test(basename(canonical)) ? basename(canonical) : 'plugin';
  const segment = `${name}-${digest}`;
  const explicitStateRoot = declared ?? inheritedStateRoot;
  const webCanonical = resolve(destination);
  const webDigest = createHash('sha256').update(webCanonical).digest('hex').slice(0, 16);
  const webName = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u.test(basename(webCanonical)) ? basename(webCanonical) : 'plugin';
  return [explicitStateRoot ?? join(stateHome, segment), join(homedir(), '.agent-bundle', 'web-data', `${webName}-${webDigest}`)];
};

if (uninstall && mode === 'local') {
  const notInstalled = () => { console.log(`Not installed ${pluginName}@${pluginVersion} for cursor (local mode) at ${destination}`); process.exit(0); };
  if (!(await exists(cursorRoot)) || !(await exists(destination))) notInstalled();
  const destinationMetadata = await lstat(destination);
  if (destinationMetadata.isSymbolicLink() || !destinationMetadata.isDirectory()) throw unsupported('.');
  const receipt = await readReceipt(destination);
  if (receipt === undefined) {
    const manifest = await readManifest(destination);
    throw new Error(`Refusing to uninstall foreign directory ${destination}: it carries no install receipt naming ${pluginName}` +
      `${manifest === undefined ? " (no loader manifest)" : ` (manifest names ${JSON.stringify(manifest.name)})`}. ` +
      'Remove it manually if it is stale; --force does not apply to foreign directories.');
  }
  if (receipt.plugin !== pluginName) {
    throw new Error(`Refusing to uninstall ${destination}: its install receipt names plugin ${JSON.stringify(receipt.plugin)}, not ` +
      `${JSON.stringify(pluginName)}. Uninstall that plugin from its own bundle instead; --force does not apply.`);
  }
  const installedHash = await hashOwned(destination, receipt.files);
  let receiptStatus = 'consumed';
  if (installedHash !== receipt.contentHash) {
    if (!force) {
      throw new Error(`Refusing to uninstall ${destination}: the owned files hash ${short(installedHash)} but the receipt recorded ` +
        `${short(receipt.contentHash)}, so the installed copy was modified after installation. Re-run with --force to remove the ` +
        'receipt-owned files anyway (unowned entries are never removed).');
    }
    receiptStatus = 'forced-mismatch';
  }
  const owned = receipt.files;
  const ownedDirectories = receipt.directories;
  const hostDirectories = receipt.hostDirectories;
  // A symlinked ancestor would let a leaf-only delete reach outside the plugin root: refused before any change.
  await assertRealAncestors(destination, owned);
  const files = [];
  for (const file of owned) {
    const path = join(destination, file);
    let metadata;
    try { metadata = await lstat(path); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw unsupported(file);
    files.push(path);
  }
  files.push(join(destination, receiptFile));
  const [resolvedStateDirectory, resolvedWebDataDirectory] = await runtimeStateRoots();
  const retainedState = [];
  const ownedStatePaths = [];
  const emptyOwnedStateFiles = [];
  const emptyOwnedStateRoots = [];
  if (receipt.state !== undefined) {
    for (const root of receipt.state.roots) {
      let metadata;
      try { metadata = await lstat(root.root); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      if (root.ownership.kind === 'unowned') { retainedState.push({ path: root.root, reason: root.ownership.reason }); continue; }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) { retainedState.push({ path: root.root, reason: 'unsupported-entry' }); continue; }
      if (await realpath(root.root) !== root.canonicalRoot) { retainedState.push({ path: root.root, reason: 'canonical-path-changed' }); continue; }
      if (root.ownership.kind === 'marker') {
        let marker;
        try { marker = JSON.parse(await readFile(root.ownership.marker, 'utf8')); } catch { marker = undefined; }
        const owner = marker?.owner;
        const expected = receipt.state.owner;
        if (root.ownership.marker !== join(root.root, stateMarkerFile) || marker?.format !== 1 || owner?.id !== expected.id ||
          owner?.host !== expected.host || owner?.mode !== expected.mode || owner?.plugin !== expected.plugin ||
          owner?.scope !== expected.scope || owner?.projectRoot !== expected.projectRoot) { retainedState.push({ path: root.root, reason: 'marker-mismatch' }); continue; }
      }
      const entries = await readdir(root.root);
      if (entries.length === 0 || (root.ownership.kind === 'marker' && entries.length === 1 && entries[0] === stateMarkerFile)) {
        emptyOwnedStateRoots.push(root.root);
        if (root.ownership.kind === 'marker') emptyOwnedStateFiles.push(root.ownership.marker);
        continue;
      }
      ownedStatePaths.push(root.root);
    }
  } else {
    // A receipt without a state block was written between the two receipt writes of an install: the observed root
    // is real but unproven, so it is retained until a reinstall records ownership.
    let metadata;
    try { metadata = await lstat(resolvedStateDirectory); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (metadata?.isDirectory()) retainedState.push({ path: resolvedStateDirectory, reason: 'unproven' });
  }
  const webDataDirectory = receipt.webDataRoot ?? resolvedWebDataDirectory;
  const dataPaths = [...ownedStatePaths];
  let webDataMetadata;
  try { webDataMetadata = await lstat(webDataDirectory); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (webDataMetadata !== undefined) {
    if (webDataMetadata.isSymbolicLink() || !webDataMetadata.isDirectory()) throw unsupported(webDataDirectory);
    dataPaths.push(webDataDirectory);
  }
  const dataKinds = dataPaths.map((path) => ownedStatePaths.includes(path) ? `owned framework state root ${path}` : `web-data directory ${path}`);
  // The receipt's cursorExpansion records the PLUGIN_DATA directory this installer created for the copy (spec 9.1). Only
  // the directory at this home's own plugin-data location is receipt-owned; a written one is durable state (kept or
  // purged like an owned state root), an empty one is an installer-created directory that is pruned, a recorded path elsewhere is left alone.
  const recordedPluginData = receipt.cursorExpansion?.pluginData;
  const pluginDataRecorded = recordedPluginData === pluginData;
  let emptyPluginData;
  let foreignNote = "";
  if (recordedPluginData !== undefined && !pluginDataRecorded) {
    foreignNote = ` The receipt records PLUGIN_DATA at ${recordedPluginData}, outside this home's agent-bundle/plugin-data; it is not touched.`;
  } else if (pluginDataRecorded) {
    // Reached only through real directories: a symlinked agent-bundle or plugin-data ancestor would let a recursive purge
    // of the leaf follow it outside the Cursor home, so any link on the way is refused before anything is read or removed.
    let pluginDataMetadata;
    for (const directory of [join(cursorRoot, 'agent-bundle'), join(cursorRoot, 'agent-bundle', 'plugin-data'), pluginData]) {
      pluginDataMetadata = undefined;
      try { pluginDataMetadata = await lstat(directory); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (pluginDataMetadata === undefined) break;
      if (pluginDataMetadata.isSymbolicLink() || !pluginDataMetadata.isDirectory()) throw unsupported(relative(cursorRoot, directory));
    }
    if (pluginDataMetadata !== undefined) {
      if ((await readdir(pluginData)).length === 0) emptyPluginData = pluginData;
      else { dataPaths.push(pluginData); dataKinds.push(`the PLUGIN_DATA directory ${pluginData}`); }
    }
  }
  const retainedStateNote = retainedState.length === 0 ? '' : ` Retained ${retainedState.map((entry) => `${entry.path} (${entry.reason})`).join(', ')} because the receipt does not prove exclusive ownership.`;
  const dataOutcome = dataPaths.length === 0 ? retainedState.length === 0 ? 'absent' : 'kept' : purgeData ? 'purged' : 'kept';
  const dataDetail = dataPaths.length === 0 && retainedState.length === 0
    ? `No durable runtime state exists${emptyPluginData === undefined ? '' : ` (the installer-created PLUGIN_DATA directory ${emptyPluginData} is empty and is pruned)`}.${foreignNote}`
    : purgeData
      ? `${dataPaths.length === 0 ? 'No owned durable runtime state is removed.' : `Durable runtime state — ${dataKinds.join(' and ')} — is removed (--purge-data --confirm-purge).`}${retainedStateNote}${foreignNote}`
      : `Durable runtime state${dataKinds.length === 0 ? '' : ` — ${dataKinds.join(' and ')}`} — is kept; pass --purge-data --confirm-purge to remove owned roots.${retainedStateNote}${foreignNote}`;
  // External state kept by --keep-data needs the remnant receipt and recorded ownership so a later purge
  // removes the same root even though no plugin content remains.
  const keepRoot = !purgeData && (dataPaths.length > 0 || retainedState.length > 0);
  const directories = [
    ...ownedDirectories.map((directory) => join(destination, directory)),
    ...(keepRoot ? [] : [destination]),
    ...hostDirectories.map((directory) => join(cursorRoot, directory)),
    ...(emptyPluginData === undefined ? [] : [emptyPluginData]),
    ...(pluginDataRecorded ? [join(cursorRoot, 'agent-bundle', 'plugin-data'), join(cursorRoot, 'agent-bundle')] : []),
    ...emptyOwnedStateRoots,
  ].sort((left, right) => right.length - left.length || left.localeCompare(right));
  files.push(...emptyOwnedStateFiles);
  const ownedSet = new Set(owned);
  const ownedDirectorySet = new Set(ownedDirectories);
  const remnantOnly = receipt.files.length === 0 && receipt.registrations.length === 0;
  const purging = purgeData && dataPaths.length > 0;
  // A keep-data rerun over a remnant whose preserved data (or retained unowned entries) are still there is the documented
  // no-op. Once the recorded roots and the PLUGIN_DATA directory are gone or emptied by hand the remnant guards nothing, and
  // the rerun consumes it (receipt, empty plugin root, the host and plugin-data directories it recorded) like an explicit purge would.
  const remnantGuards = dataPaths.length > 0 || retainedState.length > 0 || (await listRetained(destination, ownedSet, ownedDirectorySet)).length > 0;
  if (remnantOnly && !purgeData && remnantGuards && files.length === 1 && files[0] === join(destination, receiptFile)) {
    // A rerun over what an earlier --keep-data uninstall left behind, still keeping the data: nothing to remove, so the
    // remnant receipt stays and the run is the documented no-op.
    console.log(`Not installed ${pluginName}@${pluginVersion} for cursor (local mode) at ${destination}`);
    console.log(`Receipt: remnant (${join(destination, receiptFile)}) — only preserved runtime state remains from an earlier --uninstall --keep-data; pass --purge-data --confirm-purge to remove it.`);
    process.exit(0);
  }
  const purgedDirectories = purging ? dataPaths : [];
  const summary = (verb) => {
    console.log(`${verb} ${pluginName}@${pluginVersion} for cursor (local mode) at ${destination}${force ? ' [--force]' : ''}`);
    console.log(`Receipt: ${receiptStatus} (${join(destination, receiptFile)})`);
    console.log(remnantOnly
      ? 'Registration cursor-local-plugin: already-absent — Only preserved runtime state remained from an earlier --uninstall --keep-data; no plugin content was registered.'
      : `Registration cursor-local-plugin: ${verb === 'Would uninstall' ? 'planned' : 'removed'} — Cursor loads plugins/local/<name> directly; removing the directory unregisters the plugin at the next window reload.`);
  };
  if (plan) {
    summary('Would uninstall');
    printPaths('Would remove file', files);
    // Exactly the directories the run would prune: deepest first, once everything they hold is itself removed.
    const gone = new Set([...files, ...purgedDirectories]);
    const prunable = [];
    for (const directory of directories) {
      let entries;
      try { entries = await readdir(directory); } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue; throw error; }
      if (entries.every((entry) => gone.has(join(directory, entry)))) { gone.add(directory); prunable.push(directory); }
    }
    printPaths('Would remove directory', [...purgedDirectories, ...prunable]);
    console.log(`Data (${purgeData ? 'purge' : 'keep'}): ${dataOutcome} — ${dataDetail}`);
    for (const path of dataPaths) console.log(`  ${path}`);
    for (const entry of retainedState) console.log(`  retained ${entry.path}: ${entry.reason}`);
    const retained = await listRetained(destination, ownedSet, ownedDirectorySet);
    if (retained.length > 0) printPaths(`Retained unowned under ${destination}:`, retained);
    if (!prunable.includes(destination)) console.log(`Remnant receipt (would be written): ${join(destination, receiptFile)} — owns no files; keeps the created host directories receipt-owned for a later purge.`);
    process.exit(0);
  }
  for (const path of files) await rm(path, { force: true });
  for (const path of purgedDirectories) await rm(path, { force: true, recursive: true });
  const pruned = [];
  for (const directory of directories) if (await rmdirIfEmpty(directory)) pruned.push(directory);
  summary('Uninstalled');
  printPaths('Removed file', files);
  printPaths('Removed directory', [...purgedDirectories, ...pruned]);
  console.log(`Data (${purgeData ? 'purge' : 'keep'}): ${dataOutcome} — ${dataDetail}`);
  for (const path of dataPaths) console.log(`  ${path}`);
  const retained = await exists(destination) ? await listRetained(destination, ownedSet, ownedDirectorySet) : [];
  if (retained.length > 0) printPaths(`Retained unowned under ${destination}:`, retained);
  if (await exists(destination)) {
    // The plugin root survives (retained runtime state or unowned entries): a remnant receipt owning no files keeps the
    // created host directories receipt-owned for a later purge and lets Doctor explain the directory; a reinstall fills it in.
    await writeReceiptFile(join(destination, receiptFile), receiptFor({ files: [], hash: createHash('sha256').digest('hex') }, {
      // A kept PLUGIN_DATA directory stays receipt-owned through the remnant's expansion record.
      ...(keepRoot && receipt.cursorExpansion !== undefined ? { cursorExpansion: receipt.cursorExpansion } : {}),
      directories: [], hostDirectories, installedAt: receipt.installedAt, registrations: [],
      ...(receipt.state === undefined ? {} : { state: receipt.state }),
      ...(keepRoot ? { webDataRoot: webDataDirectory } : {}),
    }));
    console.log(`Remnant receipt: ${join(destination, receiptFile)} — owns no files; keeps the created host directories receipt-owned for a later purge.`);
  }
  process.exit(0);
}

if (uninstall && mode === 'marketplace') {
  const receipt = await exists(cursorRoot) ? await readReceiptFile(marketplaceReceipt) : undefined;
  const repoExists = await exists(cursorRoot) && await exists(marketplaceRepo);
  if (repoExists) {
    const repoMetadata = await lstat(marketplaceRepo);
    if (repoMetadata.isSymbolicLink() || !repoMetadata.isDirectory()) throw unsupported(relative(cursorRoot, marketplaceRepo));
  }
  if (!repoExists && receipt === undefined) {
    console.log(`Not installed ${pluginName}@${pluginVersion} for cursor (marketplace mode) at ${marketplaceRepo}`);
    process.exit(0);
  }
  let receiptStatus = receipt === undefined ? 'forced-missing' : 'consumed';
  const recorded = receipt?.registrations.find((registration) => registration.kind === 'cursor-marketplace-staging');
  if (repoExists) {
    if (receipt === undefined) {
      if (!force) {
        throw new Error(`Refusing to remove staged Cursor marketplace ${marketplaceRepo} without an install receipt at ${marketplaceReceipt}. ` +
          'Re-run with --force to remove it after verifying it is this plugin\'s staging, or rerun `node install.mjs --mode marketplace` to record a receipt first.');
      }
      let stagedName;
      try { stagedName = JSON.parse(await readFile(join(marketplaceRepo, '.cursor-plugin', 'marketplace.json'), 'utf8'))?.name; }
      catch (error) { if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      const stagedPlugin = await readManifest(marketplacePlugin);
      if (stagedName !== `${pluginName}-marketplace` || stagedPlugin?.name !== pluginName) {
        throw new Error(`Refusing to remove ${marketplaceRepo}: it is not a staged Agent Bundle marketplace for ${pluginName} ` +
          `(expected .cursor-plugin/marketplace.json naming ${pluginName}-marketplace and plugins/${pluginName}). --force does not apply.`);
      }
    } else if (receipt.plugin !== pluginName) {
      throw new Error(`Refusing to remove ${marketplaceRepo}: the receipt at ${marketplaceReceipt} names plugin ${JSON.stringify(receipt.plugin)}.`);
    } else if (recorded?.commit !== undefined) {
      const head = await readHead(marketplaceRepo);
      if (head !== recorded.commit) {
        if (!force) {
          throw new Error(`Refusing to remove ${marketplaceRepo}: its HEAD is ${head ?? 'unresolvable'} but the receipt recorded commit ` +
            `${recorded.commit}, so the staged repository changed after staging. Re-run with --force to remove it anyway.`);
        }
        receiptStatus = 'forced-mismatch';
      } else {
        // HEAD matching the receipt proves the commit, not the working tree: entries added since staging are not
        // receipt-owned and the removal below is recursive. Unverifiable (no git, status failing) is dirt too.
        const dirt = await new Promise((resolvePromise) => {
          execFile('git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all', '--ignored=matching'], { cwd: marketplaceRepo }, (error, stdout, stderr) => {
            if (error?.code === 'ENOENT') { resolvePromise('git is not available on PATH, so the staged working tree cannot be verified against the receipted commit.'); return; }
            if (error) { resolvePromise(`\`git status\` failed in the staged repository (${(stderr || error.message).trim()}), so its working tree cannot be verified against the receipted commit.`); return; }
            const entries = stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '');
            if (entries.length === 0) { resolvePromise(undefined); return; }
            const shown = entries.slice(0, 5).map((line) => JSON.stringify(line.slice(3))).join(', ');
            resolvePromise(`its working tree differs from the receipted commit (${entries.length} uncommitted, untracked, or ignored ${entries.length === 1 ? 'entry' : 'entries'}: ${shown}${entries.length > 5 ? ', …' : ''}) that the receipt does not own.`);
          });
        });
        if (dirt !== undefined) {
          if (!force) {
            throw new Error(`Refusing to remove ${marketplaceRepo}: ${dirt} Move those entries out (or commit them and rerun ` +
              '`node install.mjs --mode marketplace`), or re-run with --force to remove them anyway.');
          }
          receiptStatus = 'forced-mismatch';
        }
      }
    }
  }
  // A completed copy from this staging under Cursor's cache means Cursor imported it; that copy is Cursor-owned.
  const cacheSegment = (value) => value.replaceAll(/[^A-Za-z0-9._-]/gu, '-');
  // Whether the staged repository still exists or not: the receipt's commit is what identifies the imported copy.
  let imported = false;
  if (recorded?.commit !== undefined) {
    imported = await exists(join(cursorRoot, 'plugins', 'cache', cacheSegment(`${pluginName}-marketplace`), cacheSegment(pluginName), cacheSegment(recorded.commit), '.cache-complete'));
  }
  const files = await exists(marketplaceReceipt) ? [marketplaceReceipt] : [];
  const directories = repoExists ? [marketplaceRepo] : [];
  const summary = (verb) => {
    console.log(`${verb} ${pluginName}@${pluginVersion} for cursor (marketplace mode) at ${marketplaceRepo}${force ? ' [--force]' : ''}`);
    console.log(`Receipt: ${receiptStatus} (${marketplaceReceipt})`);
    console.log(`Registration cursor-marketplace-staging ${pluginName}-marketplace: ${repoExists ? (verb === 'Would uninstall' ? 'planned' : 'removed') : 'already-absent'}`);
    if (imported) {
      console.log(`Registration cursor-marketplace-staging ${pluginName}-marketplace: manual — Cursor imported this marketplace; its installed-plugin registry is server-assigned and exposes no non-interactive removal verb.`);
    }
  };
  const finish = (verb, removedDirectories) => {
    printPaths(verb === 'Would uninstall' ? 'Would remove file' : 'Removed file', files);
    printPaths(verb === 'Would uninstall' ? 'Would remove directory' : 'Removed directory', removedDirectories);
    console.log(`Data (${purgeData ? 'purge' : 'keep'}): unavailable — A staged marketplace repository holds no runtime state; a copy Cursor imported from it is Cursor-owned and is not touched.`);
    if (imported) {
      console.log('Next steps:');
      console.log(`  1. Open Cursor, then Customize -> Plugins, and uninstall "${pluginName}" (marketplace ${pluginName}-marketplace) there.`);
    }
  };
  if (plan) {
    // The plan names exactly what the run would prune: each parent below is removed only once every entry in it is gone.
    const gone = new Set([...files, ...directories]);
    const prunable = [];
    for (const directory of [receiptsRoot, marketplaceRoot, join(cursorRoot, 'agent-bundle')]) {
      let entries;
      try { entries = await readdir(directory); } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue; throw error; }
      if (entries.every((entry) => gone.has(join(directory, entry)))) { gone.add(directory); prunable.push(directory); }
    }
    summary('Would uninstall');
    finish('Would uninstall', [...directories, ...prunable]);
    process.exit(0);
  }
  if (repoExists) await rm(marketplaceRepo, { force: true, recursive: true });
  for (const path of files) await rm(path, { force: true });
  const pruned = [...directories];
  for (const directory of [receiptsRoot, marketplaceRoot, join(cursorRoot, 'agent-bundle')]) if (await rmdirIfEmpty(directory)) pruned.push(directory);
  summary('Uninstalled');
  finish('Uninstalled', pruned);
  process.exit(0);
}

if (!(await exists(cursorRoot)) || !(await lstat(cursorRoot)).isDirectory()) {
  throw new Error(`Cursor is not installed in ${cursorRoot}.`);
}

const git = (cwd, args) => new Promise((resolvePromise, reject) => {
  execFile('git', args, { cwd }, (error, stdout, stderr) => {
    if (error?.code === 'ENOENT') {
      reject(new Error('git is required for --mode marketplace; install git or use the default local mode.'));
      return;
    }
    if (error) { reject(new Error(`git ${args[0]} failed: ${(stderr || stdout || error.message).trim()}`)); return; }
    resolvePromise(stdout.trim());
  });
});

const printMarketplaceSteps = (state, commit) => {
  console.log(`${state} ${pluginName}@${pluginVersion} for cursor (marketplace mode) at ${marketplaceRepo}`);
  console.log(`Marketplace: ${pluginName}-marketplace${commit ? ` @ ${commit}` : ''}`);
  console.log('Next steps:');
  console.log(`  1. Open Cursor, then Customize -> Plugins -> "Add Plugins from Local Repository" and select ${marketplaceRepo}.`);
  console.log(`  2. Choose "${pluginName}" in the imported marketplace and select Install (user scope).`);
  console.log('  3. Verify with `agent-bundle doctor --host cursor`: the plugin must appear under ~/.cursor/plugins/cache once Cursor has installed it.');
};

const marketplaceManifestPath = join(marketplaceRepo, '.cursor-plugin', 'marketplace.json');
// The staged repository is a committed Git tree, so its receipt lives in the store beside it; the recorded
// commit lets --uninstall prove the repository is still the one staging wrote.
const writeMarketplaceReceipt = async (commit) => {
  const previous = await readReceiptFile(marketplaceReceipt);
  const tree = await artifactInventory(source);
  if (previous !== undefined && previous.contentHash === tree.hash && previous.registrations[0]?.commit === commit) return;
  await mkdir(receiptsRoot, { recursive: true });
  // The committed repository is removed wholesale after a HEAD check; the receipt owns no individual files.
  await writeReceiptFile(marketplaceReceipt, receiptFor({ files: [], hash: tree.hash }, {
    directories: [],
    hostDirectories: [],
    installedAt: previous?.installedAt,
    mode: 'marketplace',
    registrations: [{ ...(commit ? { commit } : {}), kind: 'cursor-marketplace-staging', name: `${pluginName}-marketplace` }],
  }));
};

if (mode === 'marketplace' && (cursorPluginDocument !== '.cursor-plugin/plugin.json' || !(await exists(join(source, cursorPluginDocument))))) {
  throw new Error('--mode marketplace requires a Cursor Plugin (.cursor-plugin/plugin.json); Cursor marketplaces resolve plugins/<name>/.cursor-plugin/plugin.json. This bundle is an Agent Plugins (root plugin.json) pack: use the default local mode.');
}
// Owner and description come from the emitted .cursor-plugin/plugin.json, exactly as `agent-bundle install
// cursor --mode marketplace` derives them, so both entry points stage byte-identical marketplace manifests.
const marketplaceManifestFor = async () => {
  const manifest = JSON.parse(await readFile(join(source, cursorPluginDocument), 'utf8'));
  const owner = typeof manifest?.author?.name === 'string' ? manifest.author.name : pluginName;
  const description = typeof manifest?.description === 'string' ? { description: manifest.description } : {};
  // Entry fields are limited to the pinned Cursor marketplace schema (name/source/description).
  return `${JSON.stringify({
    metadata: { description: `Agent Bundle local marketplace for ${pluginName}@${pluginVersion}.` },
    name: `${pluginName}-marketplace`,
    owner: { name: owner },
    plugins: [{ ...description, name: pluginName, source: `plugins/${pluginName}` }],
  }, null, 2)}\n`;
};
const blobIndex = async (root, relative = '') => {
  const index = new Map();
  for (const name of await readdir(join(root, relative))) {
    if (relative === '' && name === '.git') continue;
    const child = relative === '' ? name : `${relative}/${name}`;
    const metadata = await lstat(join(root, child));
    if (metadata.isDirectory()) {
      for (const [path, id] of await blobIndex(root, child)) index.set(path, id);
    } else if (metadata.isFile()) {
      const bytes = await readFile(join(root, child));
      index.set(child, createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'));
    }
  }
  return index;
};
const findNestedGit = async (root, relative = '') => {
  for (const name of (await readdir(join(root, relative))).sort()) {
    const child = relative === '' ? name : join(relative, name);
    if (name === '.git') return child;
    const metadata = await lstat(join(root, child));
    if (!metadata.isSymbolicLink() && metadata.isDirectory()) {
      const nested = await findNestedGit(root, child);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
};
if (mode === 'marketplace') {
  const marketplaceManifest = await marketplaceManifestFor();
  const nestedGit = await findNestedGit(source);
  if (nestedGit !== undefined) {
    throw new Error(`--mode marketplace refuses bundle-internal Git metadata at ${JSON.stringify(nestedGit)}: git would record it as an empty gitlink and Cursor would import a plugin without files. Stage from a built bundle directory without .git, or use the default local mode.`);
  }
  await artifactInventory(source);
  await mkdir(marketplaceRoot, { recursive: true });
  if (await exists(marketplaceRepo)) {
    let stagedVersion;
    try { stagedVersion = JSON.parse(await readFile(join(marketplacePlugin, cursorPluginDocument), "utf8")).version; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (stagedVersion !== undefined && stagedVersion !== pluginVersion) {
      throw new Error(`Refusing version collision at ${marketplaceRepo}: found ${stagedVersion}, requested ${pluginVersion}.`);
    }
    // The staged plugin is an unfiltered copy of the bundle, so both sides hash the files present.
    if (await exists(marketplacePlugin) && await exists(join(marketplaceRepo, '.git')) && await treeHash(source) === await treeHash(marketplacePlugin)) {
      let stagedManifest;
      try { stagedManifest = await readFile(marketplaceManifestPath, 'utf8'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (stagedManifest !== marketplaceManifest) {
        throw new Error(`Refusing content collision at ${marketplaceRepo}: .cursor-plugin/marketplace.json differs from the generated marketplace manifest; remove the staged repository and rerun.`);
      }
      if (await git(marketplaceRepo, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']) !== '') {
        throw new Error(`Refusing content collision at ${marketplaceRepo}: the working tree differs from the committed HEAD Cursor would import; remove the staged repository and rerun.`);
      }
      const commit = await git(marketplaceRepo, ['rev-parse', 'HEAD']);
      await writeMarketplaceReceipt(commit);
      printMarketplaceSteps('Already staged', commit);
      process.exit(0);
    }
    throw new Error(`Refusing content collision at ${marketplaceRepo}.`);
  }
  const stageParent = await mkdtemp(join(marketplaceRoot, `.${pluginName}.stage-`));
  const stage = join(stageParent, 'repo');
  try {
    await mkdir(join(stage, '.cursor-plugin'), { recursive: true });
    await cp(source, join(stage, 'plugins', pluginName), { errorOnExist: true, force: false, recursive: true, verbatimSymlinks: true });
    await writeFile(join(stage, '.cursor-plugin', 'marketplace.json'), marketplaceManifest);
    await treeHash(join(stage, 'plugins', pluginName));
    await git(stage, ['init', '-q', '--object-format=sha1']);
    // Attributes (text/eol/filter/ident) would rewrite bytes in the index while leaving the tree clean; disable them.
    await mkdir(join(stage, '.git', 'info'), { recursive: true });
    await writeFile(join(stage, '.git', 'info', 'attributes'), '* -text -eol -filter -ident -working-tree-encoding -export-ignore -export-subst\n');
    await git(stage, ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', 'add', '--all', '--force']);
    await git(stage, ['-c', 'user.name=agent-bundle', '-c', 'user.email=agent-bundle@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `${pluginName}@${pluginVersion}`]);
    // Prove the commit holds the staged bytes: every blob id must equal sha1("blob <len>\0" + bytes).
    const expected = await blobIndex(stage);
    const committed = new Map();
    for (const entry of (await git(stage, ['ls-tree', '-r', '-z', 'HEAD'])).split('\0')) {
      if (entry === '') continue;
      const tab = entry.indexOf('\t');
      committed.set(entry.slice(tab + 1), entry.slice(0, tab).split(' ')[2]);
    }
    const drifted = [...expected].filter(([path, id]) => committed.get(path) !== id).map(([path]) => path);
    const extra = [...committed.keys()].filter((path) => !expected.has(path));
    if (drifted.length > 0 || extra.length > 0) {
      throw new Error(`Cursor marketplace staging failed: the committed tree differs from the staged bundle bytes (${[...drifted, ...extra].map((path) => JSON.stringify(path)).join(', ')}); a Git attribute or filter transformed them.`);
    }
    const commit = await git(stage, ['rev-parse', 'HEAD']);
    await rename(stage, marketplaceRepo);
    await writeMarketplaceReceipt(commit);
    printMarketplaceSteps('Staged', commit);
  } finally {
    await rm(stageParent, { force: true, recursive: true });
  }
  process.exit(0);
}

// The artifact is inventoried (and any unsupported entry refused) before anything is created in the home.
const artifact = await artifactInventory(source, cursorTransform);
// The receipt records which host directories this run creates on the way to the plugin root (a fresh Cursor
// home has no plugins/local), so --uninstall can prune exactly those and no more.
const createdHostDirectories = [];
for (const relativePath of ['plugins', 'plugins/local']) {
  if (!(await exists(join(cursorRoot, relativePath)))) createdHostDirectories.push(relativePath);
}
await mkdir(installRoot, { recursive: true });
// Spec 9.1: the data directory exists before any plugin subprocess is launched.
if (expansion !== undefined) await mkdir(pluginData, { recursive: true });
const reportExpansion = () => {
  if (expansion === undefined) return;
  console.log(`Expanded Agent Plugins placeholders for Cursor in ${expansion.mcpDocument}: PLUGIN_ROOT=${destination} PLUGIN_DATA=${pluginData} (Cursor does not expand them; recorded in ${receiptFile})`);
};

if (!(await exists(destination))) {
  const staged = await stage(artifact, { hostDirectories: createdHostDirectories });
  try {
    await rename(staged.root, destination);
    await attachStateOwnership();
    console.log(`Installed ${pluginName}@${pluginVersion} at ${destination} (content ${short(artifact.hash)})`);
    reportExpansion();
  } finally {
    await rm(staged.parent, { force: true, recursive: true });
  }
  process.exit(0);
}
if (source === destination) {
  console.log(`Already installed ${pluginName}@${pluginVersion} at ${destination} (content ${short(artifact.hash)})`);
  process.exit(0);
}

const destinationMetadata = await lstat(destination);
if (destinationMetadata.isSymbolicLink() || !destinationMetadata.isDirectory()) throw unsupported('.');
const receipt = await readReceipt(destination);
const manifest = await readManifest(destination);
let ownership;
let installedHash;
// --uninstall --keep-data leaves a remnant receipt owning no files around the preserved durable state: a reinstall
// fills the shell back in instead of refusing it.
const remnant = receipt !== undefined && receipt.plugin === pluginName && receipt.files.length === 0 && receipt.registrations.length === 0;
if (receipt !== undefined && receipt.plugin === pluginName) {
  ownership = 'receipt';
  installedHash = await hashOwned(destination, receipt.files);
} else {
  installedHash = (await inventory(destination)).hash;
  ownership = 'foreign';
}
const installedVersion = manifest?.version ?? (ownership === 'receipt' ? receipt.version : undefined);
const installedName = manifest?.name ?? (ownership === 'receipt' ? receipt.plugin : pluginName);
const sameContent = installedHash === artifact.hash;
const verdict = installedVersion === undefined
  ? (sameContent ? 'same content, installed version unknown' : 'different content, installed version unknown')
  : installedVersion === pluginVersion
    ? (sameContent ? 'same content' : 'same version, different content')
    : (sameContent ? 'same content, different version' : 'different version');
const detail = `installed ${installedName}@${installedVersion ?? 'unknown version'} content ${short(installedHash)} ` +
  `vs artifact ${pluginName}@${pluginVersion} content ${short(artifact.hash)} (${verdict})`;
// Foreign ownership wins over byte equality: a directory that is not ours is never current.
if (ownership === 'foreign') {
  throw new Error(`Refusing foreign install at ${destination}: ${detail}; the directory is not an agent-bundle install of ` +
    `${pluginName}, so --replace does not apply. Remove it manually if it is stale.`);
}
// A receipt-managed copy is current only when its recorded inventory matches the artifact too.
const inventoryMatches = ownership !== 'receipt' ||
  (receipt.files.length === artifact.files.length && receipt.files.every((file, index) => file === artifact.files[index]));
if (installedHash === artifact.hash && inventoryMatches) {
  if (receipt.state === undefined) await attachStateOwnership();
  console.log(`Already installed ${pluginName}@${pluginVersion} at ${destination} (content ${short(artifact.hash)})`);
  process.exit(0);
}
if (installedVersion !== undefined && installedVersion !== pluginVersion && !replace) {
  throw new Error(`Refusing version collision at ${destination}: ${detail}. Re-run with --replace to replace this agent-bundle install.`);
}

// Owned-files-only replacement: stale owned files leave first, staged files rename over their
// predecessors, and the receipt lands last as the commit marker. Unowned entries (runtime state) stay.
const staged = await stage(artifact);
try {
  const incoming = new Set(staged.inventory.files);
  const owned = receipt.files;
  const ownedSet = new Set(owned);
  const ownedDirectories = new Set(receipt.directories);
  await assertRealAncestors(destination, owned);
  await assertRealAncestors(destination, staged.inventory.files, ownedSet);
  // An existing directory at an incoming file path is fine only when it is wholly owned: it and every
  // directory beneath were created by the installer, at least one file, every file owned, and no empty
  // directory anywhere beneath (no evidence of ownership).
  const isWhollyOwnedDirectory = async (relativePath) => {
    let files = 0;
    const visit = async (directory) => {
      if (!(await isOwnedEntry(destination, ownedDirectories, directory))) return false;
      const entries = (await readdir(join(destination, directory))).sort((left, right) => left.localeCompare(right));
      if (entries.length === 0) return false;
      for (const name of entries) {
        const relative = `${directory}/${name}`;
        const metadata = await lstat(join(destination, relative));
        if (metadata.isSymbolicLink()) throw unsupported(relative);
        if (metadata.isDirectory()) { if (!(await visit(relative))) return false; continue; }
        if (!metadata.isFile() || !(await isOwnedEntry(destination, ownedSet, relative))) return false;
        files += 1;
      }
      return true;
    };
    return (await visit(relativePath)) && files > 0;
  };
  const collisions = [];
  for (const file of staged.inventory.files) {
    if (ownedSet.has(file)) continue;
    const target = join(destination, file);
    let metadata;
    try { metadata = await lstat(target); } catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue; throw error; }
    const tolerated = metadata.isDirectory() && !metadata.isSymbolicLink()
      ? await isWhollyOwnedDirectory(file)
      : metadata.isFile() && await isOwnedEntry(destination, ownedSet, file);
    if (!tolerated) collisions.push(file);
  }
  if (collisions.length > 0) {
    throw new Error(`Refusing to overwrite unowned files at ${destination}: ${collisions.join(', ')}. Move them aside manually before replacing.`);
  }
  const stale = owned.filter((file) => !incoming.has(file));
  for (const file of stale) await rm(join(destination, file), { force: true });
  const pruned = await pruneEmptyDirectories(stale, ownedDirectories);
  const created = new Set();
  for (const file of staged.inventory.files) {
    await ensureAncestors(file, created);
    await rename(join(staged.root, file), join(destination, file));
  }
  // The receipt owns what the installer owns now: surviving directories it created before plus the
  // ones this replacement created; the first install time and the host directories it created carry
  // over. Finalised in the private staging copy, then committed by rename.
  const directories = sortNames(new Set([...[...ownedDirectories].filter((directory) => !pruned.has(directory)), ...created]));
  await writeFile(join(staged.root, receiptFile), receiptFor(staged.inventory, {
    directories, hostDirectories: receipt.hostDirectories, installedAt: receipt.installedAt,
  }), 'utf8');
  await rename(join(staged.root, receiptFile), join(destination, receiptFile));
  await attachStateOwnership(receipt.state);
  if (remnant) console.log(`Installed ${pluginName}@${pluginVersion} at ${destination} (content ${short(artifact.hash)})`);
  else console.log(`Replaced ${pluginName}@${pluginVersion} at ${destination} (content ${short(installedHash)} -> ${short(artifact.hash)})`);
  reportExpansion();
} finally {
  await rm(staged.parent, { force: true, recursive: true });
}
