import type { KvStore } from './types'

const LIMIT = 60

/** One counter per IP per minute. Cache hits still count. Health checks do not. */
export async function allowRequest(kv: KvStore, request: Request): Promise<boolean> {
  const ip = (request.headers.get('CF-Connecting-IP') ?? 'local').slice(0, 128)
  const bucket = Math.floor(Date.now() / 60_000)
  const key = `rl:${ip}:${bucket}`
  const raw = Number(await kv.get(key) ?? '0')
  const count = Number.isFinite(raw) ? raw : 0
  if (count >= LIMIT) return false
  await kv.put(key, String(count + 1), { expirationTtl: 120 })
  return true
}
