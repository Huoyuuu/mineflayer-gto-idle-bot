'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const HOUR_MS = 60 * 60 * 1000
const STATS_HOURS = 24 * 45
const SEARCH_SCAN_LIMIT = 200000
const SEARCH_BATCH = 500

const lower = value => String(value ?? '').toLowerCase()

class ChatStore {
  constructor (file) {
    this.file = path.resolve(file)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '', { mode: 0o600 })
    this.size = fs.statSync(this.file).size
    this.offsets = []
    this.aggregate = { kinds: new Map(), senders: new Map(), hours: new Map(), hourOfDayUtc: new Array(24).fill(0), firstAt: null, lastAt: null }
    this.indexFile()
  }

  indexFile () {
    if (this.size === 0) return
    const fd = fs.openSync(this.file, 'r')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    this.offsets.push(0)
    let pending = ''
    try {
      let position = 0
      while (position < this.size) {
        const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, this.size - position), position)
        for (let index = 0; index < bytesRead; index++) {
          const next = position + index + 1
          if (buffer[index] === 0x0a && next < this.size) this.offsets.push(next)
        }
        pending += buffer.toString('utf8', 0, bytesRead)
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) this.count(line)
        position += bytesRead
      }
      if (pending.trim()) this.count(pending)
    } finally {
      fs.closeSync(fd)
    }
  }

  count (line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    this.tally(message)
  }

  tally (message) {
    const { kinds, senders, hours, hourOfDayUtc } = this.aggregate
    const kind = message.kind || 'system'
    const sender = message.sender || 'server'
    kinds.set(kind, (kinds.get(kind) || 0) + 1)
    senders.set(sender, (senders.get(sender) || 0) + 1)
    const at = Date.parse(message.at)
    if (Number.isFinite(at)) {
      const hour = Math.floor(at / HOUR_MS)
      hours.set(hour, (hours.get(hour) || 0) + 1)
      hourOfDayUtc[new Date(at).getUTCHours()]++
      if (this.aggregate.firstAt == null || at < this.aggregate.firstAt) this.aggregate.firstAt = at
      if (this.aggregate.lastAt == null || at > this.aggregate.lastAt) this.aggregate.lastAt = at
    }
  }

  append (message) {
    const line = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
    fs.appendFileSync(this.file, line, { mode: 0o600 })
    this.offsets.push(this.size)
    this.size += line.length
    this.tally(message)
    return message
  }

  get total () { return this.offsets.length }

  pageSizeOf (limit) {
    return Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(limit, 10) || DEFAULT_PAGE_SIZE))
  }

  page ({ before, after, around, page, limit } = {}) {
    const pageSize = this.pageSizeOf(limit)
    const total = this.offsets.length
    let start
    let end
    const aroundIndex = Number.parseInt(around, 10)
    const pageNumber = Number.parseInt(page, 10)
    const afterIndex = Number.parseInt(after, 10)
    if (Number.isInteger(aroundIndex)) {
      const center = Math.min(total - 1, Math.max(0, aroundIndex))
      start = Math.max(0, center - Math.floor(pageSize / 2))
      end = Math.min(total, start + pageSize)
      start = Math.max(0, end - pageSize)
    } else if (Number.isInteger(pageNumber) && pageNumber > 0) {
      end = Math.max(0, total - (pageNumber - 1) * pageSize)
      start = Math.max(0, end - pageSize)
    } else if (Number.isInteger(afterIndex)) {
      start = Math.min(total, Math.max(0, afterIndex))
      end = Math.min(total, start + pageSize)
      start = Math.max(0, end - pageSize)
    } else {
      const requestedEnd = before == null ? total : Number.parseInt(before, 10)
      end = Number.isInteger(requestedEnd) ? Math.min(total, Math.max(0, requestedEnd)) : total
      start = Math.max(0, end - pageSize)
    }
    const items = this.readRange(start, end).map((message, offset) => ({ ...message, index: start + offset }))
    return {
      items,
      cursor: end,
      startIndex: start,
      nextBefore: start > 0 ? start : null,
      nextAfter: end < total ? end : null,
      hasOlder: start > 0,
      hasNewer: end < total,
      page: Math.floor((total - end) / pageSize) + 1,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      pageSize,
      total
    }
  }

  search ({ query, kind, sender, since, until, before, limit } = {}) {
    const pageSize = this.pageSizeOf(limit)
    const total = this.offsets.length
    const needle = lower(query).trim()
    const wantKind = kind && kind !== 'all' ? String(kind) : null
    const wantSender = lower(sender).trim()
    const from = since ? Date.parse(since) : null
    const to = until ? Date.parse(until) : null
    const requestedEnd = before == null ? total : Number.parseInt(before, 10)
    const end = Number.isInteger(requestedEnd) ? Math.min(total, Math.max(0, requestedEnd)) : total

    const matches = (message, index) => {
      if (wantKind && (message.kind || 'system') !== wantKind) return false
      if (wantSender && !lower(message.sender).includes(wantSender)) return false
      if (from != null || to != null) {
        const at = Date.parse(message.at)
        if (!Number.isFinite(at)) return false
        if (from != null && at < from) return false
        if (to != null && at > to) return false
      }
      if (!needle) return true
      return lower(message.text).includes(needle) || lower(message.sender).includes(needle)
    }

    const found = []
    let cursor = end
    let scanned = 0
    let extra = null
    while (cursor > 0 && scanned < SEARCH_SCAN_LIMIT && extra == null) {
      const batchStart = Math.max(0, cursor - SEARCH_BATCH)
      const batch = this.readRange(batchStart, cursor)
      for (let offset = batch.length - 1; offset >= 0; offset--) {
        const index = batchStart + offset
        const message = batch[offset]
        if (!matches(message, index)) continue
        if (found.length < pageSize) found.push({ ...message, index })
        else { extra = index; break }
      }
      scanned += cursor - batchStart
      cursor = batchStart
    }

    return {
      items: found.reverse(),
      matched: found.length,
      nextBefore: extra == null ? null : extra + 1,
      hasOlder: extra != null,
      scanned,
      truncated: extra == null && cursor > 0,
      searchedFrom: end,
      total,
      pageSize
    }
  }

  stats () {
    const { kinds, senders, hours, hourOfDayUtc, firstAt, lastAt } = this.aggregate
    const nowHour = Math.floor(Date.now() / HOUR_MS)
    const oldestHour = nowHour - STATS_HOURS
    const series = []
    for (const [hour, count] of hours) if (hour >= oldestHour) series.push([hour, count])
    series.sort((a, b) => a[0] - b[0])
    const sortedSenders = [...senders].sort((a, b) => b[1] - a[1])
    return {
      total: this.offsets.length,
      bytes: this.size,
      kinds: Object.fromEntries([...kinds].sort((a, b) => b[1] - a[1])),
      senderCount: senders.size,
      topSenders: sortedSenders.slice(0, 15).map(([name, count]) => ({ name, count })),
      senderNames: sortedSenders.slice(0, 40).map(([name]) => name),
      hourMs: HOUR_MS,
      series,
      hourOfDayUtc: [...hourOfDayUtc],
      firstAt: firstAt == null ? null : new Date(firstAt).toISOString(),
      lastAt: lastAt == null ? null : new Date(lastAt).toISOString()
    }
  }

  readRange (start, end) {
    if (start >= end) return []
    const byteStart = this.offsets[start]
    const byteEnd = end < this.offsets.length ? this.offsets[end] : this.size
    const buffer = Buffer.allocUnsafe(byteEnd - byteStart)
    const fd = fs.openSync(this.file, 'r')
    try {
      fs.readSync(fd, buffer, 0, buffer.length, byteStart)
    } finally {
      fs.closeSync(fd)
    }
    return buffer.toString('utf8').trimEnd().split('\n').flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
  }
}

module.exports = { ChatStore, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, HOUR_MS, STATS_HOURS, SEARCH_SCAN_LIMIT }
