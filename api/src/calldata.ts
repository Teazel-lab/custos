import { addressAt, isAddress, selectorOf, strip0x, toAddress, wordAt } from './abi'
import { APPROVAL, APPROVAL_FOR_ALL, PERMIT, PERMIT2, TRANSFER_FROM, UNLIMITED } from './messages'
import type { Approval, Reason, Tx } from './types'

const APPROVE = '095ea7b3'
const INCREASE_ALLOWANCE = '39509351'
const SET_APPROVAL_FOR_ALL = 'a22cb465'
const TRANSFER_FROM_SELECTOR = '23b872dd'
const PERMIT_SELECTOR = 'd505accf'
const DAI_PERMIT = '8fcbaf0c'
const PERMIT2_PERMIT = '2b67b570'
const PERMIT2_APPROVE = '87517c45'
const PERMIT2_BATCH = '2a2d80d1'
const TRANSFER = 'a9059cbb'
const SAFE_TRANSFER = '42842e0e'
const SAFE_TRANSFER_DATA = 'b88d4fde'
const PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const ZERO = '0x' + '0'.repeat(40)

/** ERC-20 / permit amounts at or above 2^128 are treated as unlimited. */
const NEAR_UNLIMITED = 1n << 128n
/** Permit2 amounts are uint160. 2^160-1 never equals 2^256-1, so use 2^159. */
const PERMIT2_UNLIMITED = 1n << 159n

const KNOWN_SELECTORS = new Set([
  APPROVE,
  INCREASE_ALLOWANCE,
  SET_APPROVAL_FOR_ALL,
  TRANSFER_FROM_SELECTOR,
  PERMIT_SELECTOR,
  DAI_PERMIT,
  PERMIT2_PERMIT,
  PERMIT2_APPROVE,
  PERMIT2_BATCH,
  TRANSFER,
  SAFE_TRANSFER,
  SAFE_TRANSFER_DATA,
])

export interface DecodedCall {
  reasons: Reason[]
  tokens: string[]
  spenders: string[]
  approvals: Approval[]
}

/** Empty calldata is a plain transfer. A short or unknown selector is not a known decode. */
export function isKnownCalldata(data: string): boolean {
  const selector = selectorOf(data)
  if (selector.length === 0) return true
  return selector.length === 8 && KNOWN_SELECTORS.has(selector)
}

export function decodeCalldata(tx: Tx): DecodedCall {
  const reasons: Reason[] = []
  const tokens = new Set<string>()
  const spenders = new Set<string>()
  const approvals: Approval[] = []
  const selector = selectorOf(tx.data)
  const to = tx.to.toLowerCase()

  const addApproval = (approval: Approval) => {
    approvals.push(approval)
    if (isAddress(approval.token)) tokens.add(approval.token)
    if (isAddress(approval.spender) && approval.spender !== ZERO) spenders.add(approval.spender)
  }

  if (selector === PERMIT2_APPROVE) {
    decodePermit2Approve(tx, reasons, addApproval)
  } else if (selector === PERMIT2_PERMIT) {
    decodePermit2Permit(tx, reasons, addApproval)
  } else if (selector === PERMIT2_BATCH) {
    decodePermit2Batch(tx, reasons, addApproval)
  } else if (to === PERMIT2_ADDRESS) {
    reasons.push(permit2Reason())
  }

  if (selector === APPROVE || selector === INCREASE_ALLOWANCE) {
    const spender = addressAt(tx.data, 0)
    const amount = wordAt(tx.data, 1)
    if (spender === ZERO) {
      // spender == address(0) is the only revoke. tokenId 0 is still an approval.
    } else if (spender && amount !== null) {
      const unlimited = amount >= NEAR_UNLIMITED
      addApproval({
        token: to,
        owner: tx.from,
        spender,
        amount: amount.toString(),
        operator: false,
        unlimited,
      })
      reasons.push(unlimited ? unlimitedReason() : approvalReason())
    } else {
      reasons.push(approvalReason())
      if (isAddress(to)) tokens.add(to)
    }
  }

  if (selector === SET_APPROVAL_FOR_ALL) {
    const operator = addressAt(tx.data, 0)
    const approved = wordAt(tx.data, 1)
    if (approved !== 0n) {
      if (operator && operator !== ZERO && approved === 1n) {
        addApproval({
          token: to,
          owner: tx.from,
          spender: operator,
          amount: null,
          operator: true,
          unlimited: true,
        })
      } else if (isAddress(to)) {
        tokens.add(to)
      }
      reasons.push({ code: 'approval_for_all', severity: 'danger', message: APPROVAL_FOR_ALL })
    }
  }

  if (selector === PERMIT_SELECTOR || selector === DAI_PERMIT) {
    const owner = addressAt(tx.data, 0) ?? tx.from
    const spender = addressAt(tx.data, 1)
    const amount = selector === DAI_PERMIT ? null : wordAt(tx.data, 2)
    const unlimited = selector === DAI_PERMIT ? wordAt(tx.data, 4) === 1n : amount !== null && amount >= NEAR_UNLIMITED
    if (spender && spender !== ZERO) {
      addApproval({
        token: to,
        owner,
        spender,
        amount: amount === null ? null : amount.toString(),
        operator: false,
        unlimited,
      })
    } else if (isAddress(to)) {
      tokens.add(to)
    }
    reasons.push(unlimited ? unlimitedReason() : { code: 'permit', severity: 'warn', message: PERMIT })
  }

  if (selector === TRANSFER_FROM_SELECTOR) {
    const recipient = addressAt(tx.data, 1)
    if (isAddress(to)) tokens.add(to)
    if (recipient && recipient !== ZERO) spenders.add(recipient)
    reasons.push({ code: 'transfer_from', severity: 'warn', message: TRANSFER_FROM })
  }

  if (selector === TRANSFER) {
    const recipient = addressAt(tx.data, 0)
    if (isAddress(to)) tokens.add(to)
    if (recipient && recipient !== ZERO) spenders.add(recipient)
  }

  if (selector === SAFE_TRANSFER || selector === SAFE_TRANSFER_DATA) {
    const recipient = addressAt(tx.data, 1)
    if (isAddress(to)) tokens.add(to)
    if (recipient && recipient !== ZERO) spenders.add(recipient)
  }

  return {
    reasons,
    tokens: [...tokens],
    spenders: [...spenders],
    approvals,
  }
}

function decodePermit2Approve(tx: Tx, reasons: Reason[], addApproval: (approval: Approval) => void): void {
  reasons.push(permit2Reason())
  const token = addressAt(tx.data, 0)
  const spender = addressAt(tx.data, 1)
  const amount = wordAt(tx.data, 2)
  if (!token || !spender || spender === ZERO || amount === null) return
  const unlimited = amount >= PERMIT2_UNLIMITED
  addApproval({
    token,
    owner: tx.from,
    spender,
    amount: amount.toString(),
    operator: false,
    unlimited,
  })
  if (unlimited) reasons.push(unlimitedReason())
}

function decodePermit2Permit(tx: Tx, reasons: Reason[], addApproval: (approval: Approval) => void): void {
  reasons.push(permit2Reason())
  const owner = addressAt(tx.data, 0) ?? tx.from
  const token = addressAt(tx.data, 1)
  const amount = wordAt(tx.data, 2)
  const spender = addressAt(tx.data, 5)
  if (!token || !spender || spender === ZERO) return
  const unlimited = amount !== null && amount >= PERMIT2_UNLIMITED
  addApproval({
    token,
    owner,
    spender,
    amount: amount === null ? null : amount.toString(),
    operator: false,
    unlimited,
  })
  if (unlimited) reasons.push(unlimitedReason())
}

function decodePermit2Batch(tx: Tx, reasons: Reason[], addApproval: (approval: Approval) => void): void {
  reasons.push(permit2Reason())
  const decoded = readPermitBatch(tx.data)
  if (!decoded) return
  const owner = decoded.owner ?? tx.from
  let unlimited = false
  for (const detail of decoded.details) {
    if (!isAddress(detail.token) || !decoded.spender || decoded.spender === ZERO) continue
    const rowUnlimited = detail.amount >= PERMIT2_UNLIMITED
    if (rowUnlimited) unlimited = true
    addApproval({
      token: detail.token,
      owner,
      spender: decoded.spender,
      amount: detail.amount.toString(),
      operator: false,
      unlimited: rowUnlimited,
    })
  }
  if (unlimited) reasons.push(unlimitedReason())
}

interface PermitDetail {
  token: string
  amount: bigint
}

function readPermitBatch(data: string): { owner: string | null; spender: string | null; details: PermitDetail[] } | null {
  const args = strip0x(data).slice(8)
  const owner = wordFrom(args, 0)
  const batchOffset = wordFrom(args, 32)
  if (owner === null || batchOffset === null || !Number.isSafeInteger(Number(batchOffset))) return null
  const tuple = Number(batchOffset)
  const arrayOffset = wordFrom(args, tuple)
  const spender = wordFrom(args, tuple + 32)
  if (arrayOffset === null || spender === null || !Number.isSafeInteger(Number(arrayOffset))) return null
  const arrayPos = tuple + Number(arrayOffset)
  if (!Number.isSafeInteger(arrayPos)) return null
  const lengthWord = wordFrom(args, arrayPos)
  if (lengthWord === null) return null
  const length = Number(lengthWord)
  if (!Number.isSafeInteger(length) || length < 0 || length > 16) return null
  const details: PermitDetail[] = []
  for (let i = 0; i < length; i++) {
    const base = arrayPos + 32 + i * 128
    const token = wordFrom(args, base)
    const amount = wordFrom(args, base + 32)
    if (token === null || amount === null) return null
    details.push({ token: toAddress(token), amount })
  }
  return { owner: toAddress(owner), spender: toAddress(spender), details }
}

function wordFrom(args: string, byteOffset: number): bigint | null {
  const start = byteOffset * 2
  if (start < 0 || start + 64 > args.length) return null
  const hex = args.slice(start, start + 64)
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null
  return BigInt('0x' + hex)
}

function permit2Reason(): Reason {
  return { code: 'permit2', severity: 'warn', message: PERMIT2 }
}

function approvalReason(): Reason {
  return { code: 'approval', severity: 'warn', message: APPROVAL }
}

function unlimitedReason(): Reason {
  return { code: 'unlimited_approval', severity: 'danger', message: UNLIMITED }
}
