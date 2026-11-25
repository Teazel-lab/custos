import { getAddress, isAddress, type Address } from 'viem'
import { addChainParams, type ChainId } from './config'

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

export interface Eip6963ProviderInfo {
  uuid: string
  name: string
  icon: string
  rdns: string
}

export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo
  provider: Eip1193Provider
}

interface Eip6963AnnounceEvent extends Event {
  detail: Eip6963ProviderDetail
}

export interface WalletState {
  provider: Eip1193Provider | null
  name: string
  account: Address | null
  chainId: number | null
}

type Listener = () => void

const providers = new Map<string, Eip6963ProviderDetail>()
const discoveryListeners = new Set<Listener>()
const walletListeners = new Set<Listener>()
let discoveryStarted = false
let state: WalletState = { provider: null, name: '', account: null, chainId: null }

declare global {
  interface Window {
    ethereum?: Eip1193Provider
  }
}

export function walletState(): WalletState {
  return state
}

export function subscribeWallet(listener: Listener): () => void {
  walletListeners.add(listener)
  return () => walletListeners.delete(listener)
}

export function subscribeDiscovery(listener: Listener): () => void {
  discoveryListeners.add(listener)
  return () => discoveryListeners.delete(listener)
}

/** Listen for EIP-6963 wallets. This does not connect and does not send a transaction. */
export function startDiscovery(): void {
  if (discoveryStarted || typeof window === 'undefined') return
  discoveryStarted = true
  window.addEventListener('eip6963:announceProvider', onAnnounce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
}

export function discoveredProviders(): Eip6963ProviderDetail[] {
  return [...providers.values()]
}

export function browserWallet(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null
  return window.ethereum ?? null
}

/** Asks the extension for accounts. The user confirms in the wallet. */
export async function connectWallet(provider: Eip1193Provider, name: string): Promise<void> {
  const accounts = asAccounts(await provider.request({ method: 'eth_requestAccounts' }))
  const account = firstAccount(accounts)
  if (!account) throw new Error('The wallet did not return an account.')
  const chainId = await readChainId(provider)
  state = { provider, name, account, chainId }
  watch(provider)
  emitWallet()
}

export async function refreshWallet(): Promise<void> {
  if (!state.provider) return
  const accounts = asAccounts(await state.provider.request({ method: 'eth_accounts' }))
  state = {
    ...state,
    account: firstAccount(accounts),
    chainId: await readChainId(state.provider),
  }
  emitWallet()
}

/** Switches the extension to BSC or BSC testnet. This is not a Custos transaction. */
export async function switchNetwork(provider: Eip1193Provider, chainId: ChainId): Promise<void> {
  const params = addChainParams(chainId)
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: params.chainId }] })
  } catch (err) {
    if (errorCode(err) !== 4902) throw err
    await provider.request({ method: 'wallet_addEthereumChain', params: [params] })
  }
  if (state.provider === provider) await refreshWallet()
}

/**
 * Sends one transaction the user confirms in the wallet.
 * Call this only from a button click, and only after the wallet is already on `chainId`.
 */
export async function sendTransaction(
  provider: Eip1193Provider,
  from: Address,
  to: Address,
  data: string,
  expectedChainId: number,
): Promise<string> {
  const chainId = await readChainId(provider)
  if (chainId !== expectedChainId) {
    throw new Error('Switch the wallet to the selected network, then try again. Nothing was sent.')
  }
  const hash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data }],
  })
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('The wallet did not return a transaction hash.')
  if (state.provider === provider) state = { ...state, chainId }
  return hash
}

export function walletError(err: unknown): string {
  if (errorCode(err) === 4001) return 'The wallet request was closed. Nothing was sent.'
  if (err && typeof err === 'object' && 'shortMessage' in err && typeof (err as { shortMessage: unknown }).shortMessage === 'string') {
    return (err as { shortMessage: string }).shortMessage
  }
  if (err instanceof Error && err.message) return err.message
  return 'The wallet request did not finish.'
}

function onAnnounce(event: Event): void {
  const detail = (event as Eip6963AnnounceEvent).detail
  if (!detail?.info?.uuid || !detail.provider) return
  providers.set(detail.info.uuid, detail)
  for (const listener of discoveryListeners) listener()
}

function watch(provider: Eip1193Provider): void {
  provider.on?.('accountsChanged', () => { void refreshWallet() })
  provider.on?.('chainChanged', () => { void refreshWallet() })
}

function emitWallet(): void {
  for (const listener of walletListeners) listener()
}

async function readChainId(provider: Eip1193Provider): Promise<number> {
  const chain = await provider.request({ method: 'eth_chainId' })
  if (typeof chain !== 'string') throw new Error('The wallet did not report a chain id.')
  return Number(BigInt(chain))
}

function asAccounts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function firstAccount(accounts: string[]): Address | null {
  const account = accounts[0]
  if (!account || !isAddress(account)) return null
  return getAddress(account)
}

function errorCode(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'number') {
    return (err as { code: number }).code
  }
  return undefined
}
