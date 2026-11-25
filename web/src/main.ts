import '@fontsource/fraunces/latin-600.css'
import '@fontsource/outfit/latin-400.css'
import '@fontsource/outfit/latin-500.css'
import '@fontsource/outfit/latin-600.css'
import { GITHUB_URL } from './config'
import { el, externalLink, shortAddress } from './dom'
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
  const chip = el('span', { class: 'chip', text: 'Wallet not connected' })
  const nav = el('nav', {
    class: 'nav',
    children: [
      routeLink('/', 'Custos', 'wordmark'),
      el('div', {
        class: 'nav-links',
        children: [
          routeLink('/activate', 'Activate'),
          routeLink('/scanner', 'Scanner'),
          routeLink('/report', 'Report'),
          externalLink(GITHUB_URL, 'GitHub'),
        ],
      }),
      chip,
    ],
  })
  const outlet = el('main')
  outlet.tabIndex = -1
  const footer = el('footer', {
    children: [
      el('p', { text: 'Built for the Binance Agent ID Hackathon. Custos never asks for a private key or a seed phrase, and it never sends a transaction unless you press the button and confirm it in your wallet.' }),
    ],
  })
  app.append(nav, outlet, footer)

  const paintChip = () => {
    const session = walletState()
    chip.textContent = session.account ? `${session.name || 'Wallet'} ${shortAddress(session.account)}` : 'Wallet not connected'
  }
  subscribeWallet(paintChip)
  startDiscovery()

  const show = () => {
    cleanup()
    const path = currentPath()
    document.title = titles[path] ?? 'Custos'
    markCurrent(nav, path)
    outlet.replaceChildren()
    const render = pages[path] ?? renderMissing
    cleanup = render(outlet)
    outlet.focus()
  }
  onRoute(show)
  show()
}

function markCurrent(nav: HTMLElement, path: string): void {
  for (const link of nav.querySelectorAll('a')) {
    const linkPath = link.pathname.replace(/\/$/, '') || '/'
    if (linkPath === path) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
}

boot()
