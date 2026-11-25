import { getAddress, isAddress } from 'viem'
import { API_BASE, type ChainId } from './config'

/** Simulated sender used only when a pasted address has no from filled in. Shown in the form before submit. */
export const EXAMPLE_SENDER = '0x0000000000000000000000000000000000000001'

export interface CheckRequest {
  chainId: ChainId
  from: string
  to: string
  data: string
  value: string
}

export interface Reason {
  code: string
  severity: 'info' | 'warn' | 'danger' | string
  message: string
}

export interface CheckResponse {
  verdict: 'safe' | 'warn' | 'danger' | string
  score: number
  reasons: Reason[]
  simulation: {
    mode: string
    success: boolean
    revertReason: string | null
    assetChanges: { asset: string; from: string; to: string; amount: string }[]
    approvals: { token: string; spender: string; amount: string | null; unlimited: boolean }[]
  }
  explanation: string
  checkedAt: string
}

export interface ReportResponse {
  address: string
  chainId: ChainId
  configured: boolean
  reportCount: string
  reasons: {
    drainer: string
    honeypot: string
    phishing: string
    mintOrRug: string
    other: string
  }
  message?: string
}

export interface ScannerFields {
  chainId: ChainId
  from: string
  to: string
  data: string
  value: string
}

const ZERO = '0x0000000000000000000000000000000000000000'

export function applyAddressPaste(fields: ScannerFields, pasted: string): ScannerFields | null {
  const trimmed = pasted.trim()
  if (!isAddress(trimmed) || getAddress(trimmed) === ZERO) return null
  return {
    chainId: fields.chainId,
    from: fields.from.trim() || EXAMPLE_SENDER,
    to: getAddress(trimmed),
    data: fields.data.trim() || '0x',
    value: fields.value.trim() || '0',
  }
}

export function buildCheckRequest(input: ScannerFields): CheckRequest {
  if (input.chainId !== 56 && input.chainId !== 97) throw new Error('Chain must be BSC or BSC testnet.')
  const from = addressField(input.from, 'From')
  const to = addressField(input.to, 'To')
  const data = (input.data.trim() || '0x').toLowerCase()
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length % 2 !== 0) throw new Error('Data must be even-length hex.')
  const value = input.value.trim()
  if (!(/^\d+$/.test(value) || /^0x[0-9a-fA-F]+$/.test(value))) throw new Error('Value must be a decimal or hex amount.')
  return { chainId: input.chainId, from, to, data, value }
}

export function reportUrl(address: string, chainId: ChainId): string {
  return `${API_BASE}/report/${addressField(address, 'Address')}?chainId=${chainId}`
}

export async function postCheck(body: CheckRequest): Promise<CheckResponse> {
  const response = await fetch(`${API_BASE}/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return readJson(response, 'Check failed.')
}

export async function fetchReport(address: string, chainId: ChainId): Promise<ReportResponse> {
  const response = await fetch(reportUrl(address, chainId))
  return readJson(response, 'Registry lookup failed.')
}

function addressField(value: string, name: string): string {
  const trimmed = value.trim()
  if (!isAddress(trimmed)) throw new Error(`${name} must be a 20-byte hex address.`)
  const address = getAddress(trimmed).toLowerCase()
  if (address === ZERO) throw new Error(`${name} cannot be the zero address.`)
  return address
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error(fallback)
  }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : fallback
    throw new Error(message)
  }
  return payload as T
}
