const SITE_ORIGINS = new Set(['https://custosprotocol.com', 'https://www.custosprotocol.com'])

/** Production site, plus local Vite dev on localhost or 127.0.0.1 at any port. */
export function originAllowed(origin: string): boolean {
  if (SITE_ORIGINS.has(origin)) return true
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
}

export function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  headers.set('Access-Control-Max-Age', '86400')
  headers.set('Vary', 'Origin')
  const origin = request.headers.get('Origin')
  if (origin && originAllowed(origin)) headers.set('Access-Control-Allow-Origin', origin)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
