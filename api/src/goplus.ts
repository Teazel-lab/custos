import { cacheGet, cachePut } from './cache'
import type { AppEnv } from './types'

/** Official token endpoint. https://docs.gopluslabs.io/reference/getaccesstokenusingpost */
export const GOPLUS_TOKEN_URL = 'https://api.gopluslabs.io/api/v1/token'
export const GOPLUS_TIMEOUT_MS = 8_000
/** Leave the KV entry a minute shorter than `expires_in` so a cached token is not used on its last second. */
export const GOPLUS_TOKEN_SKEW_SECONDS = 60
export const PROVIDER_USER_AGENT = 'CustosProtocol/1.0 (+https://api.custosprotocol.com)'

const TOKEN_PREFIX = 'goplus:auth:'

/**
 * One token fetch at a time for this isolate. The promise is cleared when it
 * settles, so the access token is not kept in module state.
 */
let inflight: Promise<string> | undefined
let refreshing: Promise<string> | undefined

export class ProviderError extends Error {
  readonly detail: string
  /** True when a new access token might make the same GoPlus call succeed. */
  readonly auth: boolean

  constructor(detail: string, auth = false) {
    super(detail)
    this.name = 'ProviderError'
    this.detail = detail
    this.auth = auth
  }
}

export function providerDetail(err: unknown, name: string): string {
  if (err instanceof ProviderError) return err.detail
  if (isTimeout(err)) return `${name} timeout`
  return `${name} network error`
}

/** `sha1(app_key + time + app_secret)` as lowercase hex. `time` is unix seconds. */
export async function signGoPlus(appKey: string, time: number, appSecret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${appKey}${time}${appSecret}`))
  return hex(digest)
}

/**
 * KV rejects an expiration under 60 seconds. Skip the cache rather than keep a
 * token that may already be expired by the time that minimum elapses.
 */
export function goplusTokenTtl(expiresIn: unknown): number | undefined {
  const seconds = typeof expiresIn === 'number'
    ? expiresIn
    : typeof expiresIn === 'string' && /^\d+$/.test(expiresIn)
      ? Number(expiresIn)
      : NaN
  if (!Number.isFinite(seconds)) return undefined
  const ttl = Math.floor(seconds) - GOPLUS_TOKEN_SKEW_SECONDS
  if (ttl < 60) return undefined
  return ttl
}

export function providerHeaders(authorization?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': PROVIDER_USER_AGENT,
  }
  // The official Node SDK sets this header to `result.access_token` with no Bearer prefix.
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

/** Both secrets are required. One of them, or a blank value, keeps the unauthenticated call. */
function goplusCredentials(env: AppEnv): GoPlusCreds | undefined {
  const appKey = env.GOPLUS_APP_KEY?.trim()
  const appSecret = env.GOPLUS_APP_SECRET?.trim()
  if (!appKey || !appSecret) return undefined
  return { appKey, appSecret }
}

export async function fetchGoPlus(env: AppEnv, url: string, signal?: AbortSignal): Promise<GoPlusBody> {
  const authorization = await accessToken(env, signal, false)
  try {
    return await requestGoPlus(env, url, authorization, signal)
  } catch (err) {
    if (!(err instanceof ProviderError) || !err.auth || !authorization) throw err
    const refreshed = await accessToken(env, signal, true)
    return requestGoPlus(env, url, refreshed, signal)
  }
}

async function accessToken(env: AppEnv, signal: AbortSignal | undefined, refresh: boolean): Promise<string | undefined> {
  const creds = goplusCredentials(env)
  if (!creds) return undefined
  if (refresh) {
    refreshing ??= requestToken(env, creds, signal).finally(() => {
      refreshing = undefined
    })
    return refreshing
  }
  inflight ??= loadToken(env, creds, signal).finally(() => {
    inflight = undefined
  })
  return inflight
}

async function loadToken(env: AppEnv, creds: GoPlusCreds, signal: AbortSignal | undefined): Promise<string> {
  const cacheKey = await tokenCacheKey(creds.appKey)
  const hit = await cacheGet(env.CACHE, cacheKey)
  if (hit) return hit
  return requestToken(env, creds, signal)
}

async function requestToken(env: AppEnv, creds: GoPlusCreds, signal: AbortSignal | undefined): Promise<string> {
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
      signal: linked(signal, GOPLUS_TIMEOUT_MS),
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
    throw new ProviderError(detail)
  }
  const ttl = goplusTokenTtl(token.expiresIn)
  if (ttl !== undefined) await cachePut(env.CACHE, await tokenCacheKey(creds.appKey), token.accessToken, ttl)
  return token.accessToken
}

async function requestGoPlus(
  env: AppEnv,
  url: string,
  authorization: string | undefined,
  signal: AbortSignal | undefined,
): Promise<GoPlusBody> {
  const creds = goplusCredentials(env)
  const secrets = [creds?.appKey, creds?.appSecret, authorization].filter((value): value is string => !!value)
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
    const detail = !response.ok ? `GoPlus HTTP ${response.status}` : `GoPlus code ${codeLabel(body?.code)}`
    logProviderFailure('GoPlus', {
      op: 'security',
      status: response.status,
      code: loggedCode(body?.code),
      message: clipMessage(body?.message, secrets),
    })
    throw new ProviderError(detail, isAuthFailure(response.status, body?.code))
  }
  return body ?? {}
}

async function tokenCacheKey(appKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(appKey))
  return `${TOKEN_PREFIX}${hex(digest).slice(0, 16)}`
}

function tokenValue(result: unknown): { accessToken: string; expiresIn: unknown } | undefined {
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

/** 4022 is GoPlus `INVALID_TOKEN`. 401 and 403 are the HTTP auth failures. */
function isAuthFailure(status: number, code: unknown): boolean {
  if (status === 401 || status === 403) return true
  return code === 4022 || code === '4022'
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
    const text = await response.text()
    if (text.length > 1_000_000) return undefined
    const parsed = JSON.parse(text) as unknown
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
  let text = value.replace(/\s+/g, ' ').trim().slice(0, 180)
  if (!text) return undefined
  for (const secret of secrets) {
    if (secret.length < 8) continue
    text = text.split(secret).join('[redacted]')
  }
  return text
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

function linked(parent: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return parent ? AbortSignal.any([parent, timeout]) : timeout
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
