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

  it('warns on a finite approve and ignores a revoke', () => {
    const granted = decodeCalldata(tx(TOKEN, encode('095ea7b3', [BigInt(SPENDER), 5n])))
    expect(granted.reasons.map((reason) => reason.severity)).toEqual(['warn'])
    const revoked = decodeCalldata(tx(TOKEN, encode('095ea7b3', [BigInt(SPENDER), 0n])))
    expect(revoked.reasons).toEqual([])
  })

  it('flags setApprovalForAll only when it grants', () => {
    const granted = decodeCalldata(tx(TOKEN, encode('a22cb465', [BigInt(SPENDER), 1n])))
    expect(granted.reasons[0]?.code).toBe('approval_for_all')
    const revoked = decodeCalldata(tx(TOKEN, encode('a22cb465', [BigInt(SPENDER), 0n])))
    expect(revoked.reasons).toEqual([])
  })

  it('recognizes permit, transferFrom, and Permit2', () => {
    expect(decodeCalldata(tx(TOKEN, encode('d505accf', [1n, BigInt(SPENDER), 5n, 1n, 27n, 1n, 1n]))).reasons[0]?.code).toBe('permit')
    expect(decodeCalldata(tx(TOKEN, encode('23b872dd', [BigInt(USER), BigInt(SPENDER), 1n]))).reasons[0]?.code).toBe('transfer_from')
    const permit2 = decodeCalldata(tx(PERMIT2, encode('2b67b570', [BigInt(USER), BigInt(TOKEN), 5n, 1n, 1n, BigInt(SPENDER), 1n, 64n])))
    expect(permit2.reasons.map((reason) => reason.code)).toContain('permit2')
    expect(permit2.approvals[0]?.spender).toBe(SPENDER)
    expect(permit2.tokens).toContain(TOKEN)
  })

  it('flags an unlimited increaseAllowance', () => {
    const decoded = decodeCalldata(tx(TOKEN, encode('39509351', [BigInt(SPENDER), MAX])))
    expect(decoded.reasons[0]?.severity).toBe('danger')
  })
})
