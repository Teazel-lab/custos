import { describe, expect, it } from 'vitest'
import { decodeCalldata } from '../src/calldata'
import type { Tx } from '../src/types'

const USER = '0x0000000000000000000000000000000000000001'
const SPENDER = '0x0000000000000000000000000000000000000002'
const TOKEN = '0x0000000000000000000000000000000000000003'
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const MAX = (1n << 256n) - 1n

function tx(to: string, data: string): Tx {
  return { chainId: 97, from: USER, to, data, value: 0n }
}

function encode(selector: string, words: bigint[]): string {
  return '0x' + selector + words.map((word) => word.toString(16).padStart(64, '0')).join('')
}

describe('calldata', () => {
  it('flags an unlimited approve', () => {
    const decoded = decodeCalldata(tx(TOKEN, encode('095ea7b3', [BigInt(SPENDER), MAX])))
    expect(decoded.reasons.map((reason) => reason.code)).toContain('unlimited_approval')
    expect(decoded.approvals[0]?.unlimited).toBe(true)
  })

  it('warns on a finite approve and only treats a zero spender as a revoke', () => {
    const granted = decodeCalldata(tx(TOKEN, encode('095ea7b3', [BigInt(SPENDER), 5n])))
    expect(granted.reasons.map((reason) => reason.severity)).toEqual(['warn'])
    const tokenIdZero = decodeCalldata(tx(TOKEN, encode('095ea7b3', [BigInt(SPENDER), 0n])))
    expect(tokenIdZero.reasons.map((reason) => reason.code)).toContain('approval')
    const revoked = decodeCalldata(tx(TOKEN, encode('095ea7b3', [0n, 0n])))
    expect(revoked.reasons).toEqual([])
  })

  it('flags setApprovalForAll only when it grants', () => {
    const granted = decodeCalldata(tx(TOKEN, encode('a22cb465', [BigInt(SPENDER), 1n])))
    expect(granted.reasons[0]?.code).toBe('approval_for_all')
    const revoked = decodeCalldata(tx(TOKEN, encode('a22cb465', [BigInt(SPENDER), 0n])))
    expect(revoked.reasons).toEqual([])
  })

  it('recognizes permit, transferFrom, and Permit2', () => {
    const owner = '0x0000000000000000000000000000000000000009'
    const permit = decodeCalldata(tx(TOKEN, encode('d505accf', [BigInt(owner), BigInt(SPENDER), 5n, 1n, 27n, 1n, 1n])))
    expect(permit.reasons[0]?.code).toBe('permit')
    expect(permit.approvals[0]?.owner).toBe(owner)
    expect(decodeCalldata(tx(TOKEN, encode('23b872dd', [BigInt(USER), BigInt(SPENDER), 1n]))).reasons[0]?.code).toBe('transfer_from')
    const permit2 = decodeCalldata(tx(PERMIT2, encode('2b67b570', [BigInt(owner), BigInt(TOKEN), 5n, 1n, 1n, BigInt(SPENDER), 1n, 64n])))
    expect(permit2.reasons.map((reason) => reason.code)).toContain('permit2')
    expect(permit2.approvals[0]?.spender).toBe(SPENDER)
    expect(permit2.approvals[0]?.owner).toBe(owner)
    expect(permit2.approvals[0]?.unlimited).toBe(false)
    expect(permit2.tokens).toContain(TOKEN)
  })

  it('treats a Permit2 uint160 allowance of at least 2^159 as unlimited', () => {
    const amount = (1n << 160n) - 1n
    const decoded = decodeCalldata(tx(PERMIT2, encode('87517c45', [BigInt(TOKEN), BigInt(SPENDER), amount, 1n])))
    expect(decoded.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(['permit2', 'unlimited_approval']))
    expect(decoded.approvals[0]).toMatchObject({ token: TOKEN, spender: SPENDER, owner: USER, unlimited: true })
    const finite = decodeCalldata(tx(PERMIT2, encode('87517c45', [BigInt(TOKEN), BigInt(SPENDER), 100n, 1n])))
    expect(finite.reasons.map((reason) => reason.code)).not.toContain('unlimited_approval')
  })

  it('decodes a Permit2 batch and a near-unlimited ERC-20 amount', () => {
    const amount = 1n << 159n
    const data =
      '0x2a2d80d1' +
      [
        BigInt(USER),
        0x60n,
        0x160n,
        0x60n,
        BigInt(SPENDER),
        1n,
        1n,
        BigInt(TOKEN),
        amount,
        1n,
        1n,
        0x20n,
        0n,
      ]
        .map((word) => word.toString(16).padStart(64, '0'))
        .join('')
    const batch = decodeCalldata(tx(PERMIT2, data))
    expect(batch.approvals[0]).toMatchObject({ token: TOKEN, spender: SPENDER, unlimited: true })
    const near = decodeCalldata(tx(TOKEN, encode('095ea7b3', [BigInt(SPENDER), 1n << 128n])))
    expect(near.reasons[0]?.code).toBe('unlimited_approval')
    const below = decodeCalldata(tx(TOKEN, encode('095ea7b3', [BigInt(SPENDER), (1n << 128n) - 1n])))
    expect(below.reasons[0]?.code).toBe('approval')
  })

  it('adds transfer and safeTransferFrom recipients to the checked set', () => {
    const transfer = decodeCalldata(tx(TOKEN, encode('a9059cbb', [BigInt(SPENDER), 1n])))
    expect(transfer.spenders).toContain(SPENDER)
    expect(transfer.tokens).toContain(TOKEN)
    const safe = decodeCalldata(tx(TOKEN, encode('42842e0e', [BigInt(USER), BigInt(SPENDER), 1n])))
    expect(safe.spenders).toContain(SPENDER)
    const safeData = decodeCalldata(tx(TOKEN, encode('b88d4fde', [BigInt(USER), BigInt(SPENDER), 1n, 0x80n])))
    expect(safeData.spenders).toContain(SPENDER)
  })

  it('flags an unlimited increaseAllowance', () => {
    const decoded = decodeCalldata(tx(TOKEN, encode('39509351', [BigInt(SPENDER), MAX])))
    expect(decoded.reasons[0]?.severity).toBe('danger')
  })
})
