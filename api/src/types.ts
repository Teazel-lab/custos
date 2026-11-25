export interface KvStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

/** Bindings the check uses. `KVNamespace` satisfies `CACHE`, so this accepts the generated `Env`. */
export interface AppEnv {
  CACHE: KvStore
  LLM_BASE_URL: string
  LLM_MODEL: string
  RPC_URL?: string
  TRACE_RPC_URL?: string
  LLM_API_KEY?: string
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

export interface Signal {
  reasons: Reason[]
  simulation?: Simulation
  tokens?: string[]
  spenders?: string[]
}
