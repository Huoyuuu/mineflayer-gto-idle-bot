'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { LightBot, CUSTOM_PACKETS, mergePosition, reconnectDelay, networkGate, textOf, GATE } = require('../src/light-bot')

test('LightBot accepts an isolated cooldown file', () => {
  const bot = new LightBot({ cooldownFile: 'diagnostic.cooldown' })
  assert.equal(bot.cooldownFile, 'diagnostic.cooldown')
})

test('mergePosition applies relative flags', () => {
  const old = { x: 10, y: 20, z: 30, yaw: 40, pitch: 50 }
  assert.deepEqual(mergePosition(old, { x: 1, y: 2, z: 3, yaw: 4, pitch: 5, flags: 0x15 }),
    { x: 11, y: 2, z: 33, yaw: 4, pitch: 55 })
})

test('textOf flattens chat components without HTML', () => {
  assert.equal(textOf('{"text":"hello ","extra":[{"text":"world"}]}'), 'hello world')
  assert.equal(textOf('plain'), 'plain')
})

test('textOf preserves separators in translated chat components', () => {
  assert.equal(textOf({ translate: '%s/%s', with: [{ text: '1' }, { text: '20' }] }), '1/20')
  assert.equal(textOf({ translate: 'commands.list.players', with: ['1', '20', 'huoyuuu_bot'] }), '1/20 huoyuuu_bot')
})

test('sendChat waits for the server echo instead of adding a duplicate', () => {
  const bot = new LightBot()
  let sent
  let chatEvents = 0
  bot.client = { chat: message => { sent = message } }
  bot.state.connected = true
  bot.on('chat', () => { chatEvents++ })
  bot.sendChat('hi')
  assert.equal(sent, 'hi')
  assert.equal(chatEvents, 0)
})

test('custom protocol skips Forge recipe payloads the idle bot does not use', async () => {
  const { createDeserializer } = require('../node_modules/minecraft-protocol/src/transforms/serializer')
  const deserializer = createDeserializer({ state: 'play', version: '1.20.1', customPackets: CUSTOM_PACKETS })
  const parsed = await new Promise((resolve, reject) => {
    deserializer.once('data', resolve)
    deserializer.once('error', reject)
    deserializer.end(Buffer.from('6d010203', 'hex'))
  })
  assert.equal(parsed.data.name, 'declare_recipes')
  assert.equal(parsed.data.params.data.toString('hex'), '010203')
})

test('reconnectDelay gates first, then follows the exponential schedule capped at 60 minutes', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map(reconnectDelay),
    [0, 2, 4, 8, 16, 32, 60].map(minutes => minutes * 60 * 1000)
  )
  assert.equal(reconnectDelay(7), 60 * 60 * 1000)
})

const history = now => Array.from({ length: 40 }, (_, i) => ({ t: now - (40 - i) * 30000 + 1, ms: 1500 }))

test('gate uses the last 20 minutes, strictly below 5%, without latency limits', () => {
  const now = Date.now(), probes = history(now)
  assert.equal(networkGate(probes, now).ok, true)
  probes[5].ms = null
  assert.equal(networkGate(probes, now).ok, true) // 2.5%
  probes[6].ms = null
  assert.equal(networkGate(probes, now).ok, false) // exactly 5%
  assert.equal(networkGate(probes, now + GATE.windowMs).ok, false) // stale history
  assert.equal(networkGate(history(now).slice(-5), now).ok, false) // insufficient history
})

test('startup waits like a drop and reuses saved samples on the next probe', async () => {
  const bot = new LightBot({ probe: async () => ({ latency: 200 }) })
  bot.readCooldown = () => 0; bot.clearCooldown = () => {}
  let connects = 0
  bot.connect = () => { connects++; bot.gateAt = null }
  bot.start()
  assert.equal(bot.state.phase, 'reconnecting')
  await bot.probe()
  assert.equal(connects, 0)
  bot.probes = history(Date.now())
  await bot.probe()
  assert.equal(connects, 1)
})

test('backoff, one-hour fallback and manual logout remain respected', async () => {
  const bot = new LightBot({ probe: async () => ({ latency: null }) })
  let connects = 0
  bot.connect = () => { connects++; bot.gateAt = null }
  bot.attempt = 1; bot.schedule()
  await bot.probe()
  assert.equal(connects, 0)
  assert.equal(bot.state.reconnectDelayMs, 120000)
  bot.gateAt = Date.now() - 3600001
  await bot.probe()
  assert.equal(connects, 1)
  bot.schedule(); bot.stop()
  await bot.probe()
  assert.equal(connects, 1)
})
