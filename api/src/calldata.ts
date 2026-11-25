import { MAX_UINT, addressAt, isAddress, selectorOf, wordAt } from './abi'
import { APPROVAL, APPROVAL_FOR_ALL, PERMIT, PERMIT2, TRANSFER_FROM, UNLIMITED } from './messages'
import type { Approval, Reason, Tx } from './types'

const APPROVE = '095ea7b3'
const INCREASE_ALLOWANCE = '39509351'
const SET_APPROVAL_FOR_ALL = 'a22cb465'
const TRANSFER_FROM_SELECTOR = '23b872dd'
const PERMIT_SELECTOR = 'd505accf'
const DAI_PERMIT = '8fcbaf0c'
const PERMIT2_SELECTOR = '2b67b570'
const PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3'

export interface DecodedCall {
  reasons: Reason[]
  tokens: string[]
  spenders: string[]
  approvals: Approval[]
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
    if (isAddress(approval.spender)) spenders.add(approval.spender)
  }

  if (to === PERMIT2_ADDRESS || selector === PERMIT2_SELECTOR) {
    reasons.push({ code: 'permit2', severity: 'warn', message: PERMIT2 })
    const token = addressAt(tx.data, 1)
    const spender = addressAt(tx.data, 5)
    const amount = wordAt(tx.data, 2)
    if (token && spender) {
      const unlimited = amount === MAX_UINT
      addApproval({
        token,
        owner: tx.from,
        spender,
        amount: amount === null ? null : amount.toString(),
        operator: false,
        unlimited,
      })
      if (unlimited) reasons.push({ code: 'unlimited_approval', severity: 'danger', message: UNLIMITED })
    }
  }

  if (selector === APPROVE || selector === INCREASE_ALLOWANCE) {
    const spender = addressAt(tx.data, 0)
    const amount = wordAt(tx.data, 1)
    const revokes = spender !== null && amount === 0n
    if (!revokes && spender && amount !== null && amount > 0n) {
      const unlimited = amount === MAX_UINT
      addApproval({
        token: to,
        owner: tx.from,
        spender,
        amount: amount.toString(),
        operator: false,
        unlimited,
      })
      reasons.push({
        code: unlimited ? 'unlimited_approval' : 'approval',
        severity: unlimited ? 'danger' : 'warn',
        message: unlimited ? UNLIMITED : APPROVAL,
      })
    } else if (!revokes) {
      reasons.push({ code: 'approval', severity: 'warn', message: APPROVAL })
      if (isAddress(to)) tokens.add(to)
    }
  }

  if (selector === SET_APPROVAL_FOR_ALL) {
    const operator = addressAt(tx.data, 0)
    const approved = wordAt(tx.data, 1)
    if (approved !== 0n) {
      if (operator && approved === 1n) {
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
    const spender = addressAt(tx.data, 1)
    const unlimited = selector === DAI_PERMIT ? wordAt(tx.data, 4) === 1n : wordAt(tx.data, 2) === MAX_UINT
    const amount = selector === DAI_PERMIT ? null : wordAt(tx.data, 2)
    if (spender) {
      addApproval({
        token: to,
        owner: tx.from,
        spender,
        amount: amount === null ? null : amount.toString(),
        operator: false,
        unlimited,
      })
    } else if (isAddress(to)) {
      tokens.add(to)
    }
    reasons.push({
      code: unlimited ? 'unlimited_approval' : 'permit',
      severity: unlimited ? 'danger' : 'warn',
      message: unlimited ? UNLIMITED : PERMIT,
    })
  }

  if (selector === TRANSFER_FROM_SELECTOR) {
    const recipient = addressAt(tx.data, 1)
    if (isAddress(to)) tokens.add(to)
    if (recipient) spenders.add(recipient)
    reasons.push({ code: 'transfer_from', severity: 'warn', message: TRANSFER_FROM })
  }

  return {
    reasons,
    tokens: [...tokens],
    spenders: [...spenders],
    approvals,
  }
}
