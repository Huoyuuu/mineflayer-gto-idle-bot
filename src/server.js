'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { config } = require('./config')
const {
  LightBot,
  RECONNECT_DELAYS,
  MAX_CONSECUTIVE_RECONNECTS,
  COOLDOWN_MS,
  STABLE_RESET_MS,
  LIVENESS_TIMEOUT_MS,
  networkGate,
  GATE,
  PROBE_INTERVAL_MS
} = require('./light-bot')
const { ChatStore } = require('./chat-store')

const publicDir = path.resolve(__dirname, '../public')
const TICK_MS = 5000
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

const bot = new LightBot()
const chatStore = new ChatStore(config.chatFile)
const clients = new Set()

// Reuse the existing probe history; the bot and web UI now share the same samples.
const probeFile = path.resolve(__dirname, '../.minecraft-idle-bot.probes.jsonl')
const retentionMs = 14 * 24 * 3600 * 1000
try {
  bot.probes = fs.readFileSync(probeFile, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      const r = JSON.parse(line)
      return Number.isFinite(r.t) && r.t >= Date.now() - retentionMs && (r.ms === null || Number.isFinite(r.ms)) ? [r] : []
    } catch { return [] }
  })
  fs.writeFileSync(probeFile, bot.probes.map(r => JSON.stringify(r) + '\n').join(''))
} catch (error) { if (error.code !== 'ENOENT') console.error(`[probe] load failed: ${error.message}`) }
bot.state.network = networkGate(bot.probes)
let compactAt = Date.now() + 86400000
bot.on('probe', record => {
  while (bot.probes.length && bot.probes[0].t < Date.now() - retentionMs) bot.probes.shift()
  try {
    if (Date.now() >= compactAt) {
      fs.writeFileSync(probeFile, bot.probes.map(r => JSON.stringify(r) + '\n').join(''))
      compactAt = Date.now() + 86400000
    } else fs.appendFileSync(probeFile, JSON.stringify(record) + '\n')
  } catch (error) { console.error(`[probe] save failed: ${error.message}`) }
})
const point = r => [r.t, r.ms, r.src === 'manual' ? 1 : 0, r.phase === 'play' ? 1 : 0, ...(r.err ? [r.err] : [])]
function probeData (query) {
  const hours = Math.min(336, Math.max(1, Number(query.get('hours')) || 24))
  const since = Math.max(Date.now() - hours * 3600000, Number(query.get('since')) || 0)
  const buckets = Array.from({ length: 24 }, () => ({ n: 0, fail: 0, ms: [] }))
  if (!query.has('since')) for (const r of bot.probes) {
    const b = buckets[new Date(r.t).getUTCHours()]
    b.n++
    if (r.ms == null) b.fail++; else b.ms.push(r.ms)
  }
  return {
    now: Date.now(), intervalMs: PROBE_INTERVAL_MS, gate: GATE, quality: networkGate(bot.probes),
    firstAt: bot.probes[0]?.t ?? null, total: bot.probes.length,
    points: bot.probes.filter(r => r.t > since).map(point),
    hourOfDayUtc: query.has('since') ? undefined : buckets.map(b => {
      b.ms.sort((a, b) => a - b)
      return [b.n, b.fail, b.ms.length ? b.ms[b.ms.length >> 1] : null]
    })
  }
}

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

const broadcast = (event, value) => {
  const data = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
  for (const res of clients) {
    try { res.write(data) } catch { clients.delete(res) }
  }
}

bot.on('state', state => broadcast('state', state))
bot.on('chat', message => { chatStore.append(message); broadcast('chat', message) })

const tickTimer = setInterval(() => {
  if (clients.size) broadcast('tick', bot.snapshot())
}, TICK_MS)
tickTimer.unref()

function serveStatic (req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
  const target = path.resolve(publicDir, relative)
  if (target !== publicDir && !target.startsWith(publicDir + path.sep)) return json(res, 403, { error: 'forbidden' })
  fs.stat(target, (error, stats) => {
    if (error || !stats.isFile()) return json(res, 404, { error: 'not found' })
    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream'
    const etag = `W/"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end() }
    res.writeHead(200, { 'content-type': type, etag, 'cache-control': 'no-cache' })
    fs.createReadStream(target).pipe(res)
  })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const query = url.searchParams

  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, bot.snapshot())

  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, phase: bot.state.phase })

  if (req.method === 'GET' && url.pathname === '/api/probes') return json(res, 200, probeData(query))
  if (req.method === 'POST' && url.pathname === '/api/probes/run') {
    bot.probe('manual').then(record => json(res, 200, { ok: true, point: point(record), quality: bot.state.network }))
      .catch(error => json(res, 500, { ok: false, error: error.message }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/chat') {
    return json(res, 200, chatStore.page({
      before: query.get('before'),
      after: query.get('after'),
      around: query.get('around'),
      page: query.get('page'),
      limit: query.get('limit')
    }))
  }

  if (req.method === 'GET' && url.pathname === '/api/chat/search') {
    return json(res, 200, chatStore.search({
      query: query.get('q'),
      kind: query.get('kind'),
      sender: query.get('sender'),
      since: query.get('since'),
      until: query.get('until'),
      before: query.get('before'),
      limit: query.get('limit')
    }))
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    return json(res, 200, {
      chat: chatStore.stats(),
      state: bot.snapshot(),
      limits: {
        reconnectDelays: [0, ...RECONNECT_DELAYS],
        maxConsecutiveReconnects: MAX_CONSECUTIVE_RECONNECTS,
        cooldownMs: COOLDOWN_MS,
        stableResetMs: STABLE_RESET_MS,
        livenessTimeoutMs: LIVENESS_TIMEOUT_MS,
        networkGate: GATE,
        tickMs: TICK_MS
      }
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    bot.start()
    return json(res, 200, { ok: true, state: bot.snapshot() })
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    bot.stop()
    return json(res, 200, { ok: true, state: bot.snapshot() })
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(bot.snapshot())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let body = ''
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy() })
    req.on('end', () => {
      try { bot.sendChat(JSON.parse(body).message); json(res, 200, { ok: true }) } catch (error) { json(res, 400, { ok: false, error: error.message }) }
    })
    return
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname)
  json(res, 404, { error: 'not found' })
})

let webPort = config.webPort
let started = false
let probeTimer
function listen () { server.listen(webPort, config.webHost) }
server.on('listening', () => {
  const address = server.address()
  console.log(`[web] http://${address.address}:${address.port}`)
  if (!started) {
    started = true
    bot.start()
    const probe = () => bot.probe().catch(error => console.error(`[probe] ${error.message}`))
    probeTimer = setInterval(probe, PROBE_INTERVAL_MS)
    probe()
  }
})
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && webPort < config.webPort + 100) { webPort++; setImmediate(listen); return }
  console.error(error)
  process.exitCode = 1
})
listen()

const shutdown = () => { clearInterval(tickTimer); clearInterval(probeTimer); bot.stop(); for (const res of clients) res.end(); server.close(() => process.exit(0)) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
