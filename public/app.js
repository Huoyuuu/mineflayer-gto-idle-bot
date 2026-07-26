'use strict'

// Single-page controller for the idle bot: HUD, isometric world view built from real
// block data, scoped keyboard control and paged chat. Pure maths lives in view-math.js.

const { clamp, rotatedIndex, toRotated, colorFor, rgb, keyIntent, gameClock, compass, formatDuration, countdown } = window.ViewMath

const $ = selector => document.querySelector(selector)
const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const fixed = (value, digits = 1) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '--')
const itemName = name => String(name).replace(/^minecraft:/, '').replace(/_/g, ' ')

const canvas = $('#map')
const ctx = canvas.getContext('2d')
const viewport = canvas.parentElement

const MOVEMENT_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight']
const TURN_KEYS = ['KeyQ', 'KeyE']
const CONTROL_KEYS = [...MOVEMENT_KEYS, ...TURN_KEYS]
const TILE = 15
const HEIGHT_UNIT = 0.62
const TURN_STEP = 9

const view = { rotation: 0, zoom: 1, pan: { x: 0, y: 0 }, radius: 20, ceiling: null, ceilingPinned: false }
const keys = new Set()

let botState = null
let world = null
let cells = []
let target = null
let hover = null
let controlling = false
let look = { yaw: 0, pitch: 0 }
let turnTimer = null
let worldTimer = null
let worldInFlight = false
let worldPending = false
let lastWorldKey = ''
let messages = []
let olderCursor = null
let chatTotal = 0

/* ------------------------------------------------------------------ status */

const PHASE_TEXT = {
  play: ['play', '在线挂机中', 'play'],
  connecting: ['connecting', '正在连接', 'wait'],
  reconnecting: ['reconnecting', '等待重连', 'wait'],
  cooldown: ['cooldown', '冷却保护中', 'down'],
  offline: ['offline', '离线', 'down']
}

function renderState (state) {
  botState = state
  const [label, hint, tone] = PHASE_TEXT[state.phase] || [state.phase, '', 'down']
  $('#phase-text').textContent = label + (state.action ? ' · ' + state.action : '')
  $('#phase-dot').className = 'dot ' + tone
  $('#phase-note').textContent = state.lastError && state.phase !== 'play' ? state.lastError : hint

  const health = Number(state.health)
  const food = Number(state.food)
  $('#health-bar').style.width = Number.isFinite(health) ? clamp(health / 20 * 100, 0, 100) + '%' : '0'
  $('#food-bar').style.width = Number.isFinite(food) ? clamp(food / 20 * 100, 0, 100) + '%' : '0'
  $('#health-text').textContent = Number.isFinite(health) ? `${fixed(health, 0)}/20` : '--'
  $('#food-text').textContent = Number.isFinite(food) ? `${fixed(food, 0)}/20` : '--'

  const stats = state.worldStats || {}
  const rows = [
    ['账号', state.username],
    ['服务器', `${state.host}:${state.port}`],
    ['坐标', state.position ? `${fixed(state.position.x)} ${fixed(state.position.y)} ${fixed(state.position.z)}` : '--'],
    ['朝向', `${fixed(state.look?.yaw, 0)}° ${compass(state.look?.yaw)}`],
    ['P0', state.p0 ? `${fixed(state.p0.x, 0)} ${fixed(state.p0.y, 0)} ${fixed(state.p0.z, 0)}` : '--'],
    ['运行', formatDuration(state.uptime)],
    ['重连', state.nextReconnectAt ? countdown(state.nextReconnectAt) : `${state.reconnects || 0} 次`],
    ['封包', String(state.packets || 0)],
    ['区块缓存', `${stats.chunks || 0} 列 · ${Math.round((stats.bytes || 0) / 1024)} KiB`]
  ]
  $('#info').innerHTML = rows.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('')

  renderInventory(state)
  const online = state.phase === 'play'
  for (const id of ['#return-p0', '#empty-silencer']) $(id).disabled = !online || Boolean(state.action)

  $('#world-name').textContent = state.world || state.dimension || '--'
  $('#world-clock').textContent = state.timeOfDay == null ? '' : `Day ${state.dayCount ?? 0} · ${gameClock(state.timeOfDay)}`
  $('#world-chunks').textContent = stats.chunks
    ? `${stats.chunks} chunks · ${stats.sections || 0} sections`
    : stats.lastError ? '区块解码失败' : '等待区块'

  if (!controlling && state.look) look = { ...state.look }
  if (state.position) {
    if (!view.ceilingPinned) setCeiling(Math.floor(state.position.y) + 2, false)
    scheduleWorld()
  }
  draw()
}

function renderInventory (state) {
  const inventory = state.inventory || []
  const hotbar = new Map(inventory.filter(item => item.hotbar != null).map(item => [item.hotbar, item]))
  $('#hotbar').innerHTML = Array.from({ length: 9 }, (_, slot) => {
    const item = hotbar.get(slot)
    const held = slot === state.heldSlot ? 'held' : ''
    const label = item ? esc(item.count) : '·'
    const title = item ? `${itemName(item.name)} ×${item.count}` : '空槽位'
    return `<button type="button" class="${held}" data-slot="${slot}" title="${esc(title)}" aria-label="${esc(title)}">${label}</button>`
  }).join('')
  const heldItem = hotbar.get(state.heldSlot)
  $('#held-item').textContent = heldItem ? `${itemName(heldItem.name)} ×${heldItem.count}` : '手中为空'
  const backpack = inventory.filter(item => item.hotbar == null && item.slot >= 9)
  const grouped = new Map()
  for (const item of backpack) grouped.set(item.name, (grouped.get(item.name) || 0) + item.count)
  $('#inventory').innerHTML = grouped.size
    ? [...grouped].map(([name, count]) => `<div title="${esc(itemName(name))}"><span>${esc(itemName(name))}</span><b>×${count}</b></div>`).join('')
    : '<div><span>背包为空</span></div>'
}

setInterval(() => { if (botState?.nextReconnectAt) renderState(botState) }, 1000)

/* ------------------------------------------------------------------- world */

function setCeiling (value, pin = true) {
  const level = Math.round(value)
  if (view.ceiling === level) return
  view.ceiling = level
  view.ceilingPinned = pin || view.ceilingPinned
  $('#ceiling').value = String(level)
  $('#ceiling-value').textContent = String(level)
  if (pin) fetchWorld()
}

function scheduleWorld () {
  const key = `${Math.floor(botState.position.x)},${Math.floor(botState.position.z)},${view.ceiling},${view.radius}`
  if (key === lastWorldKey || worldTimer) return
  worldTimer = setTimeout(() => { worldTimer = null; fetchWorld() }, 250)
}

async function fetchWorld () {
  if (document.hidden || !botState?.position) return
  if (worldInFlight) { worldPending = true; return }
  worldInFlight = true
  lastWorldKey = `${Math.floor(botState.position.x)},${Math.floor(botState.position.z)},${view.ceiling},${view.radius}`
  try {
    const params = new URLSearchParams({ radius: String(view.radius) })
    if (Number.isFinite(view.ceiling)) params.set('ceiling', String(view.ceiling))
    const data = await (await fetch(`/api/world?${params}`)).json()
    world = data.ok ? data : null
    if (data.ok) {
      const slider = $('#ceiling')
      slider.min = String(data.minY)
      slider.max = String(data.maxY)
      slider.value = String(data.ceiling)
      $('#ceiling-value').textContent = String(data.ceiling)
    }
    $('#world-state').textContent = data.ok
      ? `Y ≤ ${data.ceiling} · ${data.size}×${data.size} · ${data.palette.length} 种方块`
      : data.error || '世界数据不可用'
    draw()
  } catch (error) {
    world = null
    $('#world-state').textContent = `世界数据加载失败 · ${error.message}`
    draw()
  } finally {
    worldInFlight = false
    if (worldPending) { worldPending = false; setTimeout(fetchWorld, 300) }
  }
}

let drawQueued = false
function draw () {
  if (drawQueued) return
  drawQueued = true
  requestAnimationFrame(() => { drawQueued = false; paint() })
}

function paint () {
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const ratio = window.devicePixelRatio || 1
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  cells = []
  if (!world) return drawPlaceholder(width, height)

  const size = world.size
  const center = (size - 1) / 2
  const tile = TILE * view.zoom
  const originX = width / 2 + view.pan.x
  const originY = height / 2 + view.pan.y
  const base = world.heights[center * size + center] ?? world.ceiling
  const project = (a, b, h) => ({
    x: originX + (a - b) * tile,
    // Extreme columns are flattened so a cliff cannot fling tiles off screen.
    y: originY + (a + b) * tile * 0.5 - clamp(h - base, -28, 28) * tile * HEIGHT_UNIT
  })
  const at = (a, b) => {
    if (a < 0 || b < 0 || a >= size || b >= size) return null
    const [ix, iz] = rotatedIndex(a, b, size, view.rotation)
    const cell = iz * size + ix
    return { block: world.blocks[cell], height: world.heights[cell], ix, iz }
  }

  // Painter's algorithm: one screen row (a + b) at a time, farthest row first.
  for (let depth = 0; depth <= 2 * (size - 1); depth++) {
    for (let a = Math.max(0, depth - size + 1); a <= Math.min(size - 1, depth); a++) {
      const node = at(a, depth - a)
      if (!node || node.block < 0 || node.height == null) continue
      const name = world.palette[node.block]
      const point = project(a - center, depth - a - center, node.height)
      const shade = clamp(0.82 + (node.height - base) * 0.022, 0.55, 1.2)
      const color = colorFor(name)
      const rightDrop = clamp(node.height - (at(a + 1, depth - a)?.height ?? node.height - 1), 0, 6)
      const leftDrop = clamp(node.height - (at(a, depth - a + 1)?.height ?? node.height - 1), 0, 6)
      drawColumn(point, tile, color, shade, leftDrop, rightDrop)
      cells.push({ x: point.x, y: point.y, tile, name, height: node.height, world: cellToWorld(node.ix, node.iz) })
    }
  }

  if (cells.length === 0) {
    const error = botState?.worldStats?.lastError
    return drawPlaceholder(width, height, error ? `区块解码失败 · ${error}` : '当前范围没有可显示的方块')
  }

  drawMarkers(project, center, tile)
  if (target) outline(target, '#b91c1c', 2)
  if (hover && (!target || hover.x !== target.x || hover.z !== target.z)) outline(hover, 'rgba(28,25,23,.4)', 1)
}

function drawColumn (point, tile, color, shade, leftDrop, rightDrop) {
  const half = tile * 0.5
  const drop = tile * HEIGHT_UNIT
  const face = (side, depth, factor) => {
    if (depth <= 0) return
    ctx.fillStyle = rgb(color, shade * factor)
    ctx.beginPath()
    ctx.moveTo(point.x + side * tile, point.y + half)
    ctx.lineTo(point.x, point.y + tile)
    ctx.lineTo(point.x, point.y + tile + depth * drop)
    ctx.lineTo(point.x + side * tile, point.y + half + depth * drop)
    ctx.closePath()
    ctx.fill()
  }
  face(-1, leftDrop, 0.72)
  face(1, rightDrop, 0.56)
  ctx.fillStyle = rgb(color, shade)
  ctx.beginPath()
  ctx.moveTo(point.x, point.y)
  ctx.lineTo(point.x + tile, point.y + half)
  ctx.lineTo(point.x, point.y + tile)
  ctx.lineTo(point.x - tile, point.y + half)
  ctx.closePath()
  ctx.fill()
  if (tile > 7) { ctx.strokeStyle = 'rgba(28,25,23,.07)'; ctx.stroke() }
}

function drawMarkers (project, center, tile) {
  const marker = (x, z, y, paint) => {
    const [a, b] = toRotated(x - 0.5 - (world.origin.x + center), z - 0.5 - (world.origin.z + center), view.rotation)
    paint(project(a, b, y))
  }
  if (botState?.p0) {
    marker(botState.p0.x, botState.p0.z, botState.p0.y, point => {
      ctx.strokeStyle = 'rgba(180,83,9,.9)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(point.x, point.y - 5); ctx.lineTo(point.x + 7, point.y); ctx.lineTo(point.x, point.y + 5); ctx.lineTo(point.x - 7, point.y)
      ctx.closePath(); ctx.stroke()
      ctx.lineWidth = 1
    })
  }
  if (!world.bot) return
  marker(world.bot.x, world.bot.z, botState?.position?.y ?? world.bot.y, point => {
    ctx.fillStyle = 'rgba(28,25,23,.10)'
    ctx.beginPath(); ctx.arc(point.x, point.y, tile * 0.95, 0, Math.PI * 2); ctx.fill()
    const radians = (look.yaw || 0) * Math.PI / 180
    const [fa, fb] = toRotated(-Math.sin(radians), Math.cos(radians), view.rotation)
    const dx = (fa - fb) * tile
    const dy = (fa + fb) * tile * 0.5
    const length = Math.hypot(dx, dy) || 1
    ctx.strokeStyle = '#1c1917'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(point.x, point.y)
    ctx.lineTo(point.x + dx / length * tile * 1.5, point.y + dy / length * tile * 1.5)
    ctx.stroke()
    ctx.lineWidth = 1
    ctx.fillStyle = '#1c1917'
    ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(3, tile * 0.24), 0, Math.PI * 2); ctx.fill()
  })
}

function outline (block, color, width) {
  const cell = cells.find(item => item.world.x === block.x && item.world.z === block.z)
  if (!cell) return
  const half = cell.tile * 0.5
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(cell.x, cell.y)
  ctx.lineTo(cell.x + cell.tile, cell.y + half)
  ctx.lineTo(cell.x, cell.y + cell.tile)
  ctx.lineTo(cell.x - cell.tile, cell.y + half)
  ctx.closePath()
  ctx.stroke()
  ctx.lineWidth = 1
}

function drawPlaceholder (width, height, message) {
  ctx.fillStyle = '#a8a29e'
  ctx.font = '12px ui-monospace, monospace'
  ctx.textAlign = 'center'
  ctx.fillText(message || (botState?.phase === 'play' ? '正在接收区块数据…' : 'Bot 离线，暂无世界数据'), width / 2, height / 2)
  ctx.textAlign = 'start'
}

const cellToWorld = (ix, iz) => ({ x: world.origin.x + ix, z: world.origin.z + iz })

// Hit test in reverse paint order so the column drawn on top wins.
function pick (event) {
  const rect = canvas.getBoundingClientRect()
  const px = event.clientX - rect.left
  const py = event.clientY - rect.top
  for (let index = cells.length - 1; index >= 0; index--) {
    const cell = cells[index]
    const dx = Math.abs(px - cell.x)
    const dy = Math.abs(py - (cell.y + cell.tile * 0.5))
    if (dx / cell.tile + dy / (cell.tile * 0.5) <= 1) {
      return { x: cell.world.x, y: cell.height, z: cell.world.z, name: cell.name }
    }
  }
  return null
}

/* ------------------------------------------------------- pointer & actions */

let drag = null

canvas.addEventListener('contextmenu', event => event.preventDefault())
canvas.addEventListener('pointerdown', event => {
  canvas.focus()
  setControlling(true)
  if (event.button === 2) {
    const block = pick(event)
    if (block) { select(block); interact('right', event.shiftKey) }
    return
  }
  drag = { x: event.clientX, y: event.clientY, moved: false, pan: { ...view.pan } }
  canvas.setPointerCapture(event.pointerId)
})
canvas.addEventListener('pointermove', event => {
  if (drag) {
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (drag.moved || Math.hypot(dx, dy) > 4) {
      drag.moved = true
      viewport.classList.add('grabbing')
      view.pan = { x: drag.pan.x + dx, y: drag.pan.y + dy }
      draw()
    }
    return
  }
  const block = pick(event)
  const changed = block?.x !== hover?.x || block?.z !== hover?.z
  hover = block
  const tooltip = $('#tooltip')
  if (block) {
    const rect = viewport.getBoundingClientRect()
    tooltip.hidden = false
    tooltip.textContent = `${block.name} · ${block.x} ${block.y} ${block.z}`
    tooltip.style.left = `${event.clientX - rect.left}px`
    tooltip.style.top = `${event.clientY - rect.top}px`
  } else tooltip.hidden = true
  if (changed) draw()
})
canvas.addEventListener('pointerup', event => {
  const dragged = drag?.moved
  drag = null
  viewport.classList.remove('grabbing')
  if (event.button !== 0 || dragged) return
  const block = pick(event)
  if (block) select(block)
})
canvas.addEventListener('pointerleave', () => { hover = null; $('#tooltip').hidden = true; draw() })
canvas.addEventListener('dblclick', event => {
  const block = pick(event)
  if (!block) return
  select(block)
  interact('left', event.shiftKey)
})
canvas.addEventListener('wheel', event => {
  event.preventDefault()
  view.zoom = clamp(view.zoom * (event.deltaY < 0 ? 1.1 : 0.9), 0.35, 3)
  draw()
}, { passive: false })

function select (block) {
  target = block
  const distance = botState?.position
    ? `${Math.hypot(botState.position.x - (block.x + 0.5), botState.position.z - (block.z + 0.5)).toFixed(1)} 格`
    : '--'
  $('#selection').textContent = `${block.name} @ ${block.x} ${block.y} ${block.z} · 距离 ${distance}`
  draw()
}

async function interact (button, shiftKey) {
  if (!target) return
  const result = await post('/api/world-input', { button, shiftKey, target: { x: target.x, y: target.y, z: target.z } })
  $('#selection').textContent = result.ok
    ? `${button === 'left' ? '挖掘' : '使用'} ${target.name} @ ${target.x} ${target.y} ${target.z}`
    : `✕ ${result.error}`
}

async function post (path, body) {
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return await response.json()
  } catch (error) { return { ok: false, error: error.message } }
}

$('#hotbar').addEventListener('click', event => {
  const slot = event.target.closest('button')?.dataset.slot
  if (slot != null) post('/api/held', { slot: Number(slot) })
})
$('#return-p0').onclick = () => runAction('return-p0')
$('#empty-silencer').onclick = () => runAction('empty-silencer')
async function runAction (name) {
  const note = $('#action-note')
  note.textContent = '执行中…'
  note.classList.remove('error')
  const result = await post('/api/action', { action: name })
  note.textContent = result.ok ? `${name} 完成` : result.error
  note.classList.toggle('error', !result.ok)
}

$('#ceiling').oninput = event => setCeiling(Number(event.target.value))
$('#radius').onchange = event => { view.radius = Number(event.target.value); fetchWorld() }
$('#rotate').onclick = () => { view.rotation = (view.rotation + 1) % 4; draw() }
$('#recenter').onclick = () => {
  view.pan = { x: 0, y: 0 }
  view.zoom = 1
  view.ceilingPinned = false
  if (botState?.position) setCeiling(Math.floor(botState.position.y) + 2)
  fetchWorld()
}

/* ---------------------------------------------------------------- keyboard */

function setControlling (active) {
  if (controlling === active) return
  controlling = active
  viewport.classList.toggle('controlling', active)
  const badge = $('#control-badge')
  badge.classList.toggle('on', active)
  badge.textContent = active ? '控制已接管 · WASD 移动 · Esc 释放' : '点击画布接管控制'
  if (!active) {
    keys.clear()
    stopHoldLoop()
    renderKeycaps()
    syncControl()
  }
}

canvas.addEventListener('focus', () => setControlling(true))
canvas.addEventListener('blur', () => setControlling(false))
document.addEventListener('pointerdown', event => { if (!canvas.contains(event.target)) setControlling(false) })
window.addEventListener('blur', () => setControlling(false))
window.addEventListener('pagehide', () => setControlling(false))
document.addEventListener('visibilitychange', () => { if (document.hidden) setControlling(false); else fetchWorld() })

window.addEventListener('keydown', event => {
  const intent = keyIntent(event, { controlling, controlKeys: CONTROL_KEYS })
  if (intent === 'type') return
  if (intent === 'blur') { event.target.blur(); setControlling(false); return }
  if (intent === 'release') { setControlling(false); return }
  if (intent === 'rotate') {
    if (!event.repeat) { view.rotation = (view.rotation + 1) % 4; draw() }
    return
  }
  if (intent !== 'control') return
  event.preventDefault()
  if (event.repeat) return
  keys.add(event.code)
  renderKeycaps()
  syncControl()
  startHoldLoop()
})

window.addEventListener('keyup', event => {
  if (!keys.delete(event.code)) return
  renderKeycaps()
  syncControl()
  if (!keys.size) stopHoldLoop()
})

// The server expires held input after a few seconds, so a held key has to be refreshed;
// that is what stops the bot when this tab crashes or the network drops.
let holdTicks = 0
function startHoldLoop () {
  if (turnTimer) return
  holdTicks = 0
  turnTimer = setInterval(() => {
    holdTicks++
    const delta = (keys.has('KeyE') ? TURN_STEP : 0) - (keys.has('KeyQ') ? TURN_STEP : 0)
    if (delta) {
      look = { ...look, yaw: ((look.yaw + delta + 540) % 360) - 180 }
      syncControl()
      draw()
    } else if (holdTicks % 10 === 0) syncControl()
  }, 100)
}
function stopHoldLoop () {
  clearInterval(turnTimer)
  turnTimer = null
}

function renderKeycaps () {
  for (const cap of document.querySelectorAll('#keycaps span')) cap.classList.toggle('down', keys.has(cap.dataset.key))
}

function syncControl () {
  if (botState?.phase !== 'play') return
  post('/api/control', {
    forward: keys.has('KeyW'),
    back: keys.has('KeyS'),
    left: keys.has('KeyA'),
    right: keys.has('KeyD'),
    jump: keys.has('Space'),
    sneak: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    sprint: keys.has('ControlLeft') || keys.has('ControlRight'),
    look
  })
}

/* -------------------------------------------------------------------- chat */

const chatBox = $('#chat')
const nearBottom = () => chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 60

function renderChat ({ keepScroll = false } = {}) {
  const previousHeight = chatBox.scrollHeight
  const previousTop = chatBox.scrollTop
  const stick = !keepScroll && nearBottom()
  chatBox.innerHTML = messages.map(message => {
    const time = new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const sender = message.kind === 'player' ? `<b>${esc(message.sender)}</b> ` : message.sender === 'bot' ? '<b>bot</b> ' : ''
    return `<p class="msg ${esc(message.kind)}"><time>${time}</time>${sender}${esc(message.text)}</p>`
  }).join('')
  if (keepScroll) chatBox.scrollTop = previousTop + (chatBox.scrollHeight - previousHeight)
  else if (stick) chatBox.scrollTop = chatBox.scrollHeight
  $('#load-older').hidden = !olderCursor
  $('#chat-total').textContent = chatTotal ? `${chatTotal} 条` : ''
  $('#jump-latest').hidden = nearBottom()
}

chatBox.addEventListener('scroll', () => { $('#jump-latest').hidden = nearBottom() })
$('#jump-latest').onclick = () => { chatBox.scrollTop = chatBox.scrollHeight; $('#jump-latest').hidden = true }

$('#load-older').onclick = async () => {
  if (!olderCursor) return
  const page = await (await fetch(`/api/chat?before=${olderCursor}&limit=50`)).json()
  messages = [...page.items, ...messages]
  olderCursor = page.nextBefore
  chatTotal = page.total
  renderChat({ keepScroll: true })
}

$('#chat-form').onsubmit = async event => {
  event.preventDefault()
  const input = $('#message')
  const message = input.value.trim()
  if (!message) return
  input.value = ''
  const result = await post('/api/chat', { message })
  if (!result.ok) {
    input.value = message
    $('#action-note').textContent = result.error
    $('#action-note').classList.add('error')
  }
}

/* -------------------------------------------------------------------- boot */

fetch('/api/state').then(response => response.json()).then(renderState)
fetch('/api/chat?limit=50').then(response => response.json()).then(page => {
  messages = page.items
  olderCursor = page.nextBefore
  chatTotal = page.total
  renderChat()
})

const events = new EventSource('/events')
events.addEventListener('state', event => renderState(JSON.parse(event.data)))
events.addEventListener('world', () => fetchWorld())
events.addEventListener('chat', event => {
  messages.push(JSON.parse(event.data))
  if (messages.length > 400) messages = messages.slice(-400)
  chatTotal++
  renderChat()
})

window.addEventListener('resize', draw)
draw()
