import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { performance } from 'node:perf_hooks'

import type { InputPeerLike } from '@mtcute/node'
import { Dialog, getMarkedPeerId } from '@mtcute/node'
import {
  downloadToFile,
  getFolders,
  getMessages,
  getPeerDialogs,
  iterDialogs,
  iterHistory,
  readHistory,
} from '@mtcute/node/methods.js'

import { getClient } from './client.js'
import { folderSummary } from './folders.js'
import { resolvePeer } from './resolve.js'

type FolderFilter = Awaited<ReturnType<typeof getFolders>>['filters'][number]
type MtMessage = NonNullable<Dialog['lastMessage']>

export interface BatchCrawlCursorInput {
  lastProcessedMsgId?: number
  lastMessageDate?: string
  lastMessageSnippetHash?: string
  unreadCount?: number
  probedAt?: string
  updatedAt?: string
  folder?: string
}

export interface BatchCrawlSpec {
  folders?: string[]
  matchAllFolders?: boolean
  includeAllChats?: boolean
  maxDialogs?: number
  archived?: 'keep' | 'exclude' | 'only'
  dialogStrategy?: 'auto' | 'peer_dialogs' | 'iter_dialogs'
  peerDialogsChunkSpacingMs?: number
  cursors?: Record<string, BatchCrawlCursorInput>
  excludeChatIds?: string[]
  forceReadChatIds?: string[]
  onlyReadChatIds?: string[]
  skipMessageReads?: boolean
  messagesPerChannel?: number
  newChatMessagesLimit?: number
  maxReads?: number
  reserveNonPrimaryReads?: number
  readConcurrency?: number
  readSpacingMs?: number
  allowZeroRpcSingleMessage?: boolean
  directUsernames?: string[]
  singleMsgProbeChatIds?: string[]
}

export interface BatchChatSummary {
  id: string
  name: string
  title: string
  username: string | null
  type: string
  unreadCount: number
  isUnread: boolean
  isManuallyUnread: boolean
  draft: string | null
  lastMessage: string | null
  lastMessageDate: string | null
  lastMessageId: number | null
  lastMessageHasMedia: boolean
  lastMessageMediaType: string | null
}

export interface BatchMessageItem {
  id: number
  date: string
  sender: string
  senderId: string | null
  outgoing: boolean
  replyToMessageId: number | null
  text: string
  hasMedia: boolean
  mediaType: string | null
  mimeType: string | null
  fileName: string | null
}

export interface BatchChatReadResult {
  ok: boolean
  source: 'iter_history' | 'dialog_last_message_zero_rpc' | 'error'
  count: number
  messages: BatchMessageItem[]
  error?: string
}

export interface BatchMarkReadItem {
  chatId: string
  slug?: string
  maxId: number
  unreadCount?: number
}

export interface BatchMarkReadSpec {
  items: BatchMarkReadItem[]
  spacingMs?: number
  maxPerCycle?: number
}

export interface BatchDownloadMediaItem {
  chatId: string
  messageId: number
  out: string
  allowNonImage?: boolean
}

export interface BatchDownloadMediaSpec {
  items: BatchDownloadMediaItem[]
  spacingMs?: number
  maxItems?: number
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolveWait) => setTimeout(resolveWait, ms))
}

function isDialogUnread(dialog: {
  unreadCount: number
  isManuallyUnread: boolean
}): boolean {
  return dialog.unreadCount > 0 || Boolean(dialog.isManuallyUnread)
}

export function extractFloodWaitInfo(err: unknown): {
  isFloodWait: boolean
  seconds: number | null
  reason: string
} {
  const message =
    err instanceof Error ? err.message : String(err ?? 'unknown_error')
  const rawSeconds =
    typeof err === 'object' && err !== null && 'seconds' in err
      ? Number((err as { seconds?: unknown }).seconds)
      : Number.NaN
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? Number((err as { code?: unknown }).code)
      : Number.NaN
  const regexMatch = message.match(/FLOOD_WAIT[_\s:]*(\d+)/i)
  const parsedSec = Number.isFinite(rawSeconds)
    ? rawSeconds
    : regexMatch
      ? Number(regexMatch[1])
      : null
  const isFloodWait =
    code === 420 ||
    /flood[\s_-]*wait|too\s+many\s+requests|\b420\b|retry[\s_-]*after/i.test(
      message,
    )
  return {
    isFloodWait,
    seconds: Number.isFinite(parsedSec ?? Number.NaN) ? parsedSec : null,
    reason: message.replace(/\s+/g, ' ').trim().slice(0, 160),
  }
}

function getPeerUsername(peer: Dialog['peer']): string | null {
  if ('username' in peer && typeof peer.username === 'string' && peer.username) {
    return peer.username
  }
  return null
}

function extractMessageMimeType(message: MtMessage): string | null {
  const media = message.media
  if (!media) return null
  if ('mimeType' in media && typeof media.mimeType === 'string') {
    return media.mimeType
  }
  if (media.type === 'photo') return 'image/jpeg'
  return null
}

function extractMessageFileName(message: MtMessage): string | null {
  const media = message.media
  if (!media) return null
  if ('fileName' in media && typeof media.fileName === 'string' && media.fileName.trim()) {
    return media.fileName.trim()
  }
  return null
}

export function isImageDocumentMedia(
  mediaType: string | null | undefined,
  mimeType: string | null | undefined,
  fileName?: string | null,
): boolean {
  const mt = String(mediaType || '').toLowerCase()
  if (mt === 'photo' || mt === 'sticker') return true
  if (mt !== 'document') return false
  if (/^image\//i.test(String(mimeType || '').trim())) return true
  return /\.(?:png|jpe?g|webp|gif)$/i.test(String(fileName || '').trim())
}

function formatMessage(message: MtMessage): BatchMessageItem {
  return {
    id: message.id,
    date: message.date.toISOString(),
    sender: message.sender.displayName,
    senderId: 'id' in message.sender ? String(message.sender.id) : null,
    outgoing: message.isOutgoing,
    replyToMessageId: message.replyToMessage?.id ?? null,
    text: message.text,
    hasMedia: message.media !== null,
    mediaType: message.media ? String(message.media.type) : null,
    mimeType: extractMessageMimeType(message),
    fileName: extractMessageFileName(message),
  }
}

function summarizeDialog(dialog: Dialog): BatchChatSummary {
  const unread = isDialogUnread(dialog)
  const last = dialog.lastMessage
  return {
    id: String(dialog.peer.id),
    name: dialog.peer.displayName,
    title: dialog.peer.displayName,
    username: getPeerUsername(dialog.peer),
    type: dialog.peer.type,
    unreadCount: dialog.unreadCount,
    isUnread: unread,
    isManuallyUnread: Boolean(dialog.isManuallyUnread),
    draft: dialog.draftMessage?.text ?? null,
    lastMessage: last?.text ?? null,
    lastMessageDate: last?.date?.toISOString() ?? null,
    lastMessageId: last?.id ?? null,
    lastMessageHasMedia: Boolean(last?.media),
    lastMessageMediaType: last?.media ? String(last.media.type) : null,
  }
}

function normalizeFolderKey(raw: string): string {
  return String(raw || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function folderHasWildcardFlags(folder: FolderFilter): boolean {
  if (folder._ === 'dialogFilterDefault') return true
  if (folder._ === 'dialogFilterChatlist') return false
  return Boolean(
    folder.contacts ||
      folder.nonContacts ||
      folder.groups ||
      folder.broadcasts ||
      folder.bots,
  )
}

function normalizeDialogFilterForMatching(folder: FolderFilter) {
  if (folder._ === 'dialogFilterDefault') return undefined
  if (folder._ === 'dialogFilterChatlist') {
    return {
      ...folder,
      _: 'dialogFilter' as const,
      excludePeers: [],
    }
  }
  return folder
}

function getCursorForChat(
  cursors: Record<string, BatchCrawlCursorInput>,
  chatId: string,
  username: string | null,
): BatchCrawlCursorInput | null {
  if (cursors[chatId]) return cursors[chatId] ?? null
  if (username) {
    const clean = username.toLowerCase().replace(/^@/, '')
    if (cursors[clean]) return cursors[clean] ?? null
  }
  return null
}

export function canDeltaSkipDialog(
  summary: BatchChatSummary,
  cursor: BatchCrawlCursorInput | null,
  folderTitle: string,
): boolean {
  if (!cursor) return false
  const prevProcessedId = Math.max(0, Number(cursor.lastProcessedMsgId || 0) || 0)
  const prevFolder = normalizeFolderKey(cursor.folder || '')
  const curFolder = normalizeFolderKey(folderTitle || '')
  if (prevFolder && curFolder && prevFolder !== curFolder) {
    return false
  }
  // Exact mathematical check: if the dialog's top message ID is <= our last processed ID, zero new messages exist.
  if (
    prevProcessedId > 0 &&
    summary.lastMessageId !== null &&
    summary.lastMessageId > 0 &&
    summary.lastMessageId <= prevProcessedId
  ) {
    return true
  }
  const prevWasProbed = Boolean(
    prevProcessedId > 0 || cursor.probedAt || cursor.updatedAt,
  )
  const prevDate = String(cursor.lastMessageDate || '').trim()
  const curDate = String(summary.lastMessageDate || '').trim()
  if (
    prevWasProbed &&
    !summary.isUnread &&
    ((curDate && prevDate && curDate === prevDate) ||
      (!curDate && !prevDate && prevProcessedId === 0))
  ) {
    return true
  }
  return false
}

export function isValidChannelMarkReadChatId(chatId: string): boolean {
  return /^-100\d+$/.test(String(chatId || '').trim())
}

async function readJsonSpecFile<T>(specFile: string): Promise<T> {
  const resolved = resolvePath(specFile)
  const raw = await readFile(resolved, 'utf8')
  return JSON.parse(raw) as T
}

const BLOCKED_PERSONAL_OR_RAC_FOLDER_RE =
  /^(?:personal|private|dm|dms|direct[\s_-]*messages?|saved[\s_-]*messages?|family|friends|work|rac|r[áa]c|trash|spam|scam|quarantine|k[èe]o[\s_-]*r[áa]c|trash[\s_-]*signals?)$/i

export function isBlockedPersonalOrRacFolderTitle(title: string): boolean {
  const clean = normalizeFolderKey(title)
  if (!clean) return false
  return BLOCKED_PERSONAL_OR_RAC_FOLDER_RE.test(clean)
}

export function isPrimaryTradingOrGoodsFolderTitle(title: string): boolean {
  const clean = normalizeFolderKey(title)
  if (!clean || isBlockedPersonalOrRacFolderTitle(clean)) return false
  return /^(?:good|goods|vip[\s_-]*goods?|top[\s_-]*goods?|(?:(?:group|groups|nh[óo]m|folder)[\s_-]+)?trading(?:[\s_-]*\d+)?|gold|golds|xau|v[àa]ng|forex|fx|k[èe]o)\b/i.test(
    clean,
  )
}

export function rankTelegramFolderPriority(title: string): number {
  const clean = normalizeFolderKey(title)
  if (isBlockedPersonalOrRacFolderTitle(clean)) return 99
  if (/^(?:good|goods|vip[\s_-]*goods?|top[\s_-]*goods?)\b/i.test(clean)) return -1
  if (/^(?:(?:(?:group|groups|nh[óo]m|folder)[\s_-]+)?trading[\s_-]*2|gold|golds|xau|v[àa]ng)\b/i.test(clean)) return 0
  if (/^(?:(?:(?:group|groups|nh[óo]m|folder)[\s_-]+)?trading|forex|fx|crypto|k[èe]o)\b/i.test(clean)) return 1
  if (/\b(?:news|tin[\s_-]*t[ứu]c)\b/i.test(clean)) return 2
  if (/^web3[\s_-]*pack\b/i.test(clean)) return 3
  return 4
}

export function shouldIncludeFolderDialog(opts: {
  matcherMatched: boolean
  excludeArchived: boolean
  excludeRead: boolean
  isArchived: boolean
  isUnread: boolean
  isExplicitPeer: boolean
}): boolean {
  if (!opts.matcherMatched) return false
  if (opts.excludeArchived && opts.isArchived && !opts.isExplicitPeer) {
    return false
  }
  if (opts.excludeRead && !opts.isUnread && !opts.isExplicitPeer) {
    return false
  }
  return true
}

export function selectFairBatchHistoryJobs<T>(
  primaryPending: T[],
  secondaryPending: T[],
  maxReads: number,
  reserveNonPrimaryReads = 0,
): T[] {
  const safeMax = Math.max(0, Math.floor(Number(maxReads) || 0))
  if (safeMax === 0) return []
  const safeReserve = Math.max(
    0,
    Math.min(
      Math.floor(safeMax / 2),
      Math.floor(Number(reserveNonPrimaryReads) || 0),
    ),
  )
  const reservedSecondaryCount =
    safeReserve > 0 ? Math.min(safeReserve, secondaryPending.length) : 0
  const primaryCap = Math.max(0, safeMax - reservedSecondaryCount)
  const selectedPrimary = primaryPending.slice(0, primaryCap)
  const remainingBudget = Math.max(0, safeMax - selectedPrimary.length)
  const selectedSecondary = secondaryPending.slice(0, remainingBudget)
  return [...selectedPrimary, ...selectedSecondary]
}

export async function batchCrawlFromSpecFile(specFile: string) {
  const spec = await readJsonSpecFile<BatchCrawlSpec>(specFile)
  return batchCrawl(spec)
}

export async function batchCrawl(spec: BatchCrawlSpec = {}) {
  const tStart = performance.now()
  const tg = await getClient()
  const tAfterConnect = performance.now()

  const rpcCounts = {
    folders: 0,
    dialogs: 0,
    history: 0,
    zeroRpcFastPath: 0,
    directReads: 0,
  }
  let floodWaitDetected = false
  let floodWaitSeconds: number | null = null
  let floodWaitReason: string | null = null

  const noteFloodWait = (err: unknown): boolean => {
    const info = extractFloodWaitInfo(err)
    if (info.isFloodWait) {
      floodWaitDetected = true
      floodWaitSeconds = info.seconds
      floodWaitReason = info.reason
      return true
    }
    return false
  }

  // 1. Fetch all Telegram folders ONCE in this session.
  const folderResult = await getFolders(tg)
  rpcCounts.folders += 1
  const tAfterFolders = performance.now()

  const allFolderSummaries = folderResult.filters.map(folderSummary)
  const requestedFolders = Array.isArray(spec.folders)
    ? spec.folders.map((f) => String(f || '').trim()).filter(Boolean)
    : []

  const matchedEntries: Array<{
    title: string
    id: number
    filter: FolderFilter
  }> = []
  const seenFolderIds = new Set<number>()

  if (requestedFolders.length > 0) {
    for (const selector of requestedFolders) {
      const isNum = /^\d+$/.test(selector)
      const normSel = normalizeFolderKey(selector)
      const hit = folderResult.filters.find((f) => {
        const sum = folderSummary(f)
        if (isNum) return sum.id === Number(selector)
        return normalizeFolderKey(sum.title) === normSel
      })
      if (hit) {
        const sum = folderSummary(hit)
        if (!isBlockedPersonalOrRacFolderTitle(sum.title) && !seenFolderIds.has(sum.id)) {
          seenFolderIds.add(sum.id)
          matchedEntries.push({ title: sum.title, id: sum.id, filter: hit })
        }
      }
    }
  } else if (spec.matchAllFolders !== false) {
    for (const f of folderResult.filters) {
      if (f._ === 'dialogFilterDefault') continue
      const sum = folderSummary(f)
      if (isBlockedPersonalOrRacFolderTitle(sum.title)) continue
      if (!seenFolderIds.has(sum.id)) {
        seenFolderIds.add(sum.id)
        matchedEntries.push({ title: sum.title, id: sum.id, filter: f })
      }
    }
    matchedEntries.sort(
      (a, b) =>
        rankTelegramFolderPriority(a.title) -
        rankTelegramFolderPriority(b.title),
    )
  }

  const maxDialogs = Math.max(
    50,
    Math.min(1500, Number(spec.maxDialogs ?? 400) || 400),
  )
  const archivedMode: 'keep' | 'exclude' | 'only' =
    spec.archived === 'exclude' || spec.archived === 'only'
      ? spec.archived
      : 'keep'
  const includeAllChats = spec.includeAllChats === true
  const peerChunkSpacingMs = Math.max(
    100,
    Math.min(2000, Number(spec.peerDialogsChunkSpacingMs ?? 220) || 220),
  )

  const folderChats: Record<string, BatchChatSummary[]> = {}
  for (const entry of matchedEntries) {
    folderChats[entry.title] = []
  }
  const allChats: BatchChatSummary[] = []
  const dialogById = new Map<string, Dialog>()
  const summaryById = new Map<string, BatchChatSummary>()
  const primaryFolderByChatId = new Map<string, string>()

  const allMatchedExplicitOnly =
    matchedEntries.length > 0 &&
    matchedEntries.every((e) => !folderHasWildcardFlags(e.filter))

  // Build unique explicit peer list when peer_dialogs path is eligible.
  const uniqueExplicitPeers: Array<{
    markedId: string
    peer: InputPeerLike
  }> = []
  const explicitFolderMembership = new Map<string, string[]>()

  if (allMatchedExplicitOnly) {
    const seenMarked = new Set<string>()
    for (const entry of matchedEntries) {
      if (entry.filter._ === 'dialogFilterDefault') continue
      const peers = [
        ...(entry.filter.pinnedPeers || []),
        ...(entry.filter.includePeers || []),
      ]
      for (const peer of peers) {
        const markedId = String(getMarkedPeerId(peer))
        const foldersForPeer = explicitFolderMembership.get(markedId) || []
        if (!foldersForPeer.includes(entry.title)) {
          foldersForPeer.push(entry.title)
          explicitFolderMembership.set(markedId, foldersForPeer)
        }
        if (!seenMarked.has(markedId)) {
          seenMarked.add(markedId)
          uniqueExplicitPeers.push({ markedId, peer })
        }
      }
    }
  }

  // Empirical live benchmark (2026-11-24): single-pass iter_dialogs scans 300+ trading chats in ~1.7s
  // with zero FLOOD_WAIT, whereas messages.getPeerDialogs over 300 peers hits FLOOD_WAIT_29.
  // Therefore 'auto' always defaults to single-pass 'iter_dialogs'; 'peer_dialogs' is opt-in only.
  const canUsePeerDialogs =
    spec.dialogStrategy === 'peer_dialogs' &&
    !includeAllChats &&
    allMatchedExplicitOnly &&
    uniqueExplicitPeers.length > 0 &&
    uniqueExplicitPeers.length <= 350

  const usedDialogStrategy: 'peer_dialogs' | 'iter_dialogs' = canUsePeerDialogs
    ? 'peer_dialogs'
    : 'iter_dialogs'

  // 2. Hydrate dialogs across ALL matched folders in ONE pass (zero redundant scans).
  if (usedDialogStrategy === 'peer_dialogs') {
    const chunkSize = 100
    for (let i = 0; i < uniqueExplicitPeers.length; i += chunkSize) {
      if (floodWaitDetected) break
      const slice = uniqueExplicitPeers.slice(i, i + chunkSize)
      try {
        rpcCounts.dialogs += 1
        const hydrated = await getPeerDialogs(
          tg,
          slice.map((s) => s.peer),
        )
        for (const dialog of hydrated) {
          if (!dialog) continue
          const id = String(dialog.peer.id)
          const summary = summarizeDialog(dialog)
          dialogById.set(id, dialog)
          summaryById.set(id, summary)
          const ownerFolders = explicitFolderMembership.get(id) || []
          for (const folderTitle of ownerFolders) {
            folderChats[folderTitle]?.push(summary)
            if (!primaryFolderByChatId.has(id)) {
              primaryFolderByChatId.set(id, folderTitle)
            }
          }
        }
      } catch (err) {
        if (noteFloodWait(err)) break
        // Non-flood error on chunk: continue remaining chunks best-effort
      }
      if (i + chunkSize < uniqueExplicitPeers.length && !floodWaitDetected) {
        await sleep(peerChunkSpacingMs)
      }
    }
  } else {
    const folderMatchers = matchedEntries.map((entry) => {
      const normalized = normalizeDialogFilterForMatching(entry.filter)
      const excludeRead =
        entry.filter._ === 'dialogFilter' && Boolean(entry.filter.excludeRead)
      const excludeArchived =
        entry.filter._ === 'dialogFilter' &&
        Boolean(entry.filter.excludeArchived)
      const explicitPeerSet = new Set(
        entry.filter._ !== 'dialogFilterDefault'
          ? [...entry.filter.includePeers, ...entry.filter.pinnedPeers].map(
              (peer) => getMarkedPeerId(peer),
            )
          : [],
      )
      const effective =
        excludeRead && normalized?._ === 'dialogFilter'
          ? { ...normalized, excludeRead: false }
          : normalized
      const matcher = effective
        ? Dialog.filterFolder(
            {
              ...effective,
              includePeers: [
                ...effective.includePeers,
                ...effective.pinnedPeers,
              ],
            },
            false,
          )
        : () => true
      return {
        title: entry.title,
        excludeRead,
        excludeArchived,
        explicitPeerSet,
        matcher,
      }
    })

    let dialogsSeen = 0
    try {
      for await (const dialog of iterDialogs(tg, {
        limit: maxDialogs,
        archived: archivedMode,
      })) {
        dialogsSeen += 1
        const id = String(dialog.peer.id)
        const summary = summarizeDialog(dialog)
        dialogById.set(id, dialog)
        summaryById.set(id, summary)

        for (const fm of folderMatchers) {
          if (
            !shouldIncludeFolderDialog({
              matcherMatched: fm.matcher(dialog),
              excludeArchived: fm.excludeArchived,
              excludeRead: fm.excludeRead,
              isArchived: Boolean(dialog.isArchived),
              isUnread: summary.isUnread,
              isExplicitPeer: fm.explicitPeerSet.has(dialog.peer.id),
            })
          ) {
            continue
          }
          folderChats[fm.title]?.push(summary)
          if (!primaryFolderByChatId.has(id)) {
            primaryFolderByChatId.set(id, fm.title)
          }
        }

        if (includeAllChats) {
          allChats.push(summary)
          if (!primaryFolderByChatId.has(id)) {
            primaryFolderByChatId.set(id, 'all_chats')
          }
        }
      }
      rpcCounts.dialogs = Math.max(1, Math.ceil(dialogsSeen / 100))
    } catch (err) {
      noteFloodWait(err)
    }
  }

  const tAfterDialogs = performance.now()

  // 3. Single-session delta message reads (Zero-RPC single-message fast path + bounded open-socket iterHistory).
  const reads: Record<string, BatchChatReadResult> = {}
  const cursors =
    spec.cursors && typeof spec.cursors === 'object' ? spec.cursors : {}
  const excludeSet = new Set(
    (spec.excludeChatIds || []).map((id) => String(id).trim()).filter(Boolean),
  )
  const forceReadSet = new Set(
    (spec.forceReadChatIds || [])
      .map((id) => String(id).trim())
      .filter(Boolean),
  )
  const onlyReadSet =
    Array.isArray(spec.onlyReadChatIds) && spec.onlyReadChatIds.length > 0
      ? new Set(
          spec.onlyReadChatIds.map((id) => String(id).trim()).filter(Boolean),
        )
      : null

  const defaultLimit = Math.max(
    1,
    Math.min(50, Number(spec.messagesPerChannel ?? 15) || 15),
  )
  const newChatLimit = Math.max(
    defaultLimit,
    Math.min(50, Number(spec.newChatMessagesLimit ?? 20) || 20),
  )
  const maxReads = Math.max(
    0,
    Math.min(120, Number(spec.maxReads ?? 40) || 40),
  )
  const readConcurrency = Math.max(
    1,
    Math.min(3, Number(spec.readConcurrency ?? 2) || 2),
  )
  const readSpacingMs = Math.max(
    0,
    Math.min(500, Number(spec.readSpacingMs ?? 45) || 45),
  )
  const allowZeroRpc = spec.allowZeroRpcSingleMessage !== false
  let deltaSkippedCount = 0

  const reserveNonPrimaryReads = Math.max(
    0,
    Math.min(
      Math.floor(maxReads / 2),
      Number(spec.reserveNonPrimaryReads ?? 0) || 0,
    ),
  )

  if (!spec.skipMessageReads && !floodWaitDetected && maxReads > 0) {
    // Preserve folder priority order (trading 2 -> trading -> news -> Web3 Pack -> all_chats)
    // while optionally reserving fair read slots for non-primary folders (Web3 Pack, news, all_chats)
    // so high-burst Gold/Trading ticks never starve Web3 or unfoldered crypto groups.
    const orderedEntries: Array<{ chatId: string; isSecondary: boolean }> = []
    const seenOrdered = new Set<string>()
    const enqueueList = (list: BatchChatSummary[], isSecondary: boolean) => {
      // Within each folder: unread/changed and newer chats first
      const sorted = [...list].sort((a, b) => {
        const unreadDiff = (b.isUnread ? 1 : 0) - (a.isUnread ? 1 : 0)
        if (unreadDiff !== 0) return unreadDiff
        const aMs = a.lastMessageDate ? Date.parse(a.lastMessageDate) : 0
        const bMs = b.lastMessageDate ? Date.parse(b.lastMessageDate) : 0
        return bMs - aMs
      })
      for (const item of sorted) {
        if (seenOrdered.has(item.id)) continue
        seenOrdered.add(item.id)
        orderedEntries.push({ chatId: item.id, isSecondary })
      }
    }

    for (const entry of matchedEntries) {
      enqueueList(
        folderChats[entry.title] || [],
        !isPrimaryTradingOrGoodsFolderTitle(entry.title),
      )
    }
    if (includeAllChats) {
      enqueueList(allChats, true)
    }
    // Also ensure any explicit onlyReadChatIds or forceReadChatIds are visited even if outside folder slices
    if (onlyReadSet) {
      for (const id of onlyReadSet) {
        if (!seenOrdered.has(id)) {
          seenOrdered.add(id)
          orderedEntries.push({ chatId: id, isSecondary: false })
        }
      }
    }

    type HistoryJob = {
      chatId: string
      dialog: Dialog
      limit: number
      minId: number
    }
    const primaryPending: HistoryJob[] = []
    const secondaryPending: HistoryJob[] = []

    for (const { chatId, isSecondary } of orderedEntries) {
      if (excludeSet.has(chatId)) continue
      if (onlyReadSet && !onlyReadSet.has(chatId)) continue
      const dialog = dialogById.get(chatId)
      const summary = summaryById.get(chatId)
      if (!dialog || !summary) continue

      const folderTitle = primaryFolderByChatId.get(chatId) || ''
      const cursor = getCursorForChat(cursors, chatId, summary.username)
      const prevProcessedId = Math.max(
        0,
        Number(cursor?.lastProcessedMsgId || 0) || 0,
      )
      const isForced = forceReadSet.has(chatId)

      if (!isForced && canDeltaSkipDialog(summary, cursor, folderTitle)) {
        deltaSkippedCount += 1
        continue
      }

      // Lossless Zero-RPC Single-Message Fast Path:
      // If exactly 1 consecutive message arrived (lastMessage.id === prevProcessedId + 1),
      // no intermediate message ID can exist and Dialog.lastMessage already carries full text & media metadata.
      if (
        allowZeroRpc &&
        !isForced &&
        prevProcessedId > 0 &&
        dialog.lastMessage &&
        dialog.lastMessage.id === prevProcessedId + 1
      ) {
        const msg = formatMessage(dialog.lastMessage)
        reads[chatId] = {
          ok: true,
          source: 'dialog_last_message_zero_rpc',
          count: 1,
          messages: [msg],
        }
        rpcCounts.zeroRpcFastPath += 1
        continue
      }

      const isBrandNew = !cursor
      const limit = isBrandNew
        ? newChatLimit
        : summary.isUnread
          ? Math.min(30, Math.max(defaultLimit, summary.unreadCount + 2))
          : defaultLimit

      const job: HistoryJob = {
        chatId,
        dialog,
        limit,
        minId: !isForced && prevProcessedId > 0 ? prevProcessedId : 0,
      }
      if (isSecondary) {
        secondaryPending.push(job)
      } else {
        primaryPending.push(job)
      }
    }

    const historyQueue: HistoryJob[] = selectFairBatchHistoryJobs(
      primaryPending,
      secondaryPending,
      maxReads,
      reserveNonPrimaryReads,
    )

    // Bounded worker pool over the single open MTProto connection (zero cold spawns, zero resolvePeer RPCs).
    let nextIdx = 0
    const worker = async () => {
      while (!floodWaitDetected) {
        const idx = nextIdx
        nextIdx += 1
        if (idx >= historyQueue.length) break
        const job = historyQueue[idx]!
        if (readSpacingMs > 0 && idx > 0) {
          await sleep(readSpacingMs)
        }
        if (floodWaitDetected) break

        try {
          rpcCounts.history += 1
          const messages: BatchMessageItem[] = []
          for await (const message of iterHistory(
            tg,
            job.dialog.peer.inputPeer,
            {
              limit: job.limit,
              minId: job.minId > 0 ? job.minId : undefined,
            },
          )) {
            if (job.minId > 0 && message.id <= job.minId) break
            messages.push(formatMessage(message))
            if (messages.length >= job.limit) break
          }
          messages.reverse()
          reads[job.chatId] = {
            ok: true,
            source: 'iter_history',
            count: messages.length,
            messages,
          }
        } catch (err) {
          const isFlood = noteFloodWait(err)
          reads[job.chatId] = {
            ok: false,
            source: 'error',
            count: 0,
            messages: [],
            error: (err instanceof Error ? err.message : String(err)).slice(
              0,
              180,
            ),
          }
          if (isFlood) break
        }
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(readConcurrency, Math.max(1, historyQueue.length)) },
        () => worker(),
      ),
    )
  }

  // 4. Optional 1-message probes (e.g. TechFlow unread cursor tracking) in the exact same connection.
  const singleMsgProbes: Record<string, BatchChatReadResult> = {}
  for (const rawId of spec.singleMsgProbeChatIds || []) {
    if (floodWaitDetected) break
    const chatId = String(rawId || '').trim()
    if (!chatId) continue
    const dialog = dialogById.get(chatId)
    if (dialog?.lastMessage) {
      singleMsgProbes[chatId] = {
        ok: true,
        source: 'dialog_last_message_zero_rpc',
        count: 1,
        messages: [formatMessage(dialog.lastMessage)],
      }
      rpcCounts.zeroRpcFastPath += 1
    } else if (dialog) {
      try {
        rpcCounts.history += 1
        const msgs: BatchMessageItem[] = []
        for await (const m of iterHistory(tg, dialog.peer.inputPeer, {
          limit: 1,
        })) {
          msgs.push(formatMessage(m))
        }
        singleMsgProbes[chatId] = {
          ok: true,
          source: 'iter_history',
          count: msgs.length,
          messages: msgs,
        }
      } catch (err) {
        noteFloodWait(err)
        singleMsgProbes[chatId] = {
          ok: false,
          source: 'error',
          count: 0,
          messages: [],
          error: (err instanceof Error ? err.message : String(err)).slice(
            0,
            180,
          ),
        }
      }
    }
  }

  // 5. Optional direct @username channel reads (e.g. LKS02community) inside the same connection.
  const directReads: Record<
    string,
    {
      ok: boolean
      chat: { id: string; name: string; type: string; username: string } | null
      count: number
      messages: BatchMessageItem[]
      error?: string
    }
  > = {}
  for (const rawUser of spec.directUsernames || []) {
    if (floodWaitDetected) break
    const cleanUser = String(rawUser || '')
      .trim()
      .replace(/^@/, '')
    if (!cleanUser) continue
    try {
      rpcCounts.directReads += 1
      const peer = await resolvePeer(cleanUser)
      const cursor = getCursorForChat(cursors, String(peer.id), cleanUser)
      const prevProcessedId = Math.max(
        0,
        Number(cursor?.lastProcessedMsgId || 0) || 0,
      )
      const messages: BatchMessageItem[] = []
      for await (const message of iterHistory(tg, peer.inputPeer, {
        limit: defaultLimit,
        minId: prevProcessedId > 0 ? prevProcessedId : undefined,
      })) {
        if (prevProcessedId > 0 && message.id <= prevProcessedId) break
        messages.push(formatMessage(message))
        if (messages.length >= defaultLimit) break
      }
      messages.reverse()
      directReads[cleanUser] = {
        ok: true,
        chat: {
          id: String(peer.id),
          name: peer.displayName,
          type: peer.type,
          username: cleanUser,
        },
        count: messages.length,
        messages,
      }
    } catch (err) {
      noteFloodWait(err)
      directReads[cleanUser] = {
        ok: false,
        chat: null,
        count: 0,
        messages: [],
        error: (err instanceof Error ? err.message : String(err)).slice(0, 180),
      }
    }
  }

  const tEnd = performance.now()
  return {
    ok: !floodWaitDetected,
    schema: 'telegram-cli-batch-crawl/v1',
    dialogStrategy: usedDialogStrategy,
    elapsedMs: Math.round(tEnd - tStart),
    connectMs: Math.round(tAfterConnect - tStart),
    foldersMs: Math.round(tAfterFolders - tAfterConnect),
    dialogsMs: Math.round(tAfterDialogs - tAfterFolders),
    readsMs: Math.round(tEnd - tAfterDialogs),
    rpcCounts,
    deltaSkippedCount,
    floodWaitDetected,
    floodWaitSeconds,
    floodWaitReason,
    allFolders: allFolderSummaries,
    matchedFolders: matchedEntries.map((e) => ({ id: e.id, title: e.title })),
    folderChats,
    allChats: includeAllChats ? allChats : undefined,
    reads,
    singleMsgProbes,
    directReads,
  }
}

export async function batchMarkReadFromSpecFile(specFile: string) {
  const spec = await readJsonSpecFile<BatchMarkReadSpec>(specFile)
  return batchMarkRead(spec)
}

export async function batchMarkRead(spec: BatchMarkReadSpec) {
  const tStart = performance.now()
  const rawItems = Array.isArray(spec?.items) ? spec.items : []
  const maxPerCycle = Math.max(
    1,
    Math.min(120, Number(spec?.maxPerCycle ?? 60) || 60),
  )
  const spacingMs = Math.max(
    0,
    Math.min(2000, Number(spec?.spacingMs ?? 80) || 80),
  )

  const validItems: BatchMarkReadItem[] = []
  let skippedCount = 0
  for (const item of rawItems) {
    const chatId = String(item?.chatId || '').trim()
    const maxId = Number(item?.maxId)
    if (
      !isValidChannelMarkReadChatId(chatId) ||
      !Number.isInteger(maxId) ||
      maxId <= 0
    ) {
      skippedCount += 1
      continue
    }
    validItems.push({
      chatId,
      slug: item?.slug ? String(item.slug) : chatId,
      maxId,
      unreadCount: Math.max(0, Number(item?.unreadCount || 0) || 0),
    })
  }

  const queue = validItems.slice(0, maxPerCycle)
  if (queue.length === 0) {
    return {
      ok: true,
      elapsedMs: Math.round(performance.now() - tStart),
      markedCount: 0,
      failedCount: 0,
      skippedCount,
      remainingCandidatesCount: 0,
      floodWaitStopped: false,
      floodWaitSeconds: null,
      markedChats: [],
      errors: [],
    }
  }

  const tg = await getClient()
  const markedChats: Array<{
    chatId: string
    slug: string
    maxId: number
    unreadCleared: number
  }> = []
  const errors: Array<{
    chatId: string
    slug: string
    maxId: number
    error: string
  }> = []
  let floodWaitStopped = false
  let floodWaitSeconds: number | null = null

  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i]!
    try {
      const peer = await resolvePeer(item.chatId)
      await readHistory(tg, peer.inputPeer, {
        maxId: item.maxId,
        clearMentions: true,
      })
      markedChats.push({
        chatId: item.chatId,
        slug: item.slug || item.chatId,
        maxId: item.maxId,
        unreadCleared: item.unreadCount || 0,
      })
      if (spacingMs > 0 && i < queue.length - 1) {
        await sleep(spacingMs)
      }
    } catch (err) {
      const info = extractFloodWaitInfo(err)
      errors.push({
        chatId: item.chatId,
        slug: item.slug || item.chatId,
        maxId: item.maxId,
        error: info.reason,
      })
      if (info.isFloodWait) {
        floodWaitStopped = true
        floodWaitSeconds = info.seconds
        break
      }
    }
  }

  return {
    ok: errors.length === 0,
    elapsedMs: Math.round(performance.now() - tStart),
    markedCount: markedChats.length,
    failedCount: errors.length,
    skippedCount,
    remainingCandidatesCount: Math.max(0, validItems.length - queue.length),
    floodWaitStopped,
    floodWaitSeconds,
    markedChats,
    errors,
  }
}

export async function batchDownloadMediaFromSpecFile(specFile: string) {
  const spec = await readJsonSpecFile<BatchDownloadMediaSpec>(specFile)
  return batchDownloadMedia(spec)
}

export async function batchDownloadMedia(spec: BatchDownloadMediaSpec) {
  const tStart = performance.now()
  const rawItems = Array.isArray(spec?.items) ? spec.items : []
  const maxItems = Math.max(1, Math.min(25, Number(spec?.maxItems ?? 12) || 12))
  const spacingMs = Math.max(
    0,
    Math.min(2000, Number(spec?.spacingMs ?? 80) || 80),
  )
  const queue = rawItems.slice(0, maxItems)

  const items: Array<{
    chatId: string
    messageId: number
    ok: boolean
    cached: boolean
    filePath: string | null
    bytes: number
    mimeType: string | null
    error?: string
  }> = []
  let downloadedCount = 0
  let cachedCount = 0
  let failedCount = 0
  let floodWaitStopped = false

  const toFetch: BatchDownloadMediaItem[] = []
  for (const item of queue) {
    const chatId = String(item?.chatId || '').trim()
    const messageId = Number(item?.messageId)
    const outPath = item?.out ? resolvePath(String(item.out)) : ''
    if (!chatId || !Number.isInteger(messageId) || messageId <= 0 || !outPath) {
      failedCount += 1
      items.push({
        chatId,
        messageId: Number.isFinite(messageId) ? messageId : 0,
        ok: false,
        cached: false,
        filePath: null,
        bytes: 0,
        mimeType: null,
        error: 'MISSING_DOWNLOAD_ARGS',
      })
      continue
    }
    if (existsSync(outPath)) {
      cachedCount += 1
      const st = await stat(outPath).catch(() => null)
      items.push({
        chatId,
        messageId,
        ok: true,
        cached: true,
        filePath: outPath,
        bytes: st?.size ?? 0,
        mimeType: null,
      })
      continue
    }
    toFetch.push({
      chatId,
      messageId,
      out: outPath,
      allowNonImage: Boolean(item.allowNonImage),
    })
  }

  if (toFetch.length > 0) {
    const tg = await getClient()
    for (let i = 0; i < toFetch.length; i += 1) {
      const item = toFetch[i]!
      try {
        const peer = await resolvePeer(item.chatId)
        const [message] = await getMessages(tg, peer.inputPeer, [
          item.messageId,
        ])
        if (!message || !message.media) {
          failedCount += 1
          items.push({
            chatId: item.chatId,
            messageId: item.messageId,
            ok: false,
            cached: false,
            filePath: null,
            bytes: 0,
            mimeType: null,
            error: !message ? 'MESSAGE_NOT_FOUND' : 'NO_MEDIA',
          })
          continue
        }
        const media = message.media
        if (
          media.type !== 'photo' &&
          media.type !== 'document' &&
          media.type !== 'video' &&
          media.type !== 'audio' &&
          media.type !== 'voice' &&
          media.type !== 'sticker'
        ) {
          failedCount += 1
          items.push({
            chatId: item.chatId,
            messageId: item.messageId,
            ok: false,
            cached: false,
            filePath: null,
            bytes: 0,
            mimeType: null,
            error: `UNSUPPORTED_MEDIA_TYPE:${media.type}`,
          })
          continue
        }
        const mimeType =
          'mimeType' in media && typeof media.mimeType === 'string'
            ? media.mimeType
            : media.type === 'photo'
              ? 'image/jpeg'
              : ''
        const fileName =
          'fileName' in media && typeof media.fileName === 'string'
            ? media.fileName
            : ''
        const isImageLike = isImageDocumentMedia(
          media.type,
          mimeType,
          fileName,
        )
        if (!item.allowNonImage && !isImageLike) {
          failedCount += 1
          items.push({
            chatId: item.chatId,
            messageId: item.messageId,
            ok: false,
            cached: false,
            filePath: null,
            bytes: 0,
            mimeType: mimeType || null,
            error: `NON_IMAGE_MEDIA:${media.type}`,
          })
          continue
        }

        await mkdir(dirname(item.out), { recursive: true })
        await downloadToFile(tg, item.out, media)
        const st = await stat(item.out)
        downloadedCount += 1
        items.push({
          chatId: item.chatId,
          messageId: item.messageId,
          ok: true,
          cached: false,
          filePath: item.out,
          bytes: st.size,
          mimeType: mimeType || null,
        })
        if (spacingMs > 0 && i < toFetch.length - 1) {
          await sleep(spacingMs)
        }
      } catch (err) {
        const info = extractFloodWaitInfo(err)
        failedCount += 1
        items.push({
          chatId: item.chatId,
          messageId: item.messageId,
          ok: false,
          cached: false,
          filePath: null,
          bytes: 0,
          mimeType: null,
          error: info.reason,
        })
        if (info.isFloodWait) {
          floodWaitStopped = true
          break
        }
      }
    }
  }

  return {
    ok: failedCount === 0 && !floodWaitStopped,
    elapsedMs: Math.round(performance.now() - tStart),
    downloadedCount,
    cachedCount,
    failedCount,
    floodWaitStopped,
    items,
  }
}
