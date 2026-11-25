import { describe, expect, it } from 'vitest'
import { parseTx, runCheck } from '../src/check'
import {
  fetchGoPlus,
  GOPLUS_CREDENTIAL_BACKOFF_SECONDS,
  GOPLUS_TOKEN_BACKOFF_SECONDS,
  GOPLUS_TOKEN_DEFAULT_TTL,
  GOPLUS_TOKEN_MAX_TTL,
  GOPLUS_TOKEN_SKEW_SECONDS,
  GOPLUS_TOKEN_URL,
  goplusTokenTtl,
  PROVIDER_USER_AGENT,
  providerDetail,
  signGoPlus,
} from '../src/goplus'
import { GOPLUS_EMPTY_TTL, GOPLUS_RECORD_TTL, GOPLUS_TIMEOUT_MS } from '../src/reputation'
import { handle } from '../src/index'
import { WALLET_SENTENCE } from '../src/messages'
import { clientKey } from '../src/ratelimit'
import { classifyRpcError, rpc, RpcError } from '../src/rpc'
import { withTimeout } from '../src/time'
import type { AppEnv } from '../src/types'

const USER = '0x0000000000000000000000000000000000000001'
const SPENDER = '0x0000000000000000000000000000000000000002'
const TOKEN = '0x0000000000000000000000000000000000000003'
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const APPROVAL_FOR_ALL_TOPIC = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31'
const NATIVE_LOG = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const MAX = (1n << 256n) - 1n

interface RpcRequest {
  method: string
  params: unknown[]
}

class MemoryCache {
  private store = new Map<string, string>()
  fail = false
  expirations = new Map<string, number | undefined>()

  async get(key: string): Promise<string | null> {
    if (this.fail) throw new Error('kv down')
    return this.store.get(key) ?? null
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    if (this.fail) throw new Error('kv down')
    this.store.set(key, value)
    this.expirations.set(key, options?.expirationTtl)
  }

  async delete(key: string): Promise<void> {
    if (this.fail) throw new Error('kv down')
    this.store.delete(key)
    this.expirations.delete(key)
  }
}

class MemoryLimit {
  private counts = new Map<string, number>()
  fail = false
  keys: string[] = []

  async limit(options: { key: string }): Promise<{ success: boolean }> {
    if (this.fail) throw new Error('limiter down')
    this.keys.push(options.key)
    const count = (this.counts.get(options.key) ?? 0) + 1
    this.counts.set(options.key, count)
    return { success: count <= 60 }
  }
}

function testEnv(
  extra: {
    TRACE_RPC_URL_97?: string
    TRACE_RPC_URL_56?: string
    RPC_URL_56?: string
    RPC_URL_97?: string
    LLM_API_KEY?: string
    ALLOW_DEV_ORIGINS?: string
    GOPLUS_APP_KEY?: string
    GOPLUS_APP_SECRET?: string
  } = {},
): AppEnv & { CACHE: MemoryCache; CHECK_LIMIT: MemoryLimit } {
  return {
    CACHE: new MemoryCache(),
    CHECK_LIMIT: new MemoryLimit(),
    LLM_BASE_URL: 'https://api.openai.com/v1',
    LLM_MODEL: 'gpt-4o-mini',
    RPC_URL_56: extra.RPC_URL_56 ?? 'https://rpc.test',
    RPC_URL_97: extra.RPC_URL_97 ?? 'https://rpc.test',
    TRACE_RPC_URL_56: extra.TRACE_RPC_URL_56,
    TRACE_RPC_URL_97: extra.TRACE_RPC_URL_97,
    LLM_API_KEY: extra.LLM_API_KEY,
    ALLOW_DEV_ORIGINS: extra.ALLOW_DEV_ORIGINS,
    GOPLUS_APP_KEY: extra.GOPLUS_APP_KEY,
    GOPLUS_APP_SECRET: extra.GOPLUS_APP_SECRET,
  }
}

function rpcOk(result: unknown): { jsonrpc: '2.0'; id: number; result: unknown } {
  return { jsonrpc: '2.0', id: 1, result }
}

function word(value: bigint): string {
  return '0x' + value.toString(16).padStart(64, '0')
}

function words(values: bigint[]): string {
  return '0x' + values.map((value) => value.toString(16).padStart(64, '0')).join('')
}

function encode(selector: string, values: bigint[]): string {
  return '0x' + selector + values.map((value) => value.toString(16).padStart(64, '0')).join('')
}

function errorString(text: string): string {
  const hex = [...text].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  return '0x08c379a0' + '20'.padStart(64, '0') + text.length.toString(16).padStart(64, '0') + hex.padEnd(64, '0')
}

function defaultRpc(body: RpcRequest): unknown {
  if (body.method === 'eth_estimateGas') return rpcOk('0x5208')
  if (body.method === 'eth_getCode') return rpcOk('0x6001')
  if (body.method === 'eth_call') {
    const data = String((body.params[0] as { data?: string } | undefined)?.data ?? '')
    if (data.startsWith('0xb3df5a4a')) return rpcOk(words([0n, 0n, 0n, 0n, 0n]))
    return rpcOk(word(0n))
  }
  if (body.method === 'debug_traceCall') {
    return { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'the method debug_traceCall does not exist' } }
  }
  throw new Error(`unexpected rpc method ${body.method}`)
}

interface FetchSpy extends Array<string> {
  restore: () => void
}

function installFetch(onRpc?: (body: RpcRequest) => unknown, onHttp?: (url: string, init?: RequestInit) => unknown): FetchSpy {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    if (url.startsWith('https://rpc.test') || url.startsWith('https://trace.test')) {
      const body = JSON.parse(String(init?.body)) as RpcRequest
      const custom = onRpc?.(body)
      return Response.json(custom === undefined ? defaultRpc(body) : custom)
    }
    const custom = await onHttp?.(url, init)
    if (custom instanceof Response) return custom
    if (custom !== undefined) return Response.json(custom)
    if (url.startsWith('https://api.gopluslabs.io/')) return Response.json({ code: 1, result: {} })
    if (url.startsWith('https://raw.githubusercontent.com/scamsniffer/')) return Response.json([])
    if (url.startsWith('https://api.honeypot.is/')) return Response.json({ honeypotResult: { isHoneypot: false }, simulationResult: { sellTax: 0 } })
    if (url.startsWith('https://api.openai.com/')) {
      return Response.json({ choices: [{ message: { content: `Verdict: safe. ${WALLET_SENTENCE}` } }] })
    }
    throw new Error(`unexpected url ${url}`)
  }
  return Object.assign(calls, { restore: () => { globalThis.fetch = original } })
}

function tx(data = '0x', chainId: 56 | 97 = 97, extra: Record<string, unknown> = {}) {
  return { chainId, from: USER, to: TOKEN, data, value: '0', ...extra }
}

async function post(env: AppEnv, body: unknown, headers?: HeadersInit): Promise<Response> {
  return handle(new Request('https://custos.test/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }), env)
}

describe('POST /check', () => {
  it('warns in call mode when no trace or simulate result exists', async () => {
    const calls = installFetch()
    try {
      const response = await post(testEnv(), tx())
      const body = await response.json() as CheckBody
      expect(response.status).toBe(200)
      expect(body.verdict).toBe('warn')
      expect(body.score).toBe(85)
      expect(body.simulation.mode).toBe('call')
      expect(body.simulation.success).toBe(true)
      expect(body.simulation.assetChanges).toEqual([])
      expect(body.reasons.map((reason) => reason.code)).toEqual(
        expect.arrayContaining(['trace_unavailable', 'unsupported_on_testnet']),
      )
      expect(body.explanation).toContain(WALLET_SENTENCE)
      expect(calls.some((url) => url.startsWith('https://trace.test'))).toBe(false)
      expect(calls.some((url) => url.startsWith('https://api.honeypot.is/'))).toBe(false)
      expect(calls.some((url) => url.startsWith('https://api.gopluslabs.io/'))).toBe(false)
      expect(calls.filter((url) => url.startsWith('https://rpc.test')).length).toBeGreaterThan(0)
    } finally {
      calls.restore()
    }
  })

  it('flags unlimited approve as danger when the plain RPC fails', async () => {
    const calls = installFetch(() => {
      throw new Error('rpc down')
    })
    try {
      const response = await post(testEnv(), tx(encode('095ea7b3', [BigInt(SPENDER), MAX])))
      const body = await response.json() as CheckBody
      expect(response.status).toBe(200)
      expect(body.verdict).toBe('danger')
      expect(body.score).toBe(30)
      expect(body.reasons.filter((reason) => reason.code === 'provider_failed').every((reason) => reason.severity === 'info')).toBe(true)
      expect(body.simulation.mode).toBe('call')
      expect(body.reasons.map((reason) => reason.code)).toContain('unlimited_approval')
      expect(body.reasons.map((reason) => reason.code)).toContain('provider_failed')
      expect(body.explanation).toContain('Verdict: danger.')
      expect(body.explanation).toContain(WALLET_SENTENCE)
    } finally {
      calls.restore()
    }
  })

  it('uses debug_traceCall when TRACE_RPC_URL answers', async () => {
    const calls = installFetch((body) => {
      if (body.method === 'eth_getCode') {
        const address = String(body.params[0]).toLowerCase()
        return rpcOk(address === SPENDER ? '0x' : '0x6001')
      }
      if (body.method !== 'debug_traceCall') return undefined
      return rpcOk({
        from: USER,
        to: TOKEN,
        value: '0x0',
        logs: [{
          address: TOKEN,
          topics: [APPROVAL_TOPIC, word(BigInt(USER)), word(BigInt(SPENDER))],
          data: word(MAX),
        }],
      })
    })
    try {
      const response = await post(testEnv({ TRACE_RPC_URL_97: 'https://trace.test' }), tx())
      const body = await response.json() as CheckBody
      expect(body.simulation.mode).toBe('trace')
      expect(body.verdict).toBe('danger')
      expect(body.simulation.approvals[0]?.unlimited).toBe(true)
      expect(body.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(['unlimited_approval', 'approval_to_eoa']))
      expect(calls.some((url) => url.startsWith('https://trace.test'))).toBe(true)
    } finally {
      calls.restore()
    }
  })

  it('falls back to eth_call when the trace provider errors', async () => {
    const methods: string[] = []
    const calls = installFetch((body) => {
      methods.push(body.method)
      return undefined
    })
    try {
      const response = await post(
        testEnv({ TRACE_RPC_URL_97: 'https://trace.test' }),
        tx(encode('095ea7b3', [BigInt(SPENDER), MAX])),
      )
      const body = await response.json() as CheckBody
      expect(body.simulation.mode).toBe('call')
      expect(body.simulation.success).toBe(true)
      expect(body.verdict).toBe('danger')
      expect(methods).toContain('debug_traceCall')
      expect(methods).toContain('eth_call')
      expect(methods).toContain('eth_estimateGas')
      expect(body.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(['trace_unavailable', 'unlimited_approval']))
      expect(body.reasons.map((reason) => reason.code)).not.toContain('unknown_calldata')
    } finally {
      calls.restore()
    }
  })

  it('decodes eth_simulateV1 logs when no trace RPC is configured', async () => {
    let params: unknown[] | undefined
    const calls = installFetch((body) => {
      if (body.method !== 'eth_simulateV1') return undefined
      params = body.params
      return rpcOk([
        {
          calls: [
            {
              status: '0x1',
              returnData: '0x',
              logs: [
                {
                  address: TOKEN,
                  topics: [TRANSFER_TOPIC, word(BigInt(USER)), word(BigInt(SPENDER))],
                  data: word(5n),
                },
                {
                  address: TOKEN,
                  topics: [APPROVAL_TOPIC, word(BigInt(USER)), word(BigInt(SPENDER))],
                  data: word(MAX),
                },
                {
                  address: TOKEN,
                  topics: [APPROVAL_FOR_ALL_TOPIC, word(BigInt(USER)), word(BigInt(SPENDER))],
                  data: word(1n),
                },
                {
                  address: NATIVE_LOG,
                  topics: [TRANSFER_TOPIC, word(BigInt(USER)), word(BigInt(SPENDER))],
                  data: word(1n),
                },
              ],
            },
          ],
        },
      ])
    })
    try {
      const response = await post(testEnv(), tx())
      const body = await response.json() as CheckBody
      const sent = params?.[0] as { blockStateCalls: { calls: { from: string }[] }[]; traceTransfers: boolean; validation: boolean }
      expect(sent.traceTransfers).toBe(true)
      expect(sent.validation).toBe(false)
      expect(sent.blockStateCalls[0]?.calls[0]?.from).toBe(USER)
      expect(params?.[1]).toBe('latest')
      expect(body.simulation.mode).toBe('simulate')
      expect(body.simulation.success).toBe(true)
      expect(body.simulation.assetChanges).toEqual([
        { asset: TOKEN, from: USER, to: SPENDER, amount: '5' },
        { asset: 'native', from: USER, to: SPENDER, amount: '1' },
      ])
      expect(body.simulation.approvals.map((approval) => approval.unlimited)).toEqual([true, true])
      expect(body.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(['unlimited_approval', 'approval_for_all']))
      expect(calls.some((url) => url.startsWith('https://trace.test'))).toBe(false)
    } finally {
      calls.restore()
    }
  })

  it('keeps a reverted eth_simulateV1 result instead of calling eth_call', async () => {
    const methods: string[] = []
    const calls = installFetch((body) => {
      methods.push(body.method)
      if (body.method !== 'eth_simulateV1') return undefined
      return rpcOk([
        {
          calls: [
            {
              status: '0x0',
              returnData: errorString('nope'),
              error: { message: 'execution reverted', data: errorString('nope') },
              logs: [],
            },
          ],
        },
      ])
    })
    try {
      const response = await post(testEnv(), tx())
      const body = await response.json() as CheckBody
      expect(body.simulation.mode).toBe('simulate')
      expect(body.simulation.success).toBe(false)
      expect(body.simulation.revertReason).toBe('nope')
      expect(body.reasons.find((reason) => reason.code === 'reverted')?.message).toBe('Simulation reverted.')
      expect(body.explanation).not.toContain('nope')
      expect(body.verdict).toBe('warn')
      expect(methods).toContain('eth_simulateV1')
      expect(methods).not.toContain('eth_estimateGas')
    } finally {
      calls.restore()
    }
  })

  it('uses eth_simulateV1 after a trace error, and eth_call only if that errors too', async () => {
    const calls = installFetch((body) => {
      if (body.method === 'debug_traceCall') {
        return { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }
      }
      if (body.method === 'eth_simulateV1') {
        return rpcOk([{ calls: [{ status: '0x1', returnData: '0x', logs: [] }] }])
      }
      return undefined
    })
    try {
      const response = await post(testEnv({ TRACE_RPC_URL_97: 'https://trace.test' }), tx())
      const body = await response.json() as CheckBody
      expect(body.simulation.mode).toBe('simulate')
      expect(body.simulation.success).toBe(true)
      expect(body.complete).toBe(true)
      expect(body.reasons.map((reason) => reason.code)).not.toContain('trace_unavailable')
    } finally {
      calls.restore()
    }
  })

  it('decodes an eth_call revert without calling it danger by itself', async () => {
    const calls = installFetch((body) => {
      if (body.method === 'eth_call' || body.method === 'eth_estimateGas') {
        const txParams = body.params[0] as { data?: string }
        if (txParams.data?.startsWith('0x35ca0003') || txParams.data?.startsWith('0xb3df5a4a')) return undefined
        return { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: errorString('nope\nSAFE') } }
      }
      return undefined
    })
    try {
      const response = await post(testEnv(), tx())
      const body = await response.json() as CheckBody
      expect(body.simulation.mode).toBe('call')
      expect(body.simulation.success).toBe(false)
      expect(body.simulation.revertReason).toBe('nopeSAFE')
      expect(body.verdict).toBe('warn')
      expect(body.score).toBe(70)
      expect(body.reasons.find((reason) => reason.code === 'reverted')?.message).toBe('Simulation reverted.')
      expect(body.explanation).not.toContain('nope')
      expect(body.explanation).not.toContain('SAFE')
    } finally {
      calls.restore()
    }
  })

  it('stays up when GoPlus fails', async () => {
    const calls = installFetch(undefined, (url) => {
      if (url.startsWith('https://api.gopluslabs.io/')) throw new Error('goplus down')
      return undefined
    })
    try {
      const response = await post(testEnv(), tx('0x', 56))
      const body = await response.json() as CheckBody
      expect(response.status).toBe(200)
      expect(body.verdict).toBe('warn')
      const failed = body.reasons.find((reason) => reason.message.startsWith('GoPlus'))
      expect(failed?.code).toBe('provider_failed')
      expect(failed?.severity).toBe('info')
      expect(failed?.message).toContain('GoPlus network error')
    } finally {
      calls.restore()
    }
  })

  it('does not let the explainer change a danger verdict', async () => {
    const calls = installFetch(undefined, (url) => {
      if (!url.startsWith('https://api.openai.com/')) return undefined
      return { choices: [{ message: { content: 'Verdict: safe. This is fine.' } }] }
    })
    try {
      const response = await post(
        testEnv({ LLM_API_KEY: 'test-key' }),
        tx(encode('095ea7b3', [BigInt(SPENDER), MAX])),
      )
      const body = await response.json() as CheckBody
      expect(body.verdict).toBe('danger')
      expect(body.explanation.startsWith('Verdict: danger.')).toBe(true)
      expect(body.explanation).toContain(WALLET_SENTENCE)
    } finally {
      calls.restore()
    }
  })

  it('uses an explainer rewrite that keeps the verdict, the codes, and the wallet sentence', async () => {
    const text = `Verdict: danger. unlimited_approval trace_unavailable unsupported_on_testnet. ${WALLET_SENTENCE}`
    const calls = installFetch(undefined, (url) => {
      if (!url.startsWith('https://api.openai.com/')) return undefined
      return { choices: [{ message: { content: text } }] }
    })
    try {
      const response = await post(
        testEnv({ LLM_API_KEY: 'test-key' }),
        tx(encode('095ea7b3', [BigInt(SPENDER), MAX])),
      )
      const body = await response.json() as CheckBody
      expect(body.verdict).toBe('danger')
      expect(body.explanation).toBe(text)
    } finally {
      calls.restore()
    }
  })

  it('rate limits the 61st check and still serves health', async () => {
    const calls = installFetch()
    try {
      const env = testEnv()
      let last = 0
      for (let i = 0; i < 61; i++) {
        last = (await post(env, tx(), { 'CF-Connecting-IP': '203.0.113.5' })).status
      }
      expect(last).toBe(429)
      const health = await handle(new Request('https://custos.test/health', {
        headers: { 'CF-Connecting-IP': '203.0.113.5' },
      }), env)
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ ok: true })
    } finally {
      calls.restore()
    }
  })

  it('rejects a body that contains a private key', async () => {
    const calls = installFetch()
    try {
      const response = await post(testEnv(), tx('0x', 97, { privateKey: '0xabc' }))
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('does not accept keys')
      expect(calls).toHaveLength(0)
    } finally {
      calls.restore()
    }
  })

  it('allows the Custos site and not other origins', async () => {
    const calls = installFetch()
    try {
      const env = testEnv()
      const allowed = await handle(new Request('https://custos.test/health', {
        headers: { Origin: 'https://custosprotocol.com' },
      }), env)
      expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://custosprotocol.com')
      const blocked = await handle(new Request('https://custos.test/health', {
        headers: { Origin: 'https://evil.com' },
      }), env)
      expect(blocked.headers.get('Access-Control-Allow-Origin')).toBeNull()
      const options = await handle(new Request('https://custos.test/check', {
        method: 'OPTIONS',
        headers: { Origin: 'https://www.custosprotocol.com' },
      }), env)
      expect(options.status).toBe(204)
      expect(options.headers.get('Access-Control-Allow-Origin')).toBe('https://www.custosprotocol.com')
      const localOff = await handle(new Request('https://custos.test/health', {
        headers: { Origin: 'http://localhost:5173' },
      }), env)
      expect(localOff.headers.get('Access-Control-Allow-Origin')).toBeNull()
      const dev = testEnv({ ALLOW_DEV_ORIGINS: '1' })
      const local = await handle(new Request('https://custos.test/health', {
        headers: { Origin: 'http://localhost:5173' },
      }), dev)
      expect(local.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
      const loopback = await handle(new Request('https://custos.test/health', {
        headers: { Origin: 'http://127.0.0.1:4173' },
      }), dev)
      expect(loopback.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:4173')
      const ipv6 = await handle(new Request('https://custos.test/health', {
        headers: { Origin: 'http://[::1]:5173' },
      }), dev)
      expect(ipv6.headers.get('Access-Control-Allow-Origin')).toBe('http://[::1]:5173')
    } finally {
      calls.restore()
    }
  })

  it('rejects an unknown chain', async () => {
    const response = await post(testEnv(), tx('0x', 97, { chainId: 1 }))
    expect(response.status).toBe(400)
  })

  it('serves health', async () => {
    const response = await handle(new Request('https://custos.test/health'), testEnv())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('reads registry counts', async () => {
    const calls = installFetch((body) => {
      if (body.method !== 'eth_call') return undefined
      const params = body.params[0] as { data: string }
      if (params.data.startsWith('0x35ca0003')) return rpcOk(word(2n))
      if (params.data.startsWith('0xb3df5a4a')) return rpcOk(words([1n, 0n, 0n, 0n, 0n]))
      return undefined
    })
    try {
      const response = await handle(new Request(`https://custos.test/report/${TOKEN}?chainId=97`), testEnv())
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        address: TOKEN,
        chainId: 97,
        configured: true,
        reportCount: '2',
        reasons: { drainer: '1', honeypot: '0', phishing: '0', mintOrRug: '0', other: '0' },
      })
    } finally {
      calls.restore()
    }
  })

  it('warns when the registry is not configured', async () => {
    const calls = installFetch((body) => {
      if (body.method === 'eth_call') {
        const params = body.params[0] as { data?: string }
        if (params.data?.startsWith('0x35ca0003') || params.data?.startsWith('0xb3df5a4a')) {
          throw new Error('registry called')
        }
      }
      return undefined
    })
    try {
      const response = await post(testEnv(), tx('0x', 56))
      const body = await response.json() as CheckBody
      expect(body.verdict).toBe('warn')
      expect(body.reasons.map((reason) => reason.code)).toContain('registry_unconfigured')
    } finally {
      calls.restore()
    }
  })

  it('returns a cached check without calling providers again', async () => {
    const calls = installFetch()
    try {
      const env = testEnv()
      await post(env, tx())
      const afterFirst = calls.length
      const second = await post(env, tx())
      expect(second.status).toBe(200)
      expect(calls.length).toBe(afterFirst)
    } finally {
      calls.restore()
    }
  })

  it('flags a honeypot token', async () => {
    const calls = installFetch(undefined, (url) => {
      if (!url.startsWith('https://api.honeypot.is/')) return undefined
      return { honeypotResult: { isHoneypot: true }, simulationResult: { sellTax: 99 } }
    })
    try {
      const response = await post(testEnv(), tx(encode('095ea7b3', [BigInt(SPENDER), 1n]), 56))
      const body = await response.json() as CheckBody
      expect(body.verdict).toBe('danger')
      expect(body.reasons.map((reason) => reason.code)).toContain('honeypot')
    } finally {
      calls.restore()
    }
  })

  it('flags a ScamSniffer hit', async () => {
    const calls = installFetch(undefined, (url) => {
      if (!url.startsWith('https://raw.githubusercontent.com/scamsniffer/')) return undefined
      return [TOKEN]
    })
    try {
      const response = await post(testEnv(), tx())
      const body = await response.json() as CheckBody
      expect(body.verdict).toBe('danger')
      expect(body.reasons.map((reason) => reason.code)).toContain('scam_blacklist')
    } finally {
      calls.restore()
    }
  })
})

describe('helpers', () => {
  it('times out a signal that nobody observes', async () => {
    await expect(withTimeout(() => new Promise(() => undefined), 20, 'slow')).rejects.toThrow('slow timed out')
  })

  it('keys IPv6 clients on the /64 prefix', () => {
    expect(clientKey('2001:db8:85a3::1')).toBe('v6:2001:0db8:85a3:0000')
    expect(clientKey('2001:db8:85a3:0:ffff:1:2:3')).toBe(clientKey('2001:db8:85a3::1'))
    expect(clientKey('2001:db8:85a3:1::1')).not.toBe(clientKey('2001:db8:85a3::1'))
    expect(clientKey('203.0.113.5')).toBe('v4:203.0.113.5')
  })

  it('rejects broadcast methods before any network call', async () => {
    const calls = installFetch()
    try {
      await expect(rpc('https://rpc.test', 'eth_sendRawTransaction', ['0x'])).rejects.toThrow(/not allowed/)
      expect(calls).toHaveLength(0)
      expect(classifyRpcError(new RpcError('insufficient funds for gas * price + value', undefined, -32000))).toBe('rejected')
      expect(classifyRpcError(new RpcError('execution reverted', errorString('nope'), 3))).toBe('revert')
    } finally {
      calls.restore()
    }
  })
})

describe('review regressions', () => {
  it('does not send a chain 97 check to the chain 56 RPC', async () => {
    const calls = installFetch()
    try {
      const response = await post(
        testEnv({ RPC_URL_56: 'https://mainnet.example', RPC_URL_97: 'https://rpc.test' }),
        tx(),
      )
      expect(response.status).toBe(200)
      expect(calls.some((url) => url.startsWith('https://mainnet.example'))).toBe(false)
      expect(calls.some((url) => url.startsWith('https://rpc.test'))).toBe(true)
    } finally {
      calls.restore()
    }
  })

  it('uses the public RPC for a chain whose URL is unset', async () => {
    const calls = installFetch()
    try {
      const env = testEnv()
      env.RPC_URL_97 = ''
      env.RPC_URL_56 = ''
      await post(env, tx())
      expect(calls.some((url) => url.startsWith('https://bsc-testnet.publicnode.com'))).toBe(true)
      expect(calls.some((url) => url.startsWith('https://bsc.publicnode.com'))).toBe(false)
    } finally {
      calls.restore()
    }
  })

  it('adds provider_failed when the RPC chain id does not match', async () => {
    const methods: string[] = []
    const calls = installFetch((body) => {
      methods.push(body.method)
      if (body.method === 'eth_chainId') return rpcOk('0x38')
      return undefined
    })
    try {
      const response = await post(testEnv(), tx())
      const body = await response.json() as CheckBody
      expect(body.reasons.map((reason) => reason.code)).toContain('provider_failed')
      expect(methods).toContain('eth_chainId')
      expect(methods).not.toContain('eth_simulateV1')
      expect(methods).not.toContain('eth_call')
    } finally {
      calls.restore()
    }
  })

  it('treats a short registry eth_call as a failure', async () => {
    const calls = installFetch((body) => {
      if (body.method === 'eth_call') return rpcOk('0x')
      return undefined
    })
    try {
      const report = await handle(new Request(`https://custos.test/report/${TOKEN}?chainId=97`), testEnv())
      expect(report.status).toBe(502)
      const response = await post(testEnv(), tx())
      const body = await response.json() as CheckBody
      expect(body.reasons.map((reason) => reason.code)).toContain('provider_failed')
      expect(body.reasons.map((reason) => reason.message).join(' ')).not.toContain('0 report')
    } finally {
      calls.restore()
    }
  })

  it('warns on unknown calldata and on value when call mode has no trace', async () => {
    const calls = installFetch()
    try {
      const unknown = await post(testEnv(), tx('0xdeadbeef'))
      const unknownBody = await unknown.json() as CheckBody
      expect(unknownBody.reasons.map((reason) => reason.code)).toEqual(
        expect.arrayContaining(['trace_unavailable', 'unknown_calldata']),
      )
      const valued = await post(testEnv(), tx('0x', 97, { value: 1 }))
      const valuedBody = await valued.json() as CheckBody
      expect(valued.status).toBe(200)
      expect(valuedBody.reasons.map((reason) => reason.code)).toContain('value_unsimulated')
      expect(valuedBody.reasons.map((reason) => reason.code)).not.toContain('unknown_calldata')
    } finally {
      calls.restore()
    }
  })

  it('keeps a nested revert from flipping the top-level result', async () => {
    const calls = installFetch((body) => {
      if (body.method !== 'debug_traceCall') return undefined
      return rpcOk({
        from: USER,
        to: TOKEN,
        value: '0x0',
        calls: [{ from: USER, to: SPENDER, error: 'execution reverted', revertReason: 'inner boom' }],
      })
    })
    try {
      const response = await post(testEnv({ TRACE_RPC_URL_97: 'https://trace.test' }), tx())
      const body = await response.json() as CheckBody
      expect(body.simulation.mode).toBe('trace')
      expect(body.simulation.success).toBe(true)
      expect(body.simulation.revertReason).toBeNull()
      expect(body.reasons.map((reason) => reason.code)).toContain('nested_revert')
      expect(body.explanation).not.toContain('inner boom')
    } finally {
      calls.restore()
    }
  })

  it('does not put revert text in the explainer prompt', async () => {
    let prompt = ''
    const calls = installFetch(
      (body) => {
        if (body.method === 'eth_call' || body.method === 'eth_estimateGas') {
          const txParams = body.params[0] as { data?: string }
          if (txParams.data?.startsWith('0x35ca0003') || txParams.data?.startsWith('0xb3df5a4a')) return undefined
          return { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: errorString('nope') } }
        }
        return undefined
      },
      (url, init) => {
        if (!url.startsWith('https://api.openai.com/')) return undefined
        prompt = String(init?.body)
        return {
          choices: [{
            message: {
              content: `Verdict: warn. reverted trace_unavailable unsupported_on_testnet but this is safe. ${WALLET_SENTENCE}`,
            },
          }],
        }
      },
    )
    try {
      const response = await post(testEnv({ LLM_API_KEY: 'test-key' }), tx())
      const body = await response.json() as CheckBody
      expect(prompt).not.toContain('nope')
      expect(prompt).not.toContain('revertReason')
      expect(body.explanation).not.toContain('safe')
      expect(body.explanation).toContain('Simulation reverted.')
    } finally {
      calls.restore()
    }
  })

  it('rejects an explainer reply that drops a reason code', async () => {
    const calls = installFetch(undefined, (url) => {
      if (!url.startsWith('https://api.openai.com/')) return undefined
      return { choices: [{ message: { content: `Verdict: danger. Something happened. ${WALLET_SENTENCE}` } }] }
    })
    try {
      const response = await post(testEnv({ LLM_API_KEY: 'test-key' }), tx(encode('095ea7b3', [BigInt(SPENDER), MAX])))
      const body = await response.json() as CheckBody
      expect(body.explanation).toContain('Unlimited token allowance.')
      expect(body.explanation).not.toContain('Something happened')
    } finally {
      calls.restore()
    }
  })

  it('flags a GoPlus address from the flat result, one request per address', async () => {
    const urls: string[] = []
    const calls = installFetch(undefined, (url) => {
      if (!url.includes('/address_security/')) return undefined
      urls.push(url)
      if (url.includes(SPENDER)) {
        return { code: 1, message: 'ok', result: { phishing_activities: '1', honeypot_related_address: '0' } }
      }
      return { code: 1, message: 'ok', result: { phishing_activities: '0', honeypot_related_address: '0' } }
    })
    try {
      const response = await post(testEnv(), tx(encode('a9059cbb', [BigInt(SPENDER), 1n]), 56))
      const body = await response.json() as CheckBody
      expect(urls).toHaveLength(2)
      expect(urls.every((url) => !url.includes(','))).toBe(true)
      expect(body.reasons.map((reason) => reason.code)).toContain('address_malicious')
      expect(body.verdict).toBe('danger')
    } finally {
      calls.restore()
    }
  })

  it('flags a transfer recipient that is on the scam list', async () => {
    const calls = installFetch(undefined, (url) => {
      if (!url.startsWith('https://raw.githubusercontent.com/scamsniffer/')) return undefined
      return [SPENDER]
    })
    try {
      const response = await post(testEnv(), tx(encode('a9059cbb', [BigInt(SPENDER), 1n])))
      const body = await response.json() as CheckBody
      expect(body.reasons.map((reason) => reason.code)).toContain('scam_blacklist')
    } finally {
      calls.restore()
    }
  })

  it('treats delegated code as an EOA and caches it briefly', async () => {
    const env = testEnv()
    const calls = installFetch((body) => {
      if (body.method === 'eth_getCode') return rpcOk('0xef0100' + SPENDER.slice(2))
      if (body.method !== 'eth_simulateV1') return undefined
      return rpcOk([{
        calls: [{
          status: '0x1',
          logs: [{
            address: TOKEN,
            topics: [APPROVAL_TOPIC, word(BigInt(USER)), word(BigInt(SPENDER))],
            data: word(5n),
          }],
        }],
      }])
    })
    try {
      const response = await post(env, tx())
      const body = await response.json() as CheckBody
      expect(body.reasons.map((reason) => reason.code)).toEqual(
        expect.arrayContaining(['eoa_delegated', 'approval_to_eoa', 'approval']),
      )
      const ttl = [...env.CACHE.expirations.entries()].find(([key]) => key.startsWith('code:'))?.[1]
      expect(ttl).toBe(600)
    } finally {
      calls.restore()
    }
  })

  it('adds a code-lookup failure when getCode returns nothing', async () => {
    const calls = installFetch((body) => {
      if (body.method === 'eth_getCode') throw new Error('code down')
      if (body.method !== 'eth_simulateV1') return undefined
      return rpcOk([{
        calls: [{
          status: '0x1',
          logs: [{
            address: TOKEN,
            topics: [APPROVAL_TOPIC, word(BigInt(USER)), word(BigInt(SPENDER))],
            data: word(5n),
          }],
        }],
      }])
    })
    try {
      const response = await post(testEnv(), tx())
      const body = await response.json() as CheckBody
      expect(body.reasons.find((reason) => reason.message.startsWith('Code lookup'))?.code).toBe('provider_failed')
    } finally {
      calls.restore()
    }
  })

  it('ignores approval logs that are not from the sender and caps code lookups', async () => {
    const methods: string[] = []
    const spenders = Array.from({ length: 9 }, (_, index) => '0x' + (index + 10).toString(16).padStart(40, '0'))
    const calls = installFetch((body) => {
      methods.push(body.method)
      if (body.method !== 'eth_simulateV1') return undefined
      return rpcOk([{
        calls: [{
          status: '0x1',
          logs: [
            {
              address: TOKEN,
              topics: [APPROVAL_TOPIC, word(BigInt(SPENDER)), word(BigInt(USER))],
              data: word(MAX),
            },
            ...spenders.map((spender) => ({
              address: TOKEN,
              topics: [APPROVAL_TOPIC, word(BigInt(USER)), word(BigInt(spender))],
              data: word(5n),
            })),
          ],
        }],
      }])
    })
    try {
      const response = await post(testEnv(), tx())
      const body = await response.json() as CheckBody
      expect(body.reasons.map((reason) => reason.code)).not.toContain('unlimited_approval')
      expect(body.reasons.filter((reason) => reason.code === 'approval')).toHaveLength(1)
      expect(methods.filter((method) => method === 'eth_getCode')).toHaveLength(8)
    } finally {
      calls.restore()
    }
  })

  it('does not refetch the scam list after a failed download', async () => {
    let downloads = 0
    const calls = installFetch(undefined, (url) => {
      if (!url.startsWith('https://raw.githubusercontent.com/scamsniffer/')) return undefined
      downloads += 1
      throw new TypeError('scam down')
    })
    try {
      const env = testEnv()
      const first = await post(env, tx())
      const second = await post(env, tx('0x', 97, { to: SPENDER }))
      expect(downloads).toBe(1)
      const firstBody = (await first.json()) as CheckBody
      const secondBody = (await second.json()) as CheckBody
      expect(firstBody.reasons.map((reason) => reason.code)).toContain('provider_failed')
      expect(secondBody.reasons.map((reason) => reason.code)).toContain('provider_failed')
      const cause = 'ScamSniffer network error'
      expect(firstBody.reasons.find((reason) => reason.message.startsWith('ScamSniffer'))?.message).toContain(cause)
      expect(secondBody.reasons.find((reason) => reason.message.startsWith('ScamSniffer'))?.message).toContain(cause)
    } finally {
      calls.restore()
    }
  })

  it('stays up when KV or the rate limiter throws', async () => {
    const calls = installFetch()
    try {
      const limited = testEnv()
      limited.CHECK_LIMIT.fail = true
      expect((await post(limited, tx())).status).toBe(200)
      const cached = testEnv()
      cached.CACHE.fail = true
      expect((await post(cached, tx())).status).toBe(200)
    } finally {
      calls.restore()
    }
  })

  it('caches a full GoPlus record for an hour', async () => {
    let addressCalls = 0
    let tokenCalls = 0
    const env = testEnv()
    const calls = installFetch(
      (body) => {
        if (body.method === 'eth_simulateV1') {
          return rpcOk([{ calls: [{ status: '0x1', returnData: '0x', logs: [] }] }])
        }
        return undefined
      },
      (url) => {
        if (url.includes('/address_security/')) {
          addressCalls += 1
          return { code: 1, result: { phishing_activities: '0' } }
        }
        if (url.includes('/token_security/')) {
          tokenCalls += 1
          return { code: 1, result: { [TOKEN]: { is_honeypot: '0', cannot_sell_all: '0' } } }
        }
        return undefined
      },
    )
    try {
      expect(GOPLUS_TIMEOUT_MS).toBe(8_000)
      expect(GOPLUS_RECORD_TTL).toBe(3_600)
      const approval = encode('095ea7b3', [BigInt(SPENDER), 1n])
      const first = await post(env, tx(approval, 56))
      const firstBody = await first.json() as CheckBody
      expect(first.status).toBe(200)
      expect(firstBody.complete).toBe(true)
      expect(firstBody.reasons.map((reason) => reason.code)).not.toContain('provider_failed')
      expect(firstBody.reasons.map((reason) => reason.code)).not.toContain('unknown_token')
      const cached = [...env.CACHE.expirations.entries()].filter(([key]) => key.startsWith('goplus:'))
      expect(cached.length).toBeGreaterThan(0)
      expect(cached.every(([, ttl]) => ttl === GOPLUS_RECORD_TTL)).toBe(true)
      const after = { addressCalls, tokenCalls }
      const second = await post(env, tx(approval, 56, { from: SPENDER }))
      expect(second.status).toBe(200)
      expect(addressCalls).toBe(after.addressCalls)
      expect(tokenCalls).toBe(after.tokenCalls)
    } finally {
      calls.restore()
    }
  })

  it('does not cache a failed GoPlus call', async () => {
    let hits = 0
    const env = testEnv()
    const calls = installFetch(undefined, (url) => {
      if (!url.includes('/address_security/')) return undefined
      hits += 1
      if (hits === 1) throw new Error('goplus slow')
      return { code: 1, result: {} }
    })
    try {
      await post(env, tx('0x', 56))
      expect([...env.CACHE.expirations.keys()].some((key) => key.startsWith('goplus:'))).toBe(false)
      await post(env, tx('0x', 56, { from: SPENDER }))
      expect(hits).toBe(2)
    } finally {
      calls.restore()
    }
  })

  it('retries the same check when GoPlus failed', async () => {
    let hits = 0
    const env = testEnv()
    const calls = installFetch(undefined, (url) => {
      if (!url.includes('/address_security/')) return undefined
      hits += 1
      throw new Error('goplus slow')
    })
    try {
      const first = await post(env, tx('0x', 56))
      const second = await post(env, tx('0x', 56))
      expect(hits).toBe(2)
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(((await first.json()) as CheckBody).reasons.map((reason) => reason.code)).toContain('provider_failed')
    } finally {
      calls.restore()
    }
  })

  it('warns when the target token has no GoPlus record and caches that for 90 seconds', async () => {
    const env = testEnv()
    const calls = installFetch(
      (body) => {
        if (body.method === 'eth_simulateV1') {
          return rpcOk([{ calls: [{ status: '0x1', returnData: '0x', logs: [] }] }])
        }
        return undefined
      },
      (url) => {
        if (url.includes('/token_security/')) return { code: 1, result: {} }
        if (url.includes('/address_security/')) return { code: 1, result: {} }
        return undefined
      },
    )
    try {
      const response = await post(env, tx(encode('095ea7b3', [BigInt(SPENDER), 1n]), 56))
      const body = await response.json() as CheckBody
      expect(body.reasons.map((reason) => reason.code)).toContain('unknown_token')
      expect(body.reasons.find((reason) => reason.code === 'unknown_token')?.severity).toBe('warn')
      expect(body.complete).toBe(true)
      expect(body.verdict).not.toBe('safe')
      const ttls = Object.fromEntries([...env.CACHE.expirations.entries()].filter(([key]) => key.startsWith('goplus:')))
      expect(Object.values(ttls).every((ttl) => ttl === GOPLUS_EMPTY_TTL)).toBe(true)
      expect(GOPLUS_EMPTY_TTL).toBe(90)
    } finally {
      calls.restore()
    }
  })

  it('caps an incomplete reputation check at warn', async () => {
    const calls = installFetch(
      (body) => {
        if (body.method === 'eth_simulateV1') {
          return rpcOk([{ calls: [{ status: '0x1', returnData: '0x', logs: [] }] }])
        }
        return undefined
      },
      (url) => {
        if (url.startsWith('https://raw.githubusercontent.com/scamsniffer/')) throw new TypeError('scam down')
        return undefined
      },
    )
    try {
      const response = await post(testEnv(), tx())
      const body = await response.json() as CheckBody
      const failed = body.reasons.find((reason) => reason.code === 'provider_failed')
      expect(failed?.severity).toBe('info')
      expect(body.simulation.mode).toBe('simulate')
      expect(body.complete).toBe(false)
      expect(body.verdict).toBe('warn')
      expect(body.score).toBe(85)
    } finally {
      calls.restore()
    }
  })

  it('rejects unknown body fields and still finishes a pre-aborted check', async () => {
    const calls = installFetch()
    try {
      const unknown = await post(testEnv(), tx('0x', 97, { foo: 1 }))
      expect(unknown.status).toBe(400)
      expect(await unknown.text()).toContain('Unknown field foo')
      const result = await runCheck(testEnv(), parseTx(tx()), AbortSignal.abort())
      expect(result.reasons.map((reason) => reason.code)).toEqual(
        expect.arrayContaining(['provider_failed', 'trace_unavailable']),
      )
    } finally {
      calls.restore()
    }
  })
})

const APP_KEY = 'mBOMg20QW11BbtyH4Zh0'
const APP_SECRET = 'V6aRfxlPJwN3ViJSIFSCdxPvneajuJsh'
const ACCESS_TOKEN = 'token-value-one.aaaa'
const ROTATED_TOKEN = 'token-value-two.bbbb'

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value
  }
  return undefined
}

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(APP_KEY)
  expect(text).not.toContain(APP_SECRET)
  expect(text).not.toContain(ACCESS_TOKEN)
  expect(text).not.toContain(ROTATED_TOKEN)
}

describe('GoPlus auth', () => {
  it('signs app_key, unix time, and app_secret with sha1', async () => {
    expect(await signGoPlus(APP_KEY, 1647847498, APP_SECRET)).toBe('7293d385b9225b3c3f232b76ba97255d0e21063e')
    expect(goplusTokenTtl(7200)).toBe(7200 - GOPLUS_TOKEN_SKEW_SECONDS)
    expect(goplusTokenTtl('7200')).toBe(7140)
    expect(goplusTokenTtl(120)).toBe(60)
    expect(goplusTokenTtl(119)).toBe(60)
    expect(goplusTokenTtl(undefined)).toBe(GOPLUS_TOKEN_DEFAULT_TTL)
    expect(goplusTokenTtl(9_999_999_999)).toBe(GOPLUS_TOKEN_MAX_TTL)
    expect(GOPLUS_TOKEN_SKEW_SECONDS).toBe(60)
    expect(providerDetail(new SyntaxError('bad json'), 'GoPlus')).toBe('GoPlus error')
    expect(providerDetail(new TypeError('fetch failed'), 'GoPlus')).toBe('GoPlus network error')
  })

  it('sends a User-Agent and skips the token call when secrets are absent', async () => {
    const agents: string[] = []
    const calls = installFetch(undefined, (url, init) => {
      if (
        url.startsWith('https://api.gopluslabs.io/') ||
        url.startsWith('https://api.honeypot.is/') ||
        url.startsWith('https://raw.githubusercontent.com/scamsniffer/')
      ) {
        agents.push(headerValue(init, 'User-Agent') ?? '')
        expect(headerValue(init, 'Authorization')).toBeUndefined()
      }
      return undefined
    })
    try {
      const response = await post(testEnv({ GOPLUS_APP_KEY: APP_KEY }), tx(encode('095ea7b3', [BigInt(SPENDER), 1n]), 56))
      expect(response.status).toBe(200)
      expect(calls.some((url) => url === GOPLUS_TOKEN_URL)).toBe(false)
      expect(agents.length).toBeGreaterThan(0)
      expect(agents.every((agent) => agent === PROVIDER_USER_AGENT)).toBe(true)
    } finally {
      calls.restore()
    }
  })

  it('caches the access token and attaches it to GoPlus requests', async () => {
    const env = testEnv({ GOPLUS_APP_KEY: `  ${APP_KEY}  `, GOPLUS_APP_SECRET: APP_SECRET })
    const authorizations: string[] = []
    let tokenPosts = 0
    const calls = installFetch(undefined, async (url, init) => {
      if (url === GOPLUS_TOKEN_URL) {
        tokenPosts += 1
        const body = JSON.parse(String(init?.body)) as { app_key?: string; time?: number; sign?: string }
        expect(body.app_key).toBe(APP_KEY)
        expect(typeof body.time).toBe('number')
        expect(body.sign).toBe(await signGoPlus(APP_KEY, body.time ?? 0, APP_SECRET))
        expect(init?.method).toBe('POST')
        expect(headerValue(init, 'User-Agent')).toBe(PROVIDER_USER_AGENT)
        return { code: 1, message: 'ok', result: { access_token: ACCESS_TOKEN, expires_in: 7200 } }
      }
      if (url.includes('/address_security/')) {
        authorizations.push(headerValue(init, 'Authorization') ?? '')
        return { code: 1, result: { phishing_activities: '0' } }
      }
      return undefined
    })
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '))
    }
    try {
      const first = await post(env, tx('0x', 56))
      const firstText = await first.text()
      expect(first.status).toBe(200)
      expect(JSON.parse(firstText).complete).toBe(true)
      expect(tokenPosts).toBe(1)
      expect(authorizations).toEqual([ACCESS_TOKEN])
      const ttl = [...env.CACHE.expirations.entries()].find(([key]) => key.startsWith('goplus:auth:'))?.[1]
      expect(ttl).toBe(7140)
      const second = await post(env, tx('0x', 56, { to: SPENDER }))
      const secondText = await second.text()
      expect(second.status).toBe(200)
      expect(tokenPosts).toBe(1)
      expect(authorizations).toEqual([ACCESS_TOKEN, ACCESS_TOKEN])
      expectNoSecrets(`${firstText}\n${secondText}\n${logs.join('\n')}`)
    } finally {
      console.log = original
      calls.restore()
    }
  })

  it('refreshes the token once after an auth error', async () => {
    let tokenPosts = 0
    let addressCalls = 0
    const authorizations: string[] = []
    const calls = installFetch(undefined, (url, init) => {
      if (url === GOPLUS_TOKEN_URL) {
        tokenPosts += 1
        const token = tokenPosts === 1 ? ACCESS_TOKEN : ROTATED_TOKEN
        return { code: 1, result: { access_token: token, expires_in: 7200 } }
      }
      if (url.includes('/address_security/')) {
        addressCalls += 1
        authorizations.push(headerValue(init, 'Authorization') ?? '')
        if (addressCalls === 1) return { code: 4022, message: 'invalid token' }
        return { code: 1, result: {} }
      }
      return undefined
    })
    try {
      const response = await post(testEnv({ GOPLUS_APP_KEY: APP_KEY, GOPLUS_APP_SECRET: APP_SECRET }), tx('0x', 56))
      const text = await response.text()
      const body = JSON.parse(text) as CheckBody
      expect(body.complete).toBe(true)
      expect(body.reasons.map((reason) => reason.code)).not.toContain('provider_failed')
      expect(tokenPosts).toBe(2)
      expect(addressCalls).toBe(2)
      expect(authorizations).toEqual([ACCESS_TOKEN, ROTATED_TOKEN])
      expectNoSecrets(text)
    } finally {
      calls.restore()
    }
  })

  it('puts the GoPlus and ScamSniffer failure cause on provider_failed', async () => {
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '))
    }
    const goplus = installFetch(undefined, (url) => {
      if (url === GOPLUS_TOKEN_URL) {
        return { code: 1, result: { access_token: ACCESS_TOKEN, expires_in: 7200 } }
      }
      if (url.includes('/address_security/')) {
        return new Response(JSON.stringify({ code: 4029, message: `${'y'.repeat(170)}${APP_SECRET}${ACCESS_TOKEN}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return undefined
    })
    try {
      const response = await post(
        testEnv({ GOPLUS_APP_KEY: APP_KEY, GOPLUS_APP_SECRET: APP_SECRET }),
        tx('0x', 56),
      )
      const text = await response.text()
      const body = JSON.parse(text) as CheckBody
      const failed = body.reasons.find((reason) => reason.message.startsWith('GoPlus'))
      expect(failed?.message).toContain('GoPlus code 4029')
      expect(body.complete).toBe(false)
      expectNoSecrets(text)
      const logged = logs.find((line) => line.includes('"code":"4029"')) ?? ''
      expect(logged).toContain('[redacted]')
      expectNoSecrets(logged)
      goplus.restore()

      const scam = installFetch(undefined, (url) => {
        if (url.startsWith('https://raw.githubusercontent.com/scamsniffer/')) return new Response('no', { status: 502 })
        return undefined
      })
      try {
        const scamResponse = await post(testEnv(), tx())
        const scamBody = await scamResponse.json() as CheckBody
        expect(scamBody.reasons.find((reason) => reason.message.startsWith('ScamSniffer'))?.message).toContain('ScamSniffer HTTP 502')
        expect(logs.some((line) => line.includes('"provider":"ScamSniffer"') && line.includes('"status":502'))).toBe(true)
      } finally {
        scam.restore()
      }
    } finally {
      console.log = original
      goplus.restore()
    }
  })

  it('falls back to an unauthenticated GoPlus call and remembers a token failure', async () => {
    const env = testEnv({ GOPLUS_APP_KEY: APP_KEY, GOPLUS_APP_SECRET: APP_SECRET })
    let tokenPosts = 0
    const authorizations: Array<string | undefined> = []
    const calls = installFetch(undefined, (url, init) => {
      if (url === GOPLUS_TOKEN_URL) {
        tokenPosts += 1
        return new Response('blocked', { status: 403 })
      }
      if (url.includes('/address_security/')) {
        authorizations.push(headerValue(init, 'Authorization'))
        return { code: 1, result: { phishing_activities: '0' } }
      }
      return undefined
    })
    try {
      const first = await post(env, tx('0x', 56))
      const firstBody = await first.json() as CheckBody
      expect(firstBody.complete).toBe(true)
      expect(firstBody.reasons.map((reason) => reason.code)).not.toContain('provider_failed')
      expect(tokenPosts).toBe(1)
      expect(authorizations).toEqual([undefined])
      const marker = [...env.CACHE.expirations.entries()].find(([key]) => key.startsWith('goplus:auth:') && key.endsWith(':fail'))
      expect(marker?.[1]).toBe(GOPLUS_TOKEN_BACKOFF_SECONDS)
      const second = await post(env, tx('0x', 56, { to: SPENDER }))
      const secondBody = await second.json() as CheckBody
      expect(secondBody.complete).toBe(true)
      expect(tokenPosts).toBe(1)
      expect(authorizations).toEqual([undefined, undefined])
    } finally {
      calls.restore()
    }
  })

  it('backs off longer when GoPlus rejects the app signature', async () => {
    const env = testEnv({ GOPLUS_APP_KEY: APP_KEY, GOPLUS_APP_SECRET: APP_SECRET })
    const calls = installFetch(undefined, (url) => {
      if (url === GOPLUS_TOKEN_URL) return { code: 4012, message: 'signature' }
      if (url.includes('/address_security/')) return { code: 1, result: {} }
      return undefined
    })
    try {
      const response = await post(env, tx('0x', 56))
      const body = await response.json() as CheckBody
      expect(body.complete).toBe(true)
      const marker = [...env.CACHE.expirations.entries()].find(([key]) => key.endsWith(':fail'))
      expect(marker?.[1]).toBe(GOPLUS_CREDENTIAL_BACKOFF_SECONDS)
    } finally {
      calls.restore()
    }
  })

  it('refreshes once on a data-call 4012 and keeps the new token when that call succeeds', async () => {
    const env = testEnv({ GOPLUS_APP_KEY: APP_KEY, GOPLUS_APP_SECRET: APP_SECRET })
    let tokenPosts = 0
    const authorizations: Array<string | undefined> = []
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '))
    }
    const calls = installFetch(undefined, (url, init) => {
      if (url === GOPLUS_TOKEN_URL) {
        tokenPosts += 1
        const token = tokenPosts === 1 ? ACCESS_TOKEN : ROTATED_TOKEN
        return { code: 1, result: { access_token: token, expires_in: 7200 } }
      }
      if (url.includes('/address_security/')) {
        const authorization = headerValue(init, 'Authorization')
        authorizations.push(authorization)
        if (authorization === ACCESS_TOKEN) return { code: 4012, message: 'signature verification failure' }
        return { code: 1, result: { phishing_activities: '0' } }
      }
      return undefined
    })
    try {
      const response = await post(env, tx('0x', 56))
      const text = await response.text()
      const body = JSON.parse(text) as CheckBody
      expect(body.complete).toBe(true)
      expect(body.reasons.map((reason) => reason.code)).not.toContain('provider_failed')
      expect(tokenPosts).toBe(2)
      expect(authorizations).toEqual([ACCESS_TOKEN, ROTATED_TOKEN])
      expect([...env.CACHE.expirations.keys()].some((key) => key.endsWith(':noauth') || key.endsWith(':fail'))).toBe(false)
      expectNoSecrets(`${text}\n${logs.join('\n')}`)
    } finally {
      console.log = original
      calls.restore()
    }
  })

  it('drops the header after a 4012 when refresh cannot replace the token, and remembers that for two minutes', async () => {
    const env = testEnv({ GOPLUS_APP_KEY: APP_KEY, GOPLUS_APP_SECRET: APP_SECRET })
    let tokenPosts = 0
    const authorizations: Array<string | undefined> = []
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '))
    }
    const calls = installFetch(undefined, (url, init) => {
      if (url === GOPLUS_TOKEN_URL) {
        tokenPosts += 1
        return { code: 1, result: { access_token: ACCESS_TOKEN, expires_in: 7200 } }
      }
      if (url.includes('/address_security/')) {
        const authorization = headerValue(init, 'Authorization')
        authorizations.push(authorization)
        if (authorization) return { code: 4012, message: 'signature verification failure' }
        return { code: 1, result: { phishing_activities: '0' } }
      }
      return undefined
    })
    try {
      const first = await post(env, tx('0x', 56))
      const firstText = await first.text()
      const firstBody = JSON.parse(firstText) as CheckBody
      expect(firstBody.complete).toBe(true)
      expect(tokenPosts).toBe(2)
      expect(authorizations).toEqual([ACCESS_TOKEN, undefined])
      const marker = [...env.CACHE.expirations.entries()].find(([key]) => key.endsWith(':noauth'))
      expect(marker?.[1]).toBe(GOPLUS_TOKEN_BACKOFF_SECONDS)
      expect([...env.CACHE.expirations.keys()].some((key) => key.startsWith('goplus:auth:') && !key.endsWith(':noauth'))).toBe(false)
      const second = await post(env, tx('0x', 56, { to: SPENDER }))
      const secondText = await second.text()
      expect(tokenPosts).toBe(2)
      expect(authorizations).toEqual([ACCESS_TOKEN, undefined, undefined])
      expectNoSecrets(`${firstText}\n${secondText}\n${logs.join('\n')}`)
    } finally {
      console.log = original
      calls.restore()
    }
  })

  it('stops after the headerless retry when that call still fails', async () => {
    const env = testEnv({ GOPLUS_APP_KEY: APP_KEY, GOPLUS_APP_SECRET: APP_SECRET })
    let dataCalls = 0
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '))
    }
    const calls = installFetch(undefined, (url, init) => {
      if (url === GOPLUS_TOKEN_URL) return { code: 1, result: { access_token: ACCESS_TOKEN, expires_in: 7200 } }
      if (!url.includes('/address_security/')) return undefined
      dataCalls += 1
      if (headerValue(init, 'Authorization')) return { code: 4012, message: 'signature verification failure' }
      return new Response('no', { status: 500 })
    })
    try {
      const response = await post(env, tx('0x', 56))
      const text = await response.text()
      const body = JSON.parse(text) as CheckBody
      expect(body.complete).toBe(false)
      expect(body.reasons.find((reason) => reason.message.startsWith('GoPlus'))?.message).toContain('GoPlus HTTP 500')
      expect(dataCalls).toBe(2)
      expect([...env.CACHE.expirations.keys()].some((key) => key.endsWith(':noauth'))).toBe(false)
      expectNoSecrets(`${text}\n${logs.join('\n')}`)
    } finally {
      console.log = original
      calls.restore()
    }
  })

  it('does not retry a 4012 when no GoPlus credentials are set', async () => {
    let dataCalls = 0
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '))
    }
    const calls = installFetch(undefined, (url) => {
      if (url === GOPLUS_TOKEN_URL) throw new Error('token endpoint')
      if (!url.includes('/address_security/')) return undefined
      dataCalls += 1
      return { code: 4012, message: 'signature verification failure' }
    })
    try {
      const response = await post(testEnv(), tx('0x', 56))
      const text = await response.text()
      const body = JSON.parse(text) as CheckBody
      expect(body.reasons.find((reason) => reason.message.startsWith('GoPlus'))?.message).toContain('GoPlus code 4012')
      expect(dataCalls).toBe(1)
      expect(calls.some((url) => url === GOPLUS_TOKEN_URL)).toBe(false)
      expectNoSecrets(`${text}\n${logs.join('\n')}`)
    } finally {
      console.log = original
      calls.restore()
    }
  })

  it('treats HTTP 401 with code 4012 as a data-call 4012, not a refresh-only 401', async () => {
    const env = testEnv({ GOPLUS_APP_KEY: APP_KEY, GOPLUS_APP_SECRET: APP_SECRET })
    let tokenPosts = 0
    const authorizations: Array<string | undefined> = []
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '))
    }
    const calls = installFetch(undefined, (url, init) => {
      if (url === GOPLUS_TOKEN_URL) {
        tokenPosts += 1
        const token = tokenPosts === 1 ? ACCESS_TOKEN : ROTATED_TOKEN
        return { code: 1, result: { access_token: token, expires_in: 7200 } }
      }
      if (!url.includes('/address_security/')) return undefined
      const authorization = headerValue(init, 'Authorization')
      authorizations.push(authorization)
      if (authorization) {
        return new Response(JSON.stringify({ code: 4012, message: 'signature verification failure' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }
      return { code: 1, result: { phishing_activities: '0' } }
    })
    try {
      const response = await post(env, tx('0x', 56))
      const text = await response.text()
      const body = JSON.parse(text) as CheckBody
      expect(body.complete).toBe(true)
      expect(tokenPosts).toBe(2)
      expect(authorizations).toEqual([ACCESS_TOKEN, ROTATED_TOKEN, undefined])
      expect(logs.some((line) => line.includes('"status":401') && line.includes('"code":"4012"'))).toBe(true)
      expectNoSecrets(`${text}\n${logs.join('\n')}`)
    } finally {
      console.log = original
      calls.restore()
    }
  })

  it('refreshes a token_security 4012 and retries that call with the new token', async () => {
    const env = testEnv({ GOPLUS_APP_KEY: APP_KEY, GOPLUS_APP_SECRET: APP_SECRET })
    const authorizations: Array<string | undefined> = []
    const logs: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '))
    }
    let tokenPosts = 0
    const calls = installFetch(undefined, (url, init) => {
      if (url === GOPLUS_TOKEN_URL) {
        tokenPosts += 1
        const token = tokenPosts === 1 ? ACCESS_TOKEN : ROTATED_TOKEN
        return { code: 1, result: { access_token: token, expires_in: 7200 } }
      }
      if (!url.includes('/token_security/')) return undefined
      const authorization = headerValue(init, 'Authorization')
      authorizations.push(authorization)
      if (authorization === ACCESS_TOKEN) return { code: 4012, message: 'signature verification failure' }
      return { code: 1, result: { [TOKEN]: { is_honeypot: '0', cannot_sell_all: '0' } } }
    })
    try {
      const approval = encode('095ea7b3', [BigInt(SPENDER), 1n])
      const response = await post(env, tx(approval, 56))
      const text = await response.text()
      const body = JSON.parse(text) as CheckBody
      expect(body.complete).toBe(true)
      expect(body.reasons.map((reason) => reason.code)).not.toContain('provider_failed')
      expect(authorizations).toEqual([ACCESS_TOKEN, ROTATED_TOKEN])
      expectNoSecrets(`${text}\n${logs.join('\n')}`)
    } finally {
      console.log = original
      calls.restore()
    }
  })

  it('does not refresh a token after a bare GoPlus 403', async () => {
    let tokenPosts = 0
    let addressCalls = 0
    const calls = installFetch(undefined, (url) => {
      if (url === GOPLUS_TOKEN_URL) {
        tokenPosts += 1
        return { code: 1, result: { access_token: ACCESS_TOKEN, expires_in: 7200 } }
      }
      if (url.includes('/address_security/')) {
        addressCalls += 1
        return new Response('blocked', { status: 403 })
      }
      return undefined
    })
    try {
      const response = await post(testEnv({ GOPLUS_APP_KEY: APP_KEY, GOPLUS_APP_SECRET: APP_SECRET }), tx('0x', 56))
      const body = await response.json() as CheckBody
      expect(body.reasons.find((reason) => reason.message.startsWith('GoPlus'))?.message).toContain('GoPlus HTTP 403')
      expect(tokenPosts).toBe(1)
      expect(addressCalls).toBe(1)
    } finally {
      calls.restore()
    }
  })

  it('caches a token that omits expires_in and reuses it', async () => {
    const env = testEnv({ GOPLUS_APP_KEY: APP_KEY, GOPLUS_APP_SECRET: APP_SECRET })
    let tokenPosts = 0
    const calls = installFetch(undefined, (url) => {
      if (url === GOPLUS_TOKEN_URL) {
        tokenPosts += 1
        return { code: 1, result: { access_token: ACCESS_TOKEN } }
      }
      if (url.includes('/address_security/')) return { code: 1, result: {} }
      return undefined
    })
    try {
      await post(env, tx('0x', 56))
      const ttl = [...env.CACHE.expirations.entries()].find(([key]) => key.startsWith('goplus:auth:') && !key.endsWith(':fail'))?.[1]
      expect(ttl).toBe(GOPLUS_TOKEN_DEFAULT_TTL)
      await post(env, tx('0x', 56, { to: SPENDER }))
      expect(tokenPosts).toBe(1)
    } finally {
      calls.restore()
    }
  })

  it('shares one refresh across concurrent auth failures and reuses the newer token', async () => {
    const env = testEnv({ GOPLUS_APP_KEY: APP_KEY, GOPLUS_APP_SECRET: APP_SECRET })
    let tokenPosts = 0
    let held = false
    let releaseLate: () => void = () => {}
    const late = new Promise<void>((resolve) => {
      releaseLate = resolve
    })
    const calls = installFetch(undefined, async (url, init) => {
      if (url === GOPLUS_TOKEN_URL) {
        tokenPosts += 1
        const token = tokenPosts === 1 ? ACCESS_TOKEN : ROTATED_TOKEN
        return { code: 1, result: { access_token: token, expires_in: 7200 } }
      }
      if (!url.includes('/address_security/')) return undefined
      if (headerValue(init, 'Authorization') !== ACCESS_TOKEN) return { code: 1, result: {} }
      if (!held) {
        held = true
        await late
      }
      return { code: 4022, message: 'invalid token' }
    })
    try {
      const first = fetchGoPlus(env, `https://api.gopluslabs.io/api/v1/address_security/${USER}?chain_id=56`)
      const second = fetchGoPlus(env, `https://api.gopluslabs.io/api/v1/address_security/${SPENDER}?chain_id=56`)
      const deadline = Date.now() + 1_000
      while (tokenPosts < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(tokenPosts).toBe(2)
      releaseLate()
      const [left, right] = await Promise.all([first, second])
      expect(left.code).toBe(1)
      expect(right.code).toBe(1)
      expect(tokenPosts).toBe(2)
    } finally {
      calls.restore()
    }
  })

  it('remembers a ScamSniffer timeout for the next check', async () => {
    const env = testEnv()
    let downloads = 0
    const calls = installFetch(undefined, (url) => {
      if (!url.startsWith('https://raw.githubusercontent.com/scamsniffer/')) return undefined
      downloads += 1
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    try {
      const first = await post(env, tx())
      const second = await post(env, tx('0x', 97, { to: SPENDER }))
      const firstBody = await first.json() as CheckBody
      const secondBody = await second.json() as CheckBody
      expect(downloads).toBe(1)
      expect(env.CACHE.expirations.get('scam:fail')).toBe(300)
      expect(firstBody.reasons.find((reason) => reason.message.startsWith('ScamSniffer'))?.message).toContain('ScamSniffer timeout')
      expect(secondBody.reasons.find((reason) => reason.message.startsWith('ScamSniffer'))?.message).toContain('ScamSniffer timeout')
    } finally {
      calls.restore()
    }
  })

  it('reports a GoPlus timeout when the security call times out', async () => {
    const timedOut = installFetch(undefined, (url) => {
      if (!url.includes('/address_security/')) return undefined
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    try {
      const response = await post(testEnv(), tx('0x', 56))
      const body = await response.json() as CheckBody
      expect(body.reasons.find((reason) => reason.message.startsWith('GoPlus'))?.message).toContain('GoPlus timeout')
    } finally {
      timedOut.restore()
    }
  })

  it('does not fetch a GoPlus token on chain 97', async () => {
    const calls = installFetch()
    try {
      const response = await post(testEnv({ GOPLUS_APP_KEY: APP_KEY, GOPLUS_APP_SECRET: APP_SECRET }), tx())
      expect(response.status).toBe(200)
      expect(calls.some((url) => url.includes('gopluslabs.io'))).toBe(false)
    } finally {
      calls.restore()
    }
  })
})

interface CheckBody {
  verdict: string
  score: number
  complete: boolean
  reasons: { code: string; severity: string; message: string }[]
  simulation: {
    mode: string
    success: boolean
    revertReason: string | null
    approvals: { unlimited: boolean }[]
    assetChanges: { asset: string; from: string; to: string; amount: string }[]
  }
  explanation: string
}
