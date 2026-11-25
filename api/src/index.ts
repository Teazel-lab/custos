import { authorize, secretField } from './auth'
import { cacheGet, cachePut } from './cache'
import { parseTx, requestHash, runCheck } from './check'
import { withCors } from './cors'
import { HttpError, json, readLimitedBody } from './http'
import { WALLET_SENTENCE } from './messages'
import { allowRequest } from './ratelimit'
import { reportFor } from './registry'
import type { AppEnv, ChainId } from './types'

export async function handle(request: Request, env: AppEnv): Promise<Response> {
  const allowDev = env.ALLOW_DEV_ORIGINS === '1'
  try {
    return withCors(request, await route(request, env), allowDev)
  } catch (err) {
    if (err instanceof HttpError) return withCors(request, json({ error: err.message }, err.status), allowDev)
    console.error(JSON.stringify({ error: 'unhandled' }))
    return withCors(request, json({ error: 'Check failed.' }, 500), allowDev)
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env)
  },
} satisfies ExportedHandler<Env>

async function route(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true })
  if (url.pathname.startsWith('/report/')) return report(request, env, url)
  if (request.method === 'POST' && url.pathname === '/check') return check(request, env)
  return json({ error: 'Not found.' }, 404)
}

async function check(request: Request, env: AppEnv): Promise<Response> {
  const access = authorize(request)
  if (!(await allowRequest(env.CHECK_LIMIT, request))) return json({ error: 'Rate limit exceeded.' }, 429)
  const contentType = request.headers.get('Content-Type')
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json.')
  }
  let body: unknown
  try {
    const text = await readLimitedBody(request)
    body = text ? JSON.parse(text) : null
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(400, 'Body must be JSON.')
  }
  if (secretField(body)) {
    throw new HttpError(400, `This API does not accept keys or seeds. ${WALLET_SENTENCE}`)
  }
  const tx = parseTx(body)
  const cacheKey = `check:${await requestHash(tx)}`
  const cached = await cacheGet(env.CACHE, cacheKey)
  if (cached !== null) {
    return new Response(cached, { headers: { 'content-type': 'application/json; charset=utf-8' } })
  }
  const result = await runCheck(env, tx)
  const encoded = JSON.stringify(result)
  // A provider miss must not sit in the 60s check cache, or the next identical request skips the retry.
  if (!result.reasons.some((reason) => reason.code === 'provider_failed')) {
    await cachePut(env.CACHE, cacheKey, encoded, 60)
  }
  console.log(
    JSON.stringify({
      plan: access.plan,
      chainId: tx.chainId,
      verdict: result.verdict,
      score: result.score,
      complete: result.complete,
      mode: result.simulation.mode,
      reasons: result.reasons.map((reason) => reason.code),
    }),
  )
  return new Response(encoded, { headers: { 'content-type': 'application/json; charset=utf-8' } })
}

async function report(request: Request, env: AppEnv, url: URL): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Not found.' }, 404)
  authorize(request)
  if (!(await allowRequest(env.CHECK_LIMIT, request))) return json({ error: 'Rate limit exceeded.' }, 429)
  const match = /^\/report\/(0x[0-9a-fA-F]{40})$/.exec(url.pathname)
  if (!match?.[1]) return json({ error: 'Address must be a 20-byte hex string.' }, 400)
  try {
    return json(await reportFor(env, chainParam(url), match[1].toLowerCase()))
  } catch {
    return json({ error: 'Registry read failed.' }, 502)
  }
}

function chainParam(url: URL): ChainId {
  const raw = url.searchParams.get('chainId')
  if (raw === null || raw === '97') return 97
  if (raw === '56') return 56
  throw new HttpError(400, 'chainId must be 56 or 97.')
}
