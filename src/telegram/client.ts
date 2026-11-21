import readline from 'node:readline/promises'

import { BaseTelegramClient } from '@mtcute/node'
import { getMe, logOut, signInQr, start } from '@mtcute/node/methods.js'
import QRCode from 'qrcode'

import {
  ensureStorageDir,
  getCredentials,
  getStorageFile,
  promptWithInterface,
} from './config.js'

let client: BaseTelegramClient | null = null

export function getCachedClient(): BaseTelegramClient | null {
  return client
}

export function clearCachedClient(): void {
  client = null
}

export async function createClient(): Promise<BaseTelegramClient> {
  const { apiId, apiHash } = await getCredentials()
  await ensureStorageDir()

  return new BaseTelegramClient({
    apiId,
    apiHash,
    storage: getStorageFile(),
    initConnectionOptions: {
      deviceModel: 'Mac Desktop',
      systemVersion: 'macOS',
      appVersion: '1.0.0',
    },
  })
}

async function loginInteractive(tg: BaseTelegramClient) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })

  try {
    return await start(tg, {
      phone: () =>
        promptWithInterface(rl, 'Phone number (include country code): '),
      code: () => promptWithInterface(rl, 'Login code: '),
      password: () =>
        promptWithInterface(rl, '2FA password (leave blank if none): ', {
          hidden: true,
        }),
      invalidCodeCallback: async (type) => {
        console.error(`Invalid ${type}. Try again.`)
      },
      codeSentCallback: async (sentCode) => {
        console.error(`Code sent via ${sentCode.type}.`)
      },
    })
  } finally {
    rl.close()
  }
}

async function promptPasswordOnDemand(
  promptText = '2FA password (leave blank if none): ',
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })
  try {
    return await promptWithInterface(rl, promptText, { hidden: true })
  } finally {
    rl.close()
  }
}

async function loginQrInteractive(
  tg: BaseTelegramClient,
  forceLogin = false,
) {
  if (!forceLogin) {
    try {
      const existing = await getMe(tg)
      await tg.notifyLoggedIn(existing.raw)
      return existing
    } catch {
      // Not yet authorized; proceed to QR sign-in
    }
  }

  return await signInQr(tg, {
    onUrlUpdated: (url, expires) => {
      void QRCode.toString(url, { type: 'terminal', small: true })
        .then((qr) => {
          process.stderr.write(
            `\nScan this QR code using Telegram Mobile ONLY (Settings -> Devices -> Link Desktop Device; do NOT click tg:// links in Mac Telegram Desktop, or run "telegram auth --read-only" for manual 5-digit code) [expires ${expires.toLocaleTimeString()}]:\n\n${qr}\n`,
          )
        })
        .catch(() => {
          process.stderr.write(
            '\nTerminal QR render failed. Run "telegram auth --read-only" to log in with phone + 5-digit manual code.\n',
          )
        })
    },
    onQrScanned: () => {
      process.stderr.write(
        '\nQR code scanned! Completing DC migration and session authorization...\n',
      )
    },
    password: () => promptPasswordOnDemand(),
    invalidPasswordCallback: async () => {
      console.error('Invalid 2FA password. Try again.')
    },
  })
}

async function requireStoredSession(tg: BaseTelegramClient): Promise<void> {
  await tg.prepare()
  const self = await tg.storage.self.fetch()

  if (!self) {
    throw new Error('No Telegram session found. Run "telegram auth" first.')
  }
}

export async function authClient(options?: {
  forceLogin?: boolean
  qr?: boolean
}): Promise<BaseTelegramClient> {
  if (options?.forceLogin && client) {
    await client.destroy().catch(() => undefined)
    client = null
  }

  if (client && !options?.forceLogin) return client

  const tg = await createClient()

  try {
    if (options?.forceLogin) {
      try {
        await logOut(tg)
      } catch {
        // Ignore if no active session is present.
      }
    }

    if (options?.qr) {
      await loginQrInteractive(tg, Boolean(options?.forceLogin))
    } else {
      await loginInteractive(tg)
    }
    client = tg
    return tg
  } catch (error) {
    await tg.destroy().catch(() => undefined)
    throw error
  }
}

export async function getClient(): Promise<BaseTelegramClient> {
  if (client) return client

  const tg = await createClient()

  try {
    await requireStoredSession(tg)
    client = tg
    return tg
  } catch (error) {
    await tg.destroy().catch(() => undefined)
    throw error
  }
}

export async function shutdownClient() {
  if (!client) return

  const tg = client
  client = null
  await tg.destroy().catch(() => undefined)
}
