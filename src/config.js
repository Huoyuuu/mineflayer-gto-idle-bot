'use strict'

const fs = require('node:fs')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '..')
const envFile = path.join(rootDir, '.env')
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile)

function integerSetting (name, fallback, min, max) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}-${max}`)
  return value
}

const config = Object.freeze({
  botUsername: process.env.BOT_USERNAME || 'minecraft_idle',
  mcHost: process.env.MC_HOST || 'localhost',
  mcPort: integerSetting('MC_PORT', 25565, 1, 65535),
  mcVersion: process.env.MC_VERSION || '1.20.1',
  webHost: process.env.WEB_HOST || '127.0.0.1',
  webPort: integerSetting('WEB_PORT', 18000, 1, 65535),
  viewDistance: integerSetting('VIEW_DISTANCE', 2, 2, 32),
  chatFile: process.env.CHAT_FILE || path.join(rootDir, '.minecraft-idle-bot.chat.jsonl'),
  debug: ['1', 'true', 'yes', 'on'].includes((process.env.BOT_DEBUG || '').toLowerCase())
})

module.exports = { config, rootDir }
