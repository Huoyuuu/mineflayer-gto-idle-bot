'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { isStorageBusEvidence, normalize } = require('../scripts/storage-bus-scan')

test('finds a storage bus identifier nested in block entity NBT', () => {
  assert.equal(isStorageBusEvidence({ value: { parts: [{ id: 'ae2:storage_bus' }] } }), true)
  assert.equal(isStorageBusEvidence({ value: { id: 'ae2:cable_bus' } }), false)
})

test('normalizes protocol values for deterministic JSON output', () => {
  assert.deepEqual(normalize({ count: 2n, payload: Buffer.from([0xab, 0xcd]) }), {
    count: '2',
    payload: { type: 'Buffer', hex: 'abcd' }
  })
})
