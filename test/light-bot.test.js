'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { LightBot, CUSTOM_PACKETS, mergePosition, reconnectDelay, textOf, describeInventory } = require('../src/light-bot')
const { buildColumn, slab } = require('./fixtures/chunk-encoder')

// A bot that is "in game" on a flat stone floor at y = 65, with no real socket.
function stagedBot ({ yaw = 0 } = {}) {
  const bot = new LightBot()
  const writes = []
  bot.client = { write: (name, data) => writes.push([name, data]) }
  bot.state.connected = true
  bot.state.phase = 'play'
  bot.state.entityId = 7
  bot.state.position = { x: 8.5, y: 65, z: 8.5, yaw, pitch: 0 }
  bot.setLook(yaw, 0)
  bot.world.reset('minecraft:overworld', { minY: 0, height: 128 })
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) bot.world.loadColumn(x, z, buildColumn(8, new Map([[4, slab(1, 0)]])))
  }
  return { bot, writes }
}

const lastPosition = writes => writes.filter(([name]) => name === 'position_look').at(-1)?.[1]

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

test('keyboard input is clamped to the lightweight control state', () => {
  const bot = new LightBot()
  bot.client = { write: () => {} }
  bot.state.connected = true
  const result = bot.setInput({ forward: 1, sprint: true })
  assert.equal(result.input.forward, true)
  assert.equal(result.input.sprint, true)
  clearInterval(bot.controlTimer)
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

test('walking follows the bot yaw instead of the world axes', () => {
  const south = stagedBot({ yaw: 0 })
  south.bot.setInput({ forward: true })
  south.bot.applyInput()
  const forward = lastPosition(south.writes)
  assert.ok(forward.z > 8.5, 'yaw 0 faces +Z')
  assert.equal(Number(forward.x.toFixed(6)), 8.5)

  const west = stagedBot({ yaw: 90 })
  west.bot.setInput({ forward: true })
  west.bot.applyInput()
  const strafed = lastPosition(west.writes)
  assert.ok(strafed.x < 8.5, 'yaw 90 faces -X')
  assert.equal(Number(strafed.z.toFixed(6)), 8.5)

  const right = stagedBot({ yaw: 0 })
  right.bot.setInput({ right: true })
  right.bot.applyInput()
  assert.ok(lastPosition(right.writes).x < 8.5, 'facing +Z, the right hand points to -X')

  for (const staged of [south, west, right]) staged.bot.stopControlLoop()
})

test('movement stays on the decoded floor and a jump arcs back down', () => {
  const { bot, writes } = stagedBot()
  bot.setInput({ forward: true })
  for (let tick = 0; tick < 5; tick++) bot.applyInput()
  assert.equal(lastPosition(writes).y, 65, 'the floor keeps the bot at y = 65')

  bot.setInput({ jump: true })
  bot.applyInput()
  const airborne = lastPosition(writes).y
  assert.ok(airborne > 65, 'the jump impulse lifts the bot')
  bot.setInput({ jump: false })
  for (let tick = 0; tick < 8; tick++) bot.applyInput()
  assert.equal(lastPosition(writes).y, 65, 'gravity brings it back to the floor')
  bot.stopControlLoop()
})

test('sneaking and sprinting are announced as entity actions exactly once', () => {
  const { bot, writes } = stagedBot()
  bot.setInput({ forward: true, sprint: true })
  bot.applyInput(); bot.applyInput()
  const actions = writes.filter(([name]) => name === 'entity_action').map(([, data]) => data.actionId)
  assert.deepEqual(actions, [3], 'start sprinting once')
  bot.setInput({ sprint: false, sneak: true })
  bot.applyInput()
  assert.deepEqual(writes.filter(([name]) => name === 'entity_action').map(([, data]) => data.actionId), [3, 0, 4])
  bot.stopControlLoop()
})

test('held input expires when the page stops refreshing it', () => {
  const { bot, writes } = stagedBot()
  bot.setInput({ forward: true })
  bot.applyInput()
  const walked = lastPosition(writes)
  bot.lastInputAt = Date.now() - 60 * 1000
  bot.applyInput()
  assert.equal(bot.input.forward, false, 'the watchdog releases the key')
  bot.applyInput()
  assert.deepEqual(lastPosition(writes), walked, 'and the bot stops moving')
  bot.stopControlLoop()
})

test('the control loop stops itself once every key is released', () => {
  const { bot } = stagedBot()
  bot.setInput({ forward: true })
  assert.ok(bot.controlTimer, 'holding a key starts the loop')
  bot.setInput({ forward: false })
  for (let tick = 0; tick <= 41; tick++) bot.applyInput()
  assert.equal(bot.controlTimer, null, 'idle ticks release the interval')
})

test('block interaction validates reach, breakability and faces the target', async () => {
  const { bot, writes } = stagedBot()
  await assert.rejects(() => bot.handleWorldInput({ button: 'left', target: { x: 200, y: 64, z: 8 } }), /交互范围/)
  await assert.rejects(() => bot.handleWorldInput({ button: 'up', target: { x: 8, y: 64, z: 8 } }), /鼠标按钮无效/)
  await assert.rejects(() => bot.handleWorldInput({ button: 'left', target: { x: 8, y: 64.5, z: 8 } }), /坐标无效/)

  const result = await bot.handleWorldInput({ button: 'left', target: { x: 8, y: 64, z: 9 }, shiftKey: true })
  assert.equal(result.block, 'stone')
  const names = writes.map(([name]) => name)
  assert.ok(names.includes('position_look'), 'the bot looks at the block first')
  assert.deepEqual(writes.filter(([name]) => name === 'block_dig').map(([, data]) => data.status), [0, 2])
  assert.equal(bot.action, null, 'the action slot is released again')
})

test('the world slice is centred on the bot and carries a block palette', () => {
  const { bot } = stagedBot()
  const slice = bot.worldSlice({ radius: 4 })
  assert.equal(slice.ok, true)
  assert.equal(slice.size, 9)
  assert.deepEqual(slice.origin, { x: 4, z: 4 })
  assert.equal(slice.ceiling, 67)
  assert.equal(slice.palette[slice.blocks[4 * 9 + 4]], 'stone')
  assert.equal(slice.heights[4 * 9 + 4], 64)
  assert.equal(slice.bot.x, 8.5)

  const empty = new LightBot()
  assert.equal(empty.worldSlice().ok, false)
})

test('inventory slots are named and split into hotbar and backpack', () => {
  const slots = new Array(46).fill(null)
  slots[9] = { present: true, itemId: 1, itemCount: 64 }
  slots[36] = { present: true, itemId: 1, itemCount: 3 }
  slots[44] = { present: false, itemId: 0, itemCount: 0 }
  const described = describeInventory(slots)
  assert.deepEqual(described, [
    { slot: 9, id: 1, count: 64, name: 'stone', hotbar: null },
    { slot: 36, id: 1, count: 3, name: 'stone', hotbar: 0 }
  ])
  assert.deepEqual(describeInventory(null), [])
})
