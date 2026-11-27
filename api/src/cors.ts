const SITE_ORIGINS = new Set(['https://custosprotocol.com', 'https://www.custosprotocol.com'])

/** Chat clients that add the hosted connector by URL. */
export function mcpOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'claude.ai' || host.endsWith('.claude.ai')
}

/** Production origins always. Local origins only when `allowDev` is set (`ALLOW_DEV_ORIGINS=1`). */
export function originAllowed(origin: string, allowDev = false, mcp = false): boolean {
  if (SITE_ORIGINS.has(origin)) return true
  if (mcp && mcpOrigin(origin)) return true
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

export function withCors(request: Request, response: Response, allowDev = false, mcp = false): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Methods', mcp ? 'GET, POST, DELETE, OPTIONS' : 'GET, POST, OPTIONS')
  headers.set(
    'Access-Control-Allow-Headers',
    mcp
      ? 'Content-Type, Authorization, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID'
      : 'Content-Type, Authorization',
  )
  headers.set('Access-Control-Max-Age', '86400')
  headers.set('Vary', 'Origin')
  const origin = request.headers.get('Origin')
  if (origin && originAllowed(origin, allowDev, mcp)) headers.set('Access-Control-Allow-Origin', origin)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
