'use strict'

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

const envFile = path.resolve(__dirname, '../.env')
if (fs.existsSync(envFile) && typeof process.loadEnvFile !== 'function') {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match || process.env[match[1]] !== undefined) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    process.env[match[1]] = value
  }
}

const mc = require('minecraft-protocol')
const { config, rootDir } = require('../src/config')
const { installForge3 } = require('../src/forge3')
const { CUSTOM_PACKETS, mergePosition } = require('../src/light-bot')

const DEFAULT_SCAN_MS = 30_000
const DEFAULT_LOGIN_TIMEOUT_MS = 45_000

function normalize (value, seen = new WeakSet()) {
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return { type: 'Buffer', hex: value.toString('hex') }
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(entry => normalize(entry, seen))
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, seen)]))
}

function searchableText (value) {
  return JSON.stringify(normalize(value)).toLowerCase()
}

function isStorageBusEvidence (value) {
  const text = searchableText(value)
  return text.includes('ae2:storage_bus') || text.includes('storage_bus')
}

function positiveInteger (name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function createReport () {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    server: `${config.mcHost}:${config.mcPort}`,
    username: config.botUsername,
    world: null,
    position: null,
    chunks: [],
    blockEntities: [],
    storageBusEvidence: [],
    ae2BlockEntities: [],
    customPayloads: {},
    customPayloadEvidence: [],
    registries: {},
    errors: []
  }
}

function scan () {
  const report = createReport()
  const output = path.resolve(process.env.SCAN_OUTPUT || path.join(rootDir, '.runtime/storage-bus-scan.json'))
  const scanMs = positiveInteger('SCAN_MS', DEFAULT_SCAN_MS)
  const loginTimeoutMs = positiveInteger('SCAN_LOGIN_TIMEOUT_MS', DEFAULT_LOGIN_TIMEOUT_MS)
  const registryNames = new Map()
  const entityKeys = new Map()
  const chunkKeys = new Set()
  let socket
  let client
  let position
  let scanTimer
  let loginTimer
  let finished = false

  function addBlockEntity (entry) {
    const normalized = normalize(entry)
    const key = `${normalized.world}:${normalized.x},${normalized.y},${normalized.z}:${normalized.type}`
    const index = entityKeys.get(key)
    if (index === undefined) {
      entityKeys.set(key, report.blockEntities.length)
      report.blockEntities.push(normalized)
    } else {
      report.blockEntities[index] = normalized
    }
    const typeName = normalized.typeName || ''
    if (typeName.startsWith('ae2:') && !report.ae2BlockEntities.some(item => item.key === key)) {
      report.ae2BlockEntities.push({ key, ...normalized })
    }
    if (isStorageBusEvidence(normalized) && !report.storageBusEvidence.some(item => item.key === key)) {
      report.storageBusEvidence.push({ key, ...normalized })
    }
  }

  function finish (reason, exitCode = 0) {
    if (finished) return
    finished = true
    clearTimeout(scanTimer)
    clearTimeout(loginTimer)
    report.finishedAt = new Date().toISOString()
    report.finishReason = reason
    report.position = position && normalize(position)
    report.summary = {
      chunks: report.chunks.length,
      blockEntities: report.blockEntities.length,
      ae2BlockEntities: report.ae2BlockEntities.length,
      storageBusEvidence: report.storageBusEvidence.length,
      customPayloadEvidence: report.customPayloadEvidence.length
    }
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({ output, ...report.summary, finishReason: reason }))
    try { client?.end('storage bus scan complete') } catch {}
    socket?.destroy()
    setTimeout(() => process.exit(exitCode), 50)
  }

  client = mc.createClient({
    host: config.mcHost,
    port: config.mcPort,
    username: config.botUsername,
    auth: 'offline',
    version: config.mcVersion,
    hideErrors: true,
    customPackets: CUSTOM_PACKETS,
    connect: connected => {
      connected.once('connect', () => installForge3(connected, {
        log: message => console.error(message),
        onRegistryData: registry => {
          if (!registry.hasSnapshot) return
          report.registries[registry.registryName] = registry.ids
          if (registry.registryName === 'minecraft:block_entity_type') {
            for (const entry of registry.ids) registryNames.set(entry.id, entry.name)
          }
        }
      }))
      socket = net.connect({ host: config.mcHost, port: config.mcPort })
      connected.setSocket(socket)
    }
  })

  client.on('login', packet => {
    report.world = packet.worldName || packet.dimension || null
    client.write('settings', {
      locale: 'zh_CN', viewDistance: Math.max(config.viewDistance, 10), chatFlags: 0,
      chatColors: true, skinParts: 0, mainHand: 1,
      enableTextFiltering: false, enableServerListing: false
    })
    clearTimeout(loginTimer)
    scanTimer = setTimeout(() => finish('scan window elapsed'), scanMs)
  })

  client.on('position', packet => {
    position = mergePosition(position, packet)
    client.write('teleport_confirm', { teleportId: packet.teleportId })
    client.write('position_look', { ...position, onGround: false })
  })

  client.on('respawn', packet => {
    report.world = packet.worldName || packet.dimension || report.world
    position = null
  })

  client.on('map_chunk', packet => {
    const chunkKey = `${report.world}:${packet.x},${packet.z}`
    if (!chunkKeys.has(chunkKey)) {
      chunkKeys.add(chunkKey)
      report.chunks.push({ world: report.world, x: packet.x, z: packet.z, blockEntities: packet.blockEntities?.length || 0 })
    }
    for (const blockEntity of packet.blockEntities || []) {
      const typeName = registryNames.get(blockEntity.type) || null
      addBlockEntity({
        source: 'map_chunk', world: report.world,
        x: packet.x * 16 + blockEntity.x, y: blockEntity.y, z: packet.z * 16 + blockEntity.z,
        type: blockEntity.type, typeName, nbt: blockEntity.nbtData
      })
    }
  })

  client.on('tile_entity_data', packet => {
    const location = packet.location || {}
    addBlockEntity({
      source: 'tile_entity_data', world: report.world,
      x: location.x, y: location.y, z: location.z,
      type: packet.action, typeName: registryNames.get(packet.action) || null,
      nbt: packet.nbtData
    })
  })

  client.on('custom_payload', packet => {
    const channel = packet.channel || 'unknown'
    const data = Buffer.isBuffer(packet.data) ? packet.data : Buffer.from(packet.data || [])
    const current = report.customPayloads[channel] || { packets: 0, bytes: 0 }
    current.packets++
    current.bytes += data.length
    report.customPayloads[channel] = current
    const ascii = data.toString('latin1')
    if (/storage_bus|ae2:/i.test(ascii)) {
      report.customPayloadEvidence.push({ channel, bytes: data.length, hex: data.toString('hex') })
    }
  })

  client.on('disconnect', packet => report.errors.push({ event: 'disconnect', packet: normalize(packet) }))
  client.on('error', error => {
    report.errors.push({ event: 'error', message: error.message, stack: error.stack })
    if (/^Parse error /.test(error.message)) socket?.destroy()
  })
  client.on('end', reason => {
    if (!finished) finish(`connection ended: ${String(reason || 'unknown')}`, 1)
  })

  loginTimer = setTimeout(() => finish('login timeout', 1), loginTimeoutMs)
}

if (require.main === module) scan()

module.exports = { isStorageBusEvidence, normalize, searchableText }
