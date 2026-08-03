// Single source of live state: SSE with a polling fallback, plus API wrappers.

const RATE_WINDOW_MS = 10 * 60 * 1000
const STALE_TICK_MS = 16 * 1000

const listeners = { state: new Set(), chat: new Set(), link: new Set() }

export const store = {
  state: null,
  skew: 0,
  linkOk: false,
  samples: [],
  lastTickAt: 0
}

export const on = (event, handler) => { listeners[event].add(handler); return () => listeners[event].delete(handler) }
const emit = (event, value) => { for (const handler of listeners[event]) handler(value) }

export const serverNow = () => Date.now() + store.skew

function absorb (state) {
  if (!state) return
  if (state.serverTime) {
    const skew = Date.parse(state.serverTime) - Date.now()
    if (Number.isFinite(skew)) store.skew = Math.abs(skew) < 2000 ? 0 : skew
  }
  store.state = state
  emit('state', state)
}

function sample (packets, at) {
  const previous = store.samples.at(-1)
  store.samples.push({ at, packets })
  const cutoff = at - RATE_WINDOW_MS
  while (store.samples.length > 2 && store.samples[0].at < cutoff) store.samples.shift()
  if (!previous) return
  const seconds = (at - previous.at) / 1000
  if (seconds > 0.5) store.samples.at(-1).rate = Math.max(0, (packets - previous.packets) / seconds)
}

export const rateSeries = () => store.samples.filter(item => item.rate != null).map(item => item.rate)
export const currentRate = () => store.samples.at(-1)?.rate ?? null

function setLink (ok, reason = '') {
  if (store.linkOk === ok) return
  store.linkOk = ok
  emit('link', { ok, reason })
}

/* Transport -------------------------------------------------------------- */

let events = null
let pollTimer = null
let watchdog = null
let retry = 0

async function poll () {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' })
    if (!response.ok) throw new Error(String(response.status))
    const state = await response.json()
    absorb(state)
    sample(state.packets, Date.now())
  } catch { /* keep polling */ }
}

function startPolling () {
  if (pollTimer) return
  poll()
  pollTimer = setInterval(poll, 5000)
}

function stopPolling () {
  clearInterval(pollTimer)
  pollTimer = null
}

export function connect () {
  events?.close()
  events = new EventSource('/events')

  events.addEventListener('open', () => { retry = 0; stopPolling(); setLink(true) })

  events.addEventListener('state', event => {
    setLink(true)
    absorb(JSON.parse(event.data))
  })

  events.addEventListener('tick', event => {
    const payload = JSON.parse(event.data)
    store.lastTickAt = Date.now()
    setLink(true)
    sample(payload.packets, Date.now())
    absorb(payload)
  })

  events.addEventListener('chat', event => emit('chat', JSON.parse(event.data)))

  events.addEventListener('error', () => {
    setLink(false, '实时连接中断，已切换为轮询')
    startPolling()
    if (events?.readyState === EventSource.CLOSED) {
      const delay = Math.min(30000, 1000 * 2 ** retry++)
      setTimeout(connect, delay)
    }
  })

  if (!watchdog) {
    watchdog = setInterval(() => {
      if (store.lastTickAt && Date.now() - store.lastTickAt > STALE_TICK_MS) {
        setLink(false, `超过 ${STALE_TICK_MS / 1000} 秒没有收到服务端心跳`)
        startPolling()
      }
    }, 5000)
  }
}

/* API -------------------------------------------------------------------- */

async function getJson (url) {
  const response = await fetch(url, { cache: 'no-store' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`)
  return data
}

export const fetchChat = params => getJson(`/api/chat?${new URLSearchParams(params)}`)
export const fetchSearch = params => getJson(`/api/chat/search?${new URLSearchParams(params)}`)
export const fetchStats = () => getJson('/api/stats')

export async function postJson (url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) throw new Error(data.error || `操作失败 (${response.status})`)
  if (data.state) absorb(data.state)
  return data
}
