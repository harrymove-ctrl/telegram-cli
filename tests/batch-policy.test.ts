import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isImageDocumentMedia,
  rankTelegramFolderPriority,
  selectFairBatchHistoryJobs,
  shouldIncludeFolderDialog,
} from '../src/telegram/batch.ts'

test('rankTelegramFolderPriority orders trading 2 -> trading -> news -> Web3 Pack -> other', () => {
  const folders = ['Random', 'Web3 Pack', 'Macro News', 'trading', 'trading 2']
  const sorted = [...folders].sort(
    (a, b) => rankTelegramFolderPriority(a) - rankTelegramFolderPriority(b),
  )
  assert.deepEqual(sorted, [
    'trading 2',
    'trading',
    'Macro News',
    'Web3 Pack',
    'Random',
  ])
  assert.equal(rankTelegramFolderPriority('crypto'), 1)
  assert.equal(rankTelegramFolderPriority('gold'), 0)
})

test('shouldIncludeFolderDialog recovers archived Web3 Pack dialogs while enforcing excludeArchived and excludeRead with explicitPeer override', () => {
  // Allow: archived Web3 Pack channel when folder does not exclude archived
  assert.equal(
    shouldIncludeFolderDialog({
      matcherMatched: true,
      excludeArchived: false,
      excludeRead: false,
      isArchived: true,
      isUnread: true,
      isExplicitPeer: false,
    }),
    true,
  )
  // Block: archived channel when folder sets excludeArchived and peer is not explicit
  assert.equal(
    shouldIncludeFolderDialog({
      matcherMatched: true,
      excludeArchived: true,
      excludeRead: false,
      isArchived: true,
      isUnread: true,
      isExplicitPeer: false,
    }),
    false,
  )
  // Allow: explicitPeer overrides excludeArchived and excludeRead
  assert.equal(
    shouldIncludeFolderDialog({
      matcherMatched: true,
      excludeArchived: true,
      excludeRead: true,
      isArchived: true,
      isUnread: false,
      isExplicitPeer: true,
    }),
    true,
  )
  // Block: read chat when excludeRead is true and not explicit
  assert.equal(
    shouldIncludeFolderDialog({
      matcherMatched: true,
      excludeArchived: false,
      excludeRead: true,
      isArchived: false,
      isUnread: false,
      isExplicitPeer: false,
    }),
    false,
  )
  // Block: matcher rejected
  assert.equal(
    shouldIncludeFolderDialog({
      matcherMatched: false,
      excludeArchived: false,
      excludeRead: false,
      isArchived: false,
      isUnread: true,
      isExplicitPeer: true,
    }),
    false,
  )
})

test('selectFairBatchHistoryJobs guarantees secondary Web3/crypto slots, caps reservation at half maxReads, and redistributes spare budget', () => {
  const primary = Array.from({ length: 40 }, (_, i) => `p${i + 1}`)
  const secondary = Array.from({ length: 12 }, (_, i) => `s${i + 1}`)

  // Allow: 36 maxReads with reserve=8 -> 28 primary + 8 secondary (Web3/crypto never starved)
  const balanced = selectFairBatchHistoryJobs(primary, secondary, 36, 8)
  assert.equal(balanced.length, 36)
  assert.equal(balanced.filter((x) => x.startsWith('p')).length, 28)
  assert.equal(balanced.filter((x) => x.startsWith('s')).length, 8)

  // Block excessive reserve (> maxReads/2): reserve=50 on maxReads=10 caps secondary at 5
  const capped = selectFairBatchHistoryJobs(primary, secondary, 10, 50)
  assert.equal(capped.length, 10)
  assert.equal(capped.filter((x) => x.startsWith('p')).length, 5)
  assert.equal(capped.filter((x) => x.startsWith('s')).length, 5)

  // Spare primary slots spill to secondary
  const spillToSecondary = selectFairBatchHistoryJobs(['p1', 'p2'], secondary, 10, 4)
  assert.equal(spillToSecondary.length, 10)
  assert.equal(spillToSecondary.filter((x) => x.startsWith('s')).length, 8)

  // Zero maxReads returns empty fail-closed
  assert.deepEqual(selectFairBatchHistoryJobs(primary, secondary, 0, 8), [])
})

test('isImageDocumentMedia allows photo, image/* PNG documents, and octet-stream .png charts while blocking PDFs/videos', () => {
  assert.equal(isImageDocumentMedia('photo', 'image/jpeg', null), true)
  assert.equal(isImageDocumentMedia('document', 'image/png', 'XLMUSD_2026-11-24_17-54-28_b44e2.png'), true)
  assert.equal(isImageDocumentMedia('document', 'application/octet-stream', 'BTC_H4_CHART.PNG'), true)
  assert.equal(isImageDocumentMedia('document', 'application/pdf', 'report.pdf'), false)
  assert.equal(isImageDocumentMedia('video', 'video/mp4', 'clip.mp4'), false)
})
