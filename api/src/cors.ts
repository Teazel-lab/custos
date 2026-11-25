const SITE_ORIGINS = new Set(['https://custosprotocol.com', 'https://www.custosprotocol.com'])

/** Production origins always. Local origins only when `allowDev` is set (`ALLOW_DEV_ORIGINS=1`). */
export function originAllowed(origin: string, allowDev = false): boolean {
  if (SITE_ORIGINS.has(origin)) return true
  if (!allowDev) return false
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  // Node keeps the brackets on an IPv6 hostname. The WHATWG form is `::1`.
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export function withCors(request: Request, response: Response, allowDev = false): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  headers.set('Access-Control-Max-Age', '86400')
  headers.set('Vary', 'Origin')
  const origin = request.headers.get('Origin')
  if (origin && originAllowed(origin, allowDev)) headers.set('Access-Control-Allow-Origin', origin)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
