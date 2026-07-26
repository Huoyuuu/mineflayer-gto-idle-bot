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
