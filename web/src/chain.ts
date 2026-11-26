import { createPublicClient, encodeFunctionData, getAddress, http, isAddress, type Address } from 'viem'
import { base, bsc, bscTestnet } from 'viem/chains'
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
    chain: chainId === 56 ? bsc : chainId === 8453 ? base : bscTestnet,
    transport: http(chain.rpc),
  })
}

export async function readAgent(chainId: ChainId, account: Address): Promise<AgentRead> {
  const chain = CHAINS[chainId]
  if (!chain.agentId) return { balance: 0n, handle: null, holds: false }
  const client = publicClient(chainId)
  const balance = await client.readContract({
    address: chain.agentId,
    abi: agentIdAbi,
    functionName: 'balanceOf',
    args: [account],
  })
  let handle: string | null = null
  if (chain.agentIdHasHandle && balance > 0n) {
    try {
      const read = await client.readContract({
        address: chain.agentId,
        abi: agentIdAbi,
        functionName: 'handleOf',
        args: [account],
      })
      handle = read.length > 0 ? read : null
    } catch {
      handle = null
    }
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
  if (!hub) throw new Error('This chain has no Custos hub.')
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
  if (!registry) throw new Error('This chain has no Custos registry.')
  const normalized = validateReportTarget(target)
  let already = false
  try {
    already = await publicClient(chainId).readContract({
      address: registry,
      abi: registryAbi,
      functionName: 'hasReported',
      args: [account, normalized],
    })
  } catch (err) {
    throw new Error(`Could not read whether you already reported this address. ${walletError(err)}`)
  }
  if (already) throw new Error('You already have an active report on this address. Retract it before filing another.')
  const data = encodeFunctionData({
    abi: registryAbi,
    functionName: 'report',
    args: [normalized, reason],
  })
  return sendTransaction(provider, account, registry, data, chainId)
}

const ZERO_ADDRESS = getAddress('0x0000000000000000000000000000000000000000')

/** Rejects a missing or zero target before any transaction is built. */
export function validateReportTarget(target: string): Address {
  if (!isAddress(target)) throw new Error('Enter the address to report.')
  const normalized = getAddress(target)
  if (normalized === ZERO_ADDRESS) throw new Error('The zero address cannot be reported.')
  return normalized
}

export function chainError(err: unknown): string {
  return walletError(err)
}
