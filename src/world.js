'use strict'

// Minimal 1.18+ chunk-section decoder. Intentionally does NOT use prismarine-chunk:
// only block state ids inside a small radius around the bot are kept, as Uint16Array
// per non-uniform section, so the idle bot stays far below the old dashboard's RSS.

const { config } = require('./config')
const mcData = require('minecraft-data')(config.mcVersion)

const SKIPPED_BLOCKS = ['air', 'cave_air', 'void_air', 'barrier', 'light', 'structure_void']
const SKIPPED_STATES = new Set()
for (const name of SKIPPED_BLOCKS) {
  const block = mcData.blocksByName?.[name]
  if (!block) continue
  for (let state = block.minStateId; state <= block.maxStateId; state++) SKIPPED_STATES.add(state)
}

const SECTION_VOLUME = 4096
const BIOME_VOLUME = 64
const MAX_BLOCK_INDIRECT_BITS = 8
const MAX_BIOME_INDIRECT_BITS = 3
const MAX_BITS = 16
const DEFAULT_BOUNDS = { minY: -64, height: 384 }
const NO_DATA = -1
const EMPTY_COLUMN = -2

const blockName = state => mcData.blocksByStateId?.[state]?.name || 'unknown'
const blockInfo = state => mcData.blocksByStateId?.[state] || null
const isSkipped = state => state == null || SKIPPED_STATES.has(state)
const chunkKey = (x, z) => `${x},${z}`

class Reader {
  constructor (buffer) {
    this.buffer = buffer
    this.offset = 0
  }

  u8 () {
    if (this.offset >= this.buffer.length) throw new Error('chunk buffer underrun')
    return this.buffer[this.offset++]
  }

  i16 () {
    if (this.offset + 2 > this.buffer.length) throw new Error('chunk buffer underrun')
    const value = this.buffer.readInt16BE(this.offset)
    this.offset += 2
    return value
  }

  varInt () {
    let value = 0
    // Multiplication instead of `<<` keeps the 5th byte from flipping the sign bit.
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.u8()
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return value
    }
    throw new Error('varint too long')
  }

  get remaining () {
    return this.buffer.length - this.offset
  }
}

// Vanilla packs entries LSB-first and never lets one straddle a long, but an entry
// can straddle the 32-bit halves, so both halves are combined with 32-bit maths
// (BigInt here would cost ~2.4M allocations per view-distance refresh).
function readPalettedContainer (reader, volume, maxIndirectBits) {
  const bits = reader.u8()
  if (bits > MAX_BITS) throw new Error(`unsupported bits per entry: ${bits}`)
  let palette = null
  let uniform = null
  if (bits === 0) uniform = reader.varInt()
  else if (bits <= maxIndirectBits) {
    const length = reader.varInt()
    if (length < 0 || length > volume) throw new Error(`invalid palette length: ${length}`)
    palette = new Array(length)
    for (let index = 0; index < length; index++) palette[index] = reader.varInt()
  }
  const longs = reader.varInt()
  if (longs < 0 || longs * 8 > reader.remaining) throw new Error('invalid data array length')
  if (bits === 0) {
    reader.offset += longs * 8
    return { uniform }
  }
  const perLong = Math.floor(64 / bits)
  if (longs < Math.ceil(volume / perLong)) throw new Error('data array too short')
  const mask = (1 << bits) - 1
  const values = new Uint16Array(volume)
  let index = 0
  for (let long = 0; long < longs; long++) {
    const hi = reader.buffer.readUInt32BE(reader.offset + long * 8)
    const lo = reader.buffer.readUInt32BE(reader.offset + long * 8 + 4)
    for (let slot = 0; slot < perLong && index < volume; slot++, index++) {
      const bit = slot * bits
      const raw = bit + bits <= 32
        ? (lo >>> bit) & mask
        : bit >= 32
          ? (hi >>> (bit - 32)) & mask
          : ((lo >>> bit) | (hi << (32 - bit))) & mask
      values[index] = palette ? (palette[raw] ?? 0) : raw
    }
  }
  reader.offset += longs * 8
  return { values }
}

function decodeSection (reader) {
  reader.i16() // block count; recomputed lazily from the palette instead of trusted
  const blocks = readPalettedContainer(reader, SECTION_VOLUME, MAX_BLOCK_INDIRECT_BITS)
  readPalettedContainer(reader, BIOME_VOLUME, MAX_BIOME_INDIRECT_BITS) // biomes are not rendered
  return blocks
}

// The buffer must be consumed exactly: a misaligned decode almost never lands on the
// last byte, so this doubles as a self-check before anything is stored.
function decodeChunkColumn (buffer, sectionCount) {
  const reader = new Reader(buffer)
  const sections = []
  for (let index = 0; index < sectionCount; index++) sections.push(decodeSection(reader))
  if (reader.remaining !== 0) throw new Error(`chunk buffer has ${reader.remaining} trailing bytes`)
  return sections
}

function dimensionBounds (codec, dimensionName) {
  const entries = []
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 12) return
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return }
    const name = node.name?.value ?? node.name
    const element = node.element?.value ?? node.element
    const minY = element?.min_y?.value ?? element?.min_y
    const height = element?.height?.value ?? element?.height
    if (typeof name === 'string' && Number.isInteger(minY) && Number.isInteger(height)) {
      entries.push({ name, minY, height })
    }
    for (const key of Object.keys(node)) visit(node[key], depth + 1)
  }
  try { visit(codec, 0) } catch { /* codec shape is server specific; fall through */ }
  const match = entries.find(entry => entry.name === dimensionName)
  return match ? { minY: match.minY, height: match.height } : { ...DEFAULT_BOUNDS }
}

class WorldStore {
  constructor ({ radius = 4, maxChunks = 96 } = {}) {
    this.radius = radius
    this.maxChunks = maxChunks
    this.chunks = new Map()
    this.dimension = null
    this.minY = DEFAULT_BOUNDS.minY
    this.height = DEFAULT_BOUNDS.height
    this.revision = 0
    this.center = null
    this.errors = 0
    this.lastError = null
  }

  get sectionCount () {
    return Math.ceil(this.height / 16)
  }

  reset (dimension, bounds = {}) {
    this.chunks.clear()
    this.center = null
    this.dimension = dimension ?? this.dimension
    this.minY = Number.isInteger(bounds.minY) ? bounds.minY : DEFAULT_BOUNDS.minY
    this.height = Number.isInteger(bounds.height) ? bounds.height : DEFAULT_BOUNDS.height
    this.revision++
  }

  setCenter (chunkX, chunkZ) {
    if (this.center && this.center.x === chunkX && this.center.z === chunkZ) return
    this.center = { x: chunkX, z: chunkZ }
    this.evict()
  }

  distanceFromCenter (key) {
    if (!this.center) return 0
    const [x, z] = key.split(',').map(Number)
    return Math.max(Math.abs(x - this.center.x), Math.abs(z - this.center.z))
  }

  // Chunks stream in before the first position packet, so eviction only kicks in
  // once the bot's own chunk is known.
  evict () {
    if (this.center) {
      for (const key of [...this.chunks.keys()]) {
        if (this.distanceFromCenter(key) > this.radius) this.chunks.delete(key)
      }
    }
    if (this.chunks.size <= this.maxChunks) return
    const ordered = [...this.chunks.keys()]
      .map(key => ({ key, distance: this.distanceFromCenter(key) }))
      .sort((a, b) => b.distance - a.distance)
    for (const { key } of ordered) {
      if (this.chunks.size <= this.maxChunks) break
      this.chunks.delete(key)
    }
  }

  loadColumn (chunkX, chunkZ, buffer) {
    if (this.center && Math.max(Math.abs(chunkX - this.center.x), Math.abs(chunkZ - this.center.z)) > this.radius) return false
    let sections
    try {
      sections = decodeChunkColumn(buffer, this.sectionCount)
    } catch (error) {
      this.errors++
      this.lastError = error.message
      return false
    }
    this.chunks.set(chunkKey(chunkX, chunkZ), sections)
    this.evict()
    this.revision++
    return true
  }

  unloadColumn (chunkX, chunkZ) {
    if (this.chunks.delete(chunkKey(chunkX, chunkZ))) this.revision++
  }

  sectionIndex (y) {
    const index = Math.floor((y - this.minY) / 16)
    return index >= 0 && index < this.sectionCount ? index : -1
  }

  getBlock (x, y, z) {
    const sections = this.chunks.get(chunkKey(x >> 4, z >> 4))
    if (!sections) return null
    return this.readSection(sections, x, y, z)
  }

  readSection (sections, x, y, z) {
    const index = this.sectionIndex(y)
    if (index < 0) return null
    const section = sections[index]
    if (!section) return null
    if (section.uniform != null) return section.uniform
    const offset = (((y - this.minY) & 15) << 8) | ((z & 15) << 4) | (x & 15)
    return section.values[offset]
  }

  setBlock (x, y, z, state) {
    const key = chunkKey(x >> 4, z >> 4)
    const sections = this.chunks.get(key)
    if (!sections) return false
    const index = this.sectionIndex(y)
    if (index < 0) return false
    let section = sections[index]
    if (!section) return false
    if (section.uniform != null) {
      if (section.uniform === state) return true
      const values = new Uint16Array(SECTION_VOLUME).fill(section.uniform)
      section = { values }
      sections[index] = section
    }
    section.values[(((y - this.minY) & 15) << 8) | ((z & 15) << 4) | (x & 15)] = state
    this.revision++
    return true
  }

  // Highest non-air block per column at or below `ceiling`; the palette keeps the
  // JSON payload small enough to gzip to a few KiB.
  surface ({ centerX, centerZ, radius = 20, ceiling, depth = 96 }) {
    const size = radius * 2 + 1
    const originX = Math.round(centerX) - radius
    const originZ = Math.round(centerZ) - radius
    const top = Math.min(Number.isFinite(ceiling) ? Math.round(ceiling) : this.minY + this.height - 1, this.minY + this.height - 1)
    const bottom = Math.max(this.minY, top - depth)
    const palette = []
    const paletteIndex = new Map()
    const blocks = new Array(size * size).fill(NO_DATA)
    const heights = new Array(size * size).fill(null)
    for (let iz = 0; iz < size; iz++) {
      for (let ix = 0; ix < size; ix++) {
        const x = originX + ix
        const z = originZ + iz
        const sections = this.chunks.get(chunkKey(x >> 4, z >> 4))
        if (!sections) continue
        const cell = iz * size + ix
        blocks[cell] = EMPTY_COLUMN
        for (let y = top; y >= bottom; y--) {
          const state = this.readSection(sections, x, y, z)
          if (isSkipped(state)) continue
          const name = blockName(state)
          let index = paletteIndex.get(name)
          if (index === undefined) {
            index = palette.push(name) - 1
            paletteIndex.set(name, index)
          }
          blocks[cell] = index
          heights[cell] = y
          break
        }
      }
    }
    return {
      dimension: this.dimension,
      origin: { x: originX, z: originZ },
      size,
      ceiling: top,
      minY: this.minY,
      maxY: this.minY + this.height - 1,
      palette,
      blocks,
      heights,
      revision: this.revision,
      stats: this.stats()
    }
  }

  // Highest solid surface in [y - down, y + up]; used to keep manual walking on the
  // ground without importing a physics engine.
  groundAt (x, y, z, { up = 1, down = 4 } = {}) {
    const sections = this.chunks.get(chunkKey(Math.floor(x) >> 4, Math.floor(z) >> 4))
    if (!sections) return null
    const blockX = Math.floor(x)
    const blockZ = Math.floor(z)
    for (let probe = Math.floor(y) + up; probe >= Math.floor(y) - down; probe--) {
      const state = this.readSection(sections, blockX, probe, blockZ)
      if (isSkipped(state)) continue
      const info = blockInfo(state)
      if (info && info.boundingBox === 'empty') continue
      return probe + 1
    }
    return null
  }

  stats () {
    let sections = 0
    let bytes = 0
    for (const column of this.chunks.values()) {
      for (const section of column) {
        if (!section?.values) continue
        sections++
        bytes += section.values.byteLength
      }
    }
    return { chunks: this.chunks.size, sections, bytes, errors: this.errors, lastError: this.lastError }
  }
}

module.exports = {
  WorldStore,
  Reader,
  decodeChunkColumn,
  readPalettedContainer,
  dimensionBounds,
  blockName,
  blockInfo,
  isSkipped,
  DEFAULT_BOUNDS,
  NO_DATA,
  EMPTY_COLUMN,
  SECTION_VOLUME
}
