'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { LightBot, CUSTOM_PACKETS, mergePosition, reconnectDelay, networkQuality, textOf, NETWORK_WINDOW } = require('../src/light-bot')

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

test('networkQuality needs a full window with low loss and latency', () => {
  const good = Array(NETWORK_WINDOW).fill(250)
  assert.equal(networkQuality(good.slice(1)).good, false)
  assert.equal(networkQuality(good).good, true)
  assert.equal(networkQuality([...good.slice(2), null, null]).good, false)
  assert.equal(networkQuality([...good.slice(1), null]).good, true)
  assert.equal(networkQuality(Array(NETWORK_WINDOW).fill(600)).good, false)
  assert.equal(networkQuality([...good.slice(3), 1500, 1500, 1500]).good, false)
})

test('probe reconnects only after the window turns good', async () => {
  let latency = null
  const bot = new LightBot({ probe: async () => ({ latency }) })
  let connects = 0
  bot.connect = () => { connects++ }
  bot.schedule(); clearInterval(bot.timer)
  for (let i = 0; i < NETWORK_WINDOW; i++) await bot.probe(bot.generation)
  assert.equal(connects, 0)
  latency = 200
  for (let i = 0; i < NETWORK_WINDOW - 2; i++) await bot.probe(bot.generation)
  assert.equal(connects, 0)
  await bot.probe(bot.generation)
  assert.equal(connects, 1)
})
