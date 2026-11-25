import { decodeWords, padAddress } from './abi'
import { providerReason } from './messages'
import { plainRpc, rpc } from './rpc'
import type { AppEnv, ChainId, Reason } from './types'

/** Chain 97 is the live testnet registry. Chain 56 stays empty until mainnet. */
export const REGISTRIES: Record<ChainId, string | null> = {
  56: null,
  97: '0x14df99cea96c8f0980ca0af46cb5d30de782353a',
}

const REPORT_COUNT = '0x35ca0003'
const REASONS_OF = '0xb3df5a4a'
const REASON_NAMES = ['drainer', 'honeypot', 'phishing', 'mintOrRug', 'other'] as const

export interface ReasonCounts {
  drainer: string
  honeypot: string
  phishing: string
  mintOrRug: string
  other: string
}

export interface RegistryView {
  configured: boolean
  reportCount: bigint
  reasons: bigint[]
}

export interface ReportResponse {
  address: string
  chainId: ChainId
  configured: boolean
  reportCount: string
  reasons: ReasonCounts
  message?: string
}

export async function registrySignal(env: AppEnv, chainId: ChainId, addresses: string[]): Promise<Reason[]> {
  if (!REGISTRIES[chainId]) {
    return [
      {
        code: 'registry_unconfigured',
        severity: 'warn',
        message: 'Custos registry is not configured for this chain yet.',
      },
    ]
  }
  const reasons: Reason[] = []
  let failed = false
  await Promise.all(
    addresses.map(async (address) => {
      try {
        const view = await readRegistry(env, chainId, address)
        if (!view.configured || view.reportCount === 0n) return
        reasons.push(reportReason(address, view))
      } catch {
        failed = true
      }
    }),
  )
  if (failed) reasons.push(providerReason('Registry'))
  return reasons
}

export async function reportFor(env: AppEnv, chainId: ChainId, address: string): Promise<ReportResponse> {
  const view = await readRegistry(env, chainId, address)
  const response: ReportResponse = {
    address,
    chainId,
    configured: view.configured,
    reportCount: view.reportCount.toString(),
    reasons: named(view.reasons),
  }
  if (!view.configured) response.message = 'Custos registry is not deployed on this chain yet.'
  return response
}

export async function readRegistry(env: AppEnv, chainId: ChainId, address: string): Promise<RegistryView> {
  const registry = REGISTRIES[chainId]
  if (!registry) return { configured: false, reportCount: 0n, reasons: [0n, 0n, 0n, 0n, 0n] }
  const key = `reg:${chainId}:${address}`
  const hit = await env.CACHE.get(key)
  if (hit !== null) return decodeStored(JSON.parse(hit) as StoredRegistry)
  const signal = AbortSignal.timeout(4_000)
  const url = plainRpc(env, chainId)
  const padded = padAddress(address)
  const [countHex, reasonsHex] = await Promise.all([
    rpc(url, 'eth_call', [{ to: registry, data: REPORT_COUNT + padded }, 'latest'], signal),
    rpc(url, 'eth_call', [{ to: registry, data: REASONS_OF + padded }, 'latest'], signal),
  ])
  if (typeof countHex !== 'string' || typeof reasonsHex !== 'string') throw new Error('registry shape')
  const reasons = decodeWords(reasonsHex).slice(0, 5)
  while (reasons.length < 5) reasons.push(0n)
  const stored: StoredRegistry = {
    configured: true,
    reportCount: hexBig(countHex).toString(),
    reasons: reasons.map((count) => count.toString()),
  }
  await env.CACHE.put(key, JSON.stringify(stored), { expirationTtl: 300 })
  return decodeStored(stored)
}

function reportReason(address: string, view: RegistryView): Reason {
  const parts = REASON_NAMES.flatMap((name, index) => {
    const count = view.reasons[index] ?? 0n
    return count > 0n ? [`${name} ${count}`] : []
  })
  return {
    code: 'registry_reports',
    severity: view.reportCount >= 5n ? 'danger' : 'warn',
    message: `Custos registry has ${view.reportCount} report(s) on ${address}: ${parts.join(', ') || 'unspecified'}.`,
  }
}

function named(reasons: bigint[]): ReasonCounts {
  return {
    drainer: (reasons[0] ?? 0n).toString(),
    honeypot: (reasons[1] ?? 0n).toString(),
    phishing: (reasons[2] ?? 0n).toString(),
    mintOrRug: (reasons[3] ?? 0n).toString(),
    other: (reasons[4] ?? 0n).toString(),
  }
}

interface StoredRegistry {
  configured: boolean
  reportCount: string
  reasons: string[]
}

function decodeStored(stored: StoredRegistry): RegistryView {
  return {
    configured: stored.configured,
    reportCount: BigInt(stored.reportCount),
    reasons: stored.reasons.map((count) => BigInt(count)),
  }
}

function hexBig(hex: string): bigint {
  if (hex === '0x' || hex === '0x0') return 0n
  return BigInt(hex)
}
