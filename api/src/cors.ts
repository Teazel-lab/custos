const ALLOWED_ORIGINS = new Set(['https://custosprotocol.com', 'https://www.custosprotocol.com'])

export function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  headers.set('Access-Control-Max-Age', '86400')
  headers.set('Vary', 'Origin')
  const origin = request.headers.get('Origin')
  if (origin && ALLOWED_ORIGINS.has(origin)) headers.set('Access-Control-Allow-Origin', origin)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
