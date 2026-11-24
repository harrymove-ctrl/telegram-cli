export {
  getConfigFile,
  getDataDir,
  getStorageFile,
  isReadOnly,
  setupConfig,
} from './telegram/config.js'
export { authClient, getClient, shutdownClient } from './telegram/client.js'
export { auth, logout, whoAmI } from './telegram/auth.js'
export type { ResolvedPeer, ResolvedTarget } from './telegram/resolve.js'
export { resolvePeer, resolveTarget } from './telegram/resolve.js'
export { listContacts } from './telegram/contacts.js'
export { listFolders } from './telegram/folders.js'
export {
  downloadMessageMedia,
  getMemberCount,
  listChats,
  markRead,
  readChat,
  unreadChats,
} from './telegram/chats.js'
export {
  batchCrawl,
  batchCrawlFromSpecFile,
  batchDownloadMedia,
  batchDownloadMediaFromSpecFile,
  batchMarkRead,
  batchMarkReadFromSpecFile,
  canDeltaSkipDialog,
  extractFloodWaitInfo,
  isValidChannelMarkReadChatId,
} from './telegram/batch.js'
export type {
  BatchChatReadResult,
  BatchChatSummary,
  BatchCrawlCursorInput,
  BatchCrawlSpec,
  BatchDownloadMediaItem,
  BatchDownloadMediaSpec,
  BatchMarkReadItem,
  BatchMarkReadSpec,
  BatchMessageItem,
} from './telegram/batch.js'
export type { AttachmentOptions, AttachmentType } from './telegram/media.js'
export {
  buildDigest,
  getStatus,
  searchMessagesInChat,
} from './telegram/daily.js'
export {
  addChatMembers,
  createChatGroup,
  leaveChatGroup,
  removeChatMembers,
  sendMessage,
  setDraft,
} from './telegram/writes.js'
