'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { mergePosition, reconnectDelay, textOf } = require('../src/light-bot')

test('mergePosition applies relative flags', () => {
  const old = { x: 10, y: 20, z: 30, yaw: 40, pitch: 50 }
  assert.deepEqual(mergePosition(old, { x: 1, y: 2, z: 3, yaw: 4, pitch: 5, flags: 0x15 }),
    { x: 11, y: 2, z: 33, yaw: 4, pitch: 55 })
})

test('textOf flattens chat components without HTML', () => {
  assert.equal(textOf('{"text":"hello ","extra":[{"text":"world"}]}'), 'hello world')
  assert.equal(textOf('plain'), 'plain')
})

test('reconnectDelay uses the requested exponential schedule and caps at 60 minutes', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map(reconnectDelay),
    [2, 4, 8, 16, 32, 60].map(minutes => minutes * 60 * 1000)
  )
  assert.equal(reconnectDelay(6), 60 * 60 * 1000)
})
