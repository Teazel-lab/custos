declare global {
  interface Env {
    /** Plain JSON-RPC for eth_call, eth_estimateGas, eth_getCode, and registry reads. */
    RPC_URL?: string
    /** Optional debug_traceCall endpoint. Any provider; swap the URL to change it. */
    TRACE_RPC_URL?: string
    /** Optional OpenAI-compatible key. Rewrites the explanation only. */
    LLM_API_KEY?: string
  }
}

export {}
