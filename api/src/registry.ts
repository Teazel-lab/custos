import { decodeWords, padAddress, strip0x } from './abi'
import { cacheGet, cachePut } from './cache'
import { chainProfile } from './chains'
import { providerReason, REGISTRY_BASE } from './messages'
import { plainRpc, rpc, rpcMatchesChain } from './rpc'
import type { AppEnv, ChainId, ProviderState, Reason } from './types'

/**
 * Chain 56 and chain 97 registries are live. The addresses match the deployer
 * nonce, so chain 56's registry is chain 97's hub. Base has no registry.
 */
export const REGISTRIES: Record<ChainId, string | null> = {
  56: '0x062d0452187094c1b2dd546b6a793a50ebdbfd06',
  97: '0x14df99cea96c8f0980ca0af46cb5d30de782353a',
  8453: null,
}

export type RegistryState = ProviderState | 'unconfigured'

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

export async function registrySignal(
  env: AppEnv,
  chainId: ChainId,
  addresses: string[],
  signal?: AbortSignal,
): Promise<{ reasons: Reason[]; state: RegistryState }> {
  if (chainProfile(chainId).registry === 'unsupported') {
    return {
      reasons: [{ code: 'registry_unsupported', severity: 'info', message: REGISTRY_BASE }],
      state: 'skipped',
    }
  }
  if (!REGISTRIES[chainId]) {
    return {
      reasons: [
        {
          code: 'registry_unconfigured',
          severity: 'warn',
          message: 'Custos registry is not configured for this chain yet.',
        },
      ],
      state: 'unconfigured',
    }
  }
  const reasons: Reason[] = []
  let failed = false
  await Promise.all(
    addresses.map(async (address) => {
      try {
        const view = await readRegistry(env, chainId, address, signal)
        if (!view.configured || view.reportCount === 0n) return
        reasons.push(reportReason(address, view))
      } catch {
        failed = true
      }
    }),
  )
  if (failed) reasons.push(providerReason('Registry'))
  return { reasons, state: failed ? 'failed' : 'answered' }
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
  if (!view.configured) {
    response.message = chainProfile(chainId).registry === 'unsupported'
      ? 'The Custos registry is on BNB Chain. Base has no registry.'
      : 'Custos registry is not deployed on this chain yet.'
  }
  return response
}

export async function readRegistry(
  env: AppEnv,
  chainId: ChainId,
  address: string,
  parent?: AbortSignal,
): Promise<RegistryView> {
  const registry = REGISTRIES[chainId]
  if (!registry) return { configured: false, reportCount: 0n, reasons: [0n, 0n, 0n, 0n, 0n] }
  const key = `reg:${chainId}:${address}`
  const hit = await cacheGet(env.CACHE, key)
  if (hit !== null) return decodeStored(JSON.parse(hit) as StoredRegistry)
  const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(4_000)]) : AbortSignal.timeout(4_000)
  const url = plainRpc(env, chainId)
  if (!(await rpcMatchesChain(env, chainId, url, signal))) throw new Error('rpc chain mismatch')
  const padded = padAddress(address)
  const [countHex, reasonsHex] = await Promise.all([
    rpc(url, 'eth_call', [{ to: registry, data: REPORT_COUNT + padded }, 'latest'], signal),
    rpc(url, 'eth_call', [{ to: registry, data: REASONS_OF + padded }, 'latest'], signal),
  ])
  if (typeof countHex !== 'string' || typeof reasonsHex !== 'string') throw new Error('registry shape')
  const count = requireWord(countHex)
  const reasons = requireWords(reasonsHex, 5)
  const stored: StoredRegistry = {
    configured: true,
    reportCount: count.toString(),
    reasons: reasons.map((item) => item.toString()),
  }
  await cachePut(env.CACHE, key, JSON.stringify(stored), 300)
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

/** A short eth_call result, including `0x`, is a failed read. It is not a zero count. */
function requireWord(hex: string): bigint {
  const words = requireWords(hex, 1)
  return words[0] ?? 0n
}

function requireWords(hex: string, count: number): bigint[] {
  const body = strip0x(hex)
  if (body.length < count * 64 || !/^[0-9a-fA-F]+$/.test(body)) throw new Error('short registry result')
  const words = decodeWords(hex).slice(0, count)
  if (words.length < count) throw new Error('short registry result')
  return words
}
