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
  /** Present on the updated API. False means no token provider and ScamSniffer both missed. */
  complete?: boolean
  providers?: {
    goplus: string
    honeypot: string
    scamSniffer: string
    registry: string
  }
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
  if (input.chainId !== 56 && input.chainId !== 97 && input.chainId !== 8453) {
    throw new Error('Chain must be BNB Chain, BSC testnet, or Base.')
  }
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
  return parseCheckResponse(await readJson<unknown>(response, 'Check failed.'))
}

export async function fetchReport(address: string, chainId: ChainId): Promise<ReportResponse> {
  const response = await fetch(reportUrl(address, chainId))
  return parseReportResponse(await readJson<unknown>(response, 'Registry lookup failed.'))
}

export function severityClass(severity: string): string {
  if (severity === 'info' || severity === 'warn' || severity === 'danger') return severity
  return 'neutral'
}

export function parseCheckResponse(value: unknown): CheckResponse {
  if (!value || typeof value !== 'object') throw new Error('The check response was not in the expected shape.')
  const body = value as Partial<CheckResponse>
  const simulation = body.simulation
  if (typeof body.verdict !== 'string' || typeof body.score !== 'number' || typeof body.explanation !== 'string') {
    throw new Error('The check response was not in the expected shape.')
  }
  if (!simulation || typeof simulation !== 'object' || typeof simulation.mode !== 'string') {
    throw new Error('The check response was not in the expected shape.')
  }
  if (!Array.isArray(body.reasons)) throw new Error('The check response was not in the expected shape.')
  const reasons: Reason[] = []
  for (const item of body.reasons) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.code !== 'string' || typeof item.message !== 'string') continue
    reasons.push({
      code: item.code,
      severity: typeof item.severity === 'string' ? item.severity : 'info',
      message: item.message,
    })
  }
  return {
    verdict: body.verdict,
    score: body.score,
    ...(typeof body.complete === 'boolean' ? { complete: body.complete } : {}),
    ...(body.providers && typeof body.providers === 'object' ? { providers: body.providers } : {}),
    reasons,
    simulation: {
      mode: simulation.mode,
      success: simulation.success === true,
      revertReason: typeof simulation.revertReason === 'string' ? simulation.revertReason : null,
      assetChanges: Array.isArray(simulation.assetChanges) ? simulation.assetChanges : [],
      approvals: Array.isArray(simulation.approvals) ? simulation.approvals : [],
    },
    explanation: body.explanation,
    checkedAt: typeof body.checkedAt === 'string' ? body.checkedAt : '',
  }
}

export function parseReportResponse(value: unknown): ReportResponse {
  if (!value || typeof value !== 'object') throw new Error('The registry response was not in the expected shape.')
  const body = value as Partial<ReportResponse>
  if (typeof body.address !== 'string' || (body.chainId !== 56 && body.chainId !== 97 && body.chainId !== 8453)) {
    throw new Error('The registry response was not in the expected shape.')
  }
  if (typeof body.configured !== 'boolean' || typeof body.reportCount !== 'string' || !body.reasons) {
    throw new Error('The registry response was not in the expected shape.')
  }
  const reasons = body.reasons
  for (const key of ['drainer', 'honeypot', 'phishing', 'mintOrRug', 'other'] as const) {
    if (typeof reasons[key] !== 'string') throw new Error('The registry response was not in the expected shape.')
  }
  return {
    address: body.address,
    chainId: body.chainId,
    configured: body.configured,
    reportCount: body.reportCount,
    reasons: {
      drainer: reasons.drainer,
      honeypot: reasons.honeypot,
      phishing: reasons.phishing,
      mintOrRug: reasons.mintOrRug,
      other: reasons.other,
    },
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
  }
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
