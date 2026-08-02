'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { LightBot } = require('../src/light-bot')

const rootDir = path.resolve(__dirname, '..')
const runtimeDir = path.join(rootDir, '.runtime')
const reportFile = path.join(runtimeDir, 'dred-login-report.json')
const cooldownFile = path.join(runtimeDir, 'dred-login.cooldown')
const observeMs = readDuration('DRED_OBSERVE_MS', 60_000)
const loginTimeoutMs = readDuration('DRED_LOGIN_TIMEOUT_MS', 55_000)
const startedAt = Date.now()
const events = []
let bot
let homeSent = false
let playReached = false
let positionReceived = false
let finished = false
let finishTimer

function readDuration (name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function record (type, detail = {}) {
  const entry = { at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, type, ...detail }
  events.push(entry)
  console.log(`[dred-test] ${type}${detail.message ? `: ${detail.message}` : ''}`)
}

function writeReport (result, exitCode, reason) {
  fs.mkdirSync(runtimeDir, { recursive: true })
  const snapshot = bot?.snapshot()
  const report = {
    result,
    exitCode,
    reason,
    username: 'Dred',
    server: snapshot ? `${snapshot.host}:${snapshot.port}` : null,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    playReached,
    homeSent,
    positionReceived,
    finalState: snapshot,
    events
  }
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(`[dred-test] report: ${reportFile}`)
}

function finish (result, exitCode, reason) {
  if (finished) return
  finished = true
  clearTimeout(finishTimer)
  record('finished', { message: reason })
  writeReport(result, exitCode, reason)
  bot?.stop()
  setTimeout(() => process.exit(exitCode), 50)
}

function crash (type, error) {
  const message = error?.stack || error?.message || String(error)
  record(type, { message })
  finish('client-crash', 2, message)
}

process.once('uncaughtException', error => crash('uncaughtException', error))
process.once('unhandledRejection', error => crash('unhandledRejection', error))
process.once('SIGINT', () => finish('interrupted', 130, 'interrupted by user'))

record('starting', { message: `Dred -> ${process.env.MC_HOST || 'configured server'}` })
bot = new LightBot({ botUsername: 'Dred', cooldownFile })

bot.on('chat', entry => record('chat', { kind: entry.kind, sender: entry.sender, message: entry.text }))
bot.on('state', state => {
  if (state.position && !positionReceived) {
    positionReceived = true
    record('position', { position: state.position })
  }
  if (state.connected && !playReached) {
    playReached = true
    record('play', { world: state.world, entityId: state.entityId })
    setTimeout(() => {
      if (finished || !bot.snapshot().connected) return
      try {
        bot.sendChat('/home')
        homeSent = true
        record('command-sent', { message: '/home' })
      } catch (error) {
        finish('command-failed', 3, error.message)
      }
    }, 1500)
    finishTimer = setTimeout(() => {
      const stateNow = bot.snapshot()
      if (stateNow.lastError) finish('connection-error', 4, stateNow.lastError)
      else finish('passed', 0, `play remained healthy for ${observeMs} ms after login`)
    }, observeMs)
  }
  if (playReached && !state.connected && state.lastError) {
    finish('connection-error', 4, state.lastError)
  }
})

setTimeout(() => {
  if (!playReached) finish('login-failed', 5, bot.snapshot().lastError || `play not reached within ${loginTimeoutMs} ms`)
}, loginTimeoutMs)

bot.start()
