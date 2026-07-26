'use strict'

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const EventEmitter = require('node:events')
const mc = require('minecraft-protocol')
const { config } = require('./config')
const ChatMessage = require('prismarine-chat')(config.mcVersion)
const CHAT_LANGUAGE = {
  ...require('minecraft-data')(config.mcVersion).language,
  'commands.list.players': '%s/%s %s'
}
const { installForge3 } = require('./forge3')
const { WorldStore, dimensionBounds, blockName, blockInfo, isSkipped } = require('./world')
const itemsById = require('minecraft-data')(config.mcVersion).items

const RECONNECT_DELAYS = [
  2 * 60 * 1000,
  4 * 60 * 1000,
  8 * 60 * 1000,
  16 * 60 * 1000,
  32 * 60 * 1000,
  60 * 60 * 1000
]
const MAX_CONSECUTIVE_RECONNECTS = 3
const COOLDOWN_MS = 2 * 60 * 60 * 1000
const STABLE_RESET_MS = 10 * 60 * 1000
const LIVENESS_TIMEOUT_MS = 90 * 1000
const ACTION_TIMEOUT_MS = 15 * 1000
const CONTROL_TICK_MS = 100
const CONTROL_IDLE_TICKS = 40
// A browser tab that dies while a key is held must not leave the bot walking forever,
// so held input expires unless the page keeps refreshing it.
const INPUT_TIMEOUT_MS = 4 * 1000
const WORLD_EVENT_THROTTLE_MS = 300
const MAX_DIG_MS = 8 * 1000
const WALK_SPEED = 0.18
const SPRINT_SPEED = 0.32
const SNEAK_SPEED = 0.08
const JUMP_VELOCITY = 0.42
const GRAVITY = 0.16
const REACH = 6
const SILENCER_POS = { x: 94, y: 124, z: -79 }
const CHEST_POS = { x: 95, y: 124, z: -78 }
const COOLDOWN_FILE = path.resolve(__dirname, '../.minecraft-idle-bot.cooldown')
const CUSTOM_PACKETS = {
  '1.20': {
    play: {
      toClient: {
        types: {
          packet_declare_recipes: ['container', [{ name: 'data', type: 'restBuffer' }]]
        }
      }
    }
  }
}

function reconnectDelay (attempt) {
  const index = Math.min(Math.max(0, attempt), RECONNECT_DELAYS.length - 1)
  return RECONNECT_DELAYS[index]
}

function textOf (component) {
  if (component == null) return ''
  try {
    let value = component
    if (typeof component === 'string') {
      try { value = JSON.parse(component) } catch { return new ChatMessage(component).toString() }
    }
    return new ChatMessage(value).toString(CHAT_LANGUAGE)
  } catch { return typeof component === 'string' ? component : String(component) }
}

function mergePosition (old, packet) {
  const current = old || { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }
  return {
    x: (packet.flags & 1) ? current.x + packet.x : packet.x,
    y: (packet.flags & 2) ? current.y + packet.y : packet.y,
    z: (packet.flags & 4) ? current.z + packet.z : packet.z,
    yaw: (packet.flags & 8) ? current.yaw + packet.yaw : packet.yaw,
    pitch: (packet.flags & 16) ? current.pitch + packet.pitch : packet.pitch
  }
}

// Window 0 slots: 0 crafting output, 1-4 crafting, 5-8 armor, 9-35 backpack,
// 36-44 hotbar, 45 offhand. Only the non-empty ones reach the page, with names.
const HOTBAR_FIRST = 36
const HOTBAR_LAST = 44
function describeInventory (slots) {
  return (slots || []).flatMap((slot, index) => {
    const id = slot?.itemId
    if (!id || slot.present === false) return []
    return [{
      slot: index,
      id,
      count: slot.itemCount ?? 1,
      name: itemsById[id]?.name || `item_${id}`,
      hotbar: index >= HOTBAR_FIRST && index <= HOTBAR_LAST ? index - HOTBAR_FIRST : null
    }]
  })
}

class LightBot extends EventEmitter {
  constructor (options = {}) {
    super()
    this.options = { ...config, ...options }
    this.client = null
    this.socket = null
    this.timer = null
    this.loginTimer = null
    this.stableTimer = null
    this.livenessTimer = null
    this.cooldownTimer = null
    this.cooldownUntil = null
    this.consecutiveReconnects = 0
    this.attempt = 0
    this.stopping = false
    this.action = null
    this.sequence = 0
    this.controlTimer = null
    this.controlIdleTicks = 0
    this.lastInputAt = 0
    this.input = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
    this.look = { yaw: 0, pitch: 0 }
    this.velocityY = 0
    this.sneaking = false
    this.sprinting = false
    this.world = new WorldStore({ radius: Math.min(6, Math.max(2, this.options.viewDistance + 1)) })
    this.worldTimer = null
    this.dimensionCodec = null
    this.respawnRequested = false
    this.startedAt = Date.now()
    this.state = {
      phase: 'offline', connected: false, username: this.options.botUsername,
      host: this.options.mcHost, port: this.options.mcPort, version: this.options.mcVersion,
      entityId: null, world: null, dimension: null, gameMode: null, health: null, food: null,
      position: null, look: { yaw: 0, pitch: 0 }, packets: 0, chunksIgnored: 0, chunksLoaded: 0,
      reconnects: 0, consecutiveReconnects: 0, cooldownUntil: null,
      nextReconnectAt: null, reconnectDelayMs: null, reconnectAttempt: 0,
      lastPacketAt: null, lastError: null, p0: null, inventory: [], heldSlot: 0,
      timeOfDay: null, dayCount: null, worldStats: null, actionDeadline: null
    }
  }

  start () {
    if (this.client || this.cooldownTimer) return this
    this.stopping = false
    const persistedUntil = this.readCooldown()
    if (persistedUntil > Date.now()) {
      this.cooldownUntil = persistedUntil
      this.state.phase = 'cooldown'
      this.state.cooldownUntil = new Date(persistedUntil).toISOString()
      this.state.connected = false
      this.emit('state', this.snapshot())
      this.cooldownTimer = setTimeout(() => {
        this.cooldownTimer = null
        this.cooldownUntil = null
        this.clearCooldown()
        this.state.cooldownUntil = null
        this.state.phase = 'offline'
        this.emit('state', this.snapshot())
        this.start()
      }, persistedUntil - Date.now())
      console.error(`[bot] cooldown active until ${new Date(persistedUntil).toISOString()}`)
      return this
    }
    this.clearCooldown()
    this.connect()
    return this
  }
  stop () {
    this.stopping = true
    this.generation = Symbol('stopped')
    clearTimeout(this.timer); clearTimeout(this.loginTimer)
    clearTimeout(this.stableTimer); clearTimeout(this.cooldownTimer); clearInterval(this.livenessTimer)
    this.stopControlLoop(); clearTimeout(this.worldTimer)
    this.timer = this.loginTimer = this.stableTimer = this.cooldownTimer = this.livenessTimer = this.worldTimer = null
    this.client?.end('stopped'); this.socket?.destroy()
    this.client = this.socket = null
    this.action = null
    this.state.phase = 'offline'; this.state.connected = false
    this.emit('state', this.snapshot())
  }
  readCooldown () {
    try {
      const value = Number.parseInt(fs.readFileSync(COOLDOWN_FILE, 'utf8').trim(), 10)
      return Number.isFinite(value) ? value : 0
    } catch { return 0 }
  }
  clearCooldown () {
    try { fs.unlinkSync(COOLDOWN_FILE) } catch (error) { if (error.code !== 'ENOENT') console.error(`[bot] cannot clear cooldown: ${error.message}`) }
  }
  enterCooldown (reason, trigger = `${MAX_CONSECUTIVE_RECONNECTS + 1} consecutive reconnects reached`) {
    clearTimeout(this.timer); clearTimeout(this.loginTimer); clearTimeout(this.stableTimer); clearInterval(this.livenessTimer)
    this.timer = this.loginTimer = this.stableTimer = this.livenessTimer = null
    const until = Date.now() + COOLDOWN_MS
    try { fs.writeFileSync(COOLDOWN_FILE, `${until}\n`, { mode: 0o600 }) } catch (error) { console.error(`[bot] cannot persist cooldown: ${error.message}`) }
    this.cooldownUntil = until
    this.state.phase = 'cooldown'; this.state.connected = false
    this.state.cooldownUntil = new Date(until).toISOString()
    console.error(`[bot] ${reason}; ${trigger}, restarting service and cooling down until ${this.state.cooldownUntil}`)
    this.client?.end('reconnect cooldown')
    this.socket?.destroy()
    setTimeout(() => process.exit(75), 100)
  }
  snapshot () {
    return { ...this.state, position: this.state.position && { ...this.state.position },
      uptime: Math.floor((Date.now() - this.startedAt) / 1000) }
  }
  sendChat (value) {
    const message = String(value ?? '').trim()
    if (!message || message.length > 256) throw new Error('消息长度必须为 1-256 个字符')
    if (!this.client || !this.state.connected) throw new Error('Bot 尚未进入服务器')
    this.client.chat(message)
  }
  runAction (name) {
    if (!this.client || !this.state.connected) throw new Error('Bot 尚未进入服务器')
    if (this.action) throw new Error('已有动作正在执行: ' + this.action)
    if (name === 'return-p0') return this.returnToP0()
    if (name === 'empty-silencer') return this.emptySilencer()
    throw new Error('未知动作')
  }
  setInput (input = {}) {
    if (!this.client || !this.state.connected) throw new Error('Bot 尚未进入服务器')
    const flags = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
    for (const key of flags) if (key in input) this.input[key] = Boolean(input[key])
    if (input.look) this.setLook(input.look.yaw, input.look.pitch)
    this.controlIdleTicks = 0
    this.lastInputAt = Date.now()
    if (!this.controlTimer) this.controlTimer = setInterval(() => this.applyInput(), CONTROL_TICK_MS)
    return { ok: true, input: this.input, look: this.look }
  }
  releaseInput (reason) {
    if (!Object.values(this.input).some(Boolean)) return false
    this.input = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
    if (this.client && this.state.connected) this.syncPose()
    console.error(`[bot] input released: ${reason}`)
    this.emit('state', this.snapshot())
    return true
  }
  stopControlLoop () {
    clearInterval(this.controlTimer)
    this.controlTimer = null
    this.controlIdleTicks = 0
  }
  setLook (yaw, pitch) {
    if (Number.isFinite(yaw)) this.look.yaw = ((Number(yaw) % 360) + 540) % 360 - 180
    if (Number.isFinite(pitch)) this.look.pitch = Math.max(-90, Math.min(90, Number(pitch)))
    this.state.look = { ...this.look }
    return this.look
  }
  // No physics engine: movement is yaw-relative stepping, snapped onto whatever floor
  // the decoded world says is under the bot, plus a decaying jump impulse.
  applyInput () {
    if (!this.client || !this.state.connected || !this.state.position) return
    if (Date.now() - this.lastInputAt > INPUT_TIMEOUT_MS && this.releaseInput('web page stopped refreshing held keys')) return
    const { forward, back, left, right, jump, sprint, sneak } = this.input
    const moving = forward || back || left || right
    if (!moving && !jump && this.velocityY === 0) {
      if (++this.controlIdleTicks > CONTROL_IDLE_TICKS) this.stopControlLoop()
      return
    }
    this.controlIdleTicks = 0
    this.syncPose()
    const speed = sneak ? SNEAK_SPEED : (sprint ? SPRINT_SPEED : WALK_SPEED)
    const radians = this.look.yaw * Math.PI / 180
    const forwardX = -Math.sin(radians)
    const forwardZ = Math.cos(radians)
    const axis = (Number(forward) - Number(back))
    const strafe = (Number(right) - Number(left))
    const x = this.state.position.x + (forwardX * axis - forwardZ * strafe) * speed
    const z = this.state.position.z + (forwardZ * axis + forwardX * strafe) * speed
    const ground = this.world.groundAt(x, this.state.position.y, z)
    const grounded = ground != null && this.state.position.y <= ground + 0.01
    if (jump && grounded && this.velocityY <= 0) this.velocityY = JUMP_VELOCITY
    else if (!grounded || this.velocityY > 0) this.velocityY -= GRAVITY
    let y = this.state.position.y + this.velocityY
    if (ground == null) { y = this.state.position.y; this.velocityY = 0 }
    else if (y <= ground) { y = ground; this.velocityY = 0 }
    this.state.position = { ...this.state.position, x, y, z, yaw: this.look.yaw, pitch: this.look.pitch }
    this.client.write('position_look', { x, y, z, yaw: this.look.yaw, pitch: this.look.pitch, onGround: this.velocityY === 0 })
    this.emit('state', this.snapshot())
  }
  // Sneak and sprint are entity actions, not movement flags; the server ignores speed
  // changes that are not announced.
  syncPose () {
    if (!this.state.entityId) return
    if (this.input.sneak !== this.sneaking) {
      this.sneaking = this.input.sneak
      this.client.write('entity_action', { entityId: this.state.entityId, actionId: this.sneaking ? 0 : 1, jumpBoost: 0 })
    }
    const sprinting = this.input.sprint && !this.input.sneak && (this.input.forward || this.input.back || this.input.left || this.input.right)
    if (sprinting !== this.sprinting) {
      this.sprinting = sprinting
      this.client.write('entity_action', { entityId: this.state.entityId, actionId: sprinting ? 3 : 4, jumpBoost: 0 })
    }
  }
  faceBlock (target) {
    if (!this.state.position) return
    const dx = target.x + 0.5 - this.state.position.x
    const dy = target.y + 0.5 - (this.state.position.y + 1.62)
    const dz = target.z + 0.5 - this.state.position.z
    const yaw = -Math.atan2(dx, dz) * 180 / Math.PI
    const pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI
    this.setLook(yaw, pitch)
    this.client.write('position_look', { ...this.state.position, yaw: this.look.yaw, pitch: this.look.pitch, onGround: true })
  }
  blockAt (target) {
    const state = this.world.getBlock(target.x, target.y, target.z)
    return state == null ? null : { state, name: blockName(state), info: blockInfo(state) }
  }
  // Rough vanilla bare-hand timing; the server is still the authority, this only keeps
  // the two block_dig packets far enough apart to be accepted.
  // Bedrock reports hardness -1; liquids report 100 with an empty bounding box.
  unbreakable (block) {
    const info = block?.info
    if (!info || !Number.isFinite(info.hardness)) return false
    return info.hardness < 0 || (info.hardness >= 100 && info.boundingBox === 'empty')
  }
  digDuration (block) {
    const hardness = block?.info?.hardness
    if (!Number.isFinite(hardness)) return 400
    if (hardness === 0) return 0
    const seconds = hardness * (block.info.harvestTools ? 5 : 1.5)
    return Math.min(MAX_DIG_MS, Math.round(seconds * 1000))
  }
  async handleWorldInput ({ button, shiftKey = false, target }) {
    if (!target || ![target.x, target.y, target.z].every(Number.isInteger)) throw new Error('目标方块坐标无效')
    if (!['left', 'right'].includes(button)) throw new Error('鼠标按钮无效')
    if (!this.client || !this.state.connected) throw new Error('Bot 尚未进入服务器')
    if (!this.state.position) throw new Error('Bot 尚未获得位置')
    const distance = Math.hypot(this.state.position.x - (target.x + 0.5), this.state.position.y + 1.62 - (target.y + 0.5), this.state.position.z - (target.z + 0.5))
    if (distance > REACH) throw new Error(`目标方块距离 Bot ${distance.toFixed(1)} 格，超出 ${REACH} 格交互范围`)
    if (this.action) throw new Error('已有动作正在执行: ' + this.action)
    const block = this.blockAt(target)
    if (button === 'left') {
      if (block && isSkipped(block.state)) throw new Error('目标位置是空气，没有可破坏的方块')
      if (this.unbreakable(block)) throw new Error(`${block.name} 无法破坏`)
    }
    return button === 'left' ? this.digBlock(target, block, shiftKey) : this.useBlock(target, block, shiftKey)
  }
  async digBlock (target, block, instant) {
    const duration = instant ? 0 : this.digDuration(block)
    this.action = `dig ${block?.name || 'block'}`
    this.state.actionDeadline = new Date(Date.now() + duration).toISOString()
    this.emit('state', this.snapshot())
    try {
      this.faceBlock(target)
      this.client.write('block_dig', { status: 0, location: target, face: 1, sequence: this.sequence++ })
      this.client.write('arm_animation', { hand: 0 })
      if (duration > 0) await new Promise(resolve => setTimeout(resolve, duration))
      this.client.write('block_dig', { status: 2, location: target, face: 1, sequence: this.sequence++ })
      return { ok: true, action: 'dig', target, block: block?.name || null, durationMs: duration }
    } finally {
      this.action = null; this.state.actionDeadline = null; this.emit('state', this.snapshot())
    }
  }
  async useBlock (target, block, insideBlock) {
    this.action = `use ${block?.name || 'block'}`
    this.emit('state', this.snapshot())
    try {
      this.faceBlock(target)
      this.client.write('block_place', { hand: 0, location: target, direction: 1, cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5, insideBlock: Boolean(insideBlock), sequence: this.sequence++ })
      this.client.write('arm_animation', { hand: 0 })
      return { ok: true, action: 'use', target, block: block?.name || null }
    } finally { this.action = null; this.emit('state', this.snapshot()) }
  }
  setHeldSlot (slot) {
    const slotId = Number.parseInt(slot, 10)
    if (!Number.isInteger(slotId) || slotId < 0 || slotId > 8) throw new Error('快捷栏槽位必须为 0-8')
    if (!this.client || !this.state.connected) throw new Error('Bot 尚未进入服务器')
    this.client.write('held_item_slot', { slotId })
    this.state.heldSlot = slotId
    this.emit('state', this.snapshot())
    return { ok: true, heldSlot: slotId }
  }
  worldSlice ({ radius, ceiling } = {}) {
    if (!this.state.position) return { ok: false, error: 'Bot 尚未获得位置' }
    const clamped = Math.min(48, Math.max(4, Number.parseInt(radius, 10) || 24))
    // `Number('')` is 0, which would silently slice the world at bedrock.
    const requested = Number.parseInt(ceiling, 10)
    const level = Number.isInteger(requested) ? requested : Math.floor(this.state.position.y) + 2
    return {
      ok: true,
      bot: { x: this.state.position.x, y: this.state.position.y, z: this.state.position.z, yaw: this.look.yaw, pitch: this.look.pitch },
      ...this.world.surface({ centerX: Math.floor(this.state.position.x), centerZ: Math.floor(this.state.position.z), radius: clamped, ceiling: level })
    }
  }
  markWorldChanged () {
    this.state.chunksLoaded = this.world.chunks.size
    if (this.worldTimer) return
    this.worldTimer = setTimeout(() => {
      this.worldTimer = null
      this.state.worldStats = this.world.stats()
      this.emit('world', { revision: this.world.revision, ...this.state.worldStats })
    }, WORLD_EVENT_THROTTLE_MS)
  }
  moveTo (position) {
    this.client.write('position', { ...position, onGround: true })
    this.state.position = { ...(this.state.position || {}), ...position }
    this.emit('state', this.snapshot())
  }
  async returnToP0 () {
    if (!this.state.p0) throw new Error('P0 尚未记录')
    this.action = 'return-p0'; this.emit('state', this.snapshot())
    try { this.moveTo(this.state.p0); return { ok: true, action: this.action, position: this.state.p0 } } finally { this.action = null; this.emit('state', this.snapshot()) }
  }
  waitFor (event, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(event + ' 等待超时')) }, ACTION_TIMEOUT_MS)
      const handler = (...args) => { try { if (!predicate(...args)) return; cleanup(); resolve(args[0]) } catch (error) { cleanup(); reject(error) } }
      const cleanup = () => { clearTimeout(timer); this.client?.removeListener(event, handler) }
      this.client.once(event, handler)
    })
  }
  async emptySilencer () {
    this.action = 'empty-silencer'; this.emit('state', this.snapshot())
    try {
      this.moveTo(SILENCER_POS)
      const windowPromise = this.waitFor('open_window')
      this.client.write('block_place', { hand: 0, location: SILENCER_POS, direction: 1, cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5, insideBlock: false, sequence: this.sequence++ })
      const opened = await windowPromise
      const windowId = opened.windowId
      const items = await this.waitFor('window_items', packet => packet.windowId === windowId)
      const slots = items.items.map((item, slot) => ({ item, slot })).filter(({ item, slot }) => slot >= 0 && slot < items.items.length - 36 && item && item.itemId !== 0)
      for (const { slot } of slots) {
        this.client.write('window_click', { windowId, stateId: items.stateId, slot, mouseButton: 0, mode: 1, changedSlots: [], cursorItem: { itemId: 0, itemCount: 0, nbtData: null } })
        await new Promise(resolve => setTimeout(resolve, 120))
      }
      this.client.write('close_window', { windowId })
      return { ok: true, action: this.action, movedSlots: slots.length }
    } finally { this.action = null; this.emit('state', this.snapshot()) }
  }
  addChat (kind, sender, message) {
    const entry = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, kind, sender: sender || 'server', text: message, at: new Date().toISOString() }
    this.emit('chat', entry)
  }
  connect () {
    const generation = Symbol('connection')
    this.generation = generation
    this.state.phase = this.state.reconnects ? 'reconnecting' : 'connecting'
    this.state.nextReconnectAt = null; this.state.reconnectDelayMs = null; this.state.reconnectAttempt = 0
    this.state.lastPacketAt = null
    this.emit('state', this.snapshot())
    let client
    try {
      client = mc.createClient({ host: this.options.mcHost, port: this.options.mcPort, username: this.options.botUsername,
        auth: 'offline', version: this.options.mcVersion, hideErrors: true, customPackets: CUSTOM_PACKETS,
        connect: connected => { connected.once('connect', () => installForge3(connected, { log: m => this.log(m) })); this.socket = net.connect({ host: this.options.mcHost, port: this.options.mcPort }); connected.setSocket(this.socket) } })
    } catch (error) { this.fail(error); return }
    this.client = client
    const active = handler => (...args) => { if (this.generation === generation && this.client === client) handler(...args) }
    client.on('packet', active((_, meta) => { this.state.packets++; this.state.lastPacketAt = new Date().toISOString() }))
    client.on('login', active(packet => this.onLogin(packet)))
    client.on('position', active(packet => {
      this.state.position = mergePosition(this.state.position, packet)
      this.setLook(this.state.position.yaw, this.state.position.pitch)
      this.velocityY = 0
      this.world.setCenter(Math.floor(this.state.position.x) >> 4, Math.floor(this.state.position.z) >> 4)
      if (!this.state.p0) this.state.p0 = { x: this.state.position.x, y: this.state.position.y, z: this.state.position.z }
      client.write('teleport_confirm', { teleportId: packet.teleportId })
      client.write('position_look', { ...this.state.position, onGround: false })
      this.emit('state', this.snapshot())
    }))
    client.on('update_view_position', active(packet => this.world.setCenter(packet.chunkX, packet.chunkZ)))
    client.on('map_chunk', active(packet => {
      if (this.world.loadColumn(packet.x, packet.z, packet.chunkData)) this.markWorldChanged()
      else this.state.chunksIgnored++
    }))
    client.on('unload_chunk', active(packet => { this.world.unloadColumn(packet.chunkX, packet.chunkZ); this.markWorldChanged() }))
    client.on('block_change', active(packet => {
      const { x, y, z } = packet.location
      if (this.world.setBlock(x, y, z, packet.type)) this.markWorldChanged()
    }))
    client.on('multi_block_change', active(packet => {
      const base = packet.chunkCoordinates
      let changed = false
      for (const record of packet.records || []) {
        const value = Number(record)
        const state = Math.floor(value / 4096)
        const local = value % 4096
        const x = (base.x << 4) + ((local >> 8) & 15)
        const z = (base.z << 4) + ((local >> 4) & 15)
        const y = (base.y << 4) + (local & 15)
        changed = this.world.setBlock(x, y, z, state) || changed
      }
      if (changed) this.markWorldChanged()
    }))
    client.on('update_time', active(packet => {
      const time = Number(packet.time)
      this.state.timeOfDay = ((Math.abs(time) % 24000) + 24000) % 24000
      this.state.dayCount = Math.floor(Number(packet.age) / 24000)
    }))
    client.on('held_item_slot', active(packet => { this.state.heldSlot = packet.slot ?? this.state.heldSlot; this.emit('state', this.snapshot()) }))
    client.on('window_items', active(packet => { if (packet.windowId === 0) { this.state.inventory = describeInventory(packet.items); this.emit('state', this.snapshot()) } }))
    client.on('update_health', active(packet => { this.state.health = packet.health; this.state.food = packet.food; if (packet.health <= 0 && !this.respawnRequested) { this.respawnRequested = true; client.write('client_command', { actionId: 0 }) } if (packet.health > 0) this.respawnRequested = false; this.emit('state', this.snapshot()) }))
    client.on('respawn', active(packet => {
      this.respawnRequested = false
      this.state.world = packet.worldName || this.state.world
      this.state.dimension = packet.dimension || this.state.dimension
      this.state.position = null
      this.velocityY = 0
      // Block ids are dimension local: keeping the old column would render the wrong world.
      this.world.reset(packet.worldName, dimensionBounds(this.dimensionCodec, packet.dimension))
      this.markWorldChanged()
      this.emit('state', this.snapshot())
    }))
    client.on('playerChat', active(packet => this.addChat('player', textOf(packet.senderName) || packet.sender || packet.senderUuid, packet.plainMessage || textOf(packet.unsignedContent || packet.formattedMessage))))
    client.on('systemChat', active(packet => this.addChat(packet.positionId === 2 ? 'actionbar' : 'system', 'server', textOf(packet.formattedMessage))))
    client.on('disconnect', active(packet => {
      const reason = textOf(packet?.reason ?? packet) || 'server disconnect'
      this.state.lastError = reason
      console.error(`[bot] disconnect: ${reason}`)
    }))
    client.on('error', active(error => {
      this.fail(error)
      if (/^Parse error /.test(this.state.lastError)) {
        console.error('[bot] fatal protocol parse error; closing connection for recovery')
        this.socket?.destroy()
      }
    }))
    client.on('end', reason => {
      if (this.generation !== generation) return
      const wasConnected = this.state.connected
      clearTimeout(this.loginTimer); clearTimeout(this.stableTimer); clearInterval(this.livenessTimer)
      this.loginTimer = this.stableTimer = this.livenessTimer = null; this.client = this.socket = null
      this.stopControlLoop()
      this.input = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
      this.sneaking = this.sprinting = false
      this.velocityY = 0
      this.action = null
      this.state.connected = false; this.state.phase = 'offline'
      const endReason = textOf(reason) || this.state.lastError || 'socket closed'
      this.state.lastError ||= endReason
      console.error(`[bot] connection ended: ${endReason}`)
      if (this.stopping) return
      if (wasConnected) {
        this.consecutiveReconnects++
        this.state.consecutiveReconnects = this.consecutiveReconnects
      }
      this.emit('state', this.snapshot())
      if (wasConnected && this.consecutiveReconnects > MAX_CONSECUTIVE_RECONNECTS) {
        this.enterCooldown(endReason)
        return
      }
      if (!wasConnected && this.attempt >= RECONNECT_DELAYS.length) {
        this.enterCooldown(endReason, 'the 60-minute retry also failed')
        return
      }
      this.schedule()
    })
    this.loginTimer = setTimeout(() => { if (!this.state.connected && this.client === client) client.end('login timeout') }, 45000)
  }
  onLogin (packet) {
    clearTimeout(this.loginTimer); this.loginTimer = null; this.attempt = 0
    this.state.phase = 'play'; this.state.connected = true; this.state.entityId = packet.entityId; this.state.world = packet.worldName; this.state.gameMode = packet.gameMode; this.state.lastError = null
    this.dimensionCodec = packet.dimensionCodec
    this.state.dimension = packet.worldType || packet.dimension || null
    this.world.reset(packet.worldName, dimensionBounds(this.dimensionCodec, this.state.dimension))
    this.state.worldStats = this.world.stats()
    clearTimeout(this.stableTimer)
    this.stableTimer = setTimeout(() => {
      this.consecutiveReconnects = 0
      this.state.consecutiveReconnects = 0
      this.emit('state', this.snapshot())
      console.log(`[bot] connection stable for ${STABLE_RESET_MS / 60000} minutes; reconnect counter reset`)
    }, STABLE_RESET_MS)
    const playStartedAt = Date.now()
    this.livenessTimer = setInterval(() => {
      const lastActivity = this.state.lastPacketAt ? Date.parse(this.state.lastPacketAt) : playStartedAt
      if (this.state.connected && Date.now() - lastActivity > LIVENESS_TIMEOUT_MS) {
        this.state.lastError = `no packets received for ${LIVENESS_TIMEOUT_MS / 1000} seconds`
        console.error(`[bot] ${this.state.lastError}; closing stale connection`)
        this.emit('state', this.snapshot())
        this.socket?.destroy()
      }
    }, 15 * 1000)
    this.client.write('settings', { locale: 'zh_CN', viewDistance: this.options.viewDistance, chatFlags: 0, chatColors: true, skinParts: 0, mainHand: 1, enableTextFiltering: false, enableServerListing: false })
    this.addChat('system', 'bot', `已进入 ${packet.worldName || '服务器'}`)
  }
  schedule () {
    clearTimeout(this.timer)
    const delay = reconnectDelay(this.attempt++)
    this.state.reconnects++
    this.state.phase = 'reconnecting'
    this.state.reconnectDelayMs = delay
    this.state.reconnectAttempt = this.attempt
    this.state.nextReconnectAt = new Date(Date.now() + delay).toISOString()
    this.timer = setTimeout(() => this.connect(), delay)
    console.error(`[bot] reconnect attempt ${this.attempt} scheduled in ${delay / 60000} minutes at ${this.state.nextReconnectAt}`)
    this.emit('state', this.snapshot())
  }
  fail (error) { this.state.lastError = error?.message || String(error); if (this.options.debug) console.error(`[bot] ${this.state.lastError}`); this.emit('state', this.snapshot()) }
  log (message) { if (this.options.debug) console.log(message) }
}

module.exports = { LightBot, CUSTOM_PACKETS, mergePosition, reconnectDelay, textOf, describeInventory }
