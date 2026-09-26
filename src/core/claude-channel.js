import { randomUUID } from 'node:crypto';
import { mkdir, lstat, chmod, unlink } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_BYTES = 65536;
const FRAME_BYTES = MAX_BYTES * 6 + 1024;
const defaultDirectory = () => join(homedir(), '.grok-bot-cli', 'claude');
function socketPath(name, directory) {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name ?? '')) throw Error('Invalid Claude channel name');
  if (process.platform === 'win32') throw Error('Claude channels currently require Unix sockets');
  const path = join(directory, `${name}.sock`);
  if (Buffer.byteLength(path) >= 104) throw Error('Claude channel socket path is too long');
  return path;
}
function messageText(message) {
  if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > MAX_BYTES)
    throw Error('Message must contain text within 64 KiB');
  return message;
}
function timeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > 120000) throw Error('timeoutMs must be 1..120000');
  return value;
}
async function privateDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077))
    throw Error('Claude channel directory must be owned by this user with mode 0700');
}
function readFrame(socket, receive) {
  let chunks = [], bytes = 0, finished = false;
  socket.on('data', chunk => {
    if (finished) return;
    bytes += chunk.length;
    if (bytes > FRAME_BYTES) { finished = true; socket.destroy(); return; }
    chunks.push(chunk);
    if (!chunk.includes(10)) return;
    finished = true;
    try { receive(JSON.parse(Buffer.concat(chunks).toString('utf8').split('\n')[0])); }
    catch { socket.destroy(); }
    chunks = [];
  });
}

/** One explicitly enabled live session, with the user's filesystem permissions as its sender gate. */
export async function openClaudeChannel({ name, notify, directory = defaultDirectory() }) {
  const path = socketPath(name, directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await privateDirectory(directory);
  const pending = new Map(), clients = new Set();
  const server = createServer(socket => {
    if (clients.size >= 32) { socket.destroy(); return; }
    clients.add(socket);
    socket.setTimeout(125000, () => socket.destroy());
    let id, timer = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timer); clients.delete(socket); if (id) pending.delete(id); });
    readFrame(socket, input => {
      let message, wait;
      try { message = messageText(input.message); wait = timeout(input.timeoutMs); }
      catch (error) { socket.end(JSON.stringify({ delivery: 'rejected', error: error.message }) + '\n'); return; }
      clearTimeout(timer);
      id = randomUUID();
      const finish = result => {
        if (!pending.has(id)) return;
        clearTimeout(timer);
        pending.delete(id);
        socket.end(JSON.stringify({ requestId: id, ...result }) + '\n');
      };
      pending.set(id, finish);
      timer = setTimeout(() => finish({ delivery: 'unknown', error: 'No Claude reply before deadline; do not automatically resend.' }), wait);
      Promise.resolve().then(() => notify({ content: message, meta: { request_id: id } }))
        .catch(() => finish({ delivery: 'unknown', error: 'Channel notification failed; delivery is uncertain.' }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  try { await chmod(path, 0o600); }
  catch (error) { await new Promise(resolve => server.close(resolve)); await unlink(path).catch(() => {}); throw error; }
  let closed = false;
  return {
    socketPath: path,
    reply(requestId, text) {
      messageText(text);
      const finish = pending.get(requestId);
      if (!finish) throw Error('No pending request with that ID (expired or already replied)');
      finish({ delivery: 'replied', reply: text });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const client of clients) client.destroy();
      await new Promise(resolve => server.close(resolve));
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    },
  };
}

export async function sendToClaude({ name, message, timeoutMs = 60000, directory = defaultDirectory() }) {
  const path = socketPath(name, directory);
  messageText(message);
  timeout(timeoutMs);
  await privateDirectory(directory);
  const info = await lstat(path);
  if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077))
    throw Error('Claude channel socket is not private to this user');
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let sent = false, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const lost = error => sent
      ? finish(null, { delivery: 'unknown', error: 'Claude channel connection lost; do not automatically resend.' })
      : finish(error);
    const timer = setTimeout(() => lost(Error('Claude channel connection timed out')), timeoutMs + 1000);
    socket.once('error', lost);
    socket.once('close', () => lost(Error('Claude channel closed')));
    socket.once('connect', () => { sent = true; socket.write(JSON.stringify({ message, timeoutMs }) + '\n'); });
    readFrame(socket, result => {
      if (!['replied', 'unknown', 'rejected'].includes(result?.delivery) ||
          (result.delivery === 'replied' && (typeof result.reply !== 'string' || typeof result.requestId !== 'string')))
        return lost(Error('Invalid Claude channel reply'));
      finish(null, result);
    });
  });
}
