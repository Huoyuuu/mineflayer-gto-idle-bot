'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { config } = require('./config')
const { LightBot } = require('./light-bot')

const publicDir = path.resolve(__dirname, '../public')
const bot = new LightBot()
const clients = new Set()
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
const broadcast = () => { const data = `event: state\ndata: ${JSON.stringify(bot.snapshot())}\n\n`; for (const res of clients) res.write(data) }
bot.on('state', broadcast)

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, bot.snapshot())
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, phase: bot.state.phase })
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write(`event: state\ndata: ${JSON.stringify(bot.snapshot())}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy() }); req.on('end', () => { try { bot.sendChat(JSON.parse(body).message); json(res, 200, { ok: true }) } catch (error) { json(res, 400, { ok: false, error: error.message }) } }); return
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(path.join(publicDir, 'index.html')).pipe(res) }
  json(res, 404, { error: 'not found' })
})

let webPort = config.webPort
let started = false
function listen () { server.listen(webPort, config.webHost) }
server.on('listening', () => { const address = server.address(); console.log(`[web] http://${address.address}:${address.port}`); if (!started) { started = true; bot.start() } })
server.on('error', error => { if (error.code === 'EADDRINUSE' && webPort < config.webPort + 100) { webPort++; setImmediate(listen); return } console.error(error); process.exitCode = 1 })
listen()
process.on('SIGINT', () => { bot.stop(); server.close(() => process.exit(0)) })
process.on('SIGTERM', () => { bot.stop(); server.close(() => process.exit(0)) })
