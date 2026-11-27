import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { applyAddressPaste, buildCheckRequest, EXAMPLE_SENDER, parseCheckResponse, parseReportResponse, reportUrl, severityClass } from '../src/api'
import { validateReportTarget } from '../src/chain'
import { API_BASE, CHAINS, contractsReady } from '../src/config'
import { CHECK_CURL, CHECK_FETCH, MCP_CURSOR, MCP_REMOTE_URL, VERDICT_RULES } from '../src/snippets'
import { shouldAddChain, transactionCall } from '../src/wallet'

describe('addresses', () => {
  it('fills mainnet hub and registry and keeps testnet in its own roles', () => {
    expect(CHAINS[56].hub).toBe(getAddress('0xBC7e6AF6F97f2A9A56a1784D3E17d31361ed8945'))
    expect(CHAINS[56].registry).toBe(getAddress('0x062D0452187094C1B2dd546B6a793A50eBDBfd06'))
    expect(CHAINS[56].agentId).toBe(getAddress('0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F'))
    expect(CHAINS[56].agentIdHasHandle).toBe(true)
    expect(contractsReady(56)).toBe(true)

    expect(CHAINS[97].agentId).toBe(getAddress('0xBC7e6AF6F97f2A9A56a1784D3E17d31361ed8945'))
    expect(CHAINS[97].hub).toBe(getAddress('0x062D0452187094C1B2dd546B6a793A50eBDBfd06'))
    expect(CHAINS[97].registry).toBe(getAddress('0x14df99CEa96C8f0980cA0aF46CB5d30de782353A'))
    expect(CHAINS[97].agentIdHasHandle).toBe(false)
    expect(contractsReady(97)).toBe(true)

    expect(CHAINS[8453].hub).toBeNull()
    expect(CHAINS[8453].registry).toBeNull()
    expect(CHAINS[8453].agentId).toBeNull()
    expect(CHAINS[8453].native.symbol).toBe('ETH')
    expect(contractsReady(8453)).toBe(false)
  })
})

describe('check request', () => {
  it('posts only the five API fields', () => {
    const body = buildCheckRequest({
      chainId: 97,
      from: EXAMPLE_SENDER,
      to: CHAINS[97].hub ?? EXAMPLE_SENDER,
      data: '0x',
      value: '0',
    })
    expect(Object.keys(body)).toEqual(['chainId', 'from', 'to', 'data', 'value'])
    expect(body.chainId).toBe(97)
    expect(buildCheckRequest({ chainId: 8453, from: EXAMPLE_SENDER, to: EXAMPLE_SENDER, data: '0x', value: '0' }).chainId).toBe(8453)
  })

  it('fills a pasted token into to and shows the example sender', () => {
    const next = applyAddressPaste(
      { chainId: 56, from: '', to: '', data: '', value: '' },
      '0x062d0452187094c1b2dd546b6a793a50ebdbfd06',
    )
    expect(next).toEqual({
      chainId: 56,
      from: EXAMPLE_SENDER,
      to: getAddress('0x062D0452187094C1B2dd546B6a793A50eBDBfd06'),
      data: '0x',
      value: '0',
    })
  })

  it('builds the registry lookup URL', () => {
    const registry = CHAINS[97].registry
    expect(registry).toBeTruthy()
    expect(reportUrl(registry ?? '', 97)).toBe(
      `https://api.custosprotocol.com/report/${registry?.toLowerCase()}?chainId=97`,
    )
  })

  it('rejects the zero address', () => {
    expect(() => buildCheckRequest({
      chainId: 97,
      from: '0x0000000000000000000000000000000000000000',
      to: EXAMPLE_SENDER,
      data: '0x',
      value: '0',
    })).toThrow(/zero address/)
  })
})

describe('response shape', () => {
  it('rejects a check body that is missing the simulation', () => {
    expect(() => parseCheckResponse({ verdict: 'safe', score: 100, reasons: [], explanation: 'x' })).toThrow(/expected shape/)
  })

  it('keeps a well formed check and ignores a bad reason', () => {
    const parsed = parseCheckResponse({
      verdict: 'warn',
      score: 85,
      complete: false,
      explanation: 'Verdict: warn.',
      checkedAt: '2026-11-25T00:00:00.000Z',
      reasons: [{ code: 'provider_failed', severity: 'info', message: 'GoPlus did not answer.' }, { code: 1 }],
      simulation: { mode: 'simulate', success: true, revertReason: null },
    })
    expect(parsed.complete).toBe(false)
    expect(parsed.reasons).toHaveLength(1)
    expect(parsed.simulation.mode).toBe('simulate')
  })

  it('rejects a registry body without reason counts', () => {
    expect(() => parseReportResponse({ address: EXAMPLE_SENDER, chainId: 97, configured: true, reportCount: '0' })).toThrow(/expected shape/)
  })

  it('allowlists severity class names', () => {
    expect(severityClass('warn')).toBe('warn')
    expect(severityClass('danger')).toBe('danger')
    expect(severityClass('"><img>')).toBe('neutral')
  })
})

describe('site copy and chain marks', () => {
  it('does not attribute the site to a hackathon', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const files = walk(join(root, 'src')).concat(join(root, 'index.html'))
    const hits = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return text.toLowerCase().includes('hackathon') ? [file] : []
    })
    expect(hits).toEqual([])
  })

  it('points use cases and docs at the live check API', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const pages = readFileSync(join(root, 'src', 'pages.ts'), 'utf8')
    const main = readFileSync(join(root, 'src', 'main.ts'), 'utf8')
    expect(pages).toContain("text: 'Use cases'")
    expect(pages).toContain('renderDocs')
    expect(main).toContain("'/docs'")
    expect(CHECK_CURL).toContain(`${API_BASE}/check`)
    expect(CHECK_FETCH).toContain(`${API_BASE}/check`)
    expect(CHECK_CURL).toContain('"chainId":97')
    expect(MCP_CURSOR).toContain('npx')
    expect(MCP_CURSOR).toContain('["-y", "custosprotocol-mcp"]')
    expect(MCP_REMOTE_URL).toBe(`${API_BASE}/mcp`)
    expect(pages).toContain('Add to ChatGPT / Claude')
    expect(pages).toContain('developer mode')
    expect(pages).toContain('Add custom connector')
    expect(pages).toContain('Advanced settings')
    expect(pages).toContain('Admin settings')
    expect(pages).toContain('one custom connector')
    expect(VERDICT_RULES.map((rule) => rule.id)).toEqual(['block', 'warn', 'allow'])
    expect(VERDICT_RULES[0].text).toContain('Danger blocks even when complete is false.')
    expect(pages).toContain('Danger blocks even when complete is false.')
    expect(pages).not.toContain('hackathon')
  })

  it('blocks danger before an incomplete check is treated as warn', () => {
    const skill = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skill', 'custos', 'SKILL.md'), 'utf8')
    for (const source of [CHECK_FETCH, skill]) {
      expect(decide(source, { verdict: 'danger', complete: false })).toBe('block')
      expect(decide(source, { verdict: 'danger', complete: true })).toBe('block')
      expect(decide(source, { verdict: 'safe', complete: false })).toBe('warn')
      expect(decide(source, { verdict: 'warn', complete: true })).toBe('warn')
      expect(decide(source, { verdict: 'safe', complete: true })).toBe('allow')
    }
  })

  it('shows planned chains as coming-soon marks without adding them to CHAINS', () => {
    const pages = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages.ts'), 'utf8')
    expect(pages).toContain("text: 'Coming soon'")
    for (const name of ['Ethereum', 'Arbitrum', 'Solana', 'Monad']) expect(pages).toContain(`['${name}', [`)
    expect(pages).toContain("'aria-label': `${name} (coming soon)`")
    expect(Object.keys(CHAINS).map(Number).sort((a, b) => a - b)).toEqual([56, 97, 8453])
  })

  it('keeps the official BNB yellow and Base blue marks unchanged', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets')
    const bnb = readFileSync(join(root, 'bnb-chain.svg'), 'utf8')
    const base = readFileSync(join(root, 'base-square.svg'), 'utf8')
    expect(bnb).toContain('fill="#F0B90B"')
    expect(base).toContain('fill: blue')
    expect(base).not.toContain('#ff4d5e')
    expect(bnb).not.toContain('#ff4d5e')
  })
})

function decide(source: string, result: { verdict: string; complete: boolean }): string {
  const match = /const action = ([\s\S]*?);/.exec(source)
  if (!match?.[1]) throw new Error('snippet has no action')
  return new Function('result', `return (${match[1]});`)(result) as string
}

function walk(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) files.push(...walk(path))
    else if (/\.(ts|css|html|svg)$/.test(name)) files.push(path)
  }
  return files
}

describe('favicons and social image', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')

  it('serves the Custos mark from the site itself', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8')
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />')
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="any" />')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />')
    expect(html).toContain('<meta name="theme-color" content="#12030a" />')
    expect(html).toContain('property="og:title"')
    expect(html).toContain('property="og:description"')
    expect(html).toContain('content="https://custosprotocol.com/og.png"')
    expect(html).toContain('name="twitter:image" content="https://custosprotocol.com/og.png"')

    const svg = readFileSync(join(root, 'public', 'favicon.svg'), 'utf8')
    expect(svg).toContain('#ff4d5e')
    expect(svg).toContain('#ff9a5a')
    expect(svg).toContain('#1a060c')
    expect(svg).toContain('#fff6f4')

    const manifest = JSON.parse(readFileSync(join(root, 'public', 'site.webmanifest'), 'utf8')) as {
      name: string
      theme_color: string
    }
    expect(manifest.name).toBe('Custos')
    expect(manifest.theme_color).toBe('#12030a')
    expect(pngSize(join(root, 'public', 'apple-touch-icon.png'))).toEqual([180, 180])
    expect(pngSize(join(root, 'public', 'icon-192.png'))).toEqual([192, 192])
    expect(pngSize(join(root, 'public', 'icon-512.png'))).toEqual([512, 512])
    expect(pngSize(join(root, 'public', 'og.png'))).toEqual([1200, 630])

    const ico = readFileSync(join(root, 'public', 'favicon.ico'))
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(3)
    expect([ico[6], ico[22], ico[38]]).toEqual([16, 32, 48])

    const csp = readFileSync(join(root, 'public', '_headers'), 'utf8')
    expect(csp).toContain("img-src 'self'")
    expect(csp).not.toMatch(/manifest-src[^;]*https?:/)
  })
})

function pngSize(path: string): [number, number] {
  const data = readFileSync(path)
  expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return [data.readUInt32BE(16), data.readUInt32BE(20)]
}

describe('wallet guards', () => {
  it('rejects the zero address before a report is built', () => {
    expect(() => validateReportTarget('0x0000000000000000000000000000000000000000')).toThrow(/zero address/)
    expect(validateReportTarget(EXAMPLE_SENDER)).toBe(getAddress(EXAMPLE_SENDER))
  })

  it('puts the chain id on the transaction the wallet confirms', () => {
    const call = transactionCall(getAddress(EXAMPLE_SENDER), getAddress(EXAMPLE_SENDER), '0x', 97)
    expect(call.chainId).toBe('0x61')
    expect(call.value).toBe('0x0')
    expect(transactionCall(getAddress(EXAMPLE_SENDER), getAddress(EXAMPLE_SENDER), '0x', 56).chainId).toBe('0x38')
    expect(transactionCall(getAddress(EXAMPLE_SENDER), getAddress(EXAMPLE_SENDER), '0x', 8453).chainId).toBe('0x2105')
  })

  it('treats a nested 4902 as an unknown chain', () => {
    expect(shouldAddChain({ code: 4902 })).toBe(true)
    expect(shouldAddChain({ code: -32603, data: { originalError: { code: 4902 } } })).toBe(true)
    expect(shouldAddChain({ code: 4001 })).toBe(false)
  })
})
