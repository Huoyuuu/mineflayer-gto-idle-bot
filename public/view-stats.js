// Stats view: aggregate summary cards plus five hand-rolled SVG charts.

import {
  $, num, bytes, duration, relative, stamp, setText, rows,
  barChart, rowChart, stackBar, kindColor, hourLabel, dayKey, dayLabel
} from './lib.js'
import { fetchStats } from './store.js'
import { toast } from './toast.js'

const KIND_LABEL = { player: '玩家发言', system: '系统消息', actionbar: '动作栏' }
const HOUR_MS = 3600000

let refresher = null
let latest = null

/* Bucket helpers --------------------------------------------------------- */

// The server sends [utcHourIndex, count]; every bucket is a real wall-clock hour,
// so a local Date rebuilt from its start is enough to group by local time.
function hourMap (series) {
  const map = new Map()
  for (const [hour, count] of series) map.set(hour, count)
  return map
}

function lastHours (map, count) {
  const nowHour = Math.floor(Date.now() / HOUR_MS)
  const buckets = []
  for (let offset = count - 1; offset >= 0; offset--) {
    const hour = nowHour - offset
    const date = new Date(hour * HOUR_MS)
    buckets.push({
      label: hourLabel(date),
      value: map.get(hour) || 0,
      title: `${dayKey(date)} ${hourLabel(date)} · ${map.get(hour) || 0} 条`
    })
  }
  return buckets
}

function lastDays (series, count) {
  const totals = new Map()
  for (const [hour, value] of series) {
    const key = dayKey(new Date(hour * HOUR_MS))
    totals.set(key, (totals.get(key) || 0) + value)
  }
  const buckets = []
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(Date.now() - offset * 86400000)
    const key = dayKey(date)
    buckets.push({
      label: dayLabel(date),
      value: totals.get(key) || 0,
      title: `${key} · ${totals.get(key) || 0} 条`
    })
  }
  return buckets
}

function hourOfDay (hourOfDayUtc) {
  const shift = Math.round(-new Date().getTimezoneOffset() / 60)
  const local = new Array(24).fill(0)
  hourOfDayUtc.forEach((value, utcHour) => { local[(utcHour + shift + 24) % 24] += value })
  return local.map((value, hour) => ({
    label: String(hour).padStart(2, '0'),
    value,
    title: `${String(hour).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:59 · ${value} 条`
  }))
}

/* Rendering -------------------------------------------------------------- */

function render (data) {
  const chat = data.chat
  const series = chat.series || []
  const map = hourMap(series)

  setText($('#s-total'), num(chat.total))
  setText($('#s-bytes'), `${bytes(chat.bytes)} 于 JSONL`)
  setText($('#s-senders'), num(chat.senderCount))
  const top = chat.topSenders?.[0]
  setText($('#s-top'), top ? `最多：${top.name} · ${num(top.count)} 条` : '')

  setText($('#s-first'), chat.firstAt ? stamp(chat.firstAt) : '--')
  setText($('#s-last'), chat.lastAt ? stamp(chat.lastAt) : '--')
  setText($('#s-last-rel'), chat.lastAt ? relative(chat.lastAt) : '')
  setText($('#s-span'), chat.firstAt && chat.lastAt
    ? `跨度 ${duration(Date.parse(chat.lastAt) - Date.parse(chat.firstAt))}`
    : '')

  const recent = lastHours(map, 48)
  $('#chart-48').innerHTML = barChart(recent, { height: 140 })
  const recentTotal = recent.reduce((sum, bucket) => sum + bucket.value, 0)
  const busiest = recent.reduce((best, bucket) => bucket.value > best.value ? bucket : best, recent[0] || { value: 0 })
  setText($('#s-48-note'), `${num(recentTotal)} 条 · 峰值 ${num(busiest.value)} 条 / ${busiest.label}`)

  $('#chart-30d').innerHTML = barChart(lastDays(series, 30), { height: 132 })
  $('#chart-hod').innerHTML = barChart(hourOfDay(chat.hourOfDayUtc || new Array(24).fill(0)),
    { height: 132, color: '#0f766e', labelEvery: 2 })

  $('#chart-senders').innerHTML = rowChart((chat.topSenders || []).map(sender => ({
    label: sender.name,
    value: sender.count
  })))

  const kinds = Object.entries(chat.kinds || {}).map(([kind, count]) => ({
    label: KIND_LABEL[kind] || kind,
    value: count,
    color: kindColor(kind)
  }))
  $('#chart-kinds').innerHTML = stackBar(kinds)
  const total = kinds.reduce((sum, kind) => sum + kind.value, 0) || 1
  rows($('#kinds-list'), kinds.map(kind => [
    kind.label,
    `<span class="inline-flex items-center gap-2">
      <span class="dot h-2 w-2" style="background:${kind.color}"></span>
      ${num(kind.value)}
      <span class="text-stone-400">${(kind.value / total * 100).toFixed(1)}%</span>
    </span>`
  ]))
}

async function reload () {
  try {
    latest = await fetchStats()
    render(latest)
  } catch (error) {
    if (!latest) toast(error.message, 'error')
  }
}

export const statsView = {
  async mount () {
    if (latest) render(latest)
    await reload()
    refresher = setInterval(reload, 60000)
  },
  unmount () {
    clearInterval(refresher)
    refresher = null
  }
}
