'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { config } = require('./config')
const { LightBot } = require('./light-bot')
const { ChatStore } = require('./chat-store')

const publicDir = path.resolve(__dirname, '../public')
const BODY_LIMIT = 8 * 1024
const GZIP_THRESHOLD = 1400
const SSE_HEARTBEAT_MS = 25 * 1000
// Explicit allowlist: no path is ever built from the request, so traversal is impossible.
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/view-math.js', ['view-math.js', 'text/javascript; charset=utf-8']]
])

function json (req, res, status, value) {
  if (res.headersSent || res.writableEnded) return
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  if (payload.length >= GZIP_THRESHOLD && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const compressed = zlib.gzipSync(payload)
    res.writeHead(status, { ...headers, 'content-encoding': 'gzip', 'content-length': compressed.length })
    return res.end(compressed)
  }
  res.writeHead(status, { ...headers, 'content-length': payload.length })
  res.end(payload)
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let overflow = false
    // Drop the payload instead of destroying the socket so the caller still gets a
    // readable error response.
    req.on('data', chunk => {
      if (overflow) return
      body += chunk
      if (body.length > BODY_LIMIT) { overflow = true; body = '' }
    })
    req.on('end', () => {
      if (overflow) return reject(new Error(`请求体超过 ${BODY_LIMIT} 字节`))
      try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

async function handlePost (req, res, handler) {
  try {
    json(req, res, 200, await handler(await readBody(req)))
  } catch (error) {
    json(req, res, 400, { ok: false, error: error.message })
  }
}

function createApp (bot, chatStore) {
  const clients = new Set()
  const broadcast = (event, value) => {
    const data = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
    for (const res of clients) {
      try { res.write(data) } catch { clients.delete(res) }
    }
  }

  bot.on('state', state => broadcast('state', state))
  bot.on('chat', message => { chatStore.append(message); broadcast('chat', message) })
  bot.on('world', summary => broadcast('world', summary))

  const handler = (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/state': return json(req, res, 200, bot.snapshot())
      case 'GET /api/health': return json(req, res, 200, { ok: true, phase: bot.state.phase })
      case 'GET /api/world': return json(req, res, 200, bot.worldSlice({ radius: url.searchParams.get('radius'), ceiling: url.searchParams.get('ceiling') }))
      case 'GET /api/chat': return json(req, res, 200, chatStore.page({ before: url.searchParams.get('before'), limit: url.searchParams.get('limit') }))
      case 'POST /api/chat': return handlePost(req, res, body => { bot.sendChat(body.message); return { ok: true } })
      case 'POST /api/action': return handlePost(req, res, body => bot.runAction(body.action))
      case 'POST /api/control': return handlePost(req, res, body => bot.setInput(body))
      case 'POST /api/held': return handlePost(req, res, body => bot.setHeldSlot(body.slot))
      case 'POST /api/world-input': return handlePost(req, res, body => bot.handleWorldInput(body))
      case 'GET /events': {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(bot.snapshot())}\n\n`)
        clients.add(res)
        const drop = () => clients.delete(res)
        req.on('close', drop); res.on('error', drop)
        return
      }
    }
    const asset = req.method === 'GET' && STATIC_FILES.get(url.pathname)
    if (asset) {
      res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-cache' })
      return fs.createReadStream(path.join(publicDir, asset[0])).pipe(res)
    }
    json(req, res, 404, { error: 'not found' })
  }

  // Proxies and sleeping laptops drop silent event streams; a comment frame is enough.
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try { res.write(': ping\n\n') } catch { clients.delete(res) }
    }
  }, SSE_HEARTBEAT_MS)
  heartbeat.unref()

  const server = http.createServer(handler)
  server.on('close', () => { clearInterval(heartbeat); for (const res of clients) res.end() })
  return { server, clients, handler }
}

function main () {
  const bot = new LightBot()
  const chatStore = new ChatStore(path.resolve(__dirname, '../.minecraft-idle-bot.chat.jsonl'))
  const { server, clients } = createApp(bot, chatStore)

  let webPort = config.webPort
  let started = false
  const listen = () => server.listen(webPort, config.webHost)
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

  const shutdown = () => { bot.stop(); for (const res of clients) res.end(); server.close(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (require.main === module) main()

module.exports = { createApp, BODY_LIMIT, STATIC_FILES }
