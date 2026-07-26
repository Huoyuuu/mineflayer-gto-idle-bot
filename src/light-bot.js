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
    this.input = { forward: false, back: false, left: false, right: false, jump: false, sprint: false }
    this.respawnRequested = false
    this.startedAt = Date.now()
    this.state = {
      phase: 'offline', connected: false, username: this.options.botUsername,
      host: this.options.mcHost, port: this.options.mcPort, version: this.options.mcVersion,
      entityId: null, world: null, gameMode: null, health: null, food: null,
      position: null, packets: 0, chunksIgnored: 0, reconnects: 0,
      consecutiveReconnects: 0, cooldownUntil: null,
      nextReconnectAt: null, reconnectDelayMs: null, reconnectAttempt: 0,
      lastPacketAt: null, lastError: null, p0: null, inventory: []
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
    clearInterval(this.controlTimer)
    this.timer = this.loginTimer = this.stableTimer = this.cooldownTimer = this.livenessTimer = null
    this.client?.end('stopped'); this.socket?.destroy()
    this.client = this.socket = null
    this.action = null
    this.controlTimer = null
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
    this.input = { ...this.input, ...Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Boolean(value)])) }
    if (!this.controlTimer) this.controlTimer = setInterval(() => this.applyInput(), 100)
    return { ok: true, input: this.input }
  }
  applyInput () {
    if (!this.client || !this.state.position) return
    const speed = this.input.sprint ? 0.22 : 0.12
    const dx = (this.input.right ? speed : 0) - (this.input.left ? speed : 0)
    const dz = (this.input.back ? speed : 0) - (this.input.forward ? speed : 0)
    if (!dx && !dz && !this.input.jump) return
    this.client.write('position', { x: this.state.position.x + dx, y: this.state.position.y + (this.input.jump ? 0.42 : 0), z: this.state.position.z + dz, onGround: !this.input.jump })
  }
  async handleWorldInput ({ button, shiftKey = false, spaceKey = false, target }) {
    if (!target || ![target.x, target.y, target.z].every(Number.isInteger)) throw new Error('目标方块坐标无效')
    if (!['left', 'right'].includes(button)) throw new Error('鼠标按钮无效')
    if (!this.state.position) throw new Error('Bot 尚未获得位置')
    if (Math.hypot(this.state.position.x - target.x, this.state.position.z - target.z) > 6) throw new Error('目标方块距离 Bot 太远')
    if (this.action) throw new Error('已有动作正在执行: ' + this.action)
    this.action = 'world-input'; this.emit('state', this.snapshot())
    try {
      if (button === 'left') this.client.write('block_dig', { status: shiftKey ? 2 : (spaceKey ? 1 : 0), location: target, face: 1, sequence: this.sequence++ })
      else this.client.write('block_place', { hand: 0, location: target, direction: 1, cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5, insideBlock: Boolean(shiftKey), sequence: this.sequence++ })
      return { ok: true, target, button, shiftKey, spaceKey }
    } finally { this.action = null; this.emit('state', this.snapshot()) }
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
    this.emit('state', this.snapshot())
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
    client.on('packet', active((_, meta) => { this.state.packets++; this.state.lastPacketAt = new Date().toISOString(); if (meta?.name === 'map_chunk') this.state.chunksIgnored++ }))
    client.on('login', active(packet => this.onLogin(packet)))
    client.on('position', active(packet => { this.state.position = mergePosition(this.state.position, packet); if (!this.state.p0) this.state.p0 = { x: this.state.position.x, y: this.state.position.y, z: this.state.position.z }; client.write('teleport_confirm', { teleportId: packet.teleportId }); client.write('position_look', { ...this.state.position, onGround: false }); this.emit('state', this.snapshot()) }))
    client.on('window_items', active(packet => { if (packet.windowId === 0) { this.state.inventory = packet.items || []; this.emit('state', this.snapshot()) } }))
    client.on('update_health', active(packet => { this.state.health = packet.health; this.state.food = packet.food; if (packet.health <= 0 && !this.respawnRequested) { this.respawnRequested = true; client.write('client_command', { actionId: 0 }) } if (packet.health > 0) this.respawnRequested = false; this.emit('state', this.snapshot()) }))
    client.on('respawn', active(packet => { this.respawnRequested = false; this.state.world = packet.worldName || packet.dimension || this.state.world; this.state.position = null; this.emit('state', this.snapshot()) }))
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

module.exports = { LightBot, CUSTOM_PACKETS, mergePosition, reconnectDelay, textOf }
