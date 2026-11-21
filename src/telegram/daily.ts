import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'

import { iterHistory, searchMessages } from '@mtcute/node/methods.js'

import { listChats } from './chats.js'
import { getClient } from './client.js'
import { getConfigFile, getStorageFile, isReadOnly } from './config.js'
import { resolvePeer } from './resolve.js'

async function hasFile(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function hasValidStoredConfig(configFile: string): Promise<boolean> {
  try {
    const raw = await readFile(configFile, 'utf8')
    const parsed = JSON.parse(raw) as { apiId?: unknown; apiHash?: unknown }
    return (
      typeof parsed.apiId === 'string' &&
      parsed.apiId.length > 0 &&
      typeof parsed.apiHash === 'string' &&
      parsed.apiHash.length > 0
    )
  } catch {
    return false
  }
}

interface SqliteReadonlyHandle {
  prepare(sql: string): { get(): { ok?: number } | undefined }
  close(): void
}

const requireCjs = createRequire(import.meta.url)

function hasAuthenticatedSelfRow(storageFile: string): boolean {
  let db: SqliteReadonlyHandle | null = null
  try {
    const BetterSqlite3 = requireCjs('better-sqlite3') as new (
      file: string,
      opts: { readonly: boolean; fileMustExist: boolean },
    ) => SqliteReadonlyHandle
    db = new BetterSqlite3(storageFile, { readonly: true, fileMustExist: true })
    const row = db
      .prepare("SELECT 1 AS ok FROM key_value WHERE key = 'self' LIMIT 1")
      .get()
    return Boolean(row?.ok)
  } catch {
    return false
  } finally {
    try {
      db?.close()
    } catch {
      // Ignore close error on readonly probe
    }
  }
}

export async function getStatus() {
  const configFile = getConfigFile()
  const storageFile = getStorageFile()
  const [hasStoredConfig, hasSessionFile, readOnly] = await Promise.all([
    hasValidStoredConfig(configFile),
    hasFile(storageFile),
    isReadOnly(),
  ])
  const hasAuthenticatedSession = hasSessionFile
    ? hasAuthenticatedSelfRow(storageFile)
    : false
  const sessionState = hasAuthenticatedSession
    ? 'AUTHENTICATED'
    : hasSessionFile
      ? 'INCOMPLETE_AUTH_KEY_ONLY'
      : 'MISSING'
  const hasEnvCredentials = Boolean(
    process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH,
  )

  return {
    configFile,
    storageFile,
    hasStoredConfig,
    hasEnvCredentials,
    hasSessionFile,
    hasAuthenticatedSession,
    sessionState,
    readOnly,
  }
}

export async function searchMessagesInChat(
  target: string,
  options: { query: string; limit?: number },
) {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  const tg = await getClient()
  const peer = await resolvePeer(target)
  const found = await searchMessages(tg, {
    chatId: peer.inputPeer,
    query: options.query,
    limit,
  })

  const messages = found.map((message) => ({
    id: message.id,
    date: message.date.toISOString(),
    senderId: 'id' in message.sender ? String(message.sender.id) : null,
    senderName: message.sender.displayName,
    text: message.text,
  }))

  return {
    chatId: String(peer.id),
    chatName: peer.displayName,
    query: options.query,
    count: messages.length,
    messages,
  }
}

export async function buildDigest(options?: {
  limit?: number
  unreadOnly?: boolean
  messagesPerChat?: number
}) {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 30)
  const messagesPerChat = Math.min(
    Math.max(options?.messagesPerChat ?? 5, 1),
    20,
  )

  const chatList = await listChats({
    limit,
    unreadOnly: options?.unreadOnly,
  })
  const tg = await getClient()
  const digestChats: Array<{
    chatId: string
    chatName: string
    chatType: string
    unreadCount: number
    messages: Array<{
      id: number
      date: string
      senderId: string | null
      senderName: string
      outgoing: boolean
      text: string
    }>
  }> = []

  for (const chat of chatList.chats) {
    const peer = await resolvePeer(chat.id)
    const recent: Array<{
      id: number
      date: string
      senderId: string | null
      senderName: string
      outgoing: boolean
      text: string
    }> = []

    for await (const message of iterHistory(tg, peer.inputPeer, {
      limit: messagesPerChat,
    })) {
      recent.push({
        id: message.id,
        date: message.date.toISOString(),
        senderId: 'id' in message.sender ? String(message.sender.id) : null,
        senderName: message.sender.displayName,
        outgoing: message.isOutgoing,
        text: message.text,
      })
    }

    recent.reverse()
    digestChats.push({
      chatId: chat.id,
      chatName: chat.name,
      chatType: chat.type,
      unreadCount: chat.unreadCount,
      messages: recent,
    })
  }

  return {
    count: digestChats.length,
    unreadOnly: Boolean(options?.unreadOnly),
    messagesPerChat,
    chats: digestChats,
  }
}
