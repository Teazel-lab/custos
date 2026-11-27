import { describe, expect, it } from 'vitest'
import { handle } from '../src/index'
import type { AppEnv } from '../src/types'

const FROM = '0x0000000000000000000000000000000000000001'
const TO = '0x0000000000000000000000000000000000000002'

function env(limit?: { success: boolean }): AppEnv {
  return {
    CACHE: {
      async get() { return null },
      async put() {},
      async delete() {},
    },
    CHECK_LIMIT: {
      async limit() { return { success: limit?.success !== false } },
    },
    LLM_BASE_URL: 'https://api.openai.com/v1',
    LLM_MODEL: 'gpt-4o-mini',
    RPC_URL_56: 'https://rpc56.test',
    RPC_URL_97: 'https://rpc97.test',
    RPC_URL_8453: 'https://rpc8453.test',
  }
}

function rpcOk(result: unknown) {
  return { jsonrpc: '2.0', id: 1, result }
}

function word(value: bigint): string {
  return '0x' + value.toString(16).padStart(64, '0')
}

function installFetch(): { restore: () => void } {
  const original = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('https://rpc56.test') || url.startsWith('https://rpc97.test') || url.startsWith('https://rpc8453.test')) {
      const body = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] }
      if (body.method === 'eth_chainId') {
        const chain = url.startsWith('https://rpc56.test') ? '0x38' : url.startsWith('https://rpc8453.test') ? '0x2105' : '0x61'
        return Response.json(rpcOk(chain))
      }
      if (body.method === 'eth_getCode') return Response.json(rpcOk('0x'))
      if (body.method === 'eth_estimateGas') return Response.json(rpcOk('0x5208'))
      if (body.method === 'eth_simulateV1') {
        return Response.json(rpcOk([{ calls: [{ status: '0x1', returnData: '0x', logs: [] }] }]))
      }
      if (body.method === 'eth_call') {
        const data = String((body.params?.[0] as { data?: string } | undefined)?.data ?? '')
        if (data.startsWith('0xb3df5a4a')) return Response.json(rpcOk('0x' + '0'.repeat(64 * 5)))
        return Response.json(rpcOk(word(0n)))
      }
      throw new Error(`unexpected rpc ${body.method}`)
    }
    if (url.startsWith('https://raw.githubusercontent.com/scamsniffer/')) return Response.json([])
    if (url.startsWith('https://api.gopluslabs.io/')) return Response.json({ code: 1, result: {} })
    if (url.startsWith('https://api.honeypot.is/')) {
      return Response.json({ honeypotResult: { isHoneypot: false }, simulationResult: { sellTax: 0, buyTax: 0 } })
    }
    throw new Error(`unexpected url ${url}`)
  }
  return { restore: () => { globalThis.fetch = original } }
}

function post(method: string, params: unknown, id: number | string = 1, headers?: HeadersInit): Request {
  return new Request('https://custos.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
}

describe('hosted MCP', () => {
  it('negotiates initialize and lists the two tools', async () => {
    const response = await handle(post('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'curl', version: '0' },
    }), env())
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { protocolVersion: string; serverInfo: { name: string }; instructions: string } }
    expect(body.result.protocolVersion).toBe('2025-03-26')
    expect(body.result.serverInfo.name).toBe('custosprotocol-mcp')
    expect(body.result.instructions).toContain('Danger blocks even when complete is false')

    const listed = await handle(post('tools/list', {}), env())
    const tools = (await listed.json() as { result: { tools: { name: string; description: string }[] } }).result.tools
    expect(tools.map((tool) => tool.name)).toEqual(['custos_check', 'custos_report'])
    expect(tools[0]?.description).toContain('Danger blocks even when complete is false')
    expect(tools[1]?.description).toContain('not a substitute for custos_check')
  })

  it('falls back when the client asks for an older protocol it still speaks', async () => {
    const response = await handle(post('initialize', { protocolVersion: '2024-11-05', capabilities: {} }), env())
    const body = await response.json() as { result: { protocolVersion: string } }
    expect(body.result.protocolVersion).toBe('2024-11-05')
    const unknown = await handle(post('initialize', { protocolVersion: '1999-01-01', capabilities: {} }), env())
    const negotiated = await unknown.json() as { result: { protocolVersion: string } }
    expect(negotiated.result.protocolVersion).toBe('2025-03-26')
  })

  it('answers ping, ignores the initialized notification, and rejects an unknown method', async () => {
    const ping = await handle(post('ping', {}), env())
    expect(await ping.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    const note = await handle(new Request('https://custos.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }), env())
    expect(note.status).toBe(202)
    expect(await note.text()).toBe('')
    const missing = await handle(post('prompts/list', {}), env())
    const body = await missing.json() as { error: { code: number } }
    expect(body.error.code).toBe(-32601)
  })

  it('calls custos_check through the worker, not a loopback HTTP request', async () => {
    const calls = installFetch()
    try {
      const response = await handle(post('tools/call', {
        name: 'custos_check',
        arguments: { chainId: 97, from: FROM, to: TO, data: '0x', value: '0' },
      }), env())
      expect(response.status).toBe(200)
      const body = await response.json() as { result: { isError?: boolean; structuredContent: { verdict: string; complete: boolean; providers: { registry: string } } } }
      expect(body.result.isError).toBeUndefined()
      expect(body.result.structuredContent.verdict).toBe('safe')
      expect(typeof body.result.structuredContent.complete).toBe('boolean')
      expect(body.result.structuredContent.providers.registry).toBe('answered')
    } finally {
      calls.restore()
    }
  })

  it('calls custos_report for a mainnet address', async () => {
    const calls = installFetch()
    try {
      const response = await handle(post('tools/call', {
        name: 'custos_report',
        arguments: { address: TO, chainId: 56 },
      }), env())
      const body = await response.json() as { result: { structuredContent: { chainId: number; configured: boolean; reportCount: string } } }
      expect(body.result.structuredContent).toMatchObject({ chainId: 56, configured: true, reportCount: '0' })
    } finally {
      calls.restore()
    }
  })

  it('rejects a key, a bad chain, and an unknown tool without signing anything', async () => {
    const calls = installFetch()
    try {
      const secret = await handle(post('tools/call', {
        name: 'custos_check',
        arguments: { chainId: 56, from: FROM, to: TO, data: '0x', value: '0', privateKey: '0xsecret' },
      }), env())
      const secretBody = await secret.json() as { result: { isError: boolean; content: { text: string }[] } }
      expect(secretBody.result.isError).toBe(true)
      expect(secretBody.result.content[0]?.text).toContain('does not accept keys')
      const bad = await handle(post('tools/call', {
        name: 'custos_check',
        arguments: { chainId: 1, from: FROM, to: TO, data: '0x', value: '0' },
      }), env())
      const badBody = await bad.json() as { result: { isError: boolean; content: { text: string }[] } }
      expect(badBody.result.isError).toBe(true)
      expect(badBody.result.content[0]?.text).toContain('chainId')
      const unknown = await handle(post('tools/call', { name: 'custos_sign', arguments: {} }), env())
      const unknownBody = await unknown.json() as { error: { code: number } }
      expect(unknownBody.error.code).toBe(-32602)
    } finally {
      calls.restore()
    }
  })

  it('refuses GET and DELETE because there is no session stream', async () => {
    const get = await handle(new Request('https://custos.test/mcp'), env())
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    const del = await handle(new Request('https://custos.test/mcp', { method: 'DELETE' }), env())
    expect(del.status).toBe(405)
  })

  it('allows ChatGPT and Claude preflight and not an unrelated origin', async () => {
    for (const origin of ['https://chatgpt.com', 'https://claude.ai']) {
      const response = await handle(new Request('https://custos.test/mcp', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Headers': 'content-type, mcp-protocol-version' },
      }), env())
      expect(response.status).toBe(204)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
      expect(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('mcp-protocol-version')
    }
    const blocked = await handle(new Request('https://custos.test/mcp', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    }), env())
    expect(blocked.headers.get('Access-Control-Allow-Origin')).toBeNull()
    const site = await handle(new Request('https://custos.test/health', {
      headers: { Origin: 'https://chatgpt.com' },
    }), env())
    expect(site.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('rejects an unsupported protocol header', async () => {
    const response = await handle(post('ping', {}, 1, { 'MCP-Protocol-Version': '1999-01-01' }), env())
    expect(response.status).toBe(400)
    const body = await response.json() as { error: { code: number } }
    expect(body.error.code).toBe(-32600)
  })
})
