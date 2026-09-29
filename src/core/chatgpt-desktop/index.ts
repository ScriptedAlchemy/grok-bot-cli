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
} from './errors.js';
export {
  ChatGptDesktopFacade,
  getChatGptDesktopAdapter,
  setChatGptDesktopAdapterForTests,
} from './facade.js';
export type { ChatGptDesktopFallbacks } from './facade.js';
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
  sendOperation,
  sendSchema,
  statusOperation,
  statusSchema,
  waitReplyOperation,
  waitReplySchema,
} from './routes.js';
export type {
  ChatGptDesktopBackend,
  ChatGptDesktopStatus,
  ChatGptDesktopTarget,
  ChatGptDesktopThread,
  ChatGptDesktopTurn,
  ListThreadsResult,
  OpenThreadResult,
  ReadThreadResult,
  SendMessageResult,
  WaitForReplyResult,
} from './types.js';
