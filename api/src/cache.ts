import type { KvStore } from './types'

/** Cache reads never fail the check. A KV error is a miss. */
export async function cacheGet(kv: KvStore, key: string): Promise<string | null> {
  try {
    return await kv.get(key)
  } catch {
    return null
  }
}

/** Cache writes never fail the check. Returns whether the write landed. */
export async function cachePut(kv: KvStore, key: string, value: string, ttl?: number): Promise<boolean> {
  try {
    await kv.put(key, value, ttl === undefined ? undefined : { expirationTtl: ttl })
    return true
  } catch {
    return false
  }
}
