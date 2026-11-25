import { isAddress } from './abi'
import { providerReason } from './messages'
import type { AppEnv, ChainId, Reason } from './types'

const SCAM_URL = 'https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json'
const TOKEN_TTL = 3_600
const ADDRESS_TTL = 3_600
const SCAM_TTL = 21_600
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

export async function checkTokens(env: AppEnv, chainId: ChainId, tokens: string[]): Promise<Reason[]> {
  const unique = cap(tokens)
  if (unique.length === 0) return []
  const [honeypot, goplus] = await Promise.all([
    honeypotReasons(env, chainId, unique).catch(() => [providerReason('Honeypot')]),
    goplusTokenReasons(env, chainId, unique).catch(() => [providerReason('GoPlus')]),
  ])
  return [...honeypot, ...goplus]
}

export async function checkAddresses(env: AppEnv, chainId: ChainId, addresses: string[]): Promise<Reason[]> {
  const unique = cap(addresses, 8)
  if (unique.length === 0) return []
  const [goplus, scam] = await Promise.all([
    goplusAddressReasons(env, chainId, unique).catch(() => [providerReason('GoPlus')]),
    scamReasons(env, unique).catch(() => [providerReason('ScamSniffer')]),
  ])
  return [...goplus, ...scam]
}

async function honeypotReasons(env: AppEnv, chainId: ChainId, tokens: string[]): Promise<Reason[]> {
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
              { signal: AbortSignal.timeout(4_000) },
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

async function goplusTokenReasons(env: AppEnv, chainId: ChainId, tokens: string[]): Promise<Reason[]> {
  const records = await loadGoPlusRecords(
    env,
    tokens,
    (token) => `goplus:token:${chainId}:${token}`,
    TOKEN_TTL,
    `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${tokens.join(',')}`,
  )
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

async function goplusAddressReasons(env: AppEnv, chainId: ChainId, addresses: string[]): Promise<Reason[]> {
  const records = await loadGoPlusRecords(
    env,
    addresses,
    (address) => `goplus:addr:${chainId}:${address}`,
    ADDRESS_TTL,
    `https://api.gopluslabs.io/api/v1/address_security/${addresses.join(',')}?chain_id=${chainId}`,
  )
  const reasons: Reason[] = []
  for (const address of addresses) {
    const record = records.get(address)
    if (!record) continue
    if (ADDRESS_FLAGS.some((flag) => record[flag] === '1')) {
      reasons.push({
        code: 'address_malicious',
        severity: 'danger',
        message: `Address ${address} is flagged by address security.`,
      })
    }
  }
  return reasons
}

async function scamReasons(env: AppEnv, addresses: string[]): Promise<Reason[]> {
  const list = await loadScamList(env)
  const reasons: Reason[] = []
  for (const address of addresses) {
    if (!list.has(address)) continue
    reasons.push({
      code: 'scam_blacklist',
      severity: 'danger',
      message: `Address ${address} is on the ScamSniffer blacklist.`,
    })
  }
  return reasons
}

async function loadScamList(env: AppEnv): Promise<Set<string>> {
  const cached = await cachedJson<string[]>(env, 'scam:list', SCAM_TTL, async () => {
    const response = await fetch(SCAM_URL, { signal: AbortSignal.timeout(4_000) })
    if (!response.ok) throw new Error('scam list http')
    const text = await response.text()
    if (text.length > MAX_LIST_BYTES) throw new Error('scam list too large')
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) throw new Error('scam list shape')
    return parsed.filter((item): item is string => typeof item === 'string' && isAddress(item)).map((item) => item.toLowerCase())
  })
  return new Set(cached)
}

async function loadGoPlusRecords(
  env: AppEnv,
  addresses: string[],
  keyFor: (address: string) => string,
  ttl: number,
  url: string,
): Promise<Map<string, Record<string, string>>> {
  const records = new Map<string, Record<string, string>>()
  const missing: string[] = []
  for (const address of addresses) {
    const hit = await env.CACHE.get(keyFor(address))
    if (hit === null) {
      missing.push(address)
      continue
    }
    if (hit !== 'none') records.set(address, JSON.parse(hit) as Record<string, string>)
  }
  if (missing.length === 0) return records
  const response = await fetch(url, { signal: AbortSignal.timeout(4_000) })
  if (!response.ok) throw new Error('goplus http')
  const body = (await response.json()) as { code?: unknown; result?: Record<string, Record<string, string>> }
  if (body.code !== 1 && body.code !== '1') throw new Error('goplus code')
  const result = body.result ?? {}
  for (const address of missing) {
    const record = lookup(result, address)
    await env.CACHE.put(keyFor(address), record ? JSON.stringify(record) : 'none', { expirationTtl: ttl })
    if (record) records.set(address, record)
  }
  return records
}

function lookup(result: Record<string, Record<string, string>>, address: string): Record<string, string> | null {
  for (const [key, value] of Object.entries(result)) {
    if (key.toLowerCase() === address) return value
  }
  return null
}

async function cachedJson<T>(env: AppEnv, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = await env.CACHE.get(key)
  if (hit !== null) return JSON.parse(hit) as T
  const value = await load()
  await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl })
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

interface HoneypotBody {
  honeypotResult?: { isHoneypot?: boolean | string }
  simulationResult?: { sellTax?: number | string }
}
