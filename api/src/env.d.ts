declare global {
  interface Env {
    /** Plain JSON-RPC for chain 56. eth_simulateV1, eth_call, eth_estimateGas, eth_getCode, registry. */
    RPC_URL_56?: string
    /** Plain JSON-RPC for chain 97. Never used for chain 56. */
    RPC_URL_97?: string
    /** debug_traceCall for chain 56. Pay As You Go Alchemy bnb-mainnet answers callTracer with withLog. */
    TRACE_RPC_URL_56?: string
    /** debug_traceCall for chain 97. */
    TRACE_RPC_URL_97?: string
    /** Optional OpenAI-compatible key. Rewrites the explanation only. */
    LLM_API_KEY?: string
    /** `1` allows localhost origins. Set it in `.dev.vars` only. */
    ALLOW_DEV_ORIGINS?: string
    /** Optional GoPlus app key. Ignored unless `GOPLUS_APP_SECRET` is set too. */
    GOPLUS_APP_KEY?: string
    /** Optional GoPlus app secret. Ignored unless `GOPLUS_APP_KEY` is set too. */
    GOPLUS_APP_SECRET?: string
  }
}

export {}
