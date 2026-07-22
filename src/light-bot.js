'use strict'

const net = require('node:net')
const EventEmitter = require('node:events')
const mc = require('minecraft-protocol')
const { config } = require('./config')
const { installForge3 } = require('./forge3')

const RETRIES = [1000, 2000, 5000, 10000, 30000]
const CHAT_LIMIT = 100

function textOf (component) {
  if (component == null) return ''
  if (typeof component !== 'string') return String(component)
  try {
    const value = JSON.parse(component)
    const parts = []
    const visit = item => {
      if (item == null) return
      if (typeof item === 'string') return parts.push(item)
      if (typeof item !== 'object') return
      if (typeof item.text === 'string') parts.push(item.text)
      if (Array.isArray(item.extra)) item.extra.forEach(visit)
      if (Array.isArray(item.with)) item.with.forEach(visit)
    }
    visit(value)
    return parts.join('') || component
  } catch { return component }
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
    this.attempt = 0
    this.respawnRequested = false
    this.startedAt = Date.now()
    this.state = {
      phase: 'offline', connected: false, username: this.options.botUsername,
      host: this.options.mcHost, port: this.options.mcPort, version: this.options.mcVersion,
      entityId: null, world: null, gameMode: null, health: null, food: null,
      position: null, packets: 0, chunksIgnored: 0, reconnects: 0,
      lastPacketAt: null, lastError: null, chat: []
    }
  }

  start () { if (!this.client) this.connect(); return this }
  stop () {
    clearTimeout(this.timer); clearTimeout(this.loginTimer)
    this.timer = this.loginTimer = null
    this.client?.end('stopped'); this.socket?.destroy()
    this.client = this.socket = null
    this.state.phase = 'offline'; this.state.connected = false
    this.emit('state', this.snapshot())
  }
  snapshot () {
    return { ...this.state, position: this.state.position && { ...this.state.position },
      chat: this.state.chat.slice(), uptime: Math.floor((Date.now() - this.startedAt) / 1000) }
  }
  sendChat (value) {
    const message = String(value ?? '').trim()
    if (!message || message.length > 256) throw new Error('消息长度必须为 1-256 个字符')
    if (!this.client || !this.state.connected) throw new Error('Bot 尚未进入服务器')
    this.client.chat(message)
    this.addChat('outbound', this.state.username, message)
  }
  addChat (kind, sender, message) {
    this.state.chat.push({ id: Date.now() + Math.random(), kind, sender: sender || 'server', text: message, at: new Date().toISOString() })
    if (this.state.chat.length > CHAT_LIMIT) this.state.chat.splice(0, this.state.chat.length - CHAT_LIMIT)
    this.emit('chat', this.state.chat[this.state.chat.length - 1]); this.emit('state', this.snapshot())
  }
  connect () {
    const generation = Symbol('connection')
    this.generation = generation
    this.state.phase = this.state.reconnects ? 'reconnecting' : 'connecting'; this.emit('state', this.snapshot())
    let client
    try {
      client = mc.createClient({ host: this.options.mcHost, port: this.options.mcPort, username: this.options.botUsername,
        auth: 'offline', version: this.options.mcVersion, hideErrors: true,
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
    client.on('disconnect', active(packet => { this.state.lastError = textOf(packet?.reason ?? packet) }))
    client.on('error', active(error => this.fail(error)))
    client.on('end', reason => { if (this.generation !== generation) return; clearTimeout(this.loginTimer); this.loginTimer = null; this.client = this.socket = null; this.state.connected = false; this.state.phase = 'offline'; this.state.lastError ||= textOf(reason) || 'socket closed'; this.emit('state', this.snapshot()); this.schedule() })
    this.loginTimer = setTimeout(() => { if (!this.state.connected && this.client === client) client.end('login timeout') }, 45000)
  }
  onLogin (packet) {
    clearTimeout(this.loginTimer); this.loginTimer = null; this.attempt = 0
    this.state.phase = 'play'; this.state.connected = true; this.state.entityId = packet.entityId; this.state.world = packet.worldName; this.state.gameMode = packet.gameMode; this.state.lastError = null
    this.client.write('settings', { locale: 'zh_CN', viewDistance: this.options.viewDistance, chatFlags: 0, chatColors: true, skinParts: 0, mainHand: 1, enableTextFiltering: false, enableServerListing: false })
    this.addChat('system', 'bot', `已进入 ${packet.worldName || '服务器'}`)
  }
  schedule () { clearTimeout(this.timer); const delay = RETRIES[Math.min(this.attempt++, RETRIES.length - 1)]; this.state.reconnects++; this.timer = setTimeout(() => this.connect(), delay); this.emit('state', this.snapshot()) }
  fail (error) { this.state.lastError = error?.message || String(error); if (this.options.debug) console.error(`[bot] ${this.state.lastError}`); this.emit('state', this.snapshot()) }
  log (message) { if (this.options.debug) console.log(message) }
}

module.exports = { LightBot, mergePosition, textOf }
