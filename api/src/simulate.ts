import { dataWord, decodeRevertData, isAddress, topicAddress } from './abi'
import { isKnownCalldata, type DecodedCall } from './calldata'
import {
  APPROVAL,
  APPROVAL_FOR_ALL,
  NESTED_REVERT,
  REVERTED,
  TRACE_UNAVAILABLE,
  UNKNOWN_CALLDATA,
  UNLIMITED,
  VALUE_UNSIMULATED,
  approvalToEoa,
  eoaDelegated,
  providerReason,
  valueToContract,
  valueToEoa,
} from './messages'
import { codeKind, getCode, plainRpc, probe, rpc, rpcMatchesChain, sanitizeRevert, traceRpc, txCall, type CodeKind } from './rpc'
import { withTimeout } from './time'
import type { AppEnv, Approval, AssetChange, Reason, Simulation, Tx } from './types'

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
const APPROVAL_FOR_ALL_TOPIC = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31'
/** Address geth uses for synthetic native-transfer logs when traceTransfers is set. */
const NATIVE_LOG = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const NEAR_UNLIMITED = 1n << 128n
const LOOKUP_CAP = 8

interface TraceLog {
  address?: string
  topics?: string[]
  data?: string
}

interface TraceFrame {
  from?: string
  to?: string
  value?: string
  error?: string
  revertReason?: string
  logs?: TraceLog[]
  calls?: TraceFrame[]
}

export interface SimulationResult {
  simulation: Simulation
  reasons: Reason[]
  tokens: string[]
  spenders: string[]
}

export function callModeReasons(tx: Tx): Reason[] {
  const reasons: Reason[] = [{ code: 'trace_unavailable', severity: 'warn', message: TRACE_UNAVAILABLE }]
  if (tx.value > 0n) {
    reasons.push({ code: 'value_unsimulated', severity: 'warn', message: VALUE_UNSIMULATED })
  }
  if (!isKnownCalldata(tx.data)) {
    reasons.push({ code: 'unknown_calldata', severity: 'warn', message: UNKNOWN_CALLDATA })
  }
  return reasons
}

export async function simulate(
  env: AppEnv,
  tx: Tx,
  decoded: DecodedCall,
  parent?: AbortSignal,
): Promise<SimulationResult> {
  const extra: Reason[] = []
  const traceUrl = traceRpc(env, tx.chainId)
  if (traceUrl) {
    const traceOk = await rpcMatchesChain(env, tx.chainId, traceUrl, parent)
    if (!traceOk) {
      extra.push(providerReason('Trace RPC'))
    } else {
      try {
        const traced = await withTimeout((signal) => traceSimulation(env, traceUrl, tx, signal), 6_000, 'trace', parent)
        traced.simulation.approvals = mergeApprovals(traced.simulation.approvals, decoded.approvals)
        traced.reasons.unshift(...extra)
        return traced
      } catch (err) {
        if (parent?.aborted) throw err
      }
    }
  }

  const plain = plainRpc(env, tx.chainId)
  const plainOk = await rpcMatchesChain(env, tx.chainId, plain, parent)
  if (!plainOk) {
    return {
      simulation: emptySimulation('call', decoded.approvals, null),
      reasons: [...extra, providerReason('RPC'), ...callModeReasons(tx)],
      tokens: [],
      spenders: [],
    }
  }

  try {
    const simulated = await withTimeout((signal) => ethSimulate(env, tx, signal), 6_000, 'simulate', parent)
    simulated.simulation.approvals = mergeApprovals(simulated.simulation.approvals, decoded.approvals)
    simulated.reasons.unshift(...extra)
    return simulated
  } catch (err) {
    if (parent?.aborted) throw err
    const result = await callFallback(env, tx, decoded, parent)
    result.reasons.unshift(...extra)
    return result
  }
}

async function callFallback(
  env: AppEnv,
  tx: Tx,
  decoded: DecodedCall,
  parent?: AbortSignal,
): Promise<SimulationResult> {
  const limits = callModeReasons(tx)
  try {
    const result = await withTimeout((signal) => callSimulation(env, tx, decoded, signal), 4_000, 'call', parent)
    result.reasons.unshift(...limits)
    return result
  } catch {
    return {
      simulation: emptySimulation('call', decoded.approvals, 'simulation unavailable'),
      reasons: [...limits, providerReason('Simulation')],
      tokens: [],
      spenders: [],
    }
  }
}

async function callSimulation(
  env: AppEnv,
  tx: Tx,
  decoded: DecodedCall,
  signal: AbortSignal,
): Promise<SimulationResult> {
  const url = plainRpc(env, tx.chainId)
  const call = txCall(tx)
  const [executed, estimated] = await Promise.all([
    probe(url, 'eth_call', [call, 'latest'], signal),
    probe(url, 'eth_estimateGas', [call, 'latest'], signal),
  ])
  if (executed.failed && estimated.failed) throw new Error('simulation unavailable')
  const reverted = executed.reverted || estimated.reverted
  const revertReason = sanitizeRevert(executed.reason ?? estimated.reason)
  const reasons: Reason[] = []
  if (reverted) reasons.push(revertedReason())
  return {
    simulation: {
      mode: 'call',
      success: !reverted,
      revertReason: reverted ? revertReason : null,
      assetChanges: [],
      approvals: decoded.approvals,
    },
    reasons,
    tokens: [],
    spenders: [],
  }
}

async function traceSimulation(
  env: AppEnv,
  traceUrl: string,
  tx: Tx,
  signal: AbortSignal,
): Promise<SimulationResult> {
  const result = await rpc(
    traceUrl,
    'debug_traceCall',
    [txCall(tx), 'latest', { tracer: 'callTracer', tracerConfig: { withLog: true } }],
    signal,
  )
  if (!result || typeof result !== 'object') throw new Error('empty trace')
  return resultFromAcc(env, tx, walk(result as TraceFrame, tx.from.toLowerCase()), 'trace', signal)
}

interface SimCall {
  status?: string | number
  returnData?: string
  logs?: TraceLog[]
  error?: { message?: string; data?: unknown }
}

async function ethSimulate(env: AppEnv, tx: Tx, signal: AbortSignal): Promise<SimulationResult> {
  const result = await rpc(
    plainRpc(env, tx.chainId),
    'eth_simulateV1',
    [
      {
        blockStateCalls: [{ calls: [txCall(tx)] }],
        traceTransfers: true,
        validation: false,
      },
      'latest',
    ],
    signal,
  )
  if (!Array.isArray(result)) throw new Error('empty simulate')
  const calls = result.flatMap((block) => {
    if (!block || typeof block !== 'object') return []
    const list = (block as { calls?: SimCall[] }).calls
    return Array.isArray(list) ? list : []
  })
  if (calls.length === 0) throw new Error('empty simulate')
  const acc = emptyAcc()
  const user = tx.from.toLowerCase()
  for (const call of calls) {
    if (call.error || statusReverted(call.status)) {
      acc.reverted = true
      if (!acc.revertReason) acc.revertReason = reasonFromSimCall(call)
    }
    for (const log of call.logs ?? []) decodeLog(log, acc, user)
  }
  return resultFromAcc(env, tx, acc, 'simulate', signal)
}

function statusReverted(status: string | number | undefined): boolean {
  if (typeof status === 'number') return status === 0
  if (typeof status !== 'string' || status.length === 0) return false
  try {
    return BigInt(status) === 0n
  } catch {
    return false
  }
}

function reasonFromSimCall(call: SimCall): string {
  const decoded = decodeRevertData(call.error?.data) ?? decodeRevertData(call.returnData)
  if (decoded) return decoded
  const message = call.error?.message?.replace(/^execution reverted:?\s*/i, '').trim()
  return message || 'execution reverted'
}

async function resultFromAcc(
  env: AppEnv,
  tx: Tx,
  acc: Acc,
  mode: 'trace' | 'simulate',
  signal: AbortSignal,
): Promise<SimulationResult> {
  const reasons: Reason[] = []
  if (acc.reverted) reasons.push(revertedReason())
  else if (acc.nested) reasons.push({ code: 'nested_revert', severity: 'warn', message: NESTED_REVERT })
  await flagCounterparties(env, tx, acc, reasons, signal)
  return {
    simulation: {
      mode,
      success: !acc.reverted,
      revertReason: acc.reverted ? sanitizeRevert(acc.revertReason) : null,
      assetChanges: acc.assets,
      approvals: acc.approvals,
    },
    reasons,
    tokens: [...acc.tokens],
    spenders: [...acc.spenders],
  }
}

function revertedReason(): Reason {
  return { code: 'reverted', severity: 'warn', message: REVERTED }
}

interface Acc {
  reverted: boolean
  nested: boolean
  revertReason: string | null
  assets: AssetChange[]
  approvals: Approval[]
  tokens: Set<string>
  spenders: Set<string>
}

function emptyAcc(): Acc {
  return {
    reverted: false,
    nested: false,
    revertReason: null,
    assets: [],
    approvals: [],
    tokens: new Set(),
    spenders: new Set(),
  }
}

function walk(frame: TraceFrame, user: string): Acc {
  const acc = emptyAcc()
  visit(frame, acc, true, user)
  return acc
}

function visit(frame: TraceFrame, acc: Acc, top: boolean, user: string): void {
  if (frame.error || frame.revertReason) {
    if (top) {
      acc.reverted = true
      if (!acc.revertReason) acc.revertReason = frame.revertReason || frame.error || 'execution reverted'
    } else {
      acc.nested = true
    }
  }
  if (frame.from && frame.to && frame.value) {
    try {
      const amount = BigInt(frame.value)
      if (amount > 0n) {
        acc.assets.push({
          asset: 'native',
          from: frame.from.toLowerCase(),
          to: frame.to.toLowerCase(),
          amount: amount.toString(),
        })
      }
    } catch {
      // Ignore a trace value that is not a hex quantity.
    }
  }
  for (const log of frame.logs ?? []) decodeLog(log, acc, user)
  for (const call of frame.calls ?? []) visit(call, acc, false, user)
}

function decodeLog(log: TraceLog, acc: Acc, user: string): void {
  const topics = (log.topics ?? []).map((topic) => topic.toLowerCase())
  const token = log.address?.toLowerCase() ?? ''
  if (!isAddress(token) || topics.length < 3) return
  if (topics[0] === TRANSFER) {
    const amount = topics.length >= 4 ? 1n : dataWord(log.data)
    if (amount === null) return
    const from = topicAddress(topics[1] ?? '0x0')
    const to = topicAddress(topics[2] ?? '0x0')
    const native = token === NATIVE_LOG
    acc.assets.push({
      asset: native ? 'native' : token,
      from,
      to,
      amount: amount.toString(),
    })
    if (!native && from === user) acc.tokens.add(token)
    if (from === user && to !== user && isAddress(to)) acc.spenders.add(to)
    return
  }
  if (topics[0] === APPROVAL_TOPIC) {
    const amount = dataWord(log.data)
    if (amount === null || amount === 0n) return
    const owner = topicAddress(topics[1] ?? '0x0')
    const spender = topicAddress(topics[2] ?? '0x0')
    acc.approvals.push({
      token,
      owner,
      spender,
      amount: amount.toString(),
      operator: false,
      unlimited: amount >= NEAR_UNLIMITED,
    })
    if (owner === user) {
      acc.tokens.add(token)
      acc.spenders.add(spender)
    }
    return
  }
  if (topics[0] === APPROVAL_FOR_ALL_TOPIC && dataWord(log.data) === 1n) {
    const owner = topicAddress(topics[1] ?? '0x0')
    const spender = topicAddress(topics[2] ?? '0x0')
    acc.approvals.push({
      token,
      owner,
      spender,
      amount: null,
      operator: true,
      unlimited: true,
    })
    if (owner === user) {
      acc.tokens.add(token)
      acc.spenders.add(spender)
    }
  }
}

async function flagCounterparties(
  env: AppEnv,
  tx: Tx,
  acc: Acc,
  reasons: Reason[],
  signal: AbortSignal,
): Promise<void> {
  const user = tx.from.toLowerCase()
  const needed = new Set<string>()
  for (const approval of acc.approvals) {
    if (approval.owner === user) needed.add(approval.spender)
  }
  for (const change of acc.assets) {
    if (change.from === user && change.to !== user) needed.add(change.to)
  }
  const kinds = new Map<string, CodeKind>()
  let codeFailed = false
  await Promise.all(
    [...needed].slice(0, LOOKUP_CAP).map(async (address) => {
      const code = await getCode(env, tx.chainId, address, signal)
      const kind = codeKind(code)
      if (kind === 'unknown') codeFailed = true
      kinds.set(address, kind)
    }),
  )
  if (signal.aborted) throw new Error('trace timed out')
  if (codeFailed) reasons.push(providerReason('Code lookup'))

  const seenApproval = new Set<string>()
  for (const approval of acc.approvals) {
    if (approval.owner !== user) continue
    const key = `${approval.operator ? 'all' : 'one'}:${approval.spender}`
    if (seenApproval.has(key)) continue
    seenApproval.add(key)
    if (approval.operator) {
      reasons.push({ code: 'approval_for_all', severity: 'danger', message: APPROVAL_FOR_ALL })
    } else if (approval.unlimited) {
      reasons.push({ code: 'unlimited_approval', severity: 'danger', message: UNLIMITED })
    } else {
      reasons.push({ code: 'approval', severity: 'warn', message: APPROVAL })
    }
    const kind = kinds.get(approval.spender)
    if (kind === 'delegated') reasons.push(eoaDelegated(approval.spender))
    if (kind === 'eoa' || kind === 'delegated') reasons.push(approvalToEoa(approval.spender))
  }

  const seenValue = new Set<string>()
  for (const change of acc.assets) {
    if (change.from !== user || change.to === user || seenValue.has(change.to)) continue
    seenValue.add(change.to)
    const kind = kinds.get(change.to)
    if (kind === 'delegated') reasons.push(eoaDelegated(change.to))
    if (kind === 'eoa' || kind === 'delegated') reasons.push(valueToEoa(change.to))
    else if (kind === 'contract') reasons.push(valueToContract(change.to))
  }
}

function mergeApprovals(primary: Approval[], extra: Approval[]): Approval[] {
  const merged = [...primary]
  for (const approval of extra) {
    const exists = merged.some(
      (item) =>
        item.token === approval.token &&
        item.spender === approval.spender &&
        item.operator === approval.operator,
    )
    if (!exists) merged.push(approval)
  }
  return merged
}

function emptySimulation(mode: Simulation['mode'], approvals: Approval[], revertReason: string | null): Simulation {
  return { mode, success: false, revertReason, assetChanges: [], approvals }
}
