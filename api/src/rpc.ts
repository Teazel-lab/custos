import { decodeRevertData } from './abi'
import { cacheGet, cachePut } from './cache'
import type { AppEnv, ChainId } from './types'

const PUBLIC_RPC: Record<ChainId, string> = {
  56: 'https://bsc.publicnode.com',
  97: 'https://bsc-testnet.publicnode.com',
}

const ALLOWED = new Set([
  'debug_traceCall',
  'eth_simulateV1',
  'eth_call',
  'eth_estimateGas',
  'eth_getCode',
  'eth_chainId',
])

const CODE_TTL = 600
const CHAIN_TTL = 3_600

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

/** Plain JSON-RPC for this chain only. A chain 56 URL is never used for chain 97. */
export function plainRpc(env: AppEnv, chainId: ChainId): string {
  const configured = (chainId === 56 ? env.RPC_URL_56 : env.RPC_URL_97)?.trim()
  if (configured) return configured
  return PUBLIC_RPC[chainId]
}

/** Trace endpoint for this chain only. Unset means the trace tier is skipped. */
export function traceRpc(env: AppEnv, chainId: ChainId): string | undefined {
  const configured = (chainId === 56 ? env.TRACE_RPC_URL_56 : env.TRACE_RPC_URL_97)?.trim()
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

/**
 * Confirms the endpoint's eth_chainId once per URL. A transport failure does not
 * block the check. A returned id that is not `chainId` does.
 * The cache key is a hash of the URL so the key itself is not stored.
 */
export async function rpcMatchesChain(
  env: AppEnv,
  chainId: ChainId,
  url: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw new Error('aborted')
  const key = `rpc-chain:${await sha256(url)}`
  const hit = await cacheGet(env.CACHE, key)
  if (hit === String(chainId)) return true
  if (hit !== null) return false
  try {
    const result = await rpc(url, 'eth_chainId', [], signal)
    if (typeof result !== 'string') return true
    const got = Number(BigInt(result))
    if (!Number.isFinite(got)) return true
    await cachePut(env.CACHE, key, String(got), CHAIN_TTL)
    return got === chainId
  } catch (err) {
    if (signal?.aborted) throw err
    return true
  }
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

/** Revert text is untrusted. Strip controls and cap it. Callers must not put it in reasons. */
export function sanitizeRevert(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120)
  return cleaned.length > 0 ? cleaned : null
}

export function revertReasonOf(err: unknown): string | null {
  if (err instanceof RpcError) {
    const decoded = decodeRevertData(err.data)
    if (decoded) return sanitizeRevert(decoded)
    const message = err.message.replace(/^execution reverted:?\s*/i, '').trim()
    return sanitizeRevert(message || 'execution reverted')
  }
  return sanitizeRevert('execution reverted')
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
  const hit = await cacheGet(env.CACHE, key)
  if (hit !== null) return hit
  try {
    const url = plainRpc(env, chainId)
    if (!(await rpcMatchesChain(env, chainId, url, signal))) return null
    const code = await rpc(url, 'eth_getCode', [address, 'latest'], signal)
    if (typeof code !== 'string') return null
    await cachePut(env.CACHE, key, code, CODE_TTL)
    return code
  } catch (err) {
    if (signal?.aborted) throw err
    return null
  }
}

export type CodeKind = 'eoa' | 'delegated' | 'contract' | 'unknown'

/** `0xef0100` is an EIP-7702 delegation designator. That account is still an EOA. */
export function codeKind(code: string | null): CodeKind {
  if (code === null) return 'unknown'
  const normalized = code.toLowerCase()
  if (normalized === '0x' || normalized === '0x0') return 'eoa'
  if (normalized.startsWith('0xef0100')) return 'delegated'
  return 'contract'
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
