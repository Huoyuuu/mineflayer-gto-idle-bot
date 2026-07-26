'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { WorldStore, decodeChunkColumn, dimensionBounds, DEFAULT_BOUNDS, NO_DATA, EMPTY_COLUMN } = require('../src/world')
const { localIndex, buildColumn } = require('./fixtures/chunk-encoder')

function stoneFloor (stateId = 1) {
  const blocks = new Array(4096).fill(0)
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) blocks[localIndex(x, 0, z)] = stateId
  return blocks
}

test('decodeChunkColumn round-trips single-valued, indirect and direct palettes', () => {
  const indirect = stoneFloor(1)
  indirect[localIndex(3, 1, 4)] = 9 // grass_block state
  const direct = new Array(4096).fill(0)
  direct[localIndex(15, 15, 15)] = 20000

  const buffer = buildColumn(4, new Map([
    [1, { blocks: indirect, encoding: { bits: 4, palette: [0, 1, 9] } }],
    [2, { blocks: direct, encoding: { bits: 15, palette: null } }]
  ]))
  const sections = decodeChunkColumn(buffer, 4)

  assert.equal(sections.length, 4)
  assert.equal(sections[0].uniform, 0)
  assert.equal(sections[1].values[localIndex(0, 0, 0)], 1)
  assert.equal(sections[1].values[localIndex(3, 1, 4)], 9)
  assert.equal(sections[2].values[localIndex(15, 15, 15)], 20000)
  assert.equal(sections[3].uniform, 0)
})

test('decodeChunkColumn rejects a column that does not consume the whole buffer', () => {
  const buffer = Buffer.concat([buildColumn(2, new Map()), Buffer.from([0x00])])
  assert.throws(() => decodeChunkColumn(buffer, 2), /underrun|invalid|unsupported/)
  assert.throws(() => decodeChunkColumn(buffer, 4), /underrun|invalid|unsupported/)
})

test('decodeChunkColumn accepts complete Forge sections beyond the codec height', () => {
  const extended = buildColumn(25, new Map())
  assert.equal(decodeChunkColumn(extended, 24).length, 25)
  assert.throws(() => decodeChunkColumn(extended.subarray(0, extended.length - 1), 24), /underrun|invalid/)
  assert.throws(() => decodeChunkColumn(Buffer.concat([buildColumn(24, new Map()), Buffer.alloc(12, 0xff)]), 24), /unsupported|invalid/)
})

test('WorldStore keeps only chunks inside the radius and reports its own footprint', () => {
  const store = new WorldStore({ radius: 1, maxChunks: 96 })
  store.reset('minecraft:overworld', { minY: 0, height: 64 })
  const column = buildColumn(4, new Map([[1, { blocks: stoneFloor(1), encoding: { bits: 4, palette: [0, 1] } }]]))

  for (let x = -2; x <= 2; x++) assert.equal(store.loadColumn(x, 0, column), true)
  assert.equal(store.chunks.size, 5)
  store.setCenter(0, 0)
  assert.equal(store.chunks.size, 3)
  assert.equal(store.loadColumn(9, 9, column), false)

  const stats = store.stats()
  assert.equal(stats.chunks, 3)
  assert.equal(stats.sections, 3)
  assert.equal(stats.bytes, 3 * 4096 * 2)
})

test('WorldStore adopts one inferred section span and rejects later mismatches', () => {
  const store = new WorldStore({ radius: 2 })
  store.reset('minecraft:overworld', { minY: -64, height: 64 })
  assert.equal(store.loadColumn(0, 0, buildColumn(5, new Map())), true)
  assert.equal(store.sectionCount, 5)
  assert.equal(store.height, 80)
  assert.equal(store.loadColumn(1, 0, buildColumn(6, new Map())), false)
  assert.match(store.lastError, /section count changed/)
})

test('WorldStore resolves blocks, edits and the ground level', () => {
  const store = new WorldStore({ radius: 2 })
  store.reset('minecraft:overworld', { minY: -64, height: 384 })
  const blocks = new Array(4096).fill(0)
  blocks[localIndex(0, 5, 0)] = 1
  store.loadColumn(0, 0, buildColumn(24, new Map([[8, { blocks, encoding: { bits: 4, palette: [0, 1] } }]])))

  assert.equal(store.getBlock(0, 69, 0), 1)
  assert.equal(store.getBlock(0, 70, 0), 0)
  assert.equal(store.getBlock(500, 70, 0), null)
  assert.equal(store.groundAt(0.4, 71, 0.4), 70)

  assert.equal(store.setBlock(0, 70, 0, 1), true)
  assert.equal(store.getBlock(0, 70, 0), 1)
  assert.equal(store.getBlock(1, 69, 0), 0)
})

test('WorldStore surface slices the highest block below the ceiling', () => {
  const store = new WorldStore({ radius: 2 })
  store.reset('minecraft:overworld', { minY: 0, height: 64 })
  const blocks = new Array(4096).fill(0)
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) blocks[localIndex(x, 0, z)] = 1
  blocks[localIndex(2, 4, 2)] = 9
  store.loadColumn(0, 0, buildColumn(4, new Map([[1, { blocks, encoding: { bits: 4, palette: [0, 1, 9] } }]])))

  const view = store.surface({ centerX: 2, centerZ: 2, radius: 1, ceiling: 63 })
  assert.equal(view.size, 3)
  assert.deepEqual(view.origin, { x: 1, z: 1 })
  const center = view.blocks[1 * 3 + 1]
  assert.equal(view.palette[center], 'grass_block')
  assert.equal(view.heights[1 * 3 + 1], 20)
  assert.equal(view.palette[view.blocks[0]], 'stone')
  assert.equal(view.heights[0], 16)

  const below = store.surface({ centerX: 2, centerZ: 2, radius: 1, ceiling: 18 })
  assert.equal(below.palette[below.blocks[1 * 3 + 1]], 'stone')

  const outside = store.surface({ centerX: 900, centerZ: 900, radius: 1, ceiling: 63 })
  assert.equal(outside.blocks[0], NO_DATA)

  store.reset('minecraft:overworld', { minY: 0, height: 64 })
  store.loadColumn(0, 0, buildColumn(4, new Map()))
  assert.equal(store.surface({ centerX: 2, centerZ: 2, radius: 0, ceiling: 63 }).blocks[0], EMPTY_COLUMN)
})

test('dimensionBounds reads the login codec and falls back to overworld limits', () => {
  const codec = {
    value: {
      'minecraft:dimension_type': {
        value: {
          value: {
            value: [
              { name: { value: 'minecraft:overworld' }, element: { value: { min_y: { value: -64 }, height: { value: 384 } } } },
              { name: { value: 'minecraft:the_nether' }, element: { value: { min_y: { value: 0 }, height: { value: 256 } } } }
            ]
          }
        }
      }
    }
  }
  assert.deepEqual(dimensionBounds(codec, 'minecraft:the_nether'), { minY: 0, height: 256 })
  assert.deepEqual(dimensionBounds(codec, 'unknown:dimension'), DEFAULT_BOUNDS)
  assert.deepEqual(dimensionBounds(null, 'minecraft:overworld'), DEFAULT_BOUNDS)
})

test('dimensionBounds reads the real 1.20.1 registry codec shape', () => {
  const codec = require('minecraft-data')('1.20.1').loginPacket.dimensionCodec
  assert.deepEqual(dimensionBounds(codec, 'minecraft:overworld'), { minY: -64, height: 384 })
})
