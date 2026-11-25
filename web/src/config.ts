import { getAddress, type Address } from 'viem'

export type ChainId = 56 | 97

export interface ChainConfig {
  id: ChainId
  name: string
  short: string
  rpc: string
  explorer: string
  /** Agent ID token. Mainnet is the soulbound registry. Testnet is MockAgentID. */
  agentId: Address
  /** False on the testnet mock, which only implements balanceOf. */
  agentIdHasHandle: boolean
  /** Empty until that contract is deployed. A later fill-in is this one field. */
  hub: Address | null
  registry: Address | null
}

export const CHAINS: Record<ChainId, ChainConfig> = {
  56: {
    id: 56,
    name: 'BNB Smart Chain',
    short: 'BSC',
    rpc: 'https://bsc-dataseed.bnbchain.org',
    explorer: 'https://bscscan.com',
    agentId: getAddress('0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F'),
    agentIdHasHandle: true,
    hub: null,
    registry: null,
  },
  97: {
    id: 97,
    name: 'BSC Testnet',
    short: 'BSC Testnet',
    rpc: 'https://bsc-testnet.publicnode.com',
    explorer: 'https://testnet.bscscan.com',
    agentId: getAddress('0xBC7e6AF6F97f2A9A56a1784D3E17d31361ed8945'),
    agentIdHasHandle: false,
    hub: getAddress('0x062D0452187094C1B2dd546B6a793A50eBDBfd06'),
    registry: getAddress('0x14df99CEa96C8f0980cA0aF46CB5d30de782353A'),
  },
}

export const API_BASE = 'https://api.custosprotocol.com'
export const GITHUB_URL = 'https://github.com/Teazel-lab/custos'
export const AGENT_ID_URL = 'https://docs.space.id/agent-id'

export const REPORT_REASONS = [
  { code: 1, name: 'Drainer' },
  { code: 2, name: 'Honeypot' },
  { code: 3, name: 'Phishing approval or permit' },
  { code: 4, name: 'Owner can mint or rug' },
  { code: 5, name: 'Other' },
] as const

export type ReportReason = (typeof REPORT_REASONS)[number]['code']

/** Hub and registry calls stay disabled until both addresses are set. */
export function contractsReady(chainId: ChainId): boolean {
  const chain = CHAINS[chainId]
  return chain.hub !== null && chain.registry !== null
}

export function chainHex(chainId: ChainId): string {
  return chainId === 56 ? '0x38' : '0x61'
}

export function addChainParams(chainId: ChainId): {
  chainId: string
  chainName: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  rpcUrls: string[]
  blockExplorerUrls: string[]
} {
  const chain = CHAINS[chainId]
  return {
    chainId: chainHex(chainId),
    chainName: chain.name,
    nativeCurrency: { name: 'BNB', symbol: chainId === 56 ? 'BNB' : 'tBNB', decimals: 18 },
    rpcUrls: [chain.rpc],
    blockExplorerUrls: [chain.explorer],
  }
}

export function bscscanAddress(chainId: ChainId, address: string): string {
  return `${CHAINS[chainId].explorer}/address/${address}`
}

export function bscscanTx(chainId: ChainId, hash: string): string {
  return `${CHAINS[chainId].explorer}/tx/${hash}`
}

export function sourcifyUrl(address: string): string {
  return `https://sourcify.dev/#/lookup/${address}`
}
