import { MAX_UINT, dataWord, decodeRevertData, isAddress, topicAddress } from './abi'
import {
  APPROVAL,
  APPROVAL_FOR_ALL,
  TRACE_UNAVAILABLE,
  UNLIMITED,
  approvalToEoa,
  providerReason,
  valueToContract,
  valueToEoa,
} from './messages'
import { codeIsEoa, getCode, plainRpc, probe, rpc, traceRpc, txCall } from './rpc'
import { withTimeout } from './time'
import type { AppEnv, Approval, AssetChange, Reason, Simulation, Tx } from './types'
import type { DecodedCall } from './calldata'

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
const APPROVAL_FOR_ALL_TOPIC = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31'
/** Address geth uses for synthetic native-transfer logs when traceTransfers is set. */
const NATIVE_LOG = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

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

export async function simulate(env: AppEnv, tx: Tx, decoded: DecodedCall): Promise<SimulationResult> {
  const traceUrl = traceRpc(env)
  if (traceUrl) {
    try {
      const traced = await withTimeout((signal) => traceSimulation(env, traceUrl, tx, signal), 6_000, 'trace')
      traced.simulation.approvals = mergeApprovals(traced.simulation.approvals, decoded.approvals)
      return traced
    } catch {
      // eth_simulateV1, then eth_call.
    }
  }
  try {
    const simulated = await withTimeout((signal) => ethSimulate(env, tx, signal), 6_000, 'simulate')
    simulated.simulation.approvals = mergeApprovals(simulated.simulation.approvals, decoded.approvals)
    return simulated
  } catch {
    return callFallback(env, tx, decoded, Boolean(traceUrl))
  }
}

async function callFallback(
  env: AppEnv,
  tx: Tx,
  decoded: DecodedCall,
  traceFailed: boolean,
): Promise<SimulationResult> {
  try {
    const result = await withTimeout((signal) => callSimulation(env, tx, decoded, signal), 4_000, 'call')
    if (traceFailed) result.reasons.unshift({ code: 'trace_unavailable', severity: 'warn', message: TRACE_UNAVAILABLE })
    return result
  } catch {
    const reasons: Reason[] = []
    if (traceFailed) reasons.push({ code: 'trace_unavailable', severity: 'warn', message: TRACE_UNAVAILABLE })
    reasons.push(providerReason('Simulation'))
    return {
      simulation: emptySimulation('call', decoded.approvals, 'simulation unavailable'),
      reasons,
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
  const revertReason = executed.reason ?? estimated.reason
  const reasons: Reason[] = []
  if (reverted) {
    reasons.push({
      code: 'reverted',
      severity: 'warn',
      message: `Simulation reverted: ${revertReason ?? 'execution reverted'}`,
    })
  }
  return {
    simulation: {
      mode: 'call',
      success: !reverted,
      revertReason: reverted ? (revertReason ?? 'execution reverted') : null,
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
  return resultFromAcc(env, tx, walk(result as TraceFrame), 'trace', signal)
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
  for (const call of calls) {
    if (call.error || statusReverted(call.status)) {
      acc.reverted = true
      if (!acc.revertReason) acc.revertReason = reasonFromSimCall(call)
    }
    for (const log of call.logs ?? []) decodeLog(log, acc)
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
  if (acc.reverted) {
    reasons.push({
      code: 'reverted',
      severity: 'warn',
      message: `Simulation reverted: ${acc.revertReason ?? 'execution reverted'}`,
    })
  }
  await flagCounterparties(env, tx, acc, reasons, signal)
  return {
    simulation: {
      mode,
      success: !acc.reverted,
      revertReason: acc.reverted ? (acc.revertReason ?? 'execution reverted') : null,
      assetChanges: acc.assets,
      approvals: acc.approvals,
    },
    reasons,
    tokens: [...acc.tokens],
    spenders: [...acc.spenders],
  }
}

interface Acc {
  reverted: boolean
  revertReason: string | null
  assets: AssetChange[]
  approvals: Approval[]
  tokens: Set<string>
  spenders: Set<string>
}

function emptyAcc(): Acc {
  return {
    reverted: false,
    revertReason: null,
    assets: [],
    approvals: [],
    tokens: new Set(),
    spenders: new Set(),
  }
}

function walk(frame: TraceFrame): Acc {
  const acc = emptyAcc()
  visit(frame, acc)
  return acc
}

function visit(frame: TraceFrame, acc: Acc): void {
  if (frame.error || frame.revertReason) {
    acc.reverted = true
    if (!acc.revertReason) acc.revertReason = frame.revertReason || frame.error || 'execution reverted'
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
  for (const log of frame.logs ?? []) decodeLog(log, acc)
  for (const call of frame.calls ?? []) visit(call, acc)
}

function decodeLog(log: TraceLog, acc: Acc): void {
  const topics = (log.topics ?? []).map((topic) => topic.toLowerCase())
  const token = log.address?.toLowerCase() ?? ''
  if (!isAddress(token) || topics.length < 3) return
  if (topics[0] === TRANSFER) {
    const amount = topics.length >= 4 ? 1n : dataWord(log.data)
    if (amount === null) return
    const native = token === NATIVE_LOG
    acc.assets.push({
      asset: native ? 'native' : token,
      from: topicAddress(topics[1] ?? '0x0'),
      to: topicAddress(topics[2] ?? '0x0'),
      amount: amount.toString(),
    })
    if (!native) acc.tokens.add(token)
    return
  }
  if (topics[0] === APPROVAL_TOPIC) {
    const amount = dataWord(log.data)
    if (amount === null || amount === 0n) return
    const spender = topicAddress(topics[2])
    acc.approvals.push({
      token,
      owner: topicAddress(topics[1]),
      spender,
      amount: amount.toString(),
      operator: false,
      unlimited: amount === MAX_UINT,
    })
    acc.tokens.add(token)
    acc.spenders.add(spender)
    return
  }
  if (topics[0] === APPROVAL_FOR_ALL_TOPIC && dataWord(log.data) === 1n) {
    const spender = topicAddress(topics[2])
    acc.approvals.push({
      token,
      owner: topicAddress(topics[1]),
      spender,
      amount: null,
      operator: true,
      unlimited: true,
    })
    acc.tokens.add(token)
    acc.spenders.add(spender)
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
  for (const approval of acc.approvals) needed.add(approval.spender)
  for (const change of acc.assets) {
    if (change.from === user && change.to !== user) needed.add(change.to)
  }
  const codes = new Map<string, boolean | null>()
  await Promise.all(
    [...needed].map(async (address) => {
      const code = await getCode(env, tx.chainId, address, signal)
      codes.set(address, codeIsEoa(code))
    }),
  )
  if (signal.aborted) throw new Error('trace timed out')

  const seenApproval = new Set<string>()
  for (const approval of acc.approvals) {
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
    if (codes.get(approval.spender) === true) reasons.push(approvalToEoa(approval.spender))
  }

  const seenValue = new Set<string>()
  for (const change of acc.assets) {
    if (change.from !== user || change.to === user || seenValue.has(change.to)) continue
    seenValue.add(change.to)
    const eoa = codes.get(change.to)
    if (eoa === true) reasons.push(valueToEoa(change.to))
    else if (eoa === false) reasons.push(valueToContract(change.to))
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

function emptySimulation(mode: Simulation['mode'], approvals: Approval[], revertReason: string): Simulation {
  return { mode, success: false, revertReason, assetChanges: [], approvals }
}
