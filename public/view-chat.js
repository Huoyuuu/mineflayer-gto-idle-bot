// Chat view: paginated browsing, full-text search with filters, and jump-to-context.

import {
  $, $$, esc, num, clock, dayKey, dayTitle, senderColor, setText, toggleClass
} from './lib.js'
import { on, fetchChat, fetchSearch, fetchStats, postJson } from './store.js'
import { toast } from './toast.js'

const view = {
  mode: 'browse',
  page: 1,
  around: null,
  highlight: null,
  data: null,
  searchStack: [],
  searchBefore: null,
  pending: 0,
  loading: false
}

const filters = { q: '', kind: 'all', sender: '', since: '', until: '' }

const dom = {}
let mounted = false
let sendersLoaded = false

/* Rendering -------------------------------------------------------------- */

function highlighted (text, needle) {
  const safe = esc(text)
  if (!needle) return safe
  const pattern = esc(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!pattern) return safe
  return safe.replace(new RegExp(pattern, 'gi'), match => `<mark>${match}</mark>`)
}

function messageRow (message, { needle = '', hit = false, jump = false } = {}) {
  const at = new Date(message.at)
  const kind = message.kind || 'system'
  const sender = kind === 'player'
    ? `<b class="msg-sender" style="color:${senderColor(message.sender)}">${esc(message.sender)}</b> `
    : kind === 'actionbar'
      ? '<span class="label mr-1">bar</span>'
      : ''
  const action = jump
    ? `<button class="chip ml-1.5 h-5 px-1.5 align-middle text-[10px]" data-jump="${message.index}" title="在上下文中查看">#${message.index + 1}</button>`
    : ''
  return `<div class="msg msg-${kind}${hit ? ' msg-hit' : ''}" data-index="${message.index}" id="msg-${message.index}">
    <time datetime="${esc(message.at)}" title="${esc(new Date(message.at).toLocaleString('zh-CN'))}">${clock(at)}</time>
    <div>${sender}${highlighted(message.text, needle)}${action}</div>
  </div>`
}

function renderList (items, { needle = '', jump = false } = {}) {
  if (!items.length) {
    dom.chat.innerHTML = `<p class="py-16 text-center text-[13px] text-stone-400">${view.mode === 'search' ? '没有匹配的消息' : '暂无消息'}</p>`
    return
  }
  let lastDay = ''
  dom.chat.innerHTML = items.map(message => {
    const date = new Date(message.at)
    const key = dayKey(date)
    const mark = key === lastDay ? '' : `<div class="daymark">${esc(dayTitle(date))}</div>`
    lastDay = key
    return mark + messageRow(message, { needle, jump, hit: message.index === view.highlight })
  }).join('')
}

function renderBrowse (data) {
  renderList(data.items, { needle: filters.q })
  setText(dom.pageLabel, `第 ${data.page} / ${data.pageCount} 页`)
  dom.pageJump.max = String(data.pageCount)
  dom.pageJump.placeholder = String(data.page)
  dom.newest.disabled = !data.hasNewer
  dom.newer.disabled = !data.hasNewer
  dom.older.disabled = !data.hasOlder
  dom.oldest.disabled = !data.hasOlder
  setText(dom.summary, data.total
    ? `共 ${num(data.total)} 条 · 本页 ${data.startIndex + 1}–${data.startIndex + data.items.length}`
    : '共 0 条')
}

function renderSearch (data) {
  renderList(data.items, { needle: filters.q, jump: true })
  setText(dom.pageLabel, `搜索结果 ${data.items.length}`)
  dom.newest.disabled = true
  dom.oldest.disabled = true
  dom.newer.disabled = view.searchStack.length === 0
  dom.older.disabled = !data.hasOlder
  const scope = data.truncated ? `已扫描最近 ${num(data.scanned)} 条` : `已扫描 ${num(data.scanned)} 条`
  setText(dom.summary, `匹配 ${num(data.items.length)} 条 · ${scope} / 共 ${num(data.total)} 条`)
}

function afterRender () {
  if (view.highlight != null) {
    const target = document.getElementById(`msg-${view.highlight}`)
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return
  }
  if (view.mode === 'browse' && view.page === 1) dom.chat.scrollTop = dom.chat.scrollHeight
  else dom.chat.scrollTop = 0
}

/* Loading ---------------------------------------------------------------- */

const hasFilters = () => !!(filters.q || filters.kind !== 'all' || filters.sender || filters.since || filters.until)

const dayStart = value => value ? new Date(`${value}T00:00:00`).toISOString() : ''
const dayEnd = value => value ? new Date(`${value}T23:59:59.999`).toISOString() : ''

async function load () {
  if (view.loading) return
  view.loading = true
  toggleClass(dom.chat, 'opacity-60', true)
  try {
    if (view.mode === 'search') {
      const data = await fetchSearch({
        q: filters.q,
        kind: filters.kind,
        sender: filters.sender,
        since: dayStart(filters.since),
        until: dayEnd(filters.until),
        before: view.searchBefore ?? '',
        limit: 50
      })
      view.data = data
      renderSearch(data)
    } else {
      const params = view.around == null ? { page: view.page } : { around: view.around }
      const data = await fetchChat({ ...params, limit: 50 })
      view.data = data
      view.page = data.page
      renderBrowse(data)
    }
    afterRender()
    if (view.highlight != null) setTimeout(() => { view.highlight = null }, 2600)
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    view.loading = false
    toggleClass(dom.chat, 'opacity-60', false)
  }
}

function resetToSearch () {
  view.mode = hasFilters() ? 'search' : 'browse'
  view.searchStack = []
  view.searchBefore = null
  view.around = null
  view.highlight = null
  if (view.mode === 'browse') view.page = 1
  clearPending()
  load()
}

function clearPending () {
  view.pending = 0
  dom.live.classList.add('hidden')
}

function jumpTo (index) {
  view.mode = 'browse'
  view.around = index
  view.highlight = index
  view.searchStack = []
  view.searchBefore = null
  load()
}

/* Wiring ----------------------------------------------------------------- */

function bind () {
  dom.chat = $('#chat')
  dom.summary = $('#chat-summary')
  dom.pageLabel = $('#pg-label')
  dom.pageJump = $('#pg-jump')
  dom.newest = $('#pg-newest')
  dom.newer = $('#pg-newer')
  dom.older = $('#pg-older')
  dom.oldest = $('#pg-oldest')
  dom.live = $('#pg-live')
  dom.liveText = $('#pg-live-text')

  dom.newest.onclick = () => { view.around = null; view.page = 1; view.highlight = null; clearPending(); load() }
  dom.oldest.onclick = () => { view.around = null; view.page = view.data?.pageCount || 1; view.highlight = null; load() }

  dom.newer.onclick = () => {
    if (view.mode === 'search') {
      view.searchBefore = view.searchStack.pop() ?? null
      return load()
    }
    view.around = null
    view.page = Math.max(1, (view.data?.page || 1) - 1)
    view.highlight = null
    load()
  }

  dom.older.onclick = () => {
    if (view.mode === 'search') {
      if (!view.data?.hasOlder) return
      view.searchStack.push(view.searchBefore)
      view.searchBefore = view.data.nextBefore
      return load()
    }
    view.around = null
    view.page = (view.data?.page || 1) + 1
    view.highlight = null
    load()
  }

  $('#pg-go').onclick = () => {
    const wanted = Number.parseInt(dom.pageJump.value, 10)
    if (!Number.isInteger(wanted) || wanted < 1) return toast('请输入有效页码')
    view.mode = 'browse'
    view.around = null
    view.highlight = null
    view.page = wanted
    load()
  }
  dom.pageJump.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); $('#pg-go').click() } }

  dom.live.onclick = () => { clearPending(); view.mode = 'browse'; view.around = null; view.page = 1; load() }

  dom.chat.addEventListener('click', event => {
    const button = event.target.closest('[data-jump]')
    if (button) jumpTo(Number.parseInt(button.dataset.jump, 10))
  })

  let debounce = null
  $('#q').oninput = event => {
    filters.q = event.target.value.trim()
    clearTimeout(debounce)
    debounce = setTimeout(resetToSearch, 260)
  }

  $('#q-sender').onchange = event => { filters.sender = event.target.value.trim(); resetToSearch() }
  $('#q-since').onchange = event => { filters.since = event.target.value; resetToSearch() }
  $('#q-until').onchange = event => { filters.until = event.target.value; resetToSearch() }

  $$('[data-kind]').forEach(chip => {
    chip.onclick = () => {
      filters.kind = chip.dataset.kind
      $$('[data-kind]').forEach(other => other.setAttribute('aria-pressed', String(other === chip)))
      resetToSearch()
    }
  })

  $('#q-clear').onclick = () => {
    filters.q = filters.sender = filters.since = filters.until = ''
    filters.kind = 'all'
    $('#q').value = ''
    $('#q-sender').value = ''
    $('#q-since').value = ''
    $('#q-until').value = ''
    $$('[data-kind]').forEach(chip => chip.setAttribute('aria-pressed', String(chip.dataset.kind === 'all')))
    resetToSearch()
  }

  $('#composer').onsubmit = async event => {
    event.preventDefault()
    const input = $('#message')
    const message = input.value.trim()
    if (!message) return
    try {
      await postJson('/api/chat', { message })
      input.value = ''
    } catch (error) {
      toast(error.message, 'error')
    }
  }
}

on('chat', () => {
  view.pending++
  if (!mounted || !dom.live) return
  if (view.mode === 'browse' && view.page === 1 && view.around == null) { clearPending(); return load() }
  dom.live.classList.remove('hidden')
  setText(dom.liveText, `${view.pending} 条新消息`)
})

async function loadSenders () {
  if (sendersLoaded) return
  try {
    const data = await fetchStats()
    $('#sender-list').innerHTML = (data.chat?.senderNames || []).map(name => `<option value="${esc(name)}"></option>`).join('')
    sendersLoaded = true
  } catch { /* datalist is optional */ }
}

export const chatView = {
  async mount (params) {
    if (!dom.chat) bind()
    mounted = true
    loadSenders()
    const around = Number.parseInt(params?.get('around') ?? '', 10)
    if (Number.isInteger(around)) {
      jumpTo(around)
      return
    }
    if (view.pending && view.mode === 'browse' && view.page === 1) clearPending()
    await load()
  },
  unmount () { mounted = false }
}
