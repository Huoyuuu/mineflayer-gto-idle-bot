'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { LightBot, CUSTOM_PACKETS, mergePosition, reconnectDelay, textOf } = require('../src/light-bot')

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

test('reconnectDelay uses the requested exponential schedule and caps at 60 minutes', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map(reconnectDelay),
    [2, 4, 8, 16, 32, 60].map(minutes => minutes * 60 * 1000)
  )
  assert.equal(reconnectDelay(6), 60 * 60 * 1000)
})
