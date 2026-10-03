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
  LIVENESS_TIMEOUT_MS
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
function listen () { server.listen(webPort, config.webHost) }
server.on('listening', () => {
  const address = server.address()
  console.log(`[web] http://${address.address}:${address.port}`)
  if (!started) { started = true; bot.start() }
})
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && webPort < config.webPort + 100) { webPort++; setImmediate(listen); return }
  console.error(error)
  process.exitCode = 1
})
listen()

const shutdown = () => { clearInterval(tickTimer); bot.stop(); server.close(() => process.exit(0)) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
