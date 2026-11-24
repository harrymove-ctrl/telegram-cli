import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI_PATH = path.join(ROOT, 'dist', 'cli.mjs')

test('telegram --help lists core and daily triage commands', async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, '--help'])
  for (const cmd of [
    'setup',
    'auth',
    'status',
    'chats',
    'read',
    'search',
    'digest',
    'unread',
    'draft',
    'send',
    'batch-crawl',
    'batch-mark-read',
    'batch-download-media',
  ]) {
    assert.ok(stdout.includes(cmd), `Expected help output to list ${cmd}`)
  }
})

test('telegram status runs offline without exposing raw credentials', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    CLI_PATH,
    'status',
    '--json',
  ])
  const parsed = JSON.parse(stdout)
  assert.equal(typeof parsed.configFile, 'string')
  assert.equal(typeof parsed.storageFile, 'string')
  assert.equal(typeof parsed.hasStoredConfig, 'boolean')
  assert.equal(typeof parsed.hasEnvCredentials, 'boolean')
  assert.equal(typeof parsed.hasSessionFile, 'boolean')
  assert.equal(typeof parsed.hasAuthenticatedSession, 'boolean')
  assert.ok(
    ['AUTHENTICATED', 'INCOMPLETE_AUTH_KEY_ONLY', 'MISSING'].includes(
      parsed.sessionState,
    ),
  )
  assert.equal(typeof parsed.readOnly, 'boolean')
  assert.equal('apiHash' in parsed, false)
  assert.equal('apiId' in parsed, false)
})

test('negative chat IDs pass argument parsing for read and search', async () => {
  const { stdout: searchHelp } = await execFileAsync(process.execPath, [
    CLI_PATH,
    'search',
    '-1001234567890',
    'deploy',
    '--help',
  ])
  assert.ok(searchHelp.includes('Search messages inside a specific Telegram chat'))

  const { stdout: readHelp } = await execFileAsync(process.execPath, [
    CLI_PATH,
    'read',
    '-1001234567890',
    '--help',
  ])
  assert.ok(readHelp.includes('Read a page of messages from a chat'))
})

test('batch-mark-read skips non-channel IDs fail-closed offline without network calls', async () => {
  const { writeFileSync, unlinkSync } = await import('node:fs')
  const os = await import('node:os')
  const specPath = path.join(os.tmpdir(), `tg-batch-mark-read-test-${process.pid}.json`)
  writeFileSync(
    specPath,
    JSON.stringify({
      items: [
        { chatId: '123456789', maxId: 50 },
        { chatId: '-987654', maxId: 50 },
        { chatId: '-1001234567890', maxId: 0 },
      ],
    }),
    'utf8',
  )
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      CLI_PATH,
      'batch-mark-read',
      '--spec-file',
      specPath,
      '--format',
      'json',
    ])
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.markedCount, 0)
    assert.equal(parsed.skippedCount, 3)
    assert.equal(parsed.floodWaitStopped, false)
  } finally {
    unlinkSync(specPath)
  }
})

test('batch-download-media handles empty and already-cached files offline', async () => {
  const { writeFileSync, unlinkSync } = await import('node:fs')
  const os = await import('node:os')
  const cachedFile = path.join(os.tmpdir(), `tg-cached-chart-${process.pid}.jpg`)
  const specPath = path.join(os.tmpdir(), `tg-batch-dl-test-${process.pid}.json`)
  writeFileSync(cachedFile, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  writeFileSync(
    specPath,
    JSON.stringify({
      items: [
        { chatId: '-1001234567890', messageId: 42, out: cachedFile },
        { chatId: '', messageId: 0, out: '' },
      ],
    }),
    'utf8',
  )
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      CLI_PATH,
      'batch-download-media',
      '--spec-file',
      specPath,
      '--format',
      'json',
    ])
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.cachedCount, 1)
    assert.equal(parsed.downloadedCount, 0)
    assert.equal(parsed.failedCount, 1)
    assert.equal(parsed.items[0].ok, true)
    assert.equal(parsed.items[0].cached, true)
    assert.equal(parsed.items[1].ok, false)
  } finally {
    try { unlinkSync(cachedFile) } catch {}
    try { unlinkSync(specPath) } catch {}
  }
})

test('batch-crawl exposes spec-file option and fails closed on missing spec file', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    CLI_PATH,
    'batch-crawl',
    '--help',
  ])
  assert.ok(stdout.includes('--spec-file'))
  await assert.rejects(
    execFileAsync(process.execPath, [
      CLI_PATH,
      'batch-crawl',
      '--spec-file',
      '/tmp/non-existent-gd-batch-spec-999999.json',
      '--format',
      'json',
    ]),
  )
})
