import * as files from "./store.js";
import * as gw from "./gateway.js";

export function chooseBackend(opts) {
  const forceFiles = Boolean(opts.root) || opts.files;
  const forceGw = Boolean(opts.gateway);
  if (forceGw && forceFiles) {
    throw new files.StoreError("Use --dir/--files or --gateway, not both.");
  }
  if (forceGw || (!forceFiles && gw.hasGatewayAuth())) return "gateway";
  return "files";
}

export async function openBackend(opts) {
  const kind = chooseBackend(opts);
  if (kind === "gateway") {
    const session = await gw.connectGateway();
    return {
      kind,
      session,
      list: () => gw.listAgents(session),
      resolve: (ref) => gw.resolveRef(session, ref),
      createAgent: (input) => gw.createAgent(session, input),
      deleteAgent: (ref) => gw.deleteAgent(session, ref),
      createGroup: (input) => gw.createGroup(session, input),
      setGroupMembers: (group, members) => gw.setGroupMembers(session, group, members),
      addGroupMember: (group, bot) => gw.addGroupMember(session, group, bot),
      removeGroupMember: (group, bot) => gw.removeGroupMember(session, group, bot),
      send: (ref, prompt, extra) => gw.sendPrompt(session, ref, prompt, extra),
      transcript: (ref, limit) => gw.getTranscriptTail(session, ref, limit),
      thread: (ref, rootId) => gw.getThread(session, ref, rootId),
    };
  }
  const root = files.resolveAgentsRoot(opts.root);
  return {
    kind,
    root,
    list: async () => files.listRecords(root),
    resolve: async (ref) => files.resolveRef(root, ref),
    createAgent: async (input) => files.createAgent(root, input),
    deleteAgent: async (ref) => files.deleteAgent(root, ref),
    createGroup: async (input) => files.createGroup(root, input),
    setGroupMembers: async (group, members) => files.setGroupMembers(root, group, members),
    addGroupMember: async (group, bot) => files.addGroupMember(root, group, bot),
    removeGroupMember: async (group, bot) => files.removeGroupMember(root, group, bot),
    send: async () => { throw new files.StoreError("send requires the live gateway (--gateway or CURSOR_ACCESS_TOKEN / GROK_BOT_GATEWAY_TOKEN)"); },
    transcript: async () => { throw new files.StoreError("thread requires the live gateway"); },
    thread: async () => { throw new files.StoreError("thread requires the live gateway"); },
  };
}
