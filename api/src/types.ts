export interface KvStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/** Workers Rate Limiting binding. `limit` must not be able to take the check down. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/** Bindings the check uses. The generated `Env` is assignable to this. */
export interface AppEnv {
  CACHE: KvStore
  CHECK_LIMIT: RateLimiter
  LLM_BASE_URL: string
  LLM_MODEL: string
  /** Plain JSON-RPC for chain 56. Empty falls back to the public mainnet endpoint. */
  RPC_URL_56?: string
  /** Plain JSON-RPC for chain 97. Empty falls back to the public testnet endpoint. */
  RPC_URL_97?: string
  /** debug_traceCall for chain 56. Empty skips the trace tier on mainnet. */
  TRACE_RPC_URL_56?: string
  /** debug_traceCall for chain 97. Empty skips the trace tier on testnet. */
  TRACE_RPC_URL_97?: string
  /** Plain JSON-RPC for Base (chain 8453). Empty falls back to the public Base endpoint. */
  RPC_URL_8453?: string
  /** debug_traceCall for Base. Empty skips the trace tier and uses simulate, then call. */
  TRACE_RPC_URL_8453?: string
  LLM_API_KEY?: string
  /** Set to `1` in local dev so the API allows localhost origins. Unset in production. */
  ALLOW_DEV_ORIGINS?: string
  /** Optional GoPlus app key. Ignored unless `GOPLUS_APP_SECRET` is set too. */
  GOPLUS_APP_KEY?: string
  /** Optional GoPlus app secret. Ignored unless `GOPLUS_APP_KEY` is set too. */
  GOPLUS_APP_SECRET?: string
}

export type ChainId = 56 | 97 | 8453

/** Whether a reputation source returned a body we could use. */
export type ProviderState = 'answered' | 'failed' | 'skipped'

export interface Providers {
  goplus: ProviderState
  honeypot: ProviderState
  scamSniffer: ProviderState
  /** `unconfigured` is chain 56 until the mainnet registry is set. Base is `skipped`. */
  registry: ProviderState | 'unconfigured'
}
export type Verdict = 'safe' | 'warn' | 'danger'
export type Severity = 'info' | 'warn' | 'danger'
export type SimulationMode = 'trace' | 'simulate' | 'call'

export interface Reason {
  code: string
  severity: Severity
  message: string
}

export interface AssetChange {
  asset: string
  from: string
  to: string
  amount: string
}

export interface Approval {
  token: string
  owner: string
  spender: string
  amount: string | null
  operator: boolean
  unlimited: boolean
}

export interface Simulation {
  mode: SimulationMode
  success: boolean
  revertReason: string | null
  assetChanges: AssetChange[]
  approvals: Approval[]
}

export interface CheckResponse {
  verdict: Verdict
  score: number
  /**
   * False when ScamSniffer failed, or no token-reputation provider returned a
   * usable record for a token in the transaction. A GoPlus miss alone does not
   * do this when Honeypot.is answered. The verdict is then no better than warn.
   */
  complete: boolean
  /** Which reputation sources answered this check. */
  providers: Providers
  reasons: Reason[]
  simulation: Simulation
  explanation: string
  checkedAt: string
}

export interface Tx {
  chainId: ChainId
  from: string
  to: string
  data: string
  value: bigint
}
