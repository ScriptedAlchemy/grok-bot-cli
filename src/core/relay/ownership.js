import { lstat, open, chmod, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, dirname } from "node:path";
import { protectRelayDirectory } from "./state.js";

async function protectOwnershipFiles(dir) {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const path = join(dir, "worker.lock" + suffix);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid()
    )
      throw Error(
        "Relay ownership storage must be an owned regular file, never a symlink",
      );
    if (stat.size > 1024 * 1024)
      throw Error("Relay ownership storage exceeds budget");
    await chmod(path, 0o600);
  }
}
async function removeStaleSocket(socketPath) {
  let stat;
  try {
    stat = await lstat(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid()
  )
    throw Error("Relay control path must be an owned socket");
  const live = await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(Error("Relay socket ownership uncertain"));
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      ["ECONNREFUSED", "ENOENT"].includes(error.code)
        ? resolve(false)
        : reject(error);
    });
  });
  if (live) throw Error("Relay control listener already running");
  await unlink(socketPath);
}

/**
 * A dedicated SQLite file supplies an OS-released lifetime lock, independent of
 * the state driver's atomic commits. Never unlink or replace this inode: doing
 * so could let another process lock a different file while this owner runs.
 */
export async function claimRelayOwner(location) {
  await protectRelayDirectory(location.stateDir);
  if (location.socketDir !== location.stateDir) {
    await protectRelayDirectory(dirname(location.socketDir));
    await protectRelayDirectory(location.socketDir);
  }
  await protectOwnershipFiles(location.stateDir);
  const path = join(location.stateDir, "worker.lock");
  const file = await open(path, "a", 0o600);
  await file.close();
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    database.close();
  };
  try {
    database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
    await protectOwnershipFiles(location.stateDir);
    // Exclusive ownership comes before opening the relay engine or touching an
    // abandoned listener. A live foreign listener is never removed.
    await removeStaleSocket(location.socketPath);
    return release;
  } catch (error) {
    release();
    if (/locked|busy/i.test(error.message))
      throw Error("Relay owner is running or locked");
    throw error;
  }
}
