// Network view: continuous Server List Ping history from the standalone probe service.

import { $, $$, esc, num, setText, rows, stamp, relative, countdown, barChart, hourLabel, dayKey, clock } from './lib.js'
import { postJson } from './store.js'
import { toast } from './toast.js'

const HOUR_MS = 3600000
const COLORS = { good: '#059669', warn: '#d97706', bad: '#dc2626', ink: '#1c1917', ghost: '#d6d3d1' }

let hours = 24
let data = null // { gate, intervalMs, quality, points: [[t, ms, manual, online, err?]], hourOfDayUtc, ... }
let refresher = null
let ticker = null
let warned = false

/* Statistics ------------------------------------------------------------- */

function stats (points) {
  const ok = points.filter(p => p[1] != null).map(p => p[1]).sort((a, b) => a - b)
  const pick = q => ok.length ? ok[Math.min(ok.length - 1, Math.floor(q * ok.length))] : null
  return { n: points.length, fail: points.length - ok.length, p10: pick(0.1), p50: pick(0.5), p90: pick(0.9), p99: pick(0.99), max: ok.at(-1) ?? null }
}

// Replays the bot's gate rule over a sliding window ending at each point.
function gateOpen (points, index, gate) {
  const since = points[index][0] - gate.windowMs
  let samples = 0, failures = 0, oldest = points[index][0]
  for (let i = index; i >= 0 && points[i][0] > since; i--) {
    samples++
    oldest = points[i][0]
    if (points[i][1] == null) failures++
  }
  if (oldest > since + data.intervalMs) return null
  return samples >= gate.minSamples && failures / samples < gate.maxFailRate
}

const pct = (part, whole) => whole ? `${(part / whole * 100).toFixed(1)}%` : '--'
const msText = value => value == null ? '--' : `${value} ms`
const tone = value => value == null ? 'text-red-700' : 'text-emerald-700'

/* Timeline chart --------------------------------------------------------- */

function timeline (points, gate, from, to) {
  if (!points.length) return '<p class="py-8 text-center text-[12px] text-stone-400">暂无数据</p>'
  const W = 720, H = 220, top = 8, axis = 18, strip = 6
  const plot = H - axis - strip - 4
  const cols = Math.min(240, Math.max(24, Math.round((to - from) / (2 * 60000))))
  const span = (to - from) / cols
  const cells = Array.from({ length: cols }, () => ({ ms: [], fail: 0, n: 0, online: 0, gate: [] }))
  points.forEach((p, index) => {
    const c = cells[Math.min(cols - 1, Math.max(0, Math.floor((p[0] - from) / span)))]
    c.n++
    if (p[1] == null) c.fail++; else c.ms.push(p[1])
    if (p[3]) c.online++
    c.gate.push(gateOpen(points, index, gate))
  })
  const ceiling = points.reduce((m, p) => p[1] != null && p[1] < 2500 && p[1] > m ? p[1] : m, 1000)
  const y = value => top + plot - Math.min(1, value / ceiling) * plot
  const x = index => index * (W / cols)
  const w = W / cols

  let offline = '', band = '', fails = '', gateStrip = ''
  const line = []
  cells.forEach((c, i) => {
    if (!c.n) { line.push(null); return }
    if (c.online / c.n < 0.5) offline += `<rect x="${x(i).toFixed(1)}" y="${top}" width="${(w + 0.4).toFixed(1)}" height="${plot}" fill="#fef3c7" opacity="0.7"/>`
    const s = c.ms.sort((a, b) => a - b)
    if (s.length) {
      const lo = s[Math.floor(s.length * 0.1)], hi = s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]
      band += `<rect x="${x(i).toFixed(1)}" y="${y(hi).toFixed(1)}" width="${(w + 0.4).toFixed(1)}" height="${Math.max(1, y(lo) - y(hi)).toFixed(1)}" fill="${COLORS.ink}" opacity="0.10"/>`
      line.push([x(i) + w / 2, y(s[s.length >> 1])])
    } else line.push(null)
    if (c.fail) {
      const tall = 6 + 14 * (c.fail / c.n)
      fails += `<rect x="${(x(i) + w * 0.15).toFixed(1)}" y="${top}" width="${Math.max(1.5, w * 0.7).toFixed(1)}" height="${tall.toFixed(1)}" fill="${COLORS.bad}"><title>${c.fail}/${c.n} 次失败</title></rect>`
    }
    const known = c.gate.filter(g => g != null)
    if (known.length) {
      const open = known.filter(Boolean).length / known.length
      gateStrip += `<rect x="${x(i).toFixed(1)}" y="${top + plot + 3}" width="${(w + 0.4).toFixed(1)}" height="${strip}" fill="${open >= 0.5 ? COLORS.good : COLORS.bad}" opacity="${(0.25 + 0.65 * Math.abs(open - 0.5) * 2).toFixed(2)}"/>`
    }
  })
  const path = line.reduce((d, pt, i) => pt ? `${d}${line[i - 1] ? 'L' : 'M'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)} ` : d, '')
  const ticks = Array.from({ length: 7 }, (_, k) => {
    const t = from + (to - from) * k / 6
    const d = new Date(t)
    const label = to - from > 36 * HOUR_MS ? `${d.getMonth() + 1}/${d.getDate()} ${hourLabel(d)}` : clock(d).slice(0, 5)
    return `<text x="${(W * k / 6).toFixed(1)}" y="${H - 4}" text-anchor="${k === 0 ? 'start' : k === 6 ? 'end' : 'middle'}" font-size="9" fill="#a8a29e" font-family="ui-monospace,monospace">${label}</text>`
  }).join('')
  const yTicks = [0, 0.5, 1].map(f => `<text x="2" y="${(y(ceiling * f) + (f ? 10 : -2)).toFixed(1)}" font-size="9" fill="#a8a29e" font-family="ui-monospace,monospace">${Math.round(ceiling * f)}ms</text>`).join('')
  return `<svg class="net-timeline" viewBox="0 0 ${W} ${H}" role="img" aria-label="延迟时间线" style="height:${H}px">
    ${offline}${band}
    <path d="${path}" fill="none" stroke="${COLORS.ink}" stroke-width="1.3" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    ${fails}${gateStrip}${yTicks}
    <line x1="0" x2="${W}" y1="${top + plot}" y2="${top + plot}" stroke="#e7e5e4"/>${ticks}
  </svg>`
}

/* Rendering -------------------------------------------------------------- */

function render () {
  if (!data) return
  const { gate, quality } = data
  const now = Date.now()
  const from = now - hours * HOUR_MS
  const points = data.points.filter(p => p[0] >= from)
  const all = stats(points)
  const last = points.at(-1)

  setText($('#n-last'), last ? (last[1] == null ? '失败' : `${last[1]}`) : '--')
  $('#n-last').className = `display mt-2 text-[38px] ${last ? tone(last[1]) : ''}`
  setText($('#n-last-at'), last ? `${relative(new Date(last[0]).toISOString())}${last[2] ? ' · 手动' : ''}${last[4] ? ` · ${last[4]}` : ''}` : '')
  setText($('#n-gate'), quality.ok ? '达标' : '未达标')
  $('#n-gate').className = `display mt-2 text-[38px] ${quality.ok ? 'text-emerald-700' : 'text-red-700'}`
  setText($('#n-gate-note'), `最近 20 分钟 ${quality.samples} 次 · 失败 ${quality.failures}（${pct(quality.failures, quality.samples)}） · ${quality.covered ? '要求 < 5%' : '历史不足'}`)
  setText($('#n-loss'), pct(all.fail, all.n))
  setText($('#n-loss-note'), `${num(all.fail)} / ${num(all.n)} 次失败`)
  setText($('#n-p50'), all.p50 == null ? '--' : `${all.p50}`)
  setText($('#n-p50-note'), `p10 ${msText(all.p10)} · p90 ${msText(all.p90)} · p99 ${msText(all.p99)}`)

  $('#chart-net-timeline').innerHTML = timeline(points, gate, from, now)

  // Hourly loss over the selected range.
  const startHour = Math.floor(from / HOUR_MS)
  const hourly = new Map()
  for (const p of points) {
    const h = Math.floor(p[0] / HOUR_MS)
    const b = hourly.get(h) || { n: 0, fail: 0 }
    b.n++; if (p[1] == null) b.fail++
    hourly.set(h, b)
  }
  const lossBuckets = []
  for (let h = startHour; h <= Math.floor(now / HOUR_MS); h++) {
    const b = hourly.get(h) || { n: 0, fail: 0 }
    const d = new Date(h * HOUR_MS)
    lossBuckets.push({ label: hours > 48 ? `${d.getMonth() + 1}/${d.getDate()}` : hourLabel(d), value: b.n ? b.fail / b.n * 100 : 0,
      title: `${dayKey(d)} ${hourLabel(d)} · ${b.fail}/${b.n} 失败 (${pct(b.fail, b.n)})` })
  }
  $('#chart-net-loss').innerHTML = barChart(lossBuckets, { height: 132, color: COLORS.bad, labelEvery: hours > 48 ? 24 : hours > 12 ? 3 : 1 })

  // Hour-of-day profile over the whole history, shifted to local time.
  const shift = Math.round(-new Date().getTimezoneOffset() / 60)
  const hod = Array.from({ length: 24 }, () => [0, 0, null])
  ;(data.hourOfDayUtc || []).forEach((v, utc) => { hod[(utc + shift + 24) % 24] = v })
  const label = h => String(h).padStart(2, '0')
  $('#chart-net-hod-loss').innerHTML = barChart(hod.map(([n, fail], h) => ({ label: label(h), value: n ? fail / n * 100 : 0,
    title: `${label(h)}:00 · ${fail}/${n} 失败 (${pct(fail, n)})` })), { height: 120, color: COLORS.bad, labelEvery: 2 })
  $('#chart-net-hod-ms').innerHTML = barChart(hod.map(([n, , ms], h) => ({ label: label(h), value: ms || 0,
    title: `${label(h)}:00 · 中位 ${msText(ms)} · ${n} 次` })), { height: 120, color: '#0f766e', labelEvery: 2 })

  // Latency histogram, 50 ms bins up to 1500 ms, plus a failure bin.
  const bins = Array.from({ length: 30 }, (_, i) => ({ label: String(i * 50), value: 0, lo: i * 50 }))
  let over = 0
  for (const p of points) {
    if (p[1] == null) continue
    if (p[1] >= 1500) over++; else bins[Math.floor(p[1] / 50)].value++
  }
  const histogram = [...bins.map(b => ({ ...b, title: `${b.lo}–${b.lo + 49} ms · ${b.value} 次` })),
    { label: '≥1.5s', value: over, title: `≥ 1500 ms · ${over} 次`, dim: true },
    { label: '失败', value: all.fail, title: `失败 · ${all.fail} 次`, dim: true }]
  $('#chart-net-hist').innerHTML = barChart(histogram, { height: 120, color: COLORS.ink, labelEvery: 4 })

  rows($('#net-recent'), points.slice(-15).reverse().map(p => [
    `${stamp(new Date(p[0]).toISOString())}`,
    `<span class="${tone(p[1])}">${p[1] == null ? esc(p[4] || '失败') : `${p[1]} ms`}</span>
     <span class="text-stone-400">${p[2] ? '手动' : '自动'} · Bot ${p[3] ? '在线' : '离线'}</span>`
  ]))

  setText($('#n-history'), data.firstAt ? `历史自 ${stamp(new Date(data.firstAt).toISOString())} · 共 ${num(data.total)} 条 · 保留 14 天` : '')
}

function tick () {
  const last = data?.points.at(-1)
  if (!last) return setText($('#n-next'), '')
  setText($('#n-next'), `下次自动探测 ${countdown(Math.max(0, last[0] + data.intervalMs - Date.now()))}`)
}

/* Data ------------------------------------------------------------------- */

async function load (full) {
  const since = !full && data?.points.length ? `&since=${data.points.at(-1)[0]}` : ''
  try {
    const response = await fetch(`/api/probes?hours=${hours}${since}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`探测服务不可用 (${response.status})`)
    const next = await response.json()
    if (since && data) {
      const seen = new Set(data.points.map(p => p[0]))
      next.points = [...data.points, ...next.points.filter(p => !seen.has(p[0]))]
      next.hourOfDayUtc = data.hourOfDayUtc
    }
    data = next
    warned = false
    render()
  } catch (error) {
    if (!warned) { warned = true; toast(error.message || '探测服务不可用', 'error') }
  }
}

async function runNow (button) {
  button.disabled = true
  setText($('#n-run-label'), '探测中…')
  try {
    const result = await postJson('/api/probes/run')
    if (data && !data.points.some(p => p[0] === result.point[0])) data.points.push(result.point)
    if (data) data.quality = result.quality
    render()
    toast(result.point[1] == null ? `探测失败：${result.point[4] || '超时'}` : `延迟 ${result.point[1]} ms`, result.point[1] == null ? 'error' : undefined)
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    button.disabled = false
    setText($('#n-run-label'), '立即探测')
  }
}

$('#n-run').onclick = event => runNow(event.currentTarget)
$$('[data-net-hours]').forEach(chip => {
  chip.onclick = () => {
    hours = Number(chip.dataset.netHours)
    $$('[data-net-hours]').forEach(other => other.setAttribute('aria-pressed', String(other === chip)))
    load(true)
  }
})

export const networkView = {
  async mount () {
    render()
    await load(true)
    refresher = setInterval(() => load(false), 30000)
    ticker = setInterval(tick, 1000)
    tick()
  },
  unmount () {
    clearInterval(refresher); clearInterval(ticker)
    refresher = ticker = null
  }
}
