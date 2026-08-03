'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ChatStore } = require('../src/chat-store')

test('ChatStore paginates newest-first without losing history across restarts', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-bot-chat-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'chat.jsonl')
  const store = new ChatStore(file)
  for (let index = 0; index < 120; index++) store.append({ id: index, text: `message-${index}` })

  const newest = store.page()
  assert.equal(newest.items.length, 50)
  assert.deepEqual(newest.items.map(item => item.id), Array.from({ length: 50 }, (_, index) => index + 70))
  assert.equal(newest.nextBefore, 70)

  const older = store.page({ before: newest.nextBefore })
  assert.deepEqual(older.items.map(item => item.id), Array.from({ length: 50 }, (_, index) => index + 20))
  assert.equal(older.nextBefore, 20)

  store.append({ id: 120, text: 'new arrival' })
  const stableOldest = store.page({ before: older.nextBefore })
  assert.deepEqual(stableOldest.items.map(item => item.id), Array.from({ length: 20 }, (_, index) => index))
  assert.equal(stableOldest.hasOlder, false)

  const reopened = new ChatStore(file)
  assert.equal(reopened.page().items.at(-1).id, 120)
  assert.equal(reopened.page().total, 121)
})

const HOUR = 60 * 60 * 1000

function seeded (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-bot-chat-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new ChatStore(path.join(directory, 'chat.jsonl'))
  // Anchored inside the 45-day stats window so hourly buckets stay observable.
  const base = Math.floor((Date.now() - 30 * HOUR) / HOUR) * HOUR
  for (let index = 0; index < 60; index++) {
    const player = index % 3 === 0
    store.append({
      id: index,
      kind: index % 3 === 0 ? 'player' : index % 3 === 1 ? 'system' : 'actionbar',
      sender: player ? (index % 2 ? 'huoyuuu' : 'Dred') : 'server',
      text: index % 5 === 0 ? `找到 gold 矿 ${index}` : `message ${index}`,
      at: new Date(base + index * 30 * 60 * 1000).toISOString()
    })
  }
  return { store, base, file: store.file }
}

test('page navigates by page number, forward cursor and around index', t => {
  const { store } = seeded(t)

  const first = store.page({ limit: 10 })
  assert.equal(first.page, 1)
  assert.equal(first.pageCount, 6)
  assert.equal(first.total, 60)
  assert.equal(first.startIndex, 50)
  assert.equal(first.hasNewer, false)
  assert.equal(first.hasOlder, true)
  assert.deepEqual(first.items.map(item => item.index), Array.from({ length: 10 }, (_, index) => index + 50))

  const third = store.page({ page: 3, limit: 10 })
  assert.equal(third.page, 3)
  assert.deepEqual(third.items.map(item => item.id), Array.from({ length: 10 }, (_, index) => index + 30))
  assert.equal(third.hasNewer, true)

  const forward = store.page({ after: third.nextAfter, limit: 10 })
  assert.equal(forward.page, 2)
  assert.equal(forward.items[0].id, 40)

  const centred = store.page({ around: 7, limit: 10 })
  assert.equal(centred.startIndex, 2)
  assert.ok(centred.items.some(item => item.index === 7))

  const clamped = store.page({ around: 1, limit: 10 })
  assert.equal(clamped.startIndex, 0)
  assert.equal(clamped.items.length, 10)

  const beyond = store.page({ page: 99, limit: 10 })
  assert.equal(beyond.startIndex, 0)
  assert.equal(beyond.hasOlder, false)
})

test('search filters by text, kind, sender and date range', t => {
  const { store, base } = seeded(t)

  const text = store.search({ query: 'gold' })
  assert.equal(text.items.length, 12)
  assert.ok(text.items.every(item => item.text.includes('gold')))
  assert.deepEqual(text.items.map(item => item.index), text.items.map(item => item.index).sort((a, b) => a - b))
  assert.equal(text.hasOlder, false)

  const players = store.search({ kind: 'player', limit: 100 })
  assert.equal(players.items.length, 20)
  assert.ok(players.items.every(item => item.kind === 'player'))

  const sender = store.search({ sender: 'huoyuuu', limit: 100 })
  assert.ok(sender.items.length > 0)
  assert.ok(sender.items.every(item => item.sender === 'huoyuuu'))

  const senderByQuery = store.search({ query: 'HUOYUUU', limit: 100 })
  assert.deepEqual(senderByQuery.items.map(item => item.id), sender.items.map(item => item.id))

  const windowed = store.search({
    since: new Date(base + 2 * HOUR).toISOString(),
    until: new Date(base + 4 * HOUR).toISOString(),
    limit: 100
  })
  assert.deepEqual(windowed.items.map(item => item.id), [4, 5, 6, 7, 8])

  const combined = store.search({ query: 'gold', kind: 'player', limit: 100 })
  assert.ok(combined.items.every(item => item.kind === 'player' && item.text.includes('gold')))

  const none = store.search({ query: 'diamond' })
  assert.deepEqual(none.items, [])
  assert.equal(none.hasOlder, false)
})

test('search pages older matches without repeating or skipping', t => {
  const { store } = seeded(t)
  const all = store.search({ query: 'gold', limit: 100 }).items.map(item => item.index)

  const collected = []
  let before
  for (let guard = 0; guard < 10; guard++) {
    const page = store.search({ query: 'gold', limit: 5, before })
    collected.unshift(...page.items.map(item => item.index))
    if (!page.hasOlder) break
    before = page.nextBefore
  }
  assert.deepEqual(collected, all)
})

test('stats aggregate kinds, senders and hourly buckets identically after reopen', t => {
  const { store, base, file } = seeded(t)
  const stats = store.stats()

  assert.equal(stats.total, 60)
  assert.equal(stats.kinds.player, 20)
  assert.equal(stats.kinds.system, 20)
  assert.equal(stats.kinds.actionbar, 20)
  assert.equal(stats.senderCount, 3)
  assert.equal(stats.topSenders[0].name, 'server')
  assert.equal(stats.topSenders[0].count, 40)
  assert.equal(stats.firstAt, new Date(base).toISOString())
  assert.equal(stats.lastAt, new Date(base + 59 * 30 * 60 * 1000).toISOString())
  assert.equal(stats.series.reduce((sum, [, count]) => sum + count, 0), 60)
  assert.equal(stats.series.length, 30)
  assert.equal(stats.hourOfDayUtc.reduce((sum, count) => sum + count, 0), 60)
  assert.ok(stats.bytes > 0)

  const reopened = new ChatStore(file).stats()
  assert.deepEqual(reopened, stats)
})
