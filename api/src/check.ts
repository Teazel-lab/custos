import { isAddress, MAX_UINT } from './abi'
import { decodeCalldata, type DecodedCall } from './calldata'
import { explain } from './explain'
import { HttpError } from './http'
import { providerReason, UNSUPPORTED_TESTNET } from './messages'
import { REGISTRIES, registrySignal, type RegistryState } from './registry'
import { checkAddresses, checkTokens, type AddressReputation, type TokenReputation } from './reputation'
import { callModeReasons, simulate, type SimulationResult } from './simulate'
import type { AppEnv, CheckResponse, ProviderState, Providers, Reason, Tx, Verdict } from './types'

const TOKEN_CAP = 5
const ADDRESS_CAP = 8
const DEADLINE_MS = 10_000
const ZERO = '0x' + '0'.repeat(40)
const ALLOWED_FIELDS = new Set(['chainId', 'from', 'to', 'data', 'value'])

export async function runCheck(env: AppEnv, tx: Tx, parent?: AbortSignal): Promise<CheckResponse> {
  const deadline = parent ?? AbortSignal.timeout(DEADLINE_MS)
  const decoded = decodeCalldata(tx)
  const tokens = unique(decoded.tokens).slice(0, TOKEN_CAP)
  const addresses = unique([tx.to, ...decoded.spenders]).slice(0, ADDRESS_CAP)
  const [sim, registry, addressRep, tokenRep] = await Promise.all([
    settleSimulation(env, tx, decoded, deadline),
    registrySignal(env, tx.chainId, addresses, deadline).catch(() => failedRegistry()),
    checkAddresses(env, tx.chainId, addresses, deadline).catch(() => failedAddresses()),
    checkTokens(env, tx.chainId, tokens, deadline, tx.to).catch(() => failedTokens(tokens)),
  ])

  const moreTokens = unique(sim.tokens)
    .filter((token) => !tokens.includes(token))
    .slice(0, Math.max(0, TOKEN_CAP - tokens.length))
  const moreAddresses = unique(sim.spenders)
    .filter((address) => !addresses.includes(address))
    .slice(0, Math.max(0, ADDRESS_CAP - addresses.length))
  const [extraTokens, extraAddresses, extraRegistry] = await Promise.all([
    moreTokens.length
      ? checkTokens(env, tx.chainId, moreTokens, deadline, tx.to).catch(() => failedTokens(moreTokens))
      : emptyTokens(),
    moreAddresses.length
      ? checkAddresses(env, tx.chainId, moreAddresses, deadline).catch(() => failedAddresses())
      : emptyAddresses(),
    moreAddresses.length && REGISTRIES[tx.chainId]
      ? registrySignal(env, tx.chainId, moreAddresses, deadline).catch(() => failedRegistry())
      : { reasons: [], state: 'skipped' as RegistryState },
  ])

  const reasons = dedupe([
    ...decoded.reasons,
    ...sim.reasons,
    ...registry.reasons,
    ...addressRep.reasons,
    ...tokenRep.reasons,
    ...extraTokens.reasons,
    ...extraAddresses.reasons,
    ...extraRegistry.reasons,
    ...(tx.chainId === 97 ? [unsupportedTestnet()] : []),
  ])
  const providers: Providers = {
    goplus: worse(tokenRep.goplus, extraTokens.goplus, addressRep.goplus, extraAddresses.goplus),
    honeypot: worse(tokenRep.honeypot, extraTokens.honeypot),
    scamSniffer: worse(addressRep.scamSniffer, extraAddresses.scamSniffer),
    registry: registryState(registry.state, extraRegistry.state),
  }
  const tokenGap = tokenRep.uncovered.length > 0 || extraTokens.uncovered.length > 0
  const judged = applyReputationCap(judge(reasons), providers, tokenGap)
  return {
    verdict: judged.verdict,
    score: judged.score,
    complete: judged.complete,
    providers,
    reasons,
    simulation: sim.simulation,
    explanation: await explain(env, judged.verdict, reasons, deadline),
    checkedAt: new Date().toISOString(),
  }
}

/**
 * A GoPlus miss stays in the reason list, but it does not make the check
 * incomplete when Honeypot.is covered every token and ScamSniffer answered.
 * ScamSniffer is unchanged: its failure still caps a safe verdict at warn.
 */
function applyReputationCap(
  judged: { verdict: Verdict; score: number },
  providers: Providers,
  tokenGap: boolean,
): { verdict: Verdict; score: number; complete: boolean } {
  const complete = !tokenGap && providers.scamSniffer !== 'failed'
  if (complete || judged.verdict !== 'safe') return { ...judged, complete }
  return { verdict: 'warn', score: Math.min(judged.score, 85), complete: false }
}

function worse(...states: ProviderState[]): ProviderState {
  if (states.includes('failed')) return 'failed'
  if (states.includes('answered')) return 'answered'
  return 'skipped'
}

function registryState(first: RegistryState, extra: RegistryState): Providers['registry'] {
  if (first === 'failed' || extra === 'failed') return 'failed'
  if (first === 'unconfigured' || extra === 'unconfigured') return 'unconfigured'
  if (first === 'answered' || extra === 'answered') return 'answered'
  return 'skipped'
}

function emptyTokens(): TokenReputation {
  return { reasons: [], uncovered: [], honeypot: 'skipped', goplus: 'skipped' }
}

function emptyAddresses(): AddressReputation {
  return { reasons: [], scamSniffer: 'skipped', goplus: 'skipped' }
}

function failedTokens(tokens: string[]): TokenReputation {
  return {
    reasons: [providerReason('Token reputation')],
    uncovered: unique(tokens),
    honeypot: 'failed',
    goplus: 'failed',
  }
}

function failedAddresses(): AddressReputation {
  return { reasons: [providerReason('Address reputation')], scamSniffer: 'failed', goplus: 'failed' }
}

function failedRegistry(): { reasons: Reason[]; state: RegistryState } {
  return { reasons: [providerReason('Registry')], state: 'failed' }
}

function unsupportedTestnet(): Reason {
  return { code: 'unsupported_on_testnet', severity: 'info', message: UNSUPPORTED_TESTNET }
}

export function parseTx(body: unknown): Tx {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object.')
  const record = body as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) throw new HttpError(400, `Unknown field ${key}.`)
  }
  if (record.chainId !== 56 && record.chainId !== 97 && record.chainId !== 8453) {
    throw new HttpError(400, 'chainId must be 56, 97, or 8453.')
  }
  const from = addressField(record.from, 'from')
  const to = addressField(record.to, 'to')
  const data = dataField(record.data)
  const value = valueField(record.value)
  return { chainId: record.chainId, from, to, data, value }
}

export async function requestHash(tx: Tx): Promise<string> {
  const canonical = `${tx.chainId}|${tx.from}|${tx.to}|${tx.data}|${tx.value.toString()}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function settleSimulation(
  env: AppEnv,
  tx: Tx,
  decoded: DecodedCall,
  signal: AbortSignal,
): Promise<SimulationResult> {
  try {
    return await simulate(env, tx, decoded, signal)
  } catch {
    return {
      simulation: {
        mode: 'call',
        success: false,
        revertReason: 'simulation unavailable',
        assetChanges: [],
        approvals: decoded.approvals,
      },
      reasons: [...callModeReasons(tx), providerReason('Simulation')],
      tokens: [],
      spenders: [],
    }
  }
}

function dedupe(reasons: Reason[]): Reason[] {
  const seen = new Set<string>()
  const uniqueReasons: Reason[] = []
  for (const reason of reasons) {
    const key = `${reason.code}\n${reason.message}`
    if (seen.has(key)) continue
    seen.add(key)
    uniqueReasons.push(reason)
  }
  return uniqueReasons
}

function judge(reasons: Reason[]): { verdict: Verdict; score: number } {
  let score = 100
  let verdict: Verdict = 'safe'
  for (const reason of reasons) {
    if (reason.severity === 'danger') {
      score -= 40
      verdict = 'danger'
    } else if (reason.severity === 'warn') {
      score -= 15
      if (verdict === 'safe') verdict = 'warn'
    }
  }
  if (score < 0) score = 0
  if (verdict === 'danger' && score > 30) score = 30
  return { verdict, score }
}

function unique(values: string[]): string[] {
  const out: string[] = []
  for (const value of values) {
    const address = value.toLowerCase()
    if (!isAddress(address) || out.includes(address)) continue
    out.push(address)
  }
  return out
}

function addressField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isAddress(value)) throw new HttpError(400, `${name} must be a 20-byte hex address.`)
  const address = value.toLowerCase()
  if (address === ZERO) throw new HttpError(400, `${name} is the zero address.`)
  return address
}

function dataField(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new HttpError(400, 'data must be even-length hex.')
  }
  return value.toLowerCase()
}

function valueField(value: unknown): bigint {
  let parsed: bigint
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, 'value is out of range.')
    parsed = BigInt(value)
  } else if (typeof value === 'string' && value.length > 0) {
    try {
      if (value.startsWith('0x') || value.startsWith('0X')) parsed = BigInt(value)
      else if (/^\d+$/.test(value)) parsed = BigInt(value)
      else throw new HttpError(400, 'value must be decimal or hex.')
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(400, 'value is out of range.')
    }
  } else {
    throw new HttpError(400, 'value is required.')
  }
  if (parsed < 0n || parsed > MAX_UINT) throw new HttpError(400, 'value is out of range.')
  return parsed
}
