type Listener = (path: string) => void

let listener: Listener | null = null

export function onRoute(next: Listener): void {
  listener = next
  window.addEventListener('popstate', () => listener?.(currentPath()))
}

export function navigate(path: string): void {
  const url = new URL(path, location.origin)
  const next = `${url.pathname.replace(/\/$/, '') || '/'}${url.hash}`
  const current = `${location.pathname.replace(/\/$/, '') || '/'}${location.hash}`
  if (current !== next) history.pushState(null, '', next)
  listener?.(currentPath())
}

export function currentPath(): string {
  const path = location.pathname.replace(/\/$/, '')
  return path || '/'
}

export function routeLink(href: string, text: string, className?: string): HTMLAnchorElement {
  const link = document.createElement('a')
  link.href = href
  link.textContent = text
  if (className) link.className = className
  link.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    navigate(href)
  })
  return link
}
