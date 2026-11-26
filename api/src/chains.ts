import type { ChainId } from './types'

export interface NativeCoin {
  name: string
  symbol: string
}

export interface KnownToken {
  symbol: string
  address: string
}

/**
 * Per-chain facts the check must not share across networks.
 * Stablecoin addresses are the canonical contracts, lowercased.
 */
export interface ChainProfile {
  id: ChainId
  native: NativeCoin
  publicRpc: string
  /** GoPlus and Honeypot.is both cover this chain. Chain 97 does not. */
  tokenReputation: boolean
  /** Base has no Custos registry. Chain 56 and chain 97 are live. */
  registry: 'live' | 'unconfigured' | 'unsupported'
  knownTokens: KnownToken[]
}

const BSC_USDT = '0x55d398326f99059ff775485246999027b3197955'
const BSC_USDC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const BASE_USDT = '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2'

export const CHAINS: Record<ChainId, ChainProfile> = {
  56: {
    id: 56,
    native: { name: 'BNB', symbol: 'BNB' },
    publicRpc: 'https://bsc.publicnode.com',
    tokenReputation: true,
    registry: 'live',
    knownTokens: [
      { symbol: 'USDT', address: BSC_USDT },
      { symbol: 'USDC', address: BSC_USDC },
    ],
  },
  97: {
    id: 97,
    native: { name: 'BNB', symbol: 'tBNB' },
    publicRpc: 'https://bsc-testnet.publicnode.com',
    tokenReputation: false,
    registry: 'live',
    knownTokens: [],
  },
  8453: {
    id: 8453,
    native: { name: 'Ether', symbol: 'ETH' },
    publicRpc: 'https://mainnet.base.org',
    tokenReputation: true,
    registry: 'unsupported',
    knownTokens: [
      { symbol: 'USDC', address: BASE_USDC },
      { symbol: 'USDT', address: BASE_USDT },
    ],
  },
}

export function isChainId(value: unknown): value is ChainId {
  return value === 56 || value === 97 || value === 8453
}

export function chainProfile(chainId: ChainId): ChainProfile {
  return CHAINS[chainId]
}

export function nativeSymbol(chainId: ChainId): string {
  return CHAINS[chainId].native.symbol
}

/** A canonical stablecoin. It is not "unknown" when GoPlus has no row for it. */
export function knownToken(chainId: ChainId, address: string): KnownToken | undefined {
  const wanted = address.toLowerCase()
  return CHAINS[chainId].knownTokens.find((token) => token.address === wanted)
}
