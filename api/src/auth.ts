export interface Access {
  plan: 'free'
}

const SECRET_KEYS = new Set([
  'privatekey',
  'private_key',
  'seed',
  'mnemonic',
  'secret',
  'seedphrase',
  'seed_phrase',
])

/**
 * Keyless while the API stays free. API keys and plans can reject here later
 * without changing the route. Authorization is read so the header stays part of the contract.
 */
export function authorize(request: Request): Access {
  void request.headers.get('Authorization')
  return { plan: 'free' }
}

export function secretField(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  for (const key of Object.keys(body)) {
    const normalized = key.toLowerCase().replaceAll('-', '_')
    if (SECRET_KEYS.has(normalized)) return key
  }
  return null
}
