// Status view: hero band, reconnect countdown, backoff ladder and detail cards.

import {
  $, rows, num, bytes, duration, countdown, relative, stamp, setText, setHidden,
  sparkline
} from './lib.js'
import { store, on, serverNow, rateSeries, currentRate, fetchStats } from './store.js'

const PHASE_TEXT = {
  offline: '离线',
  connecting: '连接中',
  reconnecting: '等待重连',
  play: '在线',
  cooldown: '冷却中'
}

const LADDER_FALLBACK = [0, 2, 4, 8, 16, 32, 60].map(minutes => minutes * 60 * 1000)

let limits = { reconnectDelays: LADDER_FALLBACK, maxConsecutiveReconnects: 3, livenessTimeoutMs: 90000 }
let ticker = null
let mounted = false

/* Hero ------------------------------------------------------------------- */

function dotClass (state) {
  if (state.phase === 'play') return 'dot dot-online'
  if (state.phase === 'connecting' || state.phase === 'reconnecting') return 'dot dot-wait dot-pulse'
  if (state.phase === 'cooldown') return 'dot dot-error'
  return 'dot'
}

function netText (n) {
  if (!n) return '探测中'
  return `${n.samples} 次探测，失败 ${n.failures}，中位 ${n.medianMs ?? '--'}ms，p90 ${n.p90Ms ?? '--'}ms${n.good ? '，已达标' : ''}`
}

function heroNote (state, now) {
  if (state.phase === 'play') {
    const idle = state.lastPacketAt ? now - Date.parse(state.lastPacketAt) : 0
    if (idle > limits.livenessTimeoutMs * 0.6) return `已 ${Math.round(idle / 1000)} 秒没有收到数据包，看门狗监视中`
    return `${state.username} 在 ${state.world || '服务器'}`
  }
  if (state.phase === 'cooldown') return '连续掉线过多，服务已进入两小时保护冷却'
  if (state.phase === 'reconnecting') return `第 ${state.reconnectAttempt || 1} 次重连：等待网络达标（${netText(state.network)}）`
  if (state.phase === 'connecting') return '正在完成 Forge 登录握手'
  return state.lastError ? `已离线：${state.lastError}` : '尚未连接'
}

function renderHero (state, now) {
  const dot = dotClass(state)
  $('#hero-dot').className = `${dot} h-2.5 w-2.5`
  $('#head-status').firstElementChild.className = dot
  setText($('#hero-phase'), PHASE_TEXT[state.phase] || state.phase)
  setText($('#head-phase'), PHASE_TEXT[state.phase] || state.phase)
  setText($('#hero-note'), heroNote(state, now))

  const session = state.sessionStartedAt ? now - Date.parse(state.sessionStartedAt) : null
  setText($('#hero-session'), session == null ? '--' : duration(session))
  setText($('#hero-uptime'), state.startedAt ? duration(now - Date.parse(state.startedAt)) : duration(state.uptime * 1000))
  setText($('#hero-packets'), num(state.packets))

  const rate = currentRate()
  setText($('#hero-rate'), rate == null ? '--' : `${rate.toFixed(1)} /s`)

  const series = rateSeries()
  $('#rate-chart').innerHTML = sparkline(series)
  setText($('#rate-peak'), series.length ? `峰值 ${Math.max(...series).toFixed(1)} /s` : '采样中')
}

/* Alert band and ladder -------------------------------------------------- */

function renderLadder (state) {
  const delays = limits.reconnectDelays || LADDER_FALLBACK
  const attempt = state.reconnectAttempt || 0
  const steps = delays.map((delay, index) => {
    const position = index + 1
    const done = position < attempt
    const current = position === attempt
    const style = current
      ? 'border-amber-500 bg-amber-500 text-white'
      : done
        ? 'border-amber-300 bg-amber-100 text-amber-700'
        : 'border-stone-200 bg-white text-stone-400'
    return `<span class="num inline-flex h-6 items-center border ${style} px-2 text-[11px]">${delay ? `${delay / 60000}m` : '网络'}</span>`
  }).join('')

  const max = limits.maxConsecutiveReconnects ?? 3
  const dots = Array.from({ length: max + 1 }, (_, index) => {
    const filled = index < (state.consecutiveReconnects || 0)
    return `<span class="dot h-2 w-2 ${filled ? 'dot-error' : ''}"></span>`
  }).join('')

  $('#ladder').innerHTML = `${steps}
    <span class="ml-2 inline-flex items-center gap-1.5 border-l border-amber-200 pl-2.5">
      <span class="label text-amber-700">连续掉线</span>${dots}
      <span class="num text-[11px] text-amber-800">${state.consecutiveReconnects || 0}/${max + 1}</span>
    </span>`
}

function renderAlert (state, now) {
  const band = $('#alert-band')
  const waiting = state.phase === 'reconnecting' && state.nextReconnectAt
  const cooling = state.phase === 'cooldown' && state.cooldownUntil

  if (!waiting && !cooling) { band.classList.add('hidden'); return }
  band.classList.remove('hidden')

  const target = Date.parse(cooling ? state.cooldownUntil : state.nextReconnectAt)
  setText($('#alert-countdown'), countdown(target - now))

  if (cooling) {
    setText($('#alert-title'), '保护冷却中')
    setText($('#alert-detail'),
      `将在 ${stamp(state.cooldownUntil)} 结束后自动重新登录。冷却由持久化文件保存，重启服务不会跳过。`)
  } else {
    const total = state.reconnectDelayMs ? `${state.reconnectDelayMs / 60000} 分钟` : '0 分钟'
    const ladder = (limits.reconnectDelays || LADDER_FALLBACK).length
    setText($('#alert-title'), `等待第 ${state.reconnectAttempt || 1} / ${ladder} 次重连`)
    setText($('#alert-detail'),
      `先等待 ${total}，之后网络达标即重连，最迟 ${stamp(state.nextReconnectAt)} 兜底。网络：${netText(state.network)}。${state.lastError ? `上次失败：${state.lastError}` : ''}`)
  }
  renderLadder(state)
}

/* Cards ------------------------------------------------------------------ */

function meter (id, value, max, color) {
  const bar = $(id)
  if (!bar) return
  const ratio = value == null ? 0 : Math.max(0, Math.min(1, value / max))
  bar.style.width = `${(ratio * 100).toFixed(1)}%`
  bar.style.background = color
}

function renderCards (state, now) {
  rows($('#card-identity'), [
    ['用户名', `<span class="font-medium">${state.username}</span>`],
    ['服务器', `${state.host}:${state.port}`],
    ['协议版本', state.version],
    ['世界', state.world || '--'],
    ['游戏模式', state.gameMode == null ? '--' : String(state.gameMode)],
    ['实体 ID', state.entityId == null ? '--' : num(state.entityId)]
  ])

  const health = state.health
  meter('#hp-bar', health, 20, health == null ? '#e7e5e4' : health <= 6 ? '#dc2626' : health <= 14 ? '#d97706' : '#059669')
  meter('#food-bar', state.food, 20, state.food == null ? '#e7e5e4' : '#a16207')
  setText($('#hp-text'), health == null ? '--' : `${health} / 20`)
  setText($('#food-text'), state.food == null ? '--' : `${state.food} / 20`)
  rows($('#card-vitals'), [
    ['本次会话开始', state.sessionStartedAt ? stamp(state.sessionStartedAt) : '--'],
    ['自动复活', '生命值归零时发送一次 client_command']
  ])

  const position = state.position
  setText($('#pos-x'), position ? position.x.toFixed(1) : '--')
  setText($('#pos-y'), position ? position.y.toFixed(1) : '--')
  setText($('#pos-z'), position ? position.z.toFixed(1) : '--')
  rows($('#card-look'), [
    ['yaw', position ? position.yaw.toFixed(1) : '--'],
    ['pitch', position ? position.pitch.toFixed(1) : '--']
  ])

  rows($('#card-connection'), [
    ['连接状态', state.connected ? '<span class="text-emerald-700">已进入 play</span>' : '<span class="text-stone-500">未连接</span>'],
    ['累计重连', num(state.reconnects)],
    ['连续掉线', `${state.consecutiveReconnects || 0} / ${(limits.maxConsecutiveReconnects ?? 3) + 1}`],
    ['当前退避', state.reconnectDelayMs ? `${state.reconnectDelayMs / 60000} 分钟` : '--'],
    ['网络门控', state.phase === 'reconnecting' ? netText(state.network) : '--'],
    ['下次重连', state.nextReconnectAt ? `${stamp(state.nextReconnectAt)}<br><span class="text-stone-400">${countdown(Date.parse(state.nextReconnectAt) - now)} 后</span>` : '--'],
    ['冷却截止', state.cooldownUntil ? stamp(state.cooldownUntil) : '--']
  ])

  const rate = currentRate()
  rows($('#card-traffic'), [
    ['收包总数', num(state.packets)],
    ['实时速率', rate == null ? '--' : `${rate.toFixed(2)} 包/秒`],
    ['丢弃区块包', num(state.chunksIgnored)],
    ['最后收包', state.lastPacketAt ? `${relative(state.lastPacketAt, now)}<br><span class="text-stone-400">${stamp(state.lastPacketAt)}</span>` : '--']
  ])

  rows($('#card-diagnostics'), [
    ['进程启动', state.startedAt ? stamp(state.startedAt) : '--'],
    ['看门狗阈值', `${(limits.livenessTimeoutMs ?? 90000) / 1000} 秒无包即断开`],
    ['心跳间隔', `${(limits.tickMs ?? 5000) / 1000} 秒`],
    ['聊天存储', store.chatBytes == null ? '--' : bytes(store.chatBytes)]
  ])

  const hasError = !!state.lastError
  setHidden($('#last-error-box'), !hasError)
  $('#last-error-box').classList.toggle('hidden', !hasError)
  if (hasError) setText($('#last-error'), state.lastError)
}

/* Lifecycle -------------------------------------------------------------- */

function paint () {
  const state = store.state
  if (!state || !mounted) return
  const now = serverNow()
  renderHero(state, now)
  renderAlert(state, now)
  renderCards(state, now)
}

on('state', () => paint())

export const statusView = {
  async mount () {
    mounted = true
    paint()
    ticker = setInterval(paint, 1000)
    try {
      const data = await fetchStats()
      limits = { ...limits, ...data.limits }
      store.chatBytes = data.chat?.bytes
      paint()
    } catch { /* limits keep their defaults */ }
  },
  unmount () {
    mounted = false
    clearInterval(ticker)
    ticker = null
  }
}
