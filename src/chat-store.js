'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

class ChatStore {
  constructor (file) {
    this.file = path.resolve(file)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '', { mode: 0o600 })
    this.size = fs.statSync(this.file).size
    this.offsets = []
    this.indexFile()
  }

  indexFile () {
    if (this.size === 0) return
    const fd = fs.openSync(this.file, 'r')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    this.offsets.push(0)
    try {
      let position = 0
      while (position < this.size) {
        const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, this.size - position), position)
        for (let index = 0; index < bytesRead; index++) {
          const next = position + index + 1
          if (buffer[index] === 0x0a && next < this.size) this.offsets.push(next)
        }
        position += bytesRead
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  append (message) {
    const line = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
    fs.appendFileSync(this.file, line, { mode: 0o600 })
    this.offsets.push(this.size)
    this.size += line.length
    return message
  }

  page ({ before, limit } = {}) {
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(limit, 10) || DEFAULT_PAGE_SIZE))
    const requestedEnd = before == null ? this.offsets.length : Number.parseInt(before, 10)
    const end = Number.isInteger(requestedEnd)
      ? Math.min(this.offsets.length, Math.max(0, requestedEnd))
      : this.offsets.length
    const start = Math.max(0, end - pageSize)
    const items = this.readRange(start, end)
    return {
      items,
      cursor: end,
      nextBefore: start > 0 ? start : null,
      hasOlder: start > 0,
      total: this.offsets.length
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

module.exports = { ChatStore, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE }
