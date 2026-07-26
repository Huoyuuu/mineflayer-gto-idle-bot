'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const EventEmitter = require('node:events')
const { createApp, BODY_LIMIT } = require('../src/server')
const { ChatStore } = require('../src/chat-store')

class FakeBot extends EventEmitter {
  constructor () {
    super()
    this.state = { phase: 'play' }
    this.calls = []
  }

  snapshot () { return { phase: 'play', username: 'tester' } }
  worldSlice (options) { this.calls.push(['worldSlice', options]); return { ok: true, size: 1, palette: ['stone'], blocks: [0], heights: [64] } }
  sendChat (message) { this.calls.push(['sendChat', message]); if (!message) throw new Error('消息长度必须为 1-256 个字符') }
  setInput (input) { this.calls.push(['setInput', input]); return { ok: true, input } }
  setHeldSlot (slot) { this.calls.push(['setHeldSlot', slot]); return { ok: true, heldSlot: slot } }
}

async function withServer (run) {
  const bot = new FakeBot()
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idle-bot-')), 'chat.jsonl')
  const chatStore = new ChatStore(file)
  const { server } = createApp(bot, chatStore)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try { await run({ base, bot, chatStore }) } finally { await new Promise(resolve => server.close(resolve)) }
}

test('state, health and static assets are served', async () => {
  await withServer(async ({ base }) => {
    const state = await fetch(`${base}/api/state`)
    assert.equal(state.status, 200)
    assert.equal((await state.json()).username, 'tester')

    const page = await fetch(`${base}/`)
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.match(await page.text(), /app\.js/)

    const script = await fetch(`${base}/app.js`)
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8')

    assert.equal((await fetch(`${base}/../src/config.js`)).status, 404)
    assert.equal((await fetch(`${base}/app.js.map`)).status, 404)
  })
})

test('world queries pass raw query parameters through to the bot', async () => {
  await withServer(async ({ base, bot }) => {
    await fetch(`${base}/api/world?radius=32&ceiling=88`)
    assert.deepEqual(bot.calls.at(-1), ['worldSlice', { radius: '32', ceiling: '88' }])
    await fetch(`${base}/api/world`)
    assert.deepEqual(bot.calls.at(-1), ['worldSlice', { radius: null, ceiling: null }])
  })
})

test('post bodies are size limited and errors come back as JSON', async () => {
  await withServer(async ({ base, bot }) => {
    const ok = await fetch(`${base}/api/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ forward: true }) })
    assert.deepEqual(await ok.json(), { ok: true, input: { forward: true } })

    const huge = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ message: 'x'.repeat(BODY_LIMIT + 10) }) })
    assert.equal(huge.status, 400)
    assert.match((await huge.json()).error, /请求体超过/)

    const broken = await fetch(`${base}/api/chat`, { method: 'POST', body: 'not json' })
    assert.equal(broken.status, 400)
    assert.match((await broken.json()).error, /合法 JSON/)

    const rejected = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify({ message: '' }) })
    assert.equal(rejected.status, 400)
    assert.equal(bot.calls.filter(([name]) => name === 'sendChat').length, 1)
  })
})

test('chat is persisted and streamed to event subscribers', async () => {
  await withServer(async ({ base, bot, chatStore }) => {
    const stream = await fetch(`${base}/events`, { headers: { accept: 'text/event-stream' } })
    const reader = stream.body.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    assert.match(first, /event: state/)

    bot.emit('chat', { id: '1', kind: 'player', sender: 'huoyuuu', text: 'hi', at: new Date(0).toISOString() })
    const pushed = new TextDecoder().decode((await reader.read()).value)
    assert.match(pushed, /event: chat/)
    assert.match(pushed, /huoyuuu/)
    await reader.cancel()

    assert.equal(chatStore.page({}).items.at(-1).text, 'hi')
  })
})
