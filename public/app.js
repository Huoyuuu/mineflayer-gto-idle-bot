// Router and shell: hash routes, tab state, login controls, link banner.

import { $, $$, setHidden, setText } from './lib.js'
import { store, on, connect, postJson } from './store.js'
import { toast } from './toast.js'
import { statusView } from './view-status.js'
import { chatView } from './view-chat.js'
import { statsView } from './view-stats.js'

const views = {
  status: { view: statusView, section: '#view-status' },
  chat: { view: chatView, section: '#view-chat' },
  stats: { view: statsView, section: '#view-stats' }
}

const icons = () => window.lucide?.createIcons?.()

/* Routing ---------------------------------------------------------------- */

function parseRoute () {
  const raw = location.hash.replace(/^#\/?/, '')
  const [path, search = ''] = raw.split('?')
  const name = views[path] ? path : 'status'
  return { name, params: new URLSearchParams(search) }
}

let active = null

async function route () {
  const { name, params } = parseRoute()
  if (active && active !== name) views[active].view.unmount?.()

  for (const [key, entry] of Object.entries(views)) setHidden($(entry.section), key !== name)
  $$('[data-tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.tab === name)))
  document.title = { status: '状态', chat: '对话', stats: '汇总' }[name] + ' · Idle Bot'

  active = name
  await views[name].view.mount?.(params)
  icons()
}

/* Shell ------------------------------------------------------------------ */

function renderControls (state) {
  const starting = state.phase === 'connecting' || state.phase === 'reconnecting'
  $('#login').disabled = state.connected || starting || state.phase === 'cooldown'
  $('#logout').disabled = !state.connected && !starting
}

async function control (endpoint, button) {
  button.disabled = true
  try {
    await postJson(endpoint)
    toast(endpoint.endsWith('login') ? '已请求登录' : '已断开连接')
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    if (store.state) renderControls(store.state)
  }
}

$('#login').onclick = event => control('/api/login', event.currentTarget)
$('#logout').onclick = event => control('/api/logout', event.currentTarget)

on('state', renderControls)

on('link', ({ ok, reason }) => {
  const band = $('#link-warn')
  band.classList.toggle('hidden', ok)
  if (!ok) setText($('#link-warn-text'), reason || '实时连接中断，正在轮询兜底')
  icons()
})

window.addEventListener('hashchange', route)
window.addEventListener('load', icons)

if (!location.hash) location.replace('#/status')
icons()
connect()
route()
