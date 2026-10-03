'use strict'

// Standalone network probe: Server List Ping every 30 s, persisted to JSONL.
// Runs as its own systemd service so it can be changed and restarted without
// touching the bot process (and therefore without a Minecraft reconnect).

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const mc = require('minecraft-protocol')
const { config, rootDir } = require('../src/config')

const PORT = Number(process.env.PROBE_PORT || 18014)
const FILE = process.env.PROBE_FILE || path.join(rootDir, '.minecraft-idle-bot.probes.jsonl')
const INTERVAL_MS = 30 * 1000
const TIMEOUT_MS = 5 * 1000
const RETAIN_MS = 14 * 24 * 3600 * 1000
// Mirrors NETWORK_* in src/light-bot.js (the bot's own reconnect gate).
const GATE = { window: 20, maxFailures: 1, medianMs: 400, p90Ms: 800 }

// Record: { t: epoch ms, ms: latency | null, src: 'auto' | 'manual', phase: bot phase, err? }
let records = []
try {
  const cutoff = Date.now() - RETAIN_MS
  const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
  records = lines.map(line => { try { return JSON.parse(line) } catch { return null } }).filter(r => r && r.t >= cutoff)
  if (records.length < lines.length) fs.writeFileSync(FILE, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''))
} catch (error) { if (error.code !== 'ENOENT') console.error(`[probe] cannot load history: ${error.message}`) }

function prune () {
  const cutoff = Date.now() - RETAIN_MS
  let drop = 0
  while (drop < records.length && records[drop].t < cutoff) drop++
  if (!drop) return
  records = records.slice(drop)
  fs.writeFileSync(FILE, records.map(r => JSON.stringify(r)).join('\n') + '\n')
}

async function botPhase () {
  try {
    const response = await fetch(`http://127.0.0.1:${config.webPort}/api/health`, { signal: AbortSignal.timeout(2000) })
    return (await response.json()).phase || 'unknown'
  } catch { return 'unknown' }
}

let inflight = null
function probe (src) {
  if (inflight) return inflight
  inflight = (async () => {
    const t = Date.now()
    const record = { t, ms: null, src, phase: await botPhase() }
    try {
      const result = await mc.ping({ host: config.mcHost, port: config.mcPort, version: config.mcVersion, closeTimeout: TIMEOUT_MS, noPongTimeout: TIMEOUT_MS })
      if (Number.isFinite(result?.latency)) record.ms = result.latency
      else record.err = 'no pong'
    } catch (error) { record.err = String(error?.message || error).slice(0, 80) }
    records.push(record)
    fs.appendFile(FILE, JSON.stringify(record) + '\n', error => { if (error) console.error(`[probe] append failed: ${error.message}`) })
    return record
  })().finally(() => { inflight = null })
  return inflight
}

function quality (window) {
  const ok = window.filter(r => r.ms != null).map(r => r.ms).sort((a, b) => a - b)
  const pick = q => ok.length ? ok[Math.min(ok.length - 1, Math.floor(q * ok.length))] : null
  const failures = window.length - ok.length
  const medianMs = pick(0.5)
  const p90Ms = pick(0.9)
  const good = window.length >= GATE.window && failures <= GATE.maxFailures && medianMs <= GATE.medianMs && p90Ms <= GATE.p90Ms
  return { good, samples: window.length, failures, medianMs, p90Ms }
}

// Whole-history profile by UTC hour of day: [count, failures, medianMs].
function hourOfDay () {
  const buckets = Array.from({ length: 24 }, () => ({ n: 0, fail: 0, ms: [] }))
  for (const r of records) {
    const bucket = buckets[new Date(r.t).getUTCHours()]
    bucket.n++
    if (r.ms == null) bucket.fail++
    else bucket.ms.push(r.ms)
  }
  return buckets.map(b => { b.ms.sort((x, y) => x - y); return [b.n, b.fail, b.ms.length ? b.ms[b.ms.length >> 1] : null] })
}

const send = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

// Compact point: [t, ms | null, manual ? 1 : 0, botOnline ? 1 : 0, err?]
const point = r => r.err ? [r.t, r.ms, r.src === 'manual' ? 1 : 0, r.phase === 'play' ? 1 : 0, r.err] : [r.t, r.ms, r.src === 'manual' ? 1 : 0, r.phase === 'play' ? 1 : 0]

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/api/probes') {
    const hours = Math.min(14 * 24, Math.max(1, Number(url.searchParams.get('hours')) || 24))
    const since = Math.max(Date.now() - hours * 3600 * 1000, Number(url.searchParams.get('since')) || 0)
    return send(res, 200, {
      now: Date.now(), intervalMs: INTERVAL_MS, timeoutMs: TIMEOUT_MS, gate: GATE,
      quality: quality(records.slice(-GATE.window)),
      firstAt: records[0]?.t ?? null, total: records.length,
      points: records.filter(r => r.t > since).map(point),
      hourOfDayUtc: url.searchParams.has('since') ? undefined : hourOfDay()
    })
  }
  if (req.method === 'POST' && url.pathname === '/api/probes/run') {
    const record = await probe('manual')
    return send(res, 200, { ok: true, point: point(record), quality: quality(records.slice(-GATE.window)) })
  }
  send(res, 404, { error: 'not found' })
}).listen(PORT, '127.0.0.1', () => console.log(`[probe] http://127.0.0.1:${PORT} → ${config.mcHost}:${config.mcPort}, ${records.length} records loaded`))

probe('auto')
setInterval(() => { probe('auto'); prune() }, INTERVAL_MS)
