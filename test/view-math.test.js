'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const view = require('../public/view-math')

const CONTROL_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ControlLeft', 'KeyQ', 'KeyE']
const intent = (event, controlling) => view.keyIntent(event, { controlling, controlKeys: CONTROL_KEYS })

test('the chat box keeps every key while it is focused', () => {
  const input = { tagName: 'INPUT' }
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyR']) {
    assert.equal(intent({ code, target: input }, true), 'type', `${code} must reach the input`)
  }
  assert.equal(intent({ code: 'Escape', target: input }, true), 'blur')
  assert.equal(intent({ code: 'KeyW', target: { isContentEditable: true } }, true), 'type')
})

test('movement keys only apply while the canvas holds control', () => {
  const canvas = { tagName: 'CANVAS' }
  assert.equal(intent({ code: 'KeyW', target: canvas }, false), 'ignore')
  assert.equal(intent({ code: 'KeyW', target: canvas }, true), 'control')
  assert.equal(intent({ code: 'Escape', target: canvas }, true), 'release')
  assert.equal(intent({ code: 'KeyZ', target: canvas }, true), 'ignore')
})

test('rotate is a plain shortcut so ctrl+r still reloads the page', () => {
  const canvas = { tagName: 'CANVAS' }
  assert.equal(intent({ code: 'KeyR', target: canvas }, false), 'rotate')
  assert.equal(intent({ code: 'KeyR', target: canvas, ctrlKey: true }, false), 'ignore')
  assert.equal(intent({ code: 'ControlLeft', target: canvas, ctrlKey: true }, true), 'control')
})

test('grid rotation stays a bijection and keeps the centre cell centred', () => {
  const size = 5
  for (const rotation of [0, 1, 2, 3]) {
    const seen = new Set()
    for (let a = 0; a < size; a++) {
      for (let b = 0; b < size; b++) {
        const [ix, iz] = view.rotatedIndex(a, b, size, rotation)
        assert.ok(ix >= 0 && ix < size && iz >= 0 && iz < size)
        seen.add(`${ix},${iz}`)
      }
    }
    assert.equal(seen.size, size * size)
    assert.deepEqual(view.rotatedIndex(2, 2, size, rotation), [2, 2])
  }
})

test('fractional rotation matches the grid rotation it pairs with', () => {
  const size = 5
  const centre = (size - 1) / 2
  for (const rotation of [0, 1, 2, 3]) {
    for (const [a, b] of [[0, 0], [4, 1], [3, 2]]) {
      const [ix, iz] = view.rotatedIndex(a, b, size, rotation)
      assert.deepEqual(view.toRotated(ix - centre, iz - centre, rotation), [a - centre, b - centre])
    }
  }
})

test('block colours are stable, distinct per family and never out of range', () => {
  assert.deepEqual(view.colorFor('grass_block'), view.colorFor('grass_block'))
  assert.notDeepEqual(view.colorFor('water'), view.colorFor('lava'))
  assert.notDeepEqual(view.colorFor('modded:strange_block'), view.colorFor('modded:other_block'))
  for (const name of ['stone', 'unknown', 'modded:x']) {
    assert.ok(view.colorFor(name).every(channel => channel >= 0 && channel <= 255))
  }
  assert.equal(view.rgb([300, -20, 128], 1), 'rgb(255,0,128)')
})

test('clock, compass and durations read like a dashboard', () => {
  assert.equal(view.gameClock(0), '06:00')
  assert.equal(view.gameClock(6000), '12:00')
  assert.equal(view.gameClock(18000), '00:00')
  assert.equal(view.gameClock(-1000), '05:00')
  assert.equal(view.compass(0), '南')
  assert.equal(view.compass(-180), '北')
  assert.equal(view.compass(90), '西')
  assert.equal(view.formatDuration(90), '1m 30s')
  assert.equal(view.formatDuration(3700), '1h 1m')
  assert.equal(view.formatDuration(90000), '1d 1h')
  assert.equal(view.formatDuration(null), '--')
  assert.equal(view.countdown(new Date(125000).toISOString(), 0), '2m 05s')
})
