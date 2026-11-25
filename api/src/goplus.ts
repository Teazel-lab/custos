import { cacheDelete, cacheGet, cachePut } from './cache'
import type { AppEnv, KvStore } from './types'

/**
 * Token endpoint and signature: https://docs.gopluslabs.io/reference/getaccesstokenusingpost
 * `expires_in` is a duration in seconds: https://docs.gopluslabs.io/reference/response-details-10
 * The token-security page shows `Authorization: Bearer <access_token>`
 * (https://docs.gopluslabs.io/reference/tokensecurityusingget_1). A live call
 * rejects that, and lowercase `bearer`, with code 4012. Send the bare token.
 *
 * Numeric `code` values are not on those pages. The official Node SDK lists
 * 4010 app key missing, 4011 signature expired, 4012 signature mismatch,
 * 4022 invalid token, and 4029 over the rate limit
 * (GoPlusSecurity/goplus-sdk-node `src/script/errorcode.js`).
 */
export const GOPLUS_TOKEN_URL = 'https://api.gopluslabs.io/api/v1/token'
export const GOPLUS_TIMEOUT_MS = 8_000
/** A cold token must not consume the whole security budget. */
export const GOPLUS_TOKEN_TIMEOUT_MS = 3_000
/** Leave the KV entry a minute shorter than `expires_in`. */
export const GOPLUS_TOKEN_SKEW_SECONDS = 60
export const GOPLUS_TOKEN_MIN_TTL = 60
/** Used when GoPlus omits `expires_in`. */
export const GOPLUS_TOKEN_DEFAULT_TTL = 300
/** `expires_in` is seconds, but a huge value must not pin a dead token for years. */
export const GOPLUS_TOKEN_MAX_TTL = 86_400
/** Skip `/token` for a couple of minutes after a transport or edge failure. */
export const GOPLUS_TOKEN_BACKOFF_SECONDS = 120
/** A bad key or signature will not start working on the next check. */
export const GOPLUS_CREDENTIAL_BACKOFF_SECONDS = 3_600
export const PROVIDER_USER_AGENT = 'CustosProtocol/1.0 (+https://api.custosprotocol.com)'

const TOKEN_PREFIX = 'goplus:auth:'

interface TokenSlot {
  inflight?: Promise<string | undefined>
  refreshing?: Promise<string | undefined>
  /** Latest token minted for this KV store. Not used once that store has a newer value. */
  current?: string
}

/** One in-flight token fetch per cache binding, so two tests do not share a token. */
const slots = new WeakMap<object, Map<string, TokenSlot>>()

export class ProviderError extends Error {
  readonly detail: string
  /** How a failed data call may be retried. Absent on token-endpoint and transport errors. */
  readonly retry: 'refresh' | 'noauth' | undefined
  /** True when the app key or signature was rejected on the token endpoint. */
  readonly credential: boolean

  constructor(detail: string, retry?: 'refresh' | 'noauth', credential = false) {
    super(detail)
    this.name = 'ProviderError'
    this.detail = detail
    this.retry = retry
    this.credential = credential
  }
}

export function providerDetail(err: unknown, name: string): string {
  if (err instanceof ProviderError) return err.detail
  if (isTimeout(err)) return `${name} timeout`
  if (err instanceof TypeError) return `${name} network error`
  return `${name} error`
}

export function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

export function linked(parent: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return parent ? AbortSignal.any([parent, timeout]) : timeout
}

/** `sha1(app_key + time + app_secret)` as lowercase hex. `time` is unix seconds. */
export async function signGoPlus(appKey: string, time: number, appSecret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${appKey}${time}${appSecret}`))
  return hex(digest)
}

/**
 * KV rejects an expiration under 60 seconds. A missing or short `expires_in`
 * still overwrites any previous token, and a huge value is capped at one day.
 */
export function goplusTokenTtl(expiresIn: unknown): number {
  const seconds = typeof expiresIn === 'number'
    ? expiresIn
    : typeof expiresIn === 'string' && /^\d+$/.test(expiresIn)
      ? Number(expiresIn)
      : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return GOPLUS_TOKEN_DEFAULT_TTL
  const ttl = Math.floor(seconds) - GOPLUS_TOKEN_SKEW_SECONDS
  return Math.min(Math.max(ttl, GOPLUS_TOKEN_MIN_TTL), GOPLUS_TOKEN_MAX_TTL)
}

export function providerHeaders(authorization?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': PROVIDER_USER_AGENT,
  }
  // Bare token, not Bearer. See the token-security note above.
  if (authorization) headers.Authorization = authorization
  return headers
}

interface GoPlusBody {
  code?: unknown
  message?: unknown
  result?: unknown
}

interface GoPlusCreds {
  appKey: string
  appSecret: string
}

interface IssuedToken {
  accessToken: string
  expiresIn: unknown
}

/** Both secrets are required. One of them, or a blank value, keeps the unauthenticated call. */
function goplusCredentials(env: AppEnv): GoPlusCreds | undefined {
  const appKey = env.GOPLUS_APP_KEY?.trim()
  const appSecret = env.GOPLUS_APP_SECRET?.trim()
  if (!appKey || !appSecret) return undefined
  return { appKey, appSecret }
}

export async function fetchGoPlus(env: AppEnv, url: string, signal?: AbortSignal): Promise<GoPlusBody> {
  const cacheKey = await authCacheKey(env)
  if (cacheKey && (await cacheGet(env.CACHE, noAuthKey(cacheKey))) !== null) {
    return requestGoPlus(env, url, undefined, signal)
  }
  const authorization = await accessToken(env, signal)
  try {
    return await requestGoPlus(env, url, authorization, signal)
  } catch (err) {
    if (!(err instanceof ProviderError) || err.retry !== 'refresh' || !authorization) throw err
    return recoverDataCall(env, url, signal, cacheKey, authorization, err)
  }
}

/**
 * A data-call 4012 may be a stale token or a header GoPlus will not accept.
 * Refresh once. If the new token is also rejected with 4012, or no new token
 * is available, drop the header for this call. A plain 401 or 4022 only refreshes.
 */
async function recoverDataCall(
  env: AppEnv,
  url: string,
  signal: AbortSignal | undefined,
  cacheKey: string | undefined,
  failed: string,
  err: ProviderError,
): Promise<GoPlusBody> {
  const refreshed = await accessToken(env, signal, failed)
  if (refreshed && refreshed !== failed) {
    try {
      return await requestGoPlus(env, url, refreshed, signal, true)
    } catch (next) {
      if (!(next instanceof ProviderError) || next.retry !== 'noauth') throw next
      if (cacheKey) await forgetToken(env, cacheKey, refreshed)
      return callWithoutAuth(env, url, signal, cacheKey)
    }
  }
  if (!headerRejected(err)) throw err
  if (cacheKey) await forgetToken(env, cacheKey, failed)
  return callWithoutAuth(env, url, signal, cacheKey)
}

async function callWithoutAuth(
  env: AppEnv,
  url: string,
  signal: AbortSignal | undefined,
  cacheKey: string | undefined,
): Promise<GoPlusBody> {
  const body = await requestGoPlus(env, url, undefined, signal)
  if (cacheKey) await cachePut(env.CACHE, noAuthKey(cacheKey), '1', GOPLUS_TOKEN_BACKOFF_SECONDS)
  return body
}

async function forgetToken(env: AppEnv, cacheKey: string, rejected: string): Promise<void> {
  const slot = slotFor(env.CACHE, cacheKey)
  if (slot.current === rejected) slot.current = undefined
  await cacheDelete(env.CACHE, cacheKey)
}

function headerRejected(err: ProviderError): boolean {
  return err.detail === 'GoPlus code 4012'
}

async function accessToken(env: AppEnv, signal: AbortSignal | undefined, failed?: string): Promise<string | undefined> {
  const creds = goplusCredentials(env)
  if (!creds) return undefined
  const cacheKey = await tokenCacheKey(creds.appKey)
  const slot = slotFor(env.CACHE, cacheKey)
  const shared = failed ? refreshShared(env, creds, cacheKey, slot, failed) : loadShared(env, creds, cacheKey, slot)
  return watch(shared, signal)
}

function loadShared(env: AppEnv, creds: GoPlusCreds, cacheKey: string, slot: TokenSlot): Promise<string | undefined> {
  if (!slot.inflight) {
    const pending = readOrMint(env, creds, cacheKey, slot)
    slot.inflight = pending
    void pending.finally(() => {
      if (slot.inflight === pending) slot.inflight = undefined
    })
  }
  return slot.inflight
}

function refreshShared(
  env: AppEnv,
  creds: GoPlusCreds,
  cacheKey: string,
  slot: TokenSlot,
  failed: string,
): Promise<string | undefined> {
  if (slot.current && slot.current !== failed) return Promise.resolve(slot.current)
  if (!slot.refreshing) {
    const pending = (async () => {
      const newer = await newerToken(env, cacheKey, slot, failed)
      if (newer !== undefined) return newer
      if (await backedOff(env, cacheKey)) return undefined
      return mint(env, creds, cacheKey, slot)
    })()
    slot.refreshing = pending
    void pending.finally(() => {
      if (slot.refreshing === pending) slot.refreshing = undefined
    })
  }
  return slot.refreshing
}

async function readOrMint(env: AppEnv, creds: GoPlusCreds, cacheKey: string, slot: TokenSlot): Promise<string | undefined> {
  const newer = await newerToken(env, cacheKey, slot)
  if (newer !== undefined) return newer
  if (await backedOff(env, cacheKey)) return undefined
  return mint(env, creds, cacheKey, slot)
}

/** A cached token that is not the one that just failed. `undefined` means mint or skip. */
async function newerToken(env: AppEnv, cacheKey: string, slot: TokenSlot, failed?: string): Promise<string | undefined> {
  if (await backedOff(env, cacheKey)) return undefined
  const cached = await cacheGet(env.CACHE, cacheKey)
  if (cached && cached !== failed) {
    slot.current = cached
    return cached
  }
  if (slot.current && slot.current !== failed) return slot.current
  return undefined
}

async function backedOff(env: AppEnv, cacheKey: string): Promise<boolean> {
  return (await cacheGet(env.CACHE, failKey(cacheKey))) !== null
}

/**
 * The token POST uses its own 3s timeout, not the caller's deadline, so one
 * check disconnecting does not abort the fetch another check is waiting on.
 * Any failure falls back to an unauthenticated call and is remembered in KV.
 */
async function mint(env: AppEnv, creds: GoPlusCreds, cacheKey: string, slot: TokenSlot): Promise<string | undefined> {
  try {
    const issued = await requestToken(creds)
    slot.current = issued.accessToken
    await cachePut(env.CACHE, cacheKey, issued.accessToken, goplusTokenTtl(issued.expiresIn))
    return issued.accessToken
  } catch (err) {
    const credential = err instanceof ProviderError && err.credential
    await cachePut(
      env.CACHE,
      failKey(cacheKey),
      credential ? 'credential' : 'transient',
      credential ? GOPLUS_CREDENTIAL_BACKOFF_SECONDS : GOPLUS_TOKEN_BACKOFF_SECONDS,
    )
    return undefined
  }
}

async function requestToken(creds: GoPlusCreds): Promise<IssuedToken> {
  const time = Math.floor(Date.now() / 1000)
  const sign = await signGoPlus(creds.appKey, time, creds.appSecret)
  const secrets = [creds.appKey, creds.appSecret, sign]
  let response: Response
  try {
    response = await fetch(GOPLUS_TOKEN_URL, {
      method: 'POST',
      headers: {
        ...providerHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ app_key: creds.appKey, time, sign }),
      signal: AbortSignal.timeout(GOPLUS_TOKEN_TIMEOUT_MS),
    })
  } catch (err) {
    const timeout = isTimeout(err)
    logProviderFailure('GoPlus', { op: 'token', error: timeout ? 'timeout' : 'network' })
    throw new ProviderError(timeout ? 'GoPlus timeout' : 'GoPlus network error')
  }
  const body = await readBody(response)
  const token = tokenValue(body?.result)
  if (!response.ok || !successCode(body?.code) || !token) {
    const detail = !response.ok ? `GoPlus HTTP ${response.status}` : `GoPlus code ${codeLabel(body?.code)}`
    logProviderFailure('GoPlus', {
      op: 'token',
      status: response.status,
      code: loggedCode(body?.code),
      message: clipMessage(body?.message, secrets),
    })
    // 4010, 4011, and 4012 on /token are a bad key or signature. The same 4012 on a data call is not.
    throw new ProviderError(detail, undefined, isCredentialCode(body?.code))
  }
  return token
}

async function requestGoPlus(
  env: AppEnv,
  url: string,
  authorization: string | undefined,
  signal: AbortSignal | undefined,
  refreshed = false,
): Promise<GoPlusBody> {
  const creds = goplusCredentials(env)
  const secrets = [creds?.appKey, creds?.appSecret, authorization].filter((value): value is string => Boolean(value))
  let response: Response
  try {
    response = await fetch(url, {
      headers: providerHeaders(authorization),
      signal: linked(signal, GOPLUS_TIMEOUT_MS),
    })
  } catch (err) {
    const timeout = isTimeout(err)
    logProviderFailure('GoPlus', { op: 'security', error: timeout ? 'timeout' : 'network' })
    throw new ProviderError(timeout ? 'GoPlus timeout' : 'GoPlus network error')
  }
  const body = await readBody(response)
  if (!response.ok || !successCode(body?.code)) {
    const detail = !response.ok && !isCode(body?.code, 4012)
      ? `GoPlus HTTP ${response.status}`
      : `GoPlus code ${codeLabel(body?.code)}`
    logProviderFailure('GoPlus', {
      op: 'security',
      status: response.status,
      code: loggedCode(body?.code),
      message: clipMessage(body?.message, secrets),
    })
    throw new ProviderError(detail, dataRetry(response.status, body?.code, refreshed))
  }
  return body ?? {}
}

function slotFor(kv: KvStore, cacheKey: string): TokenSlot {
  const store = kv as object
  let table = slots.get(store)
  if (!table) {
    table = new Map()
    slots.set(store, table)
  }
  let slot = table.get(cacheKey)
  if (!slot) {
    slot = {}
    table.set(cacheKey, slot)
  }
  return slot
}

async function tokenCacheKey(appKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(appKey))
  return `${TOKEN_PREFIX}${hex(digest).slice(0, 16)}`
}

function failKey(cacheKey: string): string {
  return `${cacheKey}:fail`
}

function noAuthKey(cacheKey: string): string {
  return `${cacheKey}:noauth`
}

async function authCacheKey(env: AppEnv): Promise<string | undefined> {
  const creds = goplusCredentials(env)
  if (!creds) return undefined
  return tokenCacheKey(creds.appKey)
}

function tokenValue(result: unknown): IssuedToken | undefined {
  if (!result || typeof result !== 'object') return undefined
  const record = result as { access_token?: unknown; expires_in?: unknown }
  const accessToken = record.access_token
  // Reject whitespace so a token cannot break out of the Authorization header.
  if (typeof accessToken !== 'string' || accessToken.length < 8 || accessToken.length > 4096) return undefined
  if (!/^[\x21-\x7E]+$/.test(accessToken)) return undefined
  return { accessToken, expiresIn: record.expires_in }
}

function successCode(code: unknown): boolean {
  return code === 1 || code === '1'
}

/**
 * First 4012 refreshes, including an HTTP 401 body that says 4012. A second
 * 4012 drops the header. HTTP 401 or code 4022 only refreshes. A bare 403 does neither.
 */
function dataRetry(status: number, code: unknown, refreshed: boolean): 'refresh' | 'noauth' | undefined {
  if (isCode(code, 4012)) return refreshed ? 'noauth' : 'refresh'
  if (refreshed) return undefined
  if (status === 401 || isCode(code, 4022)) return 'refresh'
  return undefined
}

function isCredentialCode(code: unknown): boolean {
  return isCode(code, 4010) || isCode(code, 4011) || isCode(code, 4012)
}

function isCode(code: unknown, expected: number): boolean {
  return code === expected || code === String(expected)
}

function codeLabel(code: unknown): string {
  if (typeof code === 'number' && Number.isFinite(code)) return String(code)
  if (typeof code === 'string' && /^-?\d{1,6}$/.test(code)) return code
  return 'unknown'
}

function loggedCode(code: unknown): string | undefined {
  const label = codeLabel(code)
  return label === 'unknown' ? undefined : label
}

async function readBody(response: Response): Promise<GoPlusBody | undefined> {
  try {
    const parsed = JSON.parse(await response.text()) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    return parsed as GoPlusBody
  } catch {
    return undefined
  }
}

export function logProviderFailure(
  provider: 'GoPlus' | 'ScamSniffer',
  fields: { op?: string; status?: number; code?: string; message?: string; error?: string },
): void {
  const entry: Record<string, string | number> = { provider }
  if (fields.op) entry.op = fields.op
  if (fields.status !== undefined) entry.status = fields.status
  if (fields.code) entry.code = fields.code
  if (fields.message) entry.message = fields.message
  if (fields.error) entry.error = fields.error
  console.log(JSON.stringify(entry))
}

function clipMessage(value: unknown, secrets: string[]): string | undefined {
  if (typeof value !== 'string') return undefined
  let text = value.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  for (const secret of secrets) {
    if (secret.length === 0) continue
    text = text.split(secret).join('[redacted]')
  }
  return text.slice(0, 180)
}

function watch<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError')
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
