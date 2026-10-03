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
const KEEPALIVE_TIMEOUT_MS = 60 * 1000
// Network gate: after a drop, probe with Server List Ping (no login) and only reconnect
// once a full sliding window is good; conservative thresholds, 60-minute fallback.
const PROBE_INTERVAL_MS = 30 * 1000
const PROBE_TIMEOUT_MS = 5 * 1000
const NETWORK_WINDOW = 20
const NETWORK_MAX_FAILURES = 1
const NETWORK_MAX_MEDIAN_MS = 400
const NETWORK_MAX_P90_MS = 800
const NETWORK_FALLBACK_MS = 60 * 60 * 1000
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
  // attempt 0 is the network gate alone; later attempts add the exponential schedule
  if (attempt <= 0) return 0
  return RECONNECT_DELAYS[Math.min(attempt - 1, RECONNECT_DELAYS.length - 1)]
}

// samples: latency in ms, or null for a failed probe (most recent last)
function networkQuality (samples) {
  const window = samples.slice(-NETWORK_WINDOW)
  const ok = window.filter(value => value != null).sort((a, b) => a - b)
  const pick = q => ok.length ? ok[Math.min(ok.length - 1, Math.floor(q * ok.length))] : null
  const failures = window.length - ok.length
  const medianMs = pick(0.5)
  const p90Ms = pick(0.9)
  const good = window.length >= NETWORK_WINDOW && failures <= NETWORK_MAX_FAILURES &&
    medianMs <= NETWORK_MAX_MEDIAN_MS && p90Ms <= NETWORK_MAX_P90_MS
  return { good, samples: window.length, failures, medianMs, p90Ms }
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
    this.cooldownFile = options.cooldownFile || COOLDOWN_FILE
    this.client = null
    this.socket = null
    this.timer = null
    this.loginTimer = null
    this.stableTimer = null
    this.samples = []
    this.livenessTimer = null
    this.cooldownTimer = null
    this.cooldownUntil = null
    this.consecutiveReconnects = 0
    this.attempt = 0
    this.stopping = false
    this.respawnRequested = false
    this.startedAt = Date.now()
    this.state = {
      phase: 'offline', connected: false, username: this.options.botUsername,
      host: this.options.mcHost, port: this.options.mcPort, version: this.options.mcVersion,
      entityId: null, world: null, gameMode: null, health: null, food: null,
      position: null, packets: 0, chunksIgnored: 0, reconnects: 0,
      consecutiveReconnects: 0, cooldownUntil: null,
      nextReconnectAt: null, reconnectDelayMs: null, reconnectAttempt: 0,
      lastPacketAt: null, lastError: null, sessionStartedAt: null, network: null
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
        // Cooldown expiry is a reconnect too: go through the network gate.
        this.schedule()
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
    this.timer = this.loginTimer = this.stableTimer = this.cooldownTimer = this.livenessTimer = null
    this.client?.end('stopped'); this.socket?.destroy()
    this.client = this.socket = null
    this.state.phase = 'offline'; this.state.connected = false
    this.state.sessionStartedAt = null
    this.emit('state', this.snapshot())
  }
  readCooldown () {
    try {
      const value = Number.parseInt(fs.readFileSync(this.cooldownFile, 'utf8').trim(), 10)
      return Number.isFinite(value) ? value : 0
    } catch { return 0 }
  }
  clearCooldown () {
    try { fs.unlinkSync(this.cooldownFile) } catch (error) { if (error.code !== 'ENOENT') console.error(`[bot] cannot clear cooldown: ${error.message}`) }
  }
  enterCooldown (reason, trigger = `${MAX_CONSECUTIVE_RECONNECTS + 1} consecutive reconnects reached`) {
    clearTimeout(this.timer); clearTimeout(this.loginTimer); clearTimeout(this.stableTimer); clearInterval(this.livenessTimer)
    this.timer = this.loginTimer = this.stableTimer = this.livenessTimer = null
    const until = Date.now() + COOLDOWN_MS
    try { fs.writeFileSync(this.cooldownFile, `${until}\n`, { mode: 0o600 }) } catch (error) { console.error(`[bot] cannot persist cooldown: ${error.message}`) }
    this.cooldownUntil = until
    this.state.phase = 'cooldown'; this.state.connected = false
    this.state.cooldownUntil = new Date(until).toISOString()
    console.error(`[bot] ${reason}; ${trigger}, restarting service and cooling down until ${this.state.cooldownUntil}`)
    this.client?.end('reconnect cooldown')
    this.socket?.destroy()
    setTimeout(() => process.exit(75), 100)
  }
  snapshot () {
    const now = Date.now()
    return { ...this.state, position: this.state.position && { ...this.state.position },
      uptime: Math.floor((now - this.startedAt) / 1000),
      startedAt: new Date(this.startedAt).toISOString(),
      sessionUptime: this.state.sessionStartedAt
        ? Math.floor((now - Date.parse(this.state.sessionStartedAt)) / 1000)
        : null,
      serverTime: new Date(now).toISOString() }
  }
  sendChat (value) {
    const message = String(value ?? '').trim()
    if (!message || message.length > 256) throw new Error('消息长度必须为 1-256 个字符')
    if (!this.client || !this.state.connected) throw new Error('Bot 尚未进入服务器')
    this.client.chat(message)
  }
  addChat (kind, sender, message) {
    const text = String(message ?? '').trim()
    if (!text) return
    if (kind === 'system' && /^(gtocore\.|doespotatotick\.)/.test(text)) return
    const entry = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, kind, sender: sender || 'server', text, at: new Date().toISOString() }
    this.emit('chat', entry)
    this.emit('state', this.snapshot())
  }
  connect () {
    const generation = Symbol('connection')
    this.generation = generation
    this.state.phase = this.state.reconnects ? 'reconnecting' : 'connecting'
    this.state.nextReconnectAt = null; this.state.reconnectDelayMs = null; this.state.reconnectAttempt = 0
    clearInterval(this.timer); this.timer = null
    this.state.lastPacketAt = null
    this.emit('state', this.snapshot())
    let client
    try {
      client = mc.createClient({ host: this.options.mcHost, port: this.options.mcPort, username: this.options.botUsername,
        auth: 'offline', version: this.options.mcVersion, hideErrors: true, customPackets: CUSTOM_PACKETS, checkTimeoutInterval: KEEPALIVE_TIMEOUT_MS,
        connect: connected => { connected.once('connect', () => installForge3(connected, { log: m => this.log(m) })); this.socket = net.connect({ host: this.options.mcHost, port: this.options.mcPort }); connected.setSocket(this.socket) } })
    } catch (error) { this.fail(error); return }
    this.client = client
    const active = handler => (...args) => { if (this.generation === generation && this.client === client) handler(...args) }
    client.on('packet', active((_, meta) => { this.state.packets++; this.state.lastPacketAt = new Date().toISOString(); if (meta?.name === 'map_chunk') this.state.chunksIgnored++ }))
    client.on('login', active(packet => this.onLogin(packet)))
    client.on('position', active(packet => { this.state.position = mergePosition(this.state.position, packet); client.write('teleport_confirm', { teleportId: packet.teleportId }); client.write('position_look', { ...this.state.position, onGround: false }); this.emit('state', this.snapshot()) }))
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
      this.state.sessionStartedAt = null
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
      if (!wasConnected && this.attempt > RECONNECT_DELAYS.length) {
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
    this.state.sessionStartedAt = new Date().toISOString()
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
    clearInterval(this.timer)
    const delay = reconnectDelay(this.attempt++)
    this.state.reconnects++
    this.state.phase = 'reconnecting'
    this.state.reconnectDelayMs = delay
    this.state.reconnectAttempt = this.attempt
    // Fresh window: only probes taken after this drop count toward the gate.
    this.samples = []
    this.state.network = networkQuality(this.samples)
    this.gateAt = Date.now() + delay
    this.fallbackAt = this.gateAt + NETWORK_FALLBACK_MS
    this.state.nextReconnectAt = new Date(this.fallbackAt).toISOString()
    const generation = this.generation
    this.timer = setInterval(() => this.probe(generation), PROBE_INTERVAL_MS)
    console.error(`[bot] reconnect attempt ${this.attempt}: wait ${delay / 60000} minutes, then reconnect once network is good (fallback at ${this.state.nextReconnectAt})`)
    this.emit('state', this.snapshot())
  }
  async probe (generation) {
    if (this.probing) return
    this.probing = true
    let latency = null
    try {
      const ping = this.options.probe || (() => mc.ping({ host: this.options.mcHost, port: this.options.mcPort, version: this.options.mcVersion, closeTimeout: PROBE_TIMEOUT_MS, noPongTimeout: PROBE_TIMEOUT_MS }))
      const result = await ping()
      latency = Number.isFinite(result?.latency) ? result.latency : null
    } catch {} finally { this.probing = false }
    // Ignore results that arrive after stop(), a manual login, or a new drop.
    if (this.generation !== generation || this.client || this.stopping) return
    this.samples.push(latency)
    if (this.samples.length > NETWORK_WINDOW) this.samples.shift()
    const quality = this.state.network = networkQuality(this.samples)
    const now = Date.now()
    if (now >= this.gateAt && (quality.good || now >= this.fallbackAt)) {
      console.error(`[bot] ${quality.good ? 'network good' : 'network fallback reached'} (median ${quality.medianMs}ms, p90 ${quality.p90Ms}ms, ${quality.failures}/${quality.samples} failed); reconnecting`)
      this.connect()
      return
    }
    this.emit('state', this.snapshot())
  }
  fail (error) { this.state.lastError = error?.message || String(error); if (this.options.debug) console.error(`[bot] ${this.state.lastError}`); this.emit('state', this.snapshot()) }
  log (message) { if (this.options.debug) console.log(message) }
}

module.exports = {
  LightBot,
  CUSTOM_PACKETS,
  mergePosition,
  reconnectDelay,
  networkQuality,
  textOf,
  RECONNECT_DELAYS,
  MAX_CONSECUTIVE_RECONNECTS,
  COOLDOWN_MS,
  STABLE_RESET_MS,
  LIVENESS_TIMEOUT_MS,
  NETWORK_WINDOW
}
