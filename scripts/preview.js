'use strict'

// Dev-only preview: serves the real web UI with a synthetic world so the page can be
// driven without logging into the live Minecraft server (a duplicate login would kick
// the production bot). Usage: node scripts/preview.js

const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { LightBot } = require('../src/light-bot')
const { ChatStore } = require('../src/chat-store')
const { createApp } = require('../src/server')
const { buildColumn } = require('../test/fixtures/chunk-encoder')
const { config } = require('../src/config')
const blocksByName = require('minecraft-data')(config.mcVersion).blocksByName

const SECTIONS = 8
const MIN_Y = 0
const state = name => blocksByName[name]?.defaultState ?? 0
const STATES = {
  stone: state('stone'), grass: state('grass_block'), dirt: state('dirt'), water: state('water'),
  planks: state('oak_planks'), glass: state('glass'), bricks: state('stone_bricks'), lantern: state('lantern')
}
const localIndex = (x, y, z) => ((y & 15) << 8) | ((z & 15) << 4) | (x & 15)

// Rolling hills, a pond and a small brick hut next to the bot's spawn.
function terrainColumn (chunkX, chunkZ) {
  const sections = new Map()
  const set = (x, y, z, state) => {
    const index = Math.floor((y - MIN_Y) / 16)
    if (index < 0 || index >= SECTIONS) return
    if (!sections.has(index)) sections.set(index, { blocks: new Array(4096).fill(0), encoding: { bits: 15, palette: null } })
    sections.get(index).blocks[localIndex(x, y, z)] = state
  }
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      const worldX = chunkX * 16 + x
      const worldZ = chunkZ * 16 + z
      const height = Math.round(64 + Math.sin(worldX / 9) * 3 + Math.cos(worldZ / 7) * 2)
      for (let y = 56; y < height; y++) set(x, y, z, y > height - 4 ? STATES.dirt : STATES.stone)
      const pond = Math.hypot(worldX - 20, worldZ - 20) < 5
      set(x, height, z, pond ? STATES.water : STATES.grass)
      const inHut = worldX >= 4 && worldX <= 10 && worldZ >= 4 && worldZ <= 10
      const wall = inHut && (worldX === 4 || worldX === 10 || worldZ === 4 || worldZ === 10)
      if (wall) for (let y = height + 1; y <= height + 3; y++) set(x, y, z, y === height + 2 ? STATES.glass : STATES.bricks)
      if (inHut && !wall) set(x, height + 4, z, STATES.planks)
      if (worldX === 12 && worldZ === 7) set(x, height + 1, z, STATES.lantern)
    }
  }
  return buildColumn(SECTIONS, sections)
}

const bot = new LightBot()
bot.client = { write: (name, data) => { if (process.env.PREVIEW_TRACE) console.log('[write]', name, JSON.stringify(data)) } }
bot.state.phase = 'play'
bot.state.connected = true
bot.state.entityId = 42
bot.state.world = 'minecraft:overworld'
bot.state.dimension = 'minecraft:overworld'
bot.state.health = 18
bot.state.food = 15
bot.state.timeOfDay = 4200
bot.state.dayCount = 137
bot.state.heldSlot = 0
bot.state.position = { x: 8.5, y: 70, z: 8.5, yaw: 0, pitch: 0 }
bot.state.p0 = { x: 8.5, y: 70, z: 8.5 }
bot.state.inventory = [
  { slot: 36, id: 1, count: 64, name: 'stone', hotbar: 0 },
  { slot: 37, id: 795, count: 1, name: 'diamond_pickaxe', hotbar: 1 },
  { slot: 9, id: 20, count: 32, name: 'oak_planks', hotbar: null }
]
bot.world.reset('minecraft:overworld', { minY: MIN_Y, height: SECTIONS * 16 })
for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) bot.world.loadColumn(x, z, terrainColumn(x, z))
bot.world.setCenter(0, 0)
bot.state.worldStats = bot.world.stats()
bot.setLook(0, 0)

const chatStore = new ChatStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idle-bot-preview-')), 'chat.jsonl'))
for (const [kind, sender, text] of [
  ['system', 'bot', '已进入 minecraft:overworld'],
  ['player', 'huoyuuu', '预览世界已经加载'],
  ['system', 'server', '1/20 huoyuuu_bot']
]) chatStore.append({ id: `${kind}-${sender}`, kind, sender, text, at: new Date().toISOString() })

const { server } = createApp(bot, chatStore)
let port = Number(process.env.WEB_PORT) || 18000
server.on('error', error => { if (error.code === 'EADDRINUSE' && port < 18100) server.listen(++port, '127.0.0.1'); else throw error })
server.on('listening', () => console.log(`[preview] http://127.0.0.1:${server.address().port}  (synthetic world, no Minecraft connection)`))
server.listen(port, '127.0.0.1')
setInterval(() => bot.emit('state', bot.snapshot()), 2000).unref()
