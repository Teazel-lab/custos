import {
  applyAddressPaste,
  buildCheckRequest,
  fetchReport,
  postCheck,
  severityClass,
  type CheckResponse,
  type ReportResponse,
  type ScannerFields,
} from './api'
import { activateWallet, chainError, readAgent, readProtected, reportTarget, type AgentRead } from './chain'
import {
  AGENT_ID_URL,
  bscscanAddress,
  bscscanTx,
  CHAINS,
  contractsReady,
  GITHUB_URL,
  REPORT_REASONS,
  sourcifyUrl,
  type ChainId,
  type ReportReason,
} from './config'
import { el, externalLink, field, input, shortAddress } from './dom'
import { routeLink } from './router'
import {
  browserWallet,
  connectWallet,
  discoveredProviders,
  subscribeDiscovery,
  subscribeWallet,
  switchNetwork,
  walletError,
  walletState,
  type Eip1193Provider,
} from './wallet'

const CURL = `curl -s -X POST https://api.custosprotocol.com/check \\
  -H 'content-type: application/json' \\
  -d '{"chainId":97,"from":"0x0000000000000000000000000000000000000001","to":"0x0000000000000000000000000000000000000002","data":"0x","value":"0"}'`

export function renderLanding(root: HTMLElement): () => void {
  const contracts = contractList()
  root.append(
    el('section', {
      class: 'hero',
      children: [
        el('p', { class: 'eyebrow', text: 'Binance Agent ID Hackathon' }),
        el('h1', { text: 'Check the transaction before the agent signs it.' }),
        el('p', {
          class: 'lede',
          text: 'Custos is a pre-sign security check for AI agents on BNB Chain. The agent calls /check, gets a verdict, and the person still confirms the transaction in their own wallet.',
        }),
        el('div', {
          class: 'row',
          children: [
            routeLink('/scanner', 'Scan a transaction', 'button'),
            routeLink('/activate', 'Activate a wallet', 'button ghost'),
            externalLink(GITHUB_URL, 'GitHub', 'button ghost'),
          ],
        }),
      ],
    }),
    el('section', {
      class: 'grid-3',
      children: [
        verdictCard('safe', 'Safe', 'Reputation checks finished and no warn or danger signal fired. If GoPlus or ScamSniffer did not answer, complete is false and the verdict is warn.'),
        verdictCard('warn', 'Warn', 'Something needs a look: an allowance, value leaving the sender, a community report, or a reputation check that did not finish.'),
        verdictCard('danger', 'Danger', 'A stronger signal, such as a honeypot, an unlimited allowance, or a flagged address.'),
      ],
    }),
    el('section', {
      class: 'panel',
      children: [
        el('h2', { text: 'How it works' }),
        el('ol', {
          class: 'steps',
          children: [
            el('li', { children: [el('strong', { text: 'The agent builds the transaction.' }), el('span', { text: ' Chain, sender, target, value, and calldata. Custos never receives a key or a seed phrase.' })] }),
            el('li', { children: [el('strong', { text: 'The agent POSTs it to /check.' }), el('span', { text: ' The API simulates the call and reads reputation and the community registry. It does not sign or broadcast.' })] }),
            el('li', { children: [el('strong', { text: 'The person confirms in their wallet.' }), el('span', { text: ' The verdict is safe, warn, or danger, with reasons. The signature still happens in MetaMask or Binance Wallet.' })] }),
          ],
        }),
      ],
    }),
    el('section', {
      class: 'split',
      children: [
        el('div', {
          class: 'panel',
          children: [
            el('h2', { text: 'Community registry' }),
            el('p', { text: 'Agent ID holders can file a report against an address. Reason codes are 1 drainer, 2 honeypot, 3 phishing approval or permit, 4 owner can mint or rug, and 5 other. A report is a statement by a holder. It is not proof that a contract is safe or unsafe.' }),
            routeLink('/report', 'File a report', 'button ghost'),
          ],
        }),
        el('div', {
          class: 'panel',
          children: [
            el('h2', { text: 'API' }),
            el('p', { text: 'POST /check with chainId, from, to, data, and value. GET /health returns { "ok": true }. GET /report/<address>?chainId= returns registry counts.' }),
            el('pre', { text: CURL }),
          ],
        }),
      ],
    }),
    el('section', {
      class: 'panel',
      children: [
        el('h2', { text: 'Contracts' }),
        el('p', { text: 'Testnet (chain 97) is live. Mainnet hub and registry are not deployed yet. Filling those two addresses later is a one-line change in web/src/config.ts.' }),
        contracts,
      ],
    }),
  )
  return () => {}
}

export function renderActivate(root: HTMLElement): () => void {
  return renderWalletPage(root, 'activate')
}

export function renderReport(root: HTMLElement): () => void {
  return renderWalletPage(root, 'report')
}

export function renderScanner(root: HTMLElement): () => void {
  const fields: ScannerFields = { chainId: 97, from: '', to: '', data: '0x', value: '0' }
  const chain = el('select') as HTMLSelectElement
  chain.append(option('97', 'BSC Testnet (97)'), option('56', 'BNB Smart Chain (56)'))
  const from = input({ value: fields.from, placeholder: '0x… simulated sender' })
  const to = input({ value: fields.to, placeholder: '0x… contract or recipient' })
  const value = input({ value: fields.value, placeholder: '0' })
  const data = input({ value: fields.data, placeholder: '0x' })
  const paste = input({ placeholder: 'Paste a contract or token address' })
  const output = el('div', { class: 'stack' })
  const error = el('p', { class: 'error' })
  const button = el('button', { class: 'button', text: 'Check', attrs: { type: 'button' } })

  const sync = () => {
    fields.chainId = chain.value === '56' ? 56 : 97
    fields.from = from.value
    fields.to = to.value
    fields.value = value.value
    fields.data = data.value
  }

  paste.addEventListener('change', () => {
    sync()
    const next = applyAddressPaste(fields, paste.value)
    if (!next) {
      error.className = 'error'
      error.textContent = 'That paste is not an address. Use the fields below, or paste a 20-byte hex address.'
      return
    }
    from.value = next.from
    to.value = next.to
    data.value = next.data
    value.value = next.value
    if (!fields.from.trim()) {
      error.className = 'muted'
      error.textContent = 'From was empty, so the form now shows a public example sender. It is not your wallet, and nothing is signed.'
    } else {
      error.className = 'error'
      error.textContent = ''
    }
  })

  button.addEventListener('click', () => {
    sync()
    error.textContent = ''
    error.className = 'error'
    output.replaceChildren(el('p', { class: 'muted', text: 'Checking…' }))
    button.disabled = true
    void runScan(fields)
      .then((nodes) => output.replaceChildren(...nodes))
      .catch((err: unknown) => {
        output.replaceChildren()
        error.textContent = err instanceof Error ? err.message : 'Check failed.'
      })
      .finally(() => {
        button.disabled = false
      })
  })

  root.append(
    el('section', {
      class: 'page-head',
      children: [
        el('h1', { text: 'Scanner' }),
        el('p', { text: 'POST a transaction to the live /check API, and read the community registry for the target address. This page does not connect a wallet and does not send a transaction.' }),
      ],
    }),
    el('form', {
      class: 'panel form',
      attrs: { action: '#' },
      children: [
        field('Chain', chain),
        field('From', from, 'Simulated sender. Custos does not sign as this address.'),
        field('To', to),
        field('Value', value, 'Decimal wei, or hex.'),
        field('Data', data),
        field('Or paste a contract / token', paste, 'Fills To. If From is empty, the example sender is shown in the form before you check.'),
        el('div', { class: 'row', children: [button] }),
        error,
      ],
    }),
    output,
  )

  const form = root.querySelector('form')
  form?.addEventListener('submit', (event) => {
    event.preventDefault()
    button.click()
  })
  return () => {}
}

export function renderMissing(root: HTMLElement): () => void {
  root.append(
    el('section', {
      class: 'page-head',
      children: [
        el('h1', { text: 'Page not found' }),
        routeLink('/', 'Back to the start', 'button'),
      ],
    }),
  )
  return () => {}
}

function renderWalletPage(root: HTMLElement, mode: 'activate' | 'report'): () => void {
  let selected: ChainId = 97
  const status = el('div', { class: 'stack' })
  const connectSlot = el('div', { class: 'row' })
  const txBox = el('div', { class: 'stack' })
  const connectError = el('p', { class: 'error' })
  let pending = false
  const target = input({ placeholder: '0x… address to report' })
  const reason = el('select') as HTMLSelectElement
  for (const item of REPORT_REASONS) reason.append(option(String(item.code), `${item.code} — ${item.name}`))
  const action = el('button', {
    class: 'button',
    text: mode === 'activate' ? 'Activate' : 'File report',
    attrs: { type: 'button' },
  })
  action.disabled = true

  const drawConnect = () => {
    connectSlot.replaceChildren()
    const found = discoveredProviders()
    const injected = browserWallet()
    if (found.length === 0 && !injected) {
      connectSlot.append(el('p', { text: 'No injected wallet was found. Install MetaMask or Binance Wallet in this browser, then reload. Custos does not show a QR code and does not ask for a seed phrase.' }))
      return
    }
    for (const item of found) {
      connectSlot.append(connectButton(item.info.name, item.provider, connectError, () => void paint()))
    }
    if (found.length === 0 && injected) {
      connectSlot.append(connectButton('Browser wallet', injected, connectError, () => void paint()))
    }
  }

  let paintGen = 0
  const paint = async () => {
    const gen = ++paintGen
    status.replaceChildren(el('p', { class: 'muted', text: 'Reading…' }))
    const view = await loadStatus(selected, (message) => {
      if (!pending) txBox.replaceChildren(el('p', { class: 'error', text: message }))
    })
    if (gen !== paintGen) return
    status.replaceChildren(...view.nodes)
    const session = walletState()
    const onNetwork = session.chainId === selected
    const mayActivate = view.holder && view.protectedWallet === false
    action.disabled = pending || !contractsReady(selected) || !session.account || !onNetwork || (mode === 'report' ? !view.holder : !mayActivate)
  }

  action.addEventListener('click', () => {
    const session = walletState()
    if (pending || !session.provider || !session.account || action.disabled) return
    const chainAtSend = selected
    pending = true
    action.disabled = true
    txBox.replaceChildren(el('p', { class: 'muted', text: 'Confirm the transaction in your wallet.' }))
    const run = mode === 'activate'
      ? activateWallet(session.provider, session.account, chainAtSend)
      : reportTarget(session.provider, session.account, chainAtSend, target.value, Number(reason.value) as ReportReason)
    void run
      .then((hash) => {
        txBox.replaceChildren(
          el('p', { text: 'Transaction submitted. You confirmed it in your wallet.' }),
          externalLink(bscscanTx(chainAtSend, hash), `View ${shortAddress(hash)} on BscScan`),
        )
      })
      .catch((err: unknown) => {
        txBox.replaceChildren(el('p', { class: 'error', text: chainError(err) }))
      })
      .finally(() => {
        pending = false
        void paint()
      })
  })

  const chainPicker = chainButtons(selected, (next) => {
    selected = next
    void paint()
  })

  root.append(
    el('section', {
      class: 'page-head',
      children: [
        el('h1', { text: mode === 'activate' ? 'Activate' : 'Report' }),
        el('p', {
          text: mode === 'activate'
            ? 'Connect the wallet you already use in this browser. Custos reads your Agent ID, shows whether the hub marks the wallet protected, and sends activate only when you press the button.'
            : 'Agent ID holders can file one community report. You confirm CustosRegistry.report in your wallet. Custos does not take a key.',
        }),
      ],
    }),
    el('section', {
      class: 'panel stack',
      children: [
        el('h2', { text: 'Wallet' }),
        el('p', { class: 'muted', text: 'Injected provider only, discovered with EIP-6963. No WalletConnect QR. No seed phrase.' }),
        connectSlot,
        connectError,
        chainPicker,
        status,
        ...(mode === 'report'
          ? [
              field('Address', target, 'The contract or account you are reporting.'),
              field('Reason', reason),
            ]
          : []),
        el('div', { class: 'row', children: [action] }),
        txBox,
      ],
    }),
  )

  drawConnect()
  void paint()
  const stopDiscovery = subscribeDiscovery(drawConnect)
  const stopWallet = subscribeWallet(() => { void paint() })
  return () => {
    stopDiscovery()
    stopWallet()
  }
}

interface StatusView {
  nodes: HTMLElement[]
  holder: boolean
  protectedWallet: boolean | null
}

async function loadStatus(chainId: ChainId, onError: (message: string) => void): Promise<StatusView> {
  const chain = CHAINS[chainId]
  const session = walletState()
  const nodes: HTMLElement[] = []
  const ready = contractsReady(chainId)
  if (!ready) {
    nodes.push(el('div', {
      class: 'callout',
      children: [el('p', { text: 'Coming soon. Mainnet hub and registry are not deployed yet, so activate and report stay off on BSC. Testnet is ready.' })],
    }))
  }
  if (!session.account || !session.provider) {
    nodes.push(el('p', { text: 'Connect your wallet to read Agent ID and protection.' }))
    return { nodes, holder: false, protectedWallet: null }
  }
  nodes.push(el('p', { children: [el('span', { class: 'muted', text: 'Account ' }), el('code', { text: session.account })] }))
  const onSelected = session.chainId === chainId
  nodes.push(el('p', {
    text: onSelected
      ? `Wallet network is ${chain.name}.`
      : `Wallet is on chain ${session.chainId ?? 'unknown'}. Switch to ${chain.name} before a transaction.`,
  }))
  if (!onSelected) {
    const button = el('button', { class: 'button ghost', text: `Switch to ${chain.short}`, attrs: { type: 'button' } })
    button.addEventListener('click', () => {
      const provider = walletState().provider
      if (!provider) return
      button.disabled = true
      void switchNetwork(provider, chainId)
        .catch((err: unknown) => onError(walletError(err)))
        .finally(() => { button.disabled = false })
    })
    nodes.push(button)
  }

  let holder = false
  let agent: AgentRead | null = null
  try {
    agent = await readAgent(chainId, session.account)
    holder = agent.holds
  } catch (err) {
    nodes.push(el('p', { class: 'error', text: `Could not read Agent ID. ${chainError(err)}` }))
  }
  if (agent) nodes.push(agentCallout(chainId, agent))

  let protectedWallet: boolean | null = null
  if (ready) {
    try {
      protectedWallet = await readProtected(chainId, session.account)
      const text = protectedWallet ? 'This wallet is protected. A later activate returns immediately.' : 'This wallet is not protected yet.'
      nodes.push(el('p', { text }))
    } catch (err) {
      nodes.push(el('p', { class: 'error', text: `Could not read isProtected. ${chainError(err)}` }))
    }
  }
  return { nodes, holder, protectedWallet }
}

function agentCallout(chainId: ChainId, agent: AgentRead): HTMLElement {
  const chain = CHAINS[chainId]
  const holder = el('div', { class: agent.holds ? 'callout safe' : 'callout warn' })
  if (!agent.holds) {
    holder.append(
      el('p', { text: 'You need an Agent ID before the first activate or report.' }),
      externalLink(AGENT_ID_URL, 'Get a Binance Agent ID'),
    )
    if (!chain.agentIdHasHandle) {
      holder.append(el('p', { text: 'On testnet the token is MockAgentID. It is not the soulbound .ai name. balanceOf has to be greater than zero, and this site will not mint it for you.' }))
    }
  } else if (agent.handle) {
    holder.append(el('p', { text: `${agent.handle}.ai` }), el('p', { class: 'muted', text: 'Agent ID handle from the mainnet registry.' }))
  } else if (!chain.agentIdHasHandle) {
    holder.append(el('p', { text: `Mock Agent ID balance ${agent.balance.toString()}.` }), el('p', { class: 'muted', text: 'Testnet mock. This is not a .ai handle.' }))
  } else {
    holder.append(el('p', { text: 'This wallet holds Agent ID.' }), el('p', { class: 'muted', text: 'handleOf did not return a name.' }))
  }
  return holder
}

function connectButton(
  name: string,
  provider: Eip1193Provider,
  error: HTMLElement,
  after: () => void,
): HTMLButtonElement {
  const button = el('button', { class: 'button', text: `Connect ${name}`, attrs: { type: 'button' } })
  button.addEventListener('click', () => {
    button.disabled = true
    error.textContent = ''
    void connectWallet(provider, name)
      .then(after)
      .catch((err: unknown) => {
        error.textContent = walletError(err)
      })
      .finally(() => { button.disabled = false })
  })
  return button
}

function chainButtons(initial: ChainId, onPick: (chainId: ChainId) => void): HTMLElement {
  const group = el('div', { class: 'row', attrs: { role: 'group', 'aria-label': 'Network' } })
  const buttons = ([56, 97] as const).map((chainId) => {
    const button = el('button', {
      class: chainId === initial ? 'button' : 'button ghost',
      text: CHAINS[chainId].short,
      attrs: { type: 'button' },
    })
    button.addEventListener('click', () => {
      for (const other of buttons) other.className = 'button ghost'
      button.className = 'button'
      onPick(chainId)
    })
    return button
  })
  group.append(...buttons)
  return group
}

async function runScan(fields: ScannerFields): Promise<HTMLElement[]> {
  const body = buildCheckRequest(fields)
  const [checked, reported] = await Promise.allSettled([postCheck(body), fetchReport(body.to, body.chainId)])
  const nodes: HTMLElement[] = []
  if (checked.status === 'fulfilled') nodes.push(renderCheck(checked.value))
  else nodes.push(el('p', { class: 'error', text: checked.reason instanceof Error ? checked.reason.message : 'Check failed.' }))
  if (reported.status === 'fulfilled') nodes.push(renderRegistry(reported.value))
  else nodes.push(el('p', { class: 'error', text: reported.reason instanceof Error ? reported.reason.message : 'Registry lookup failed.' }))
  return nodes
}

function renderCheck(result: CheckResponse): HTMLElement {
  const tone = result.verdict === 'safe' || result.verdict === 'warn' || result.verdict === 'danger' ? result.verdict : 'neutral'
  return el('article', {
    class: `panel verdict verdict-${tone}`,
    children: [
      el('p', { class: 'eyebrow', text: 'Verdict' }),
      el('h2', { text: result.verdict }),
      el('p', { class: 'meta', text: checkMeta(result) }),
      el('p', { text: result.explanation }),
      result.reasons.length
        ? el('ul', {
            class: 'reasons',
            children: result.reasons.map((reason) => el('li', {
              children: [
                el('span', { class: `pill ${severityClass(reason.severity)}`, text: severityClass(reason.severity) }),
                el('span', { text: reason.message }),
              ],
            })),
          })
        : el('p', { text: 'No reasons were returned.' }),
      ...(result.simulation.revertReason ? [el('p', { class: 'muted', text: `Revert text from the chain: ${result.simulation.revertReason}` })] : []),
    ],
  })
}

function checkMeta(result: CheckResponse): string {
  const completeness = result.complete === false ? 'incomplete' : result.complete === true ? 'complete' : ''
  const parts = [
    `Score ${result.score}`,
    `mode ${result.simulation.mode}`,
    result.simulation.success ? 'simulation succeeded' : 'simulation failed',
  ]
  if (completeness) parts.push(completeness)
  return parts.join(' · ')
}

function renderRegistry(report: ReportResponse): HTMLElement {
  const reasons = report.reasons
  const lines = [
    ['Drainer', reasons.drainer],
    ['Honeypot', reasons.honeypot],
    ['Phishing', reasons.phishing],
    ['Mint or rug', reasons.mintOrRug],
    ['Other', reasons.other],
  ]
  return el('article', {
    class: 'panel',
    children: [
      el('h2', { text: 'Registry' }),
      el('p', { text: report.configured ? `${report.reportCount} active report(s) on ${report.address}.` : (report.message ?? 'Registry is not configured on this chain.') }),
      el('ul', { class: 'reasons', children: lines.map(([name, count]) => el('li', { text: `${name}: ${count}` })) }),
    ],
  })
}

function contractList(): HTMLElement {
  const list = el('ul', { class: 'contracts' })
  const rows: Array<[string, ChainId, string | null]> = [
    ['Agent ID', 56, CHAINS[56].agentId],
    ['CustosHub', 56, CHAINS[56].hub],
    ['CustosRegistry', 56, CHAINS[56].registry],
    ['MockAgentID', 97, CHAINS[97].agentId],
    ['CustosHub', 97, CHAINS[97].hub],
    ['CustosRegistry', 97, CHAINS[97].registry],
  ]
  for (const [name, chainId, address] of rows) {
    const chain = CHAINS[chainId]
    if (!address) {
      list.append(el('li', { children: [el('strong', { text: `${name} · ${chain.short}` }), el('span', { text: 'Coming soon' })] }))
      continue
    }
    list.append(el('li', {
      children: [
        el('strong', { text: `${name} · ${chain.short}` }),
        el('code', { text: address }),
        externalLink(bscscanAddress(chainId, address), 'BscScan'),
        externalLink(sourcifyUrl(address), 'Sourcify'),
      ],
    }))
  }
  return list
}

function verdictCard(tone: string, title: string, body: string): HTMLElement {
  return el('article', { class: `panel verdict verdict-${tone}`, children: [el('h2', { text: title }), el('p', { text: body })] })
}

function option(value: string, text: string): HTMLOptionElement {
  return el('option', { text, attrs: { value } })
}
