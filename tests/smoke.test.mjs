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
