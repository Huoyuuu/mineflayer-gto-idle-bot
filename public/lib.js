// Shared formatting, DOM and hand-rolled SVG chart helpers.

export const $ = (selector, root = document) => root.querySelector(selector)
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

export const esc = value => String(value ?? '').replace(/[&<>"]/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]))

export const setText = (element, value) => { if (element && element.textContent !== String(value)) element.textContent = value }

export const setHidden = (element, hidden) => { if (element) element.hidden = !!hidden }

export const toggleClass = (element, className, on) => element?.classList.toggle(className, !!on)

/* Numbers and time ------------------------------------------------------- */

export const num = value => value == null || !Number.isFinite(Number(value))
  ? '--'
  : Number(value).toLocaleString('zh-CN')

export function bytes (value) {
  if (!Number.isFinite(value)) return '--'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return `${unit === 0 ? size : size.toFixed(size < 10 ? 2 : 1)} ${units[unit]}`
}

export function duration (ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--'
  const total = Math.floor(ms / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = value => String(value).padStart(2, '0')
  if (days) return `${days}天 ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export function countdown (ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00'
  const total = Math.ceil(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = value => String(value).padStart(2, '0')
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

export function relative (iso, now = Date.now()) {
  const at = Date.parse(iso ?? '')
  if (!Number.isFinite(at)) return '--'
  const delta = Math.max(0, now - at)
  if (delta < 5000) return '刚刚'
  if (delta < 60000) return `${Math.floor(delta / 1000)} 秒前`
  if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`
  if (delta < 86400000) return `${Math.floor(delta / 3600000)} 小时前`
  return `${Math.floor(delta / 86400000)} 天前`
}

const pad2 = value => String(value).padStart(2, '0')

export const clock = date => `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
export const hourLabel = date => `${pad2(date.getHours())}:00`
export const dayKey = date => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
export const dayLabel = date => `${date.getMonth() + 1}/${date.getDate()}`

export function stamp (iso) {
  const at = Date.parse(iso ?? '')
  if (!Number.isFinite(at)) return '--'
  const date = new Date(at)
  return `${dayKey(date)} ${clock(date)}`
}

export function dayTitle (date) {
  const today = dayKey(new Date())
  const yesterday = dayKey(new Date(Date.now() - 86400000))
  const key = dayKey(date)
  const weekday = '日一二三四五六'[date.getDay()]
  if (key === today) return `今天 · ${key}`
  if (key === yesterday) return `昨天 · ${key}`
  return `${key} · 周${weekday}`
}

/* Definition lists ------------------------------------------------------- */

export function rows (element, entries) {
  if (!element) return
  element.innerHTML = entries
    .filter(entry => entry)
    .map(([key, value, extra = '']) =>
      `<div class="kv"><dt>${esc(key)}</dt><dd ${extra}>${value ?? '--'}</dd></div>`)
    .join('')
}

/* Colour ----------------------------------------------------------------- */

const SENDER_COLORS = ['#0f766e', '#7c3aed', '#b45309', '#1d4ed8', '#be123c', '#4d7c0f', '#0369a1', '#a21caf']

export function senderColor (name) {
  let hash = 0
  const value = String(name ?? '')
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) % 100000
  return SENDER_COLORS[hash % SENDER_COLORS.length]
}

/* Charts ----------------------------------------------------------------- */

const EMPTY = '<p class="py-8 text-center text-[12px] text-stone-400">暂无数据</p>'

const svg = (width, height, body) =>
  `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-hidden="true">${body}</svg>`

export function sparkline (values, { height = 44, stroke = '#059669', fill = 'rgba(5,150,105,0.10)' } = {}) {
  if (!values || values.length < 2) return EMPTY
  const width = 600
  const top = 3
  const usable = height - top - 3
  const max = Math.max(...values, 1)
  const step = width / (values.length - 1)
  const points = values.map((value, index) => [
    +(index * step).toFixed(2),
    +(top + usable - (value / max) * usable).toFixed(2)
  ])
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ')
  const area = `${line} L${width} ${height} L0 ${height} Z`
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-hidden="true" style="height:${height}px">
    <path d="${area}" fill="${fill}"></path>
    <path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.4" vector-effect="non-scaling-stroke"
      stroke-linejoin="round" stroke-linecap="round"></path>
  </svg>`
}

export function barChart (buckets, { height = 132, color = '#1c1917', labelEvery = 0 } = {}) {
  if (!buckets?.length) return EMPTY
  const width = 720
  const axis = 16
  const plot = height - axis
  const max = Math.max(...buckets.map(bucket => bucket.value), 1)
  const slot = width / buckets.length
  const barWidth = Math.max(1, slot * 0.72)
  const every = labelEvery || Math.max(1, Math.ceil(buckets.length / 12))
  const bars = buckets.map((bucket, index) => {
    const tall = bucket.value ? Math.max(2, (bucket.value / max) * (plot - 4)) : 0
    const x = index * slot + (slot - barWidth) / 2
    return tall
      ? `<rect x="${x.toFixed(2)}" y="${(plot - tall).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${tall.toFixed(2)}"
          fill="${color}" opacity="${bucket.dim ? 0.28 : 0.85}"><title>${esc(bucket.title || bucket.label)}</title></rect>`
      : ''
  }).join('')
  const ticks = buckets.map((bucket, index) => index % every === 0
    ? `<text x="${(index * slot + slot / 2).toFixed(2)}" y="${height - 4}" text-anchor="middle"
        font-size="9" fill="#a8a29e" font-family="ui-monospace,monospace">${esc(bucket.label)}</text>`
    : '').join('')
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-hidden="true" style="height:${height}px">
    <line x1="0" y1="${plot}" x2="${width}" y2="${plot}" stroke="#e7e5e4" stroke-width="1"></line>
    ${bars}${ticks}
  </svg>`
}

export function rowChart (items, { color = '#1c1917' } = {}) {
  if (!items?.length) return EMPTY
  const rowHeight = 22
  const width = 480
  const labelWidth = 116
  const valueWidth = 52
  const track = width - labelWidth - valueWidth
  const max = Math.max(...items.map(item => item.value), 1)
  const body = items.map((item, index) => {
    const y = index * rowHeight
    const length = Math.max(2, (item.value / max) * track)
    const label = item.label.length > 15 ? `${item.label.slice(0, 14)}…` : item.label
    return `<g>
      <text x="0" y="${y + 14}" font-size="11" fill="#57534e" font-family="ui-monospace,monospace">${esc(label)}</text>
      <rect x="${labelWidth}" y="${y + 5}" width="${length.toFixed(2)}" height="11" fill="${color}" opacity="0.82" rx="1">
        <title>${esc(item.label)} · ${item.value}</title></rect>
      <text x="${width}" y="${y + 14}" text-anchor="end" font-size="10.5" fill="#a8a29e"
        font-family="ui-monospace,monospace">${item.value.toLocaleString('zh-CN')}</text>
    </g>`
  }).join('')
  return `<svg viewBox="0 0 ${width} ${items.length * rowHeight}" role="img" aria-hidden="true"
    style="height:${items.length * rowHeight}px">${body}</svg>`
}

const KIND_COLORS = { player: '#0f766e', system: '#78716c', actionbar: '#d6d3d1' }

export const kindColor = kind => KIND_COLORS[kind] || '#a8a29e'

export function stackBar (items) {
  if (!items?.length) return EMPTY
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1
  let x = 0
  const body = items.map(item => {
    const width = (item.value / total) * 100
    const rect = `<rect x="${x}" y="0" width="${width}" height="14" fill="${item.color}">
      <title>${esc(item.label)} · ${item.value} (${(width).toFixed(1)}%)</title></rect>`
    x += width
    return rect
  }).join('')
  return svg(100, 14, body).replace('<svg ', '<svg style="height:14px" ')
}
