import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { applyAddressPaste, buildCheckRequest, EXAMPLE_SENDER, reportUrl } from '../src/api'
import { CHAINS, contractsReady } from '../src/config'

describe('addresses', () => {
  it('leaves mainnet hub and registry empty and keeps testnet filled', () => {
    expect(CHAINS[56].hub).toBeNull()
    expect(CHAINS[56].registry).toBeNull()
    expect(CHAINS[56].agentId).toBe(getAddress('0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F'))
    expect(CHAINS[56].agentIdHasHandle).toBe(true)
    expect(contractsReady(56)).toBe(false)

    expect(CHAINS[97].agentId).toBe(getAddress('0xBC7e6AF6F97f2A9A56a1784D3E17d31361ed8945'))
    expect(CHAINS[97].hub).toBe(getAddress('0x062D0452187094C1B2dd546B6a793A50eBDBfd06'))
    expect(CHAINS[97].registry).toBe(getAddress('0x14df99CEa96C8f0980cA0aF46CB5d30de782353A'))
    expect(CHAINS[97].agentIdHasHandle).toBe(false)
    expect(contractsReady(97)).toBe(true)
  })
})

describe('check request', () => {
  it('posts only the five API fields', () => {
    const body = buildCheckRequest({
      chainId: 97,
      from: EXAMPLE_SENDER,
      to: CHAINS[97].hub ?? EXAMPLE_SENDER,
      data: '0x',
      value: '0',
    })
    expect(Object.keys(body)).toEqual(['chainId', 'from', 'to', 'data', 'value'])
    expect(body.chainId).toBe(97)
  })

  it('fills a pasted token into to and shows the example sender', () => {
    const next = applyAddressPaste(
      { chainId: 56, from: '', to: '', data: '', value: '' },
      '0x062d0452187094c1b2dd546b6a793a50ebdbfd06',
    )
    expect(next).toEqual({
      chainId: 56,
      from: EXAMPLE_SENDER,
      to: getAddress('0x062D0452187094C1B2dd546B6a793A50eBDBfd06'),
      data: '0x',
      value: '0',
    })
  })

  it('builds the registry lookup URL', () => {
    const registry = CHAINS[97].registry
    expect(registry).toBeTruthy()
    expect(reportUrl(registry ?? '', 97)).toBe(
      `https://api.custosprotocol.com/report/${registry?.toLowerCase()}?chainId=97`,
    )
  })

  it('rejects the zero address', () => {
    expect(() => buildCheckRequest({
      chainId: 97,
      from: '0x0000000000000000000000000000000000000000',
      to: EXAMPLE_SENDER,
      data: '0x',
      value: '0',
    })).toThrow(/zero address/)
  })
})
