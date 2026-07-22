'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { mergePosition, textOf } = require('../src/light-bot')

test('mergePosition applies relative flags', () => {
  const old = { x: 10, y: 20, z: 30, yaw: 40, pitch: 50 }
  assert.deepEqual(mergePosition(old, { x: 1, y: 2, z: 3, yaw: 4, pitch: 5, flags: 0x15 }),
    { x: 11, y: 2, z: 33, yaw: 4, pitch: 55 })
})

test('textOf flattens chat components without HTML', () => {
  assert.equal(textOf('{"text":"hello ","extra":[{"text":"world"}]}'), 'hello world')
  assert.equal(textOf('plain'), 'plain')
})
