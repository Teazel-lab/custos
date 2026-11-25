import { decodeRevertData } from './abi'
import type { AppEnv, ChainId } from './types'

const PUBLIC_RPC: Record<ChainId, string> = {
  56: 'https://bsc.publicnode.com',
  97: 'https://bsc-testnet.publicnode.com',
}

const ALLOWED = new Set(['debug_traceCall', 'eth_simulateV1', 'eth_call', 'eth_estimateGas', 'eth_getCode'])

export class RpcError extends Error {
  readonly data: unknown
  readonly code: number | undefined

  constructor(message: string, data: unknown, code?: number) {
    super(message)
    this.name = 'RpcError'
    this.data = data
    this.code = code
  }
}

export type RpcFailure = 'revert' | 'rejected' | 'transport'

/** Plain JSON-RPC. `RPC_URL` wins; otherwise a public endpoint for `chainId`. */
export function plainRpc(env: AppEnv, chainId: ChainId): string {
  const configured = env.RPC_URL?.trim()
  if (configured) return configured
  return PUBLIC_RPC[chainId]
}

/**
 * Trace endpoint. The host is whatever `TRACE_RPC_URL` is set to
 * (Alchemy, NodeReal, QuickNode, or anything else). Unset means no trace.
 */
export function traceRpc(env: AppEnv): string | undefined {
  const configured = env.TRACE_RPC_URL?.trim()
  return configured || undefined
}

export function txCall(tx: { from: string; to: string; data: string; value: bigint }): {
  from: string
  to: string
  data: string
  value: string
} {
  return {
    from: tx.from,
    to: tx.to,
    data: tx.data,
    value: '0x' + tx.value.toString(16),
  }
}

export async function rpc(
  url: string,
  method: string,
  params: unknown[],
  signal?: AbortSignal,
): Promise<unknown> {
  if (!ALLOWED.has(method)) throw new Error(`rpc method not allowed: ${method}`)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  })
  if (!response.ok) throw new Error(`rpc http ${response.status}`)
  const json = (await response.json()) as {
    result?: unknown
    error?: { code?: number; message?: string; data?: unknown }
  }
  if (json.error) {
    throw new RpcError(json.error.message ?? 'rpc error', json.error.data, json.error.code)
  }
  return json.result
}

export function classifyRpcError(err: unknown): RpcFailure {
  if (!(err instanceof RpcError)) return 'transport'
  const message = err.message.toLowerCase()
  if (
    message.includes('insufficient funds') ||
    message.includes('exceeds allowance') ||
    message.includes('intrinsic gas')
  ) {
    return 'rejected'
  }
  if (
    err.code === 3 ||
    message.includes('revert') ||
    (typeof err.data === 'string' && err.data.startsWith('0x') && err.data.length > 2)
  ) {
    return 'revert'
  }
  return 'transport'
}

export function revertReasonOf(err: unknown): string {
  if (err instanceof RpcError) {
    const decoded = decodeRevertData(err.data)
    if (decoded) return decoded
    const message = err.message.replace(/^execution reverted:?\s*/i, '').trim()
    return message || 'execution reverted'
  }
  return 'execution reverted'
}

export interface Probe {
  reverted: boolean
  reason: string | null
  failed: boolean
}

export async function probe(
  url: string,
  method: 'eth_call' | 'eth_estimateGas',
  params: unknown[],
  signal?: AbortSignal,
): Promise<Probe> {
  try {
    await rpc(url, method, params, signal)
    return { reverted: false, reason: null, failed: false }
  } catch (err) {
    const kind = classifyRpcError(err)
    if (kind === 'revert') return { reverted: true, reason: revertReasonOf(err), failed: false }
    if (kind === 'rejected') return { reverted: false, reason: null, failed: false }
    return { reverted: false, reason: null, failed: true }
  }
}

export async function getCode(
  env: AppEnv,
  chainId: ChainId,
  address: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const key = `code:${chainId}:${address}`
  const hit = await env.CACHE.get(key)
  if (hit !== null) return hit
  try {
    const code = await rpc(plainRpc(env, chainId), 'eth_getCode', [address, 'latest'], signal)
    if (typeof code !== 'string') return null
    await env.CACHE.put(key, code, { expirationTtl: 86_400 })
    return code
  } catch {
    return null
  }
}

/** `true` when the address has no code, `false` when it does, `null` if the lookup failed. */
export function codeIsEoa(code: string | null): boolean | null {
  if (code === null) return null
  return code === '0x' || code === '0x0'
}
