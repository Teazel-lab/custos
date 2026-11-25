import { isAddress } from './abi'
import { cacheGet, cachePut } from './cache'
import { providerReason } from './messages'
import type { AppEnv, ChainId, Reason } from './types'

const SCAM_URL = 'https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json'
const TOKEN_TTL = 3_600
const ADDRESS_TTL = 3_600
/**
 * GoPlus from a Worker often takes longer than 4s. 8s still finishes inside
 * the check deadline. Only a successful body is written to KV.
 */
export const GOPLUS_TIMEOUT_MS = 8_000
const SCAM_TTL = 21_600
const SCAM_FAIL_TTL = 300
const SCAM_READY = 'scam:ready'
const SCAM_FAIL = 'scam:fail'
const MAX_LIST_BYTES = 5_000_000

const ADDRESS_FLAGS = [
  'honeypot_related_address',
  'phishing_activities',
  'cybercrime',
  'money_laundering',
  'stealing_attack',
  'blackmail_activities',
  'financial_crime',
] as const

export async function checkTokens(
  env: AppEnv,
  chainId: ChainId,
  tokens: string[],
  signal?: AbortSignal,
): Promise<Reason[]> {
  const unique = cap(tokens)
  if (unique.length === 0) return []
  if (chainId === 97) return []
  const [honeypot, goplus] = await Promise.all([
    honeypotReasons(env, chainId, unique, signal).catch(() => [providerReason('Honeypot')]),
    goplusTokenReasons(env, chainId, unique, signal).catch(() => [providerReason('GoPlus')]),
  ])
  return [...honeypot, ...goplus]
}

export async function checkAddresses(
  env: AppEnv,
  chainId: ChainId,
  addresses: string[],
  signal?: AbortSignal,
): Promise<Reason[]> {
  const unique = cap(addresses, 8)
  if (unique.length === 0) return []
  const scam = await scamReasons(env, unique, signal).catch(() => [providerReason('ScamSniffer')])
  if (chainId === 97) return scam
  const goplus = await goplusAddressReasons(env, chainId, unique, signal).catch(() => [providerReason('GoPlus')])
  return [...goplus, ...scam]
}

async function honeypotReasons(
  env: AppEnv,
  chainId: ChainId,
  tokens: string[],
  signal?: AbortSignal,
): Promise<Reason[]> {
  const reasons: Reason[] = []
  let failed = false
  await Promise.all(
    tokens.map(async (token) => {
      try {
        const body = await cachedJson<HoneypotBody>(
          env,
          `honeypot:${chainId}:${token}`,
          TOKEN_TTL,
          async () => {
            const response = await fetch(
              `https://api.honeypot.is/v2/IsHoneypot?address=${token}&chainID=${chainId}`,
              { signal: linked(signal, 4_000) },
            )
            if (!response.ok) throw new Error('honeypot http')
            return (await response.json()) as HoneypotBody
          },
        )
        const flag = body.honeypotResult?.isHoneypot
        if (flag === true || flag === 'true') {
          reasons.push({
            code: 'honeypot',
            severity: 'danger',
            message: `Token ${token} looks like a honeypot.`,
          })
        }
        const tax = Number(body.simulationResult?.sellTax)
        if (Number.isFinite(tax) && tax > 20) {
          reasons.push({
            code: 'high_tax',
            severity: 'warn',
            message: `Token ${token} has a high sell tax (${tax}%).`,
          })
        }
      } catch {
        failed = true
      }
    }),
  )
  if (failed) reasons.push(providerReason('Honeypot'))
  return reasons
}

async function goplusTokenReasons(
  env: AppEnv,
  chainId: ChainId,
  tokens: string[],
  signal?: AbortSignal,
): Promise<Reason[]> {
  const records = await loadGoPlusTokenRecords(env, chainId, tokens, signal)
  const reasons: Reason[] = []
  for (const token of tokens) {
    const record = records.get(token)
    if (!record) continue
    if (record.is_honeypot === '1') {
      reasons.push({ code: 'honeypot', severity: 'danger', message: `Token ${token} looks like a honeypot.` })
    }
    if (record.cannot_sell_all === '1') {
      reasons.push({
        code: 'cannot_sell',
        severity: 'danger',
        message: `Token ${token} may not be fully sellable.`,
      })
    }
  }
  return reasons
}

/**
 * address_security takes one address and returns a flat result object.
 * A comma-joined path is a parameter error, and the flags are not keyed by address.
 */
async function goplusAddressReasons(
  env: AppEnv,
  chainId: ChainId,
  addresses: string[],
  signal?: AbortSignal,
): Promise<Reason[]> {
  const reasons: Reason[] = []
  let failed = false
  await Promise.all(
    addresses.map(async (address) => {
      try {
        const record = await cachedJson<Record<string, string>>(
          env,
          `goplus:addr:${chainId}:${address}`,
          ADDRESS_TTL,
          async () => {
            const response = await fetch(
              `https://api.gopluslabs.io/api/v1/address_security/${address}?chain_id=${chainId}`,
              { signal: linked(signal, GOPLUS_TIMEOUT_MS) },
            )
            if (!response.ok) throw new Error('goplus http')
            const body = (await response.json()) as { code?: unknown; result?: unknown }
            if (body.code !== 1 && body.code !== '1') throw new Error('goplus code')
            if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) return {}
            return body.result as Record<string, string>
          },
        )
        if (ADDRESS_FLAGS.some((flag) => record[flag] === '1')) {
          reasons.push({
            code: 'address_malicious',
            severity: 'danger',
            message: `Address ${address} is flagged by address security.`,
          })
        }
      } catch {
        failed = true
      }
    }),
  )
  if (failed) reasons.push(providerReason('GoPlus'))
  return reasons
}

async function scamReasons(env: AppEnv, addresses: string[], signal?: AbortSignal): Promise<Reason[]> {
  const listed = await scamHits(env, addresses, signal)
  if (listed === 'fail') return [providerReason('ScamSniffer')]
  const reasons: Reason[] = []
  for (const address of addresses) {
    if (!listed.has(address)) continue
    reasons.push({
      code: 'scam_blacklist',
      severity: 'danger',
      message: `Address ${address} is on the ScamSniffer blacklist.`,
    })
  }
  return reasons
}

/**
 * The blacklist is stored one shard per first address byte. A fetch failure is
 * cached for a few minutes so the next check does not download it again.
 */
async function scamHits(env: AppEnv, addresses: string[], signal?: AbortSignal): Promise<Set<string> | 'fail'> {
  if ((await cacheGet(env.CACHE, SCAM_FAIL)) === '1') return 'fail'
  if ((await cacheGet(env.CACHE, SCAM_READY)) === '1') return hitsFromShards(env, addresses)
  try {
    const response = await fetch(SCAM_URL, { signal: linked(signal, 4_000) })
    if (!response.ok) throw new Error('scam list http')
    const text = await response.text()
    if (text.length > MAX_LIST_BYTES) throw new Error('scam list too large')
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) throw new Error('scam list shape')
    const list = parsed
      .filter((item): item is string => typeof item === 'string' && isAddress(item))
      .map((item) => item.toLowerCase())
    const shards = new Map<string, string[]>()
    for (const address of list) {
      const byte = address.slice(2, 4)
      const bucket = shards.get(byte) ?? []
      bucket.push(address)
      shards.set(byte, bucket)
    }
    const writes = [...shards].map(([byte, bucket]) => cachePut(env.CACHE, `scam:${byte}`, JSON.stringify(bucket), SCAM_TTL))
    const wrote = await Promise.all(writes)
    if (wrote.some((ok) => !ok)) throw new Error('scam shard write')
    const ready = await cachePut(env.CACHE, SCAM_READY, '1', SCAM_TTL)
    if (!ready) throw new Error('scam ready write')
    const set = new Set(list)
    return new Set(addresses.filter((address) => set.has(address)))
  } catch (err) {
    if (signal?.aborted) throw err
    await cachePut(env.CACHE, SCAM_FAIL, '1', SCAM_FAIL_TTL)
    return 'fail'
  }
}

async function hitsFromShards(env: AppEnv, addresses: string[]): Promise<Set<string>> {
  const hits = new Set<string>()
  const seen = new Map<string, Set<string>>()
  for (const address of addresses) {
    const byte = address.slice(2, 4)
    let bucket = seen.get(byte)
    if (!bucket) {
      const raw = await cacheGet(env.CACHE, `scam:${byte}`)
      const list = raw ? (JSON.parse(raw) as string[]) : []
      bucket = new Set(list)
      seen.set(byte, bucket)
    }
    if (bucket.has(address)) hits.add(address)
  }
  return hits
}

async function loadGoPlusTokenRecords(
  env: AppEnv,
  chainId: ChainId,
  tokens: string[],
  signal?: AbortSignal,
): Promise<Map<string, Record<string, string>>> {
  const records = new Map<string, Record<string, string>>()
  const missing: string[] = []
  for (const token of tokens) {
    const hit = await cacheGet(env.CACHE, `goplus:token:${chainId}:${token}`)
    if (hit === null) {
      missing.push(token)
      continue
    }
    if (hit !== 'none') records.set(token, JSON.parse(hit) as Record<string, string>)
  }
  if (missing.length === 0) return records
  const response = await fetch(
    `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${missing.join(',')}`,
    { signal: linked(signal, GOPLUS_TIMEOUT_MS) },
  )
  if (!response.ok) throw new Error('goplus http')
  const body = (await response.json()) as { code?: unknown; result?: Record<string, Record<string, string>> }
  if (body.code !== 1 && body.code !== '1') throw new Error('goplus code')
  const result = body.result ?? {}
  for (const token of missing) {
    const record = lookup(result, token)
    await cachePut(env.CACHE, `goplus:token:${chainId}:${token}`, record ? JSON.stringify(record) : 'none', TOKEN_TTL)
    if (record) records.set(token, record)
  }
  return records
}

function lookup(result: Record<string, Record<string, string>>, address: string): Record<string, string> | null {
  for (const [key, value] of Object.entries(result)) {
    if (key.toLowerCase() === address) return value
  }
  return null
}

/** Caches a successful load only. A thrown load, including a timeout, is not stored. */
async function cachedJson<T>(env: AppEnv, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = await cacheGet(env.CACHE, key)
  if (hit !== null) return JSON.parse(hit) as T
  const value = await load()
  await cachePut(env.CACHE, key, JSON.stringify(value), ttl)
  return value
}

function cap(values: string[], limit = 5): string[] {
  const unique: string[] = []
  for (const value of values) {
    const address = value.toLowerCase()
    if (!isAddress(address) || unique.includes(address)) continue
    unique.push(address)
    if (unique.length === limit) break
  }
  return unique
}

function linked(parent: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return parent ? AbortSignal.any([parent, timeout]) : timeout
}

interface HoneypotBody {
  honeypotResult?: { isHoneypot?: boolean | string }
  simulationResult?: { sellTax?: number | string }
}
