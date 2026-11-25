import { createPublicClient, encodeFunctionData, getAddress, http, isAddress, type Address } from 'viem'
import { bsc, bscTestnet } from 'viem/chains'
import { agentIdAbi, hubAbi, registryAbi } from './abi'
import { CHAINS, type ChainId, type ReportReason } from './config'
import { sendTransaction, walletError, type Eip1193Provider } from './wallet'

export interface AgentRead {
  balance: bigint
  handle: string | null
  holds: boolean
}

export function publicClient(chainId: ChainId) {
  const chain = CHAINS[chainId]
  return createPublicClient({
    chain: chainId === 56 ? bsc : bscTestnet,
    transport: http(chain.rpc),
  })
}

export async function readAgent(chainId: ChainId, account: Address): Promise<AgentRead> {
  const chain = CHAINS[chainId]
  const client = publicClient(chainId)
  const balance = await client.readContract({
    address: chain.agentId,
    abi: agentIdAbi,
    functionName: 'balanceOf',
    args: [account],
  })
  let handle: string | null = null
  if (chain.agentIdHasHandle && balance > 0n) {
    handle = await client.readContract({
      address: chain.agentId,
      abi: agentIdAbi,
      functionName: 'handleOf',
      args: [account],
    })
  }
  return { balance, handle, holds: balance > 0n }
}

/** Null means the hub address is still empty, not that the wallet is unprotected. */
export async function readProtected(chainId: ChainId, account: Address): Promise<boolean | null> {
  const hub = CHAINS[chainId].hub
  if (!hub) return null
  return publicClient(chainId).readContract({
    address: hub,
    abi: hubAbi,
    functionName: 'isProtected',
    args: [account],
  })
}

export async function activateWallet(provider: Eip1193Provider, account: Address, chainId: ChainId): Promise<string> {
  const hub = CHAINS[chainId].hub
  if (!hub) throw new Error('Mainnet activation is coming soon. The hub is not deployed yet.')
  const data = encodeFunctionData({ abi: hubAbi, functionName: 'activate' })
  return sendTransaction(provider, account, hub, data, chainId)
}

export async function reportTarget(
  provider: Eip1193Provider,
  account: Address,
  chainId: ChainId,
  target: string,
  reason: ReportReason,
): Promise<string> {
  const registry = CHAINS[chainId].registry
  if (!registry) throw new Error('Mainnet reports are coming soon. The registry is not deployed yet.')
  if (!isAddress(target)) throw new Error('Enter the address to report.')
  const data = encodeFunctionData({
    abi: registryAbi,
    functionName: 'report',
    args: [getAddress(target), reason],
  })
  return sendTransaction(provider, account, registry, data, chainId)
}

export function chainError(err: unknown): string {
  return walletError(err)
}
