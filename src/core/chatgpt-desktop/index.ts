export type { ChatGptDesktopAdapter } from './adapter.js';
export { CdpChatGptDesktopAdapter } from './cdp-adapter.js';
export {
  ASSISTANT_MESSAGE_SELECTOR,
  ATTR,
  COMPOSER_SELECTOR,
  FINAL_ASSISTANT_SELECTOR,
  IGNORED_TARGET_URL_MARKERS,
  MAIN_CONTENT_SURFACE_CLASS_PREFIX,
  MAIN_WINDOW_URL,
  SELECTORS,
  SEND_BUTTON_SELECTOR,
  STOP_BUTTON_SELECTOR,
  TEMP_THREAD_ID_PREFIX,
  dedupeThreadsById,
  isMainWindowTarget,
  newChatInProjectSelector,
  pickMainWindowTarget,
  summarizeTargetInfos,
} from './cdp-dom.js';
export { CdpSession } from './cdp-session.js';
export {
  CdpHostRejectedError,
  CdpUnreachableError,
  NotImplementedError,
  RemoteThreadNotLoadedError,
} from './errors.js';
export {
  ChatGptDesktopFacade,
  finalizeThreadList,
  getChatGptDesktopAdapter,
  groupThreadsByHost,
  mergeThreadLists,
  setChatGptDesktopAdapterForTests,
} from './facade.js';
export type { ChatGptDesktopFallbacks, ListThreadsOptions } from './facade.js';
export {
  HISTORY_CONTENT_TURN_PREFIX,
  LOCAL_THREAD_ID_PREFIX,
  appServerThreadIdCandidates,
  isTemporaryDesktopThreadId,
  requireAppServerThreadId,
  threadIdsEquivalent,
  toAppServerThreadId,
  toDesktopThreadId,
  toDomTurnKey,
} from './thread-ids.js';
export {
  codexGlobalStatePath,
  findRemoteThread,
  findRemoteThreadHostId,
  listRemoteThreadsFromState,
  loadCodexGlobalState,
} from './remote-threads.js';
export {
  CDP_LOOPBACK_HOST,
  DEFAULT_CDP_PORT,
  assertLoopbackHostname,
  cdpHttpBase,
  forceLoopbackWebSocketUrl,
  isLoopbackHostname,
  resolveCdpPort,
} from './loopback.js';
export {
  CHATGPT_APP_PATH,
  CHATGPT_BUNDLE_ID,
  chatgptDesktopRelaunchArgs,
  chatgptDesktopRelaunchCommand,
  relaunchChatGptDesktopWithCdp,
} from './relaunch.js';
export {
  listThreadsOperation,
  listThreadsSchema,
  readThreadOperation,
  readThreadSchema,
  resultSchema,
  resultText,
  searchThreadsOperation,
  searchThreadsSchema,
  sendOperation,
  sendSchema,
  statusOperation,
  statusSchema,
  waitReplyOperation,
  waitReplySchema,
} from './routes.js';
export type {
  ChatGptDesktopBackend,
  ChatGptDesktopHostGroup,
  ChatGptDesktopStatus,
  ChatGptDesktopTarget,
  ChatGptDesktopThread,
  ChatGptDesktopThreadLocation,
  ChatGptDesktopThreadSection,
  ChatGptDesktopTurn,
  ListThreadsResult,
  OpenThreadResult,
  ReadThreadResult,
  SendMessageResult,
  WaitForReplyResult,
} from './types.js';
