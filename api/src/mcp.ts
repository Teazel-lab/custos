import { secretField } from './auth'
import { parseTx, runCheck } from './check'
import { HttpError, json, readLimitedBody } from './http'
import { WALLET_SENTENCE } from './messages'
import { allowRequest } from './ratelimit'
import { reportFor } from './registry'
import type { AppEnv, ChainId, CheckResponse } from './types'

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
const PROTOCOL_VERSION = '2025-03-26'
const SERVER_INFO = { name: 'custosprotocol-mcp', version: '1.0.0' }

const CHECK_DESCRIPTION =
  'Check a transaction before it is signed on BNB Smart Chain (56), BSC testnet (97), or Base (8453). ' +
  'Send only chainId, from, to, data, and value. Do not send a private key, seed phrase, or keystore. ' +
  'Custos does not sign or broadcast. Returns verdict, complete, reasons, providers, and explanation. ' +
  'Danger blocks even when complete is false: do not sign, and tell the owner. ' +
  'warn, or complete false when the verdict is not danger: stop and ask the owner to confirm. ' +
  'safe with complete true: the owner may confirm it in their own wallet. Do not skip that confirmation. ' +
  'A provider_failed reason does not by itself mean the check is incomplete. ' +
  'If this tool errors, do not sign.'

const REPORT_DESCRIPTION =
  'Read Custos community-report counts for an address from GET /report/:address. ' +
  'chainId is 56, 97, or 8453 and defaults to 97. Base has no registry. ' +
  'A report is a statement by an Agent ID holder, not proof that an address is safe or unsafe. ' +
  'This does not send a transaction and is not a substitute for custos_check.'

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}

const ADDRESS = '^0x[0-9a-fA-F]{40}$'
const HEX_DATA = '^0x(?:[0-9a-fA-F]{2})*$'
const VALUE = '^(?:0x[0-9a-fA-F]+|\\d+)$'

const TOOLS = [
  {
    name: 'custos_check',
    title: 'Check a transaction',
    description: CHECK_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        chainId: { type: 'number', enum: [56, 97, 8453], description: '56 BSC, 97 BSC testnet, or 8453 Base.' },
        from: { type: 'string', pattern: ADDRESS, description: 'Simulated sender. Not a private key.' },
        to: { type: 'string', pattern: ADDRESS, description: 'Transaction target.' },
        data: { type: 'string', pattern: HEX_DATA, description: 'Calldata, or 0x when empty.' },
        value: {
          anyOf: [
            { type: 'string', pattern: VALUE },
            { type: 'integer', minimum: 0 },
          ],
          description: 'Native value in wei, as a decimal string, hex string, or a safe integer.',
        },
      },
      required: ['chainId', 'from', 'to', 'data', 'value'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'custos_report',
    title: 'Look up community reports',
    description: REPORT_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', pattern: ADDRESS, description: 'Address to look up in the Custos registry.' },
        chainId: { type: 'number', enum: [56, 97, 8453], description: '56, 97, or 8453. Defaults to 97, matching the API.' },
      },
      required: ['address'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
]

export async function handleMcp(request: Request, env: AppEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), {
      status: 405,
      headers: { allow: 'POST', 'content-type': 'application/json; charset=utf-8' },
    })
  }
  if (!(await allowRequest(env.CHECK_LIMIT, request))) return json({ error: 'Rate limit exceeded.' }, 429)
  const protocol = request.headers.get('MCP-Protocol-Version')
  if (protocol && !supported(protocol)) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Unsupported protocol version.' } }, 400)
  }
  if (!accepts(request)) return json({ error: 'Accept must include application/json or text/event-stream.' }, 406)
  const contentType = request.headers.get('Content-Type')
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    return json({ error: 'Content-Type must be application/json.' }, 415)
  }
  let body: unknown
  try {
    const text = await readLimitedBody(request)
    body = text ? JSON.parse(text) : null
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    return rpcError(null, -32700, 'Parse error.', 400)
  }
  if (Array.isArray(body)) return rpcError(null, -32600, 'Batching is not supported.', 400)
  if (!body || typeof body !== 'object') return rpcError(null, -32600, 'Invalid request.', 400)
  const message = body as Record<string, unknown>
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(idOf(message.id), -32600, 'Invalid request.')
  if (message.method.startsWith('notifications/')) return new Response(null, { status: 202 })
  if (!hasId(message.id)) return rpcError(null, -32600, 'Invalid request.')
  const sse = wantsSse(request)
  try {
    const result = await dispatch(env, message.method, message.params)
    return rpcResult(message.id, result, sse)
  } catch (err) {
    if (err instanceof RpcFailure) return rpcError(message.id, err.code, err.message, 200, sse)
    console.error(JSON.stringify({ error: 'mcp' }))
    return rpcError(message.id, -32603, 'Check failed.', 200, sse)
  }
}

async function dispatch(env: AppEnv, method: string, params: unknown): Promise<unknown> {
  if (method === 'initialize') return initialize(params)
  if (method === 'ping') return {}
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'tools/call') return callTool(env, params)
  throw new RpcFailure(-32601, 'Method not found.')
}

function initialize(params: unknown): unknown {
  const record = objectParams(params)
  const requested = record.protocolVersion
  if (typeof requested !== 'string' || requested.length === 0) throw new RpcFailure(-32602, 'protocolVersion is required.')
  return {
    protocolVersion: negotiate(requested),
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions:
      'Custos checks a transaction before it is signed. Danger blocks even when complete is false. ' +
      'Warn, or complete false when the verdict is not danger, means stop and ask the owner. ' +
      'Safe with complete true still needs the owner\'s wallet confirmation. ' +
      `Never send a key or a seed. ${WALLET_SENTENCE}`,
  }
}

async function callTool(env: AppEnv, params: unknown): Promise<unknown> {
  const record = objectParams(params)
  const name = record.name
  if (name !== 'custos_check' && name !== 'custos_report') throw new RpcFailure(-32602, 'Unknown tool.')
  const args = record.arguments === undefined ? {} : record.arguments
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RpcFailure(-32602, 'arguments must be an object.')
  if (secretField(args)) {
    return toolError(`This API does not accept keys or seeds. ${WALLET_SENTENCE}`)
  }
  try {
    const value = name === 'custos_check' ? await checkTool(env, args) : await reportTool(env, args)
    return {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
    }
  } catch (err) {
    if (err instanceof RpcFailure) throw err
    const message = err instanceof HttpError ? err.message : err instanceof Error ? err.message : 'Check failed.'
    return toolError(message)
  }
}

async function checkTool(env: AppEnv, args: object): Promise<unknown> {
  const tx = parseTx(args)
  const result = await runCheck(env, tx)
  return checkView(result)
}

async function reportTool(env: AppEnv, args: object): Promise<unknown> {
  const record = args as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'address' && key !== 'chainId') throw new HttpError(400, `Unknown field ${key}.`)
  }
  if (typeof record.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(record.address)) {
    throw new HttpError(400, 'Address must be a 20-byte hex string.')
  }
  return reportFor(env, chainOf(record.chainId), record.address.toLowerCase())
}

function checkView(result: CheckResponse): unknown {
  return {
    verdict: result.verdict,
    complete: result.complete,
    reasons: result.reasons,
    providers: result.providers,
    explanation: result.explanation,
  }
}

function chainOf(value: unknown): ChainId {
  if (value === undefined) return 97
  if (value === 56 || value === 97 || value === 8453) return value
  throw new HttpError(400, 'chainId must be 56, 97, or 8453.')
}

function toolError(message: string): unknown {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function objectParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new RpcFailure(-32602, 'Invalid params.')
  return params as Record<string, unknown>
}

function negotiate(requested: string): string {
  return supported(requested) ? requested : PROTOCOL_VERSION
}

function supported(version: string): boolean {
  return (PROTOCOL_VERSIONS as readonly string[]).includes(version)
}

function accepts(request: Request): boolean {
  const accept = request.headers.get('Accept')
  if (!accept) return true
  const value = accept.toLowerCase()
  return value.includes('application/json') || value.includes('text/event-stream') || value.includes('*/*')
}

function wantsSse(request: Request): boolean {
  const accept = request.headers.get('Accept')?.toLowerCase() ?? ''
  return accept.includes('text/event-stream') && !accept.includes('application/json') && !accept.includes('*/*')
}

function hasId(id: unknown): boolean {
  return typeof id === 'string' || typeof id === 'number'
}

function idOf(id: unknown): string | number | null {
  return hasId(id) ? id as string | number : null
}

class RpcFailure extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'RpcFailure'
    this.code = code
  }
}

function rpcResult(id: unknown, result: unknown, sse: boolean): Response {
  return rpcResponse({ jsonrpc: '2.0', id, result }, 200, sse)
}

function rpcError(id: unknown, code: number, message: string, status = 200, sse = false): Response {
  return rpcResponse({ jsonrpc: '2.0', id, error: { code, message } }, status, sse)
}

function rpcResponse(body: unknown, status: number, sse: boolean): Response {
  if (!sse) return json(body, status)
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    status,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}
