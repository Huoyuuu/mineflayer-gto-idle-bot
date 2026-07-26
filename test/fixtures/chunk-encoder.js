'use strict'

// Independent encoder written from the 1.18+ wire format, so the decoder is checked
// against the spec rather than against itself. Shared by the world and bot tests.

function writeVarInt (bytes, value) {
  let rest = value
  do {
    let byte = rest & 0x7f
    rest >>>= 7
    if (rest !== 0) byte |= 0x80
    bytes.push(byte)
  } while (rest !== 0)
}

function encodePalettedContainer (bytes, values, volume, { bits, palette }) {
  bytes.push(bits)
  if (bits === 0) {
    writeVarInt(bytes, palette[0])
    writeVarInt(bytes, 0)
    return
  }
  if (palette) {
    writeVarInt(bytes, palette.length)
    for (const entry of palette) writeVarInt(bytes, entry)
  }
  const perLong = Math.floor(64 / bits)
  const longs = Math.ceil(volume / perLong)
  writeVarInt(bytes, longs)
  for (let long = 0; long < longs; long++) {
    let hi = 0
    let lo = 0
    for (let slot = 0; slot < perLong; slot++) {
      const index = long * perLong + slot
      if (index >= volume) break
      const raw = palette ? palette.indexOf(values[index]) : values[index]
      // Spread the entry across both 32-bit halves exactly like the server does.
      for (let offset = 0; offset < bits; offset++) {
        if (((raw >> offset) & 1) === 0) continue
        const position = slot * bits + offset
        if (position < 32) lo |= 1 << position
        else hi |= 1 << (position - 32)
      }
    }
    bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff)
    bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff)
  }
}

function encodeSection (bytes, blocks, encoding) {
  const count = blocks ? blocks.filter(state => state !== 0).length : 0
  bytes.push((count >> 8) & 0xff, count & 0xff)
  encodePalettedContainer(bytes, blocks, 4096, encoding)
  encodePalettedContainer(bytes, null, 64, { bits: 0, palette: [4] })
}

function airSection (bytes) {
  bytes.push(0, 0)
  encodePalettedContainer(bytes, null, 4096, { bits: 0, palette: [0] })
  encodePalettedContainer(bytes, null, 64, { bits: 0, palette: [4] })
}

const localIndex = (x, y, z) => ((y & 15) << 8) | ((z & 15) << 4) | (x & 15)

function buildColumn (sectionCount, filled) {
  const bytes = []
  for (let index = 0; index < sectionCount; index++) {
    const section = filled.get(index)
    if (!section) { airSection(bytes); continue }
    encodeSection(bytes, section.blocks, section.encoding)
  }
  return Buffer.from(bytes)
}

// A single section filled to `top` local layers with `stateId`.
function slab (stateId = 1, top = 0) {
  const blocks = new Array(4096).fill(0)
  for (let y = 0; y <= top; y++) {
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) blocks[localIndex(x, y, z)] = stateId
  }
  return { blocks, encoding: { bits: 4, palette: [0, stateId] } }
}

module.exports = { writeVarInt, encodePalettedContainer, encodeSection, airSection, localIndex, buildColumn, slab }
