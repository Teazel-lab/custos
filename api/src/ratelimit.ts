import type { RateLimiter } from './types'

/** IPv4 stays the full address. IPv6 is the /64 prefix so a subnet shares one bucket. */
export function clientKey(ip: string): string {
  const trimmed = ip.trim().slice(0, 128)
  if (!trimmed) return 'local'
  if (trimmed.includes(':')) return `v6:${ipv6Prefix64(trimmed)}`
  return `v4:${trimmed}`
}

/**
 * Workers Rate Limiting binding. A missing or throwing limiter allows the request
 * so a binding problem cannot turn into a 500.
 */
export async function allowRequest(limiter: RateLimiter | undefined, request: Request): Promise<boolean> {
  try {
    if (!limiter) return true
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local'
    const outcome = await limiter.limit({ key: clientKey(ip) })
    return outcome.success !== false
  } catch {
    return true
  }
}

function ipv6Prefix64(input: string): string {
  const address = (input.split('%')[0] ?? input).trim().toLowerCase()
  const halves = address.split('::')
  if (halves.length > 2) return address
  const parse = (part: string | undefined): string[] => (part ? part.split(':').filter((group) => group.length > 0) : [])
  let groups: string[]
  if (halves.length === 1) {
    groups = address.split(':')
  } else {
    const left = parse(halves[0])
    const right = parse(halves[1])
    const missing = 8 - left.length - right.length
    groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right]
  }
  return groups
    .slice(0, 4)
    .map((group) => group.padStart(4, '0'))
    .join(':')
}
