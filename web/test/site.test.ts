import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { applyAddressPaste, buildCheckRequest, EXAMPLE_SENDER, parseCheckResponse, parseReportResponse, reportUrl, severityClass } from '../src/api'
import { validateReportTarget } from '../src/chain'
import { API_BASE, CHAINS, contractsReady } from '../src/config'
import { CHECK_CURL, CHECK_FETCH, MCP_CURSOR, VERDICT_RULES } from '../src/snippets'
import { shouldAddChain, transactionCall } from '../src/wallet'

describe('addresses', () => {
  it('leaves mainnet hub and registry empty and keeps testnet filled', () => {
    expect(CHAINS[56].hub).toBeNull()
    expect(CHAINS[56].registry).toBeNull()
    expect(CHAINS[56].agentId).toBe(getAddress('0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F'))
    expect(CHAINS[56].agentIdHasHandle).toBe(true)
    expect(contractsReady(56)).toBe(false)

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
    expect(MCP_CURSOR).toContain('custos-mcp')
    expect(VERDICT_RULES.map((rule) => rule.id)).toEqual(['block', 'warn', 'allow'])
    expect(pages).not.toContain('hackathon')
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

function walk(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) files.push(...walk(path))
    else if (/\.(ts|css|html|svg)$/.test(name)) files.push(path)
  }
  return files
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
