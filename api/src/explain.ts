import { WALLET_SENTENCE } from './messages'
import type { AppEnv, Reason, Verdict } from './types'

export { WALLET_SENTENCE }

export function templateExplanation(verdict: Verdict, reasons: Reason[]): string {
  const findings =
    reasons.length === 0
      ? 'No risk signals fired on this transaction.'
      : reasons.map((reason) => reason.message).join(' ')
  return `Verdict: ${verdict}. ${findings} ${WALLET_SENTENCE}`
}

/** Rewrites findings in plain English. The verdict string is an input, never an output. */
export async function explain(
  env: AppEnv,
  verdict: Verdict,
  reasons: Reason[],
  signal?: AbortSignal,
): Promise<string> {
  const fallback = templateExplanation(verdict, reasons)
  if (!env.LLM_API_KEY) return fallback
  try {
    const text = await rewrite(env, verdict, reasons, signal)
    if (!acceptsRewrite(text, verdict, reasons)) return fallback
    return text
  } catch {
    return fallback
  }
}

function acceptsRewrite(text: string, verdict: Verdict, reasons: Reason[]): boolean {
  if (!text.startsWith(`Verdict: ${verdict}.`)) return false
  if (!text.includes(WALLET_SENTENCE)) return false
  if (verdict !== 'safe' && /\bsafe\b/i.test(text)) return false
  for (const reason of reasons) {
    if (!text.includes(reason.code)) return false
  }
  return true
}

async function rewrite(env: AppEnv, verdict: Verdict, reasons: Reason[], signal?: AbortSignal): Promise<string> {
  const findings = reasons.map((reason) => ({ code: reason.code, message: reason.message }))
  const response = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.LLM_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            `Rewrite the findings in plain English. The verdict is already decided and is ${verdict}. ` +
            `Start with the exact text "Verdict: ${verdict}." Include every reason code exactly as given. ` +
            `End with the exact sentence "${WALLET_SENTENCE}" ` +
            'Do not change the verdict, do not add findings, and do not tell the user to sign or broadcast.',
        },
        { role: 'user', content: JSON.stringify({ verdict, reasons: findings }) },
      ],
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error('llm http')
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  const text = body.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('llm empty')
  return text
}
