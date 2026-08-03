// Inline, non-blocking notices. Replaces alert() so failures stay in the page.

const wrap = () => document.getElementById('toasts')

export function toast (message, tone = 'info', ms = 4200) {
  const host = wrap()
  if (!host) return
  const node = document.createElement('div')
  node.className = `toast${tone === 'error' ? ' toast-error' : ''}`
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status')
  node.textContent = String(message ?? '')
  host.appendChild(node)
  setTimeout(() => {
    node.style.transition = 'opacity 160ms ease'
    node.style.opacity = '0'
    setTimeout(() => node.remove(), 200)
  }, ms)
}
