'use strict'

// Pure helpers shared by the page: no DOM access, so they can be unit tested in Node.
// Loaded as a plain script in the browser (window.ViewMath) and required in tests.

;(function (root, factory) {
  const api = factory()
  root.ViewMath = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  // Rotated index space: (a, b) walks away from the camera, so painter order is a + b.
  function rotatedIndex (a, b, size, rotation) {
    const last = size - 1
    if (rotation === 1) return [b, last - a]
    if (rotation === 2) return [last - a, last - b]
    if (rotation === 3) return [last - b, a]
    return [a, b]
  }

  // Same rotation applied to fractional world offsets (bot marker, facing arrow).
  // `+ 0` collapses the negative zero that -x produces, which would otherwise leak
  // into cell keys and comparisons.
  function toRotated (x, z, rotation) {
    if (rotation === 1) return [-z + 0, x + 0]
    if (rotation === 2) return [-x + 0, -z + 0]
    if (rotation === 3) return [z + 0, -x + 0]
    return [x + 0, z + 0]
  }

  const COLOR_RULES = [
    [/grass_block|moss|grass$/, [122, 158, 92]], [/dirt|farmland|mud|rooted/, [126, 96, 68]],
    [/red_sand/, [186, 118, 72]], [/sand$|sandstone/, [219, 205, 158]],
    [/deepslate|blackstone|basalt/, [82, 82, 86]], [/granite/, [156, 116, 98]],
    [/diorite|calcite|quartz/, [222, 220, 214]],
    [/gravel|cobble|andesite|stone_brick|smooth_stone|^stone|tuff/, [140, 139, 136]],
    [/water|kelp|bubble/, [74, 122, 176]], [/lava|magma/, [206, 108, 44]],
    [/leaves|vine|azalea|bamboo/, [96, 134, 79]],
    [/log$|wood$|stem$|planks|barrel|bookshelf|crafting|scaffolding|fence|door|stairs|slab/, [166, 128, 79]],
    [/glass|ice|beacon/, [196, 220, 228]], [/wool|carpet|bed$/, [214, 208, 200]],
    [/iron|anvil|hopper|rail|chain|lantern/, [176, 178, 182]], [/gold|copper|honey/, [206, 168, 92]],
    [/diamond|emerald|lapis|amethyst/, [110, 176, 178]], [/redstone|netherrack|crimson/, [162, 82, 74]],
    [/chest|furnace|smoker|dispenser|dropper/, [158, 122, 74]],
    [/snow|powder/, [238, 240, 243]], [/obsidian|coal/, [56, 52, 62]],
    [/wheat|carrot|potato|beet|hay|melon|pumpkin/, [198, 172, 84]],
    [/flower|tulip|poppy|dandelion|rose|lilac|peony/, [188, 142, 158]]
  ]
  const colorCache = new Map()
  function colorFor (name) {
    const key = String(name || 'unknown')
    if (colorCache.has(key)) return colorCache.get(key)
    let color = COLOR_RULES.find(([pattern]) => pattern.test(key))?.[1]
    if (!color) {
      let hash = 0
      for (let index = 0; index < key.length; index++) hash = (hash * 31 + key.charCodeAt(index)) >>> 0
      color = [148 + hash % 64, 144 + (hash >> 8) % 64, 138 + (hash >> 16) % 64]
    }
    colorCache.set(key, color)
    return color
  }

  const rgb = ([r, g, b], shade) => `rgb(${clamp(r * shade, 0, 255) | 0},${clamp(g * shade, 0, 255) | 0},${clamp(b * shade, 0, 255) | 0})`

  const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
  const isTyping = node => Boolean(node) && (TYPING_TAGS.has(node.tagName) || node.isContentEditable === true)

  // The chat box owns the keyboard while focused; movement keys are only swallowed
  // once the canvas has explicitly taken control.
  function keyIntent (event, { controlling, controlKeys }) {
    if (isTyping(event.target)) return event.code === 'Escape' ? 'blur' : 'type'
    if (event.code === 'Escape') return 'release'
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey
    if (event.code === 'KeyR' && plain) return 'rotate'
    if (controlling && controlKeys.includes(event.code)) return 'control'
    return 'ignore'
  }

  // Minecraft ticks: 0 is 06:00 and a day is 24000 ticks.
  function gameClock (time) {
    const ticks = ((Number(time) % 24000) + 24000) % 24000
    const hours = Math.floor(ticks / 1000 + 6) % 24
    const minutes = Math.floor((ticks % 1000) / 1000 * 60)
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  }

  function compass (yaw) {
    if (!Number.isFinite(Number(yaw))) return ''
    const index = Math.round((((Number(yaw) % 360) + 360) % 360) / 45) % 8
    return ['南', '西南', '西', '西北', '北', '东北', '东', '东南'][index]
  }

  function formatDuration (seconds) {
    // `Number(null)` is 0, so a missing uptime must be rejected before conversion.
    if (seconds == null || seconds === '' || !Number.isFinite(Number(seconds))) return '--'
    const total = Math.max(0, Math.floor(Number(seconds)))
    const days = Math.floor(total / 86400)
    const hours = Math.floor(total % 86400 / 3600)
    const minutes = Math.floor(total % 3600 / 60)
    if (days) return `${days}d ${hours}h`
    if (hours) return `${hours}h ${minutes}m`
    return `${minutes}m ${total % 60}s`
  }

  function countdown (iso, now = Date.now()) {
    const remaining = Math.max(0, Date.parse(iso) - now)
    return `${Math.floor(remaining / 60000)}m ${String(Math.floor(remaining % 60000 / 1000)).padStart(2, '0')}s`
  }

  return { clamp, rotatedIndex, toRotated, colorFor, rgb, isTyping, keyIntent, gameClock, compass, formatDuration, countdown }
})
