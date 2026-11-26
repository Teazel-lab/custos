import { isAddress } from './abi'
import { cacheGet, cachePut } from './cache'
import { chainProfile, knownToken } from './chains'
import { fetchGoPlus, isTimeout, linked, logProviderFailure, ProviderError, providerDetail, providerHeaders } from './goplus'
import { providerReason } from './messages'
import type { AppEnv, ChainId, ProviderState, Reason } from './types'

const SCAM_URL = 'https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json'
/** A GoPlus body with a real security answer. Flags change slowly. */
export const GOPLUS_RECORD_TTL = 21_600
/** Address flags that are all zero. Unknown addresses look like this. */
export const GOPLUS_ADDRESS_CLEAN_TTL = 1_800
/** Empty GoPlus body, a partial token, or a token GoPlus has not indexed. */
export const GOPLUS_EMPTY_TTL = 90
/**
 * GoPlus from a Worker often takes longer than 4s. 8s still finishes inside
 * the check deadline. Only a successful body is written to KV.
 */
export { GOPLUS_TIMEOUT_MS } from './goplus'
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

export interface TokenReputation {
  reasons: Reason[]
  /** Tokens with no usable record from GoPlus or Honeypot.is. */
  uncovered: string[]
  honeypot: ProviderState
  goplus: ProviderState
}

export interface AddressReputation {
  reasons: Reason[]
  scamSniffer: ProviderState
  goplus: ProviderState
}

const SKIPPED_TOKENS: TokenReputation = { reasons: [], uncovered: [], honeypot: 'skipped', goplus: 'skipped' }

export async function checkTokens(
  env: AppEnv,
  chainId: ChainId,
  tokens: string[],
  signal?: AbortSignal,
  target?: string,
): Promise<TokenReputation> {
  const unique = cap(tokens)
  if (unique.length === 0 || !chainProfile(chainId).tokenReputation) return SKIPPED_TOKENS
  const [honeypot, goplus] = await Promise.all([
    honeypotReasons(env, chainId, unique, signal),
    goplusTokenReasons(env, chainId, unique, signal, target),
  ])
  const uncovered = unique.filter((token) => !honeypot.covered.has(token) && !goplus.covered.has(token))
  return {
    reasons: [...honeypot.reasons, ...goplus.reasons],
    uncovered,
    honeypot: honeypot.state,
    goplus: goplus.state,
  }
}

export async function checkAddresses(
  env: AppEnv,
  chainId: ChainId,
  addresses: string[],
  signal?: AbortSignal,
): Promise<AddressReputation> {
  const unique = cap(addresses, 8)
  if (unique.length === 0) return { reasons: [], scamSniffer: 'skipped', goplus: 'skipped' }
  const scam = await scamReasons(env, unique, signal).catch((err) => [
    providerReason('ScamSniffer', providerDetail(err, 'ScamSniffer')),
  ])
  const scamSniffer: ProviderState = scam.some((reason) => reason.code === 'provider_failed') ? 'failed' : 'answered'
  if (!chainProfile(chainId).tokenReputation) return { reasons: scam, scamSniffer, goplus: 'skipped' }
  const goplus = await goplusAddressReasons(env, chainId, unique, signal).catch((err) => [
    providerReason('GoPlus', providerDetail(err, 'GoPlus')),
  ])
  const goplusState: ProviderState = goplus.some((reason) => reason.code === 'provider_failed') ? 'failed' : 'answered'
  return { reasons: [...goplus, ...scam], scamSniffer, goplus: goplusState }
}

interface HoneypotRead {
  reasons: Reason[]
  covered: Set<string>
  state: ProviderState
}

/**
 * Honeypot.is IsHoneypot. Docs (docs.honeypot.is) say X-API-KEY is optional and
 * not required yet, so we do not send one. chainID is 56 or 8453. A non-OK
 * response is not cached.
 */
async function honeypotReasons(
  env: AppEnv,
  chainId: ChainId,
  tokens: string[],
  signal?: AbortSignal,
): Promise<HoneypotRead> {
  const reasons: Reason[] = []
  const covered = new Set<string>()
  let failed = false
  await Promise.all(
    tokens.map(async (token) => {
      try {
        const body = await readHoneypot(env, chainId, token, signal)
        if (!body) {
          failed = true
          return
        }
        covered.add(token)
        const flag = body.honeypotResult?.isHoneypot
        if (flag === true || flag === 'true') {
          reasons.push({
            code: 'honeypot',
            severity: 'danger',
            message: `Token ${token} looks like a honeypot.`,
          })
        }
        if (cannotSell(body)) {
          reasons.push({
            code: 'cannot_sell',
            severity: 'danger',
            message: `Token ${token} may not be fully sellable.`,
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
  return { reasons, covered, state: failed ? 'failed' : 'answered' }
}

async function readHoneypot(
  env: AppEnv,
  chainId: ChainId,
  token: string,
  signal?: AbortSignal,
): Promise<HoneypotBody | null> {
  const key = `honeypot:${chainId}:${token}`
  const hit = await cacheGet(env.CACHE, key)
  if (hit !== null) return JSON.parse(hit) as HoneypotBody
  const response = await fetch(
    `https://api.honeypot.is/v2/IsHoneypot?address=${token}&chainID=${chainId}`,
    { headers: providerHeaders(), signal: linked(signal, 4_000) },
  )
  if (!response.ok) {
    logProviderFailure('Honeypot', { status: response.status })
    throw new Error('honeypot http')
  }
  const body = (await response.json()) as HoneypotBody
  const ttl = honeypotTtl(body)
  if (ttl === null) return null
  await cachePut(env.CACHE, key, JSON.stringify(body), ttl)
  return body
}

/** Flagged answers stay for 6 hours, a clean simulation for 30 minutes, a partial body for 90 seconds. */
export function honeypotTtl(body: HoneypotBody): number | null {
  if (!honeypotKnown(body.honeypotResult?.isHoneypot)) return null
  const tax = Number(body.simulationResult?.sellTax)
  if (!Number.isFinite(tax)) return GOPLUS_EMPTY_TTL
  if (body.honeypotResult?.isHoneypot === true || body.honeypotResult?.isHoneypot === 'true' || tax > 20 || cannotSell(body)) {
    return GOPLUS_RECORD_TTL
  }
  return GOPLUS_ADDRESS_CLEAN_TTL
}

function honeypotKnown(flag: boolean | string | undefined): boolean {
  return flag === true || flag === false || flag === 'true' || flag === 'false'
}

function cannotSell(body: HoneypotBody): boolean {
  const max = body.simulationResult?.maxSell
  if (!max) return false
  if (max.token === 0) return true
  return max.tokenWei === '0'
}

async function goplusTokenReasons(
  env: AppEnv,
  chainId: ChainId,
  tokens: string[],
  signal: AbortSignal | undefined,
  target: string | undefined,
): Promise<{ reasons: Reason[]; covered: Set<string>; state: ProviderState }> {
  try {
    const loaded = await loadGoPlusTokenRecords(env, chainId, tokens, signal)
    const reasons: Reason[] = []
    for (const token of tokens) {
      const record = loaded.records.get(token)
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
    const wanted = target?.toLowerCase()
    if (wanted && loaded.absent.has(wanted) && !knownToken(chainId, wanted)) {
      reasons.push({
        code: 'unknown_token',
        severity: 'warn',
        message: `Token ${wanted} has no GoPlus record.`,
      })
    }
    return { reasons, covered: new Set(loaded.records.keys()), state: 'answered' }
  } catch (err) {
    return {
      reasons: [providerReason('GoPlus', providerDetail(err, 'GoPlus'))],
      covered: new Set(),
      state: 'failed',
    }
  }
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
  let detail: string | undefined
  await Promise.all(
    addresses.map(async (address) => {
      try {
        const record = await goplusAddress(env, chainId, address, signal)
        if (ADDRESS_FLAGS.some((flag) => record[flag] === '1')) {
          reasons.push({
            code: 'address_malicious',
            severity: 'danger',
            message: `Address ${address} is flagged by address security.`,
          })
        }
      } catch (err) {
        failed = true
        detail ??= providerDetail(err, 'GoPlus')
      }
    }),
  )
  if (failed) reasons.push(providerReason('GoPlus', detail))
  return reasons
}

async function scamReasons(env: AppEnv, addresses: string[], signal?: AbortSignal): Promise<Reason[]> {
  const listed = await scamHits(env, addresses, signal)
  if (typeof listed === 'string') return [providerReason('ScamSniffer', listed)]
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
async function scamHits(env: AppEnv, addresses: string[], signal?: AbortSignal): Promise<Set<string> | string> {
  const failed = await cacheGet(env.CACHE, SCAM_FAIL)
  if (failed !== null) return scamFailDetail(failed)
  if ((await cacheGet(env.CACHE, SCAM_READY)) === '1') return hitsFromShards(env, addresses)
  try {
    const response = await fetch(SCAM_URL, { headers: providerHeaders(), signal: linked(signal, 4_000) })
    if (!response.ok) {
      logProviderFailure('ScamSniffer', { status: response.status })
      throw new ProviderError(`ScamSniffer HTTP ${response.status}`)
    }
    const text = await response.text()
    if (text.length > MAX_LIST_BYTES) throw scamInvalid()
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      throw scamInvalid()
    }
    if (!Array.isArray(parsed)) throw scamInvalid()
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
    if (wrote.some((ok) => !ok)) throw new ProviderError('ScamSniffer cache error')
    const ready = await cachePut(env.CACHE, SCAM_READY, '1', SCAM_TTL)
    if (!ready) throw new ProviderError('ScamSniffer cache error')
    const set = new Set(list)
    return new Set(addresses.filter((address) => set.has(address)))
  } catch (err) {
    const detail = providerDetail(err, 'ScamSniffer')
    if (!(err instanceof ProviderError)) {
      const error = isTimeout(err) ? 'timeout' : err instanceof TypeError ? 'network' : 'error'
      logProviderFailure('ScamSniffer', { error })
    }
    // The download's own timeout is remembered. Only the caller's deadline is not.
    if (signal?.aborted) throw err instanceof ProviderError ? err : new ProviderError(detail)
    await cachePut(env.CACHE, SCAM_FAIL, detail, SCAM_FAIL_TTL)
    return detail
  }
}

function scamInvalid(): ProviderError {
  logProviderFailure('ScamSniffer', { error: 'invalid response' })
  return new ProviderError('ScamSniffer invalid response')
}

function scamFailDetail(stored: string): string {
  if (stored.startsWith('ScamSniffer ')) return stored.slice(0, 80)
  return 'ScamSniffer network error'
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

async function goplusAddress(
  env: AppEnv,
  chainId: ChainId,
  address: string,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const key = `goplus:addr:${chainId}:${address}`
  const hit = await cacheGet(env.CACHE, key)
  if (hit !== null) return JSON.parse(hit) as Record<string, string>
  const body = await fetchGoPlus(
    env,
    `https://api.gopluslabs.io/api/v1/address_security/${address}?chain_id=${chainId}`,
    signal,
  )
  const record = recordObject(body.result)
  await cachePut(env.CACHE, key, JSON.stringify(record), goplusAddressTtl(record))
  return record
}

interface TokenLoad {
  records: Map<string, Record<string, string>>
  absent: Set<string>
}

async function loadGoPlusTokenRecords(
  env: AppEnv,
  chainId: ChainId,
  tokens: string[],
  signal?: AbortSignal,
): Promise<TokenLoad> {
  const records = new Map<string, Record<string, string>>()
  const absent = new Set<string>()
  const missing: string[] = []
  for (const token of tokens) {
    const hit = await cacheGet(env.CACHE, `goplus:token:${chainId}:${token}`)
    if (hit === null) {
      missing.push(token)
      continue
    }
    if (hit === 'none') {
      absent.add(token)
      continue
    }
    const stored = JSON.parse(hit) as Record<string, string>
    records.set(token, stored)
    if (!tokenComplete(stored)) absent.add(token)
  }
  if (missing.length === 0) return { records, absent }
  const body = await fetchGoPlus(
    env,
    `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${missing.join(',')}`,
    signal,
  )
  const result = (body.result ?? {}) as Record<string, Record<string, string>>
  for (const token of missing) {
    const record = lookup(result, token)
    if (!record) {
      await cachePut(env.CACHE, `goplus:token:${chainId}:${token}`, 'none', GOPLUS_EMPTY_TTL)
      absent.add(token)
      continue
    }
    const complete = tokenComplete(record)
    await cachePut(
      env.CACHE,
      `goplus:token:${chainId}:${token}`,
      JSON.stringify(record),
      complete ? GOPLUS_RECORD_TTL : GOPLUS_EMPTY_TTL,
    )
    records.set(token, record)
    if (!complete) absent.add(token)
  }
  return { records, absent }
}

function recordObject(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, string>
}

function goplusAddressTtl(record: Record<string, string>): number {
  if (ADDRESS_FLAGS.some((flag) => record[flag] === '1')) return GOPLUS_RECORD_TTL
  if (Object.keys(record).length === 0) return GOPLUS_EMPTY_TTL
  return GOPLUS_ADDRESS_CLEAN_TTL
}

/** Both answers are present, so the record can be cached for hours and is not unknown. */
function tokenComplete(record: Record<string, string> | null): boolean {
  if (!record) return false
  const honeypot = record.is_honeypot
  if (honeypot !== '0' && honeypot !== '1') return false
  const sell = record.cannot_sell_all
  return typeof sell === 'string' && sell.length > 0
}

function lookup(result: Record<string, Record<string, string>>, address: string): Record<string, string> | null {
  for (const [key, value] of Object.entries(result)) {
    if (key.toLowerCase() === address) return value
  }
  return null
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
  simulationResult?: { sellTax?: number | string; maxSell?: { token?: number; tokenWei?: string } }
}
