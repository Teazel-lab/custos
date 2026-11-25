export const MAX_UINT = (1n << 256n) - 1n

export function strip0x(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
}

export function selectorOf(data: string): string {
  return strip0x(data).slice(0, 8).toLowerCase()
}

export function wordAt(data: string, index: number): bigint | null {
  const body = strip0x(data)
  const start = 8 + index * 64
  const hex = body.slice(start, start + 64)
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) return null
  return BigInt('0x' + hex)
}

export function toAddress(word: bigint): string {
  return '0x' + word.toString(16).padStart(64, '0').slice(-40)
}

export function addressAt(data: string, index: number): string | null {
  const word = wordAt(data, index)
  if (word === null) return null
  return toAddress(word)
}

export function topicAddress(topic: string): string {
  return toAddress(BigInt(topic))
}

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value)
}

export function padAddress(address: string): string {
  return strip0x(address).toLowerCase().padStart(64, '0')
}

export function decodeWords(hex: string): bigint[] {
  const body = strip0x(hex)
  const words: bigint[] = []
  for (let i = 0; i < body.length; i += 64) {
    const slice = body.slice(i, i + 64)
    if (slice.length < 64) break
    words.push(BigInt('0x' + slice))
  }
  return words
}

export function dataWord(data: string | undefined): bigint | null {
  if (!data) return null
  const body = strip0x(data)
  if (body.length < 64) return null
  return BigInt('0x' + body.slice(0, 64))
}

export function decodeRevertData(data: unknown): string | null {
  if (typeof data !== 'string' || !data.startsWith('0x')) return null
  const body = strip0x(data).toLowerCase()
  if (body.length < 8) return null
  const selector = body.slice(0, 8)
  if (selector === '08c379a0') {
    const args = body.slice(8)
    if (args.length < 128) return 'execution reverted'
    const offset = Number(BigInt('0x' + args.slice(0, 64))) * 2
    if (!Number.isFinite(offset) || offset < 0 || offset + 64 > args.length) return 'execution reverted'
    const length = Number(BigInt('0x' + args.slice(offset, offset + 64)))
    if (!Number.isFinite(length) || length < 0 || length > 256) return 'execution reverted'
    const text = hexToUtf8(args.slice(offset + 64, offset + 64 + length * 2))
    return text || 'execution reverted'
  }
  if (selector === '4e487b71' && body.length >= 72) {
    return `panic ${BigInt('0x' + body.slice(8, 72))}`
  }
  return `custom error 0x${selector}`
}

function hexToUtf8(hex: string): string {
  if (hex.length === 0 || hex.length % 2 !== 0) return ''
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return new TextDecoder().decode(bytes).replaceAll('\0', '')
}
