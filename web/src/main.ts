import '@fontsource/plus-jakarta-sans/latin-400.css'
import '@fontsource/plus-jakarta-sans/latin-500.css'
import '@fontsource/plus-jakarta-sans/latin-600.css'
import '@fontsource/plus-jakarta-sans/latin-700.css'
import { el, shortAddress } from './dom'
import { renderActivate, renderLanding, renderMissing, renderReport, renderScanner } from './pages'
import { currentPath, onRoute, routeLink } from './router'
import { startDiscovery, subscribeWallet, walletState } from './wallet'
import './styles.css'

const titles: Record<string, string> = {
  '/': 'Custos — pre-sign check for agents',
  '/activate': 'Activate — Custos',
  '/scanner': 'Scanner — Custos',
  '/report': 'Report — Custos',
}

const pages: Record<string, (root: HTMLElement) => () => void> = {
  '/': renderLanding,
  '/activate': renderActivate,
  '/scanner': renderScanner,
  '/report': renderReport,
}

let cleanup = () => {}

function boot(): void {
  const app = document.querySelector('#app')
  if (!app) return
  const chip = el('span', { class: 'wallet-chip', text: 'Wallet not connected' })
  const brand = routeLink('/', 'Custos', 'wordmark')
  brand.prepend(logoMark())
  const cta = routeLink('/activate', 'Protect your agent', 'cta')
  cta.append(arrowIcon())
  const menu = el('button', {
    class: 'menu-toggle',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'primary-nav', 'aria-label': 'Open menu' },
    children: [el('span', { class: 'menu-icon', attrs: { 'aria-hidden': 'true' } })],
  })
  const links = el('nav', {
    class: 'nav-links',
    attrs: { id: 'primary-nav', 'aria-label': 'Primary' },
    children: [
      routeLink('/', 'Home'),
      routeLink('/#how', 'How it works'),
      routeLink('/scanner', 'Check'),
      routeLink('/activate', 'Agents'),
      routeLink('/#docs', 'Docs'),
    ],
  })
  const nav = el('header', {
    class: 'topbar',
    children: [
      el('a', { class: 'skip', text: 'Skip to content', attrs: { href: '#content' } }),
      el('div', {
        class: 'topbar-inner',
        children: [
          brand,
          links,
          el('div', { class: 'nav-end', children: [chip, cta, menu] }),
        ],
      }),
    ],
  })
  const setMenu = (open: boolean) => {
    menu.setAttribute('aria-expanded', open ? 'true' : 'false')
    menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu')
    nav.classList.toggle('is-open', open)
  }
  menu.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'))
  links.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) setMenu(false)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
      setMenu(false)
      menu.focus()
    }
  })
  document.addEventListener('click', (event) => {
    if (event.target instanceof Node && !nav.contains(event.target)) setMenu(false)
  })
  const outlet = el('main', { attrs: { id: 'content' } })
  outlet.tabIndex = -1
  const footer = el('footer', {
    children: [
      el('p', { text: 'Custos never asks for a private key or a seed phrase, and it never sends a transaction unless you press the button and confirm it in your wallet.' }),
    ],
  })
  app.append(nav, outlet, footer)

  const paintChip = () => {
    const session = walletState()
    chip.textContent = session.account ? `${session.name || 'Wallet'} ${shortAddress(session.account)}` : 'Wallet not connected'
  }
  subscribeWallet(paintChip)
  startDiscovery()

  let active = ''
  const show = () => {
    const path = currentPath()
    document.body.dataset.page = path === '/' ? 'home' : 'inner'
    setMenu(false)
    document.title = titles[path] ?? 'Custos'
    markCurrent(nav, path)
    const pathChanged = path !== active
    if (pathChanged) {
      cleanup()
      outlet.replaceChildren()
      outlet.className = path === '/' ? 'home-main' : 'page-wrap'
      const render = pages[path] ?? renderMissing
      cleanup = render(outlet)
      active = path
      outlet.focus({ preventScroll: true })
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const target = location.hash ? document.getElementById(location.hash.slice(1)) : null
    if (target) target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    else if (pathChanged) window.scrollTo({ top: 0, behavior: 'auto' })
  }
  onRoute(show)
  show()
}

function markCurrent(nav: HTMLElement, path: string): void {
  for (const link of nav.querySelectorAll<HTMLAnchorElement>('.nav-links a')) {
    const linkPath = link.pathname.replace(/\/$/, '') || '/'
    const current = linkPath === path && link.hash === location.hash
    if (current) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
}

function logoMark(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'logo-mark')
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
  const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient')
  grad.setAttribute('id', 'custos-mark')
  grad.setAttribute('x1', '0')
  grad.setAttribute('y1', '0')
  grad.setAttribute('x2', '1')
  grad.setAttribute('y2', '1')
  for (const [offset, color] of [['0%', '#ff4d5e'], ['100%', '#ff9a5a']] as const) {
    const stop = document.createElementNS('http://www.w3.org/2000/svg', 'stop')
    stop.setAttribute('offset', offset)
    stop.setAttribute('stop-color', color)
    grad.append(stop)
  }
  defs.append(grad)
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', '16')
  circle.setAttribute('cy', '16')
  circle.setAttribute('r', '14')
  circle.setAttribute('fill', 'url(#custos-mark)')
  const eye = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  eye.setAttribute('cx', '16')
  eye.setAttribute('cy', '15')
  eye.setAttribute('r', '4.2')
  eye.setAttribute('fill', '#1a060c')
  const glint = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  glint.setAttribute('cx', '17.4')
  glint.setAttribute('cy', '13.6')
  glint.setAttribute('r', '1.3')
  glint.setAttribute('fill', '#fff6f4')
  svg.append(defs, circle, eye, glint)
  return svg
}

function arrowIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'arrow')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M5 12h14M13 6l6 6-6 6')
  svg.append(path)
  return svg
}

boot()
