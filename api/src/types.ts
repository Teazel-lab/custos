export interface KvStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
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
  LLM_API_KEY?: string
  /** Set to `1` in local dev so the API allows localhost origins. Unset in production. */
  ALLOW_DEV_ORIGINS?: string
}

export type ChainId = 56 | 97
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
  /** False when GoPlus or ScamSniffer did not answer. The verdict is then no better than warn. */
  complete: boolean
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
