export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
  parent?: AbortSignal,
): Promise<T> {
  if (parent?.aborted) throw new Error(`${label} timed out`)
  const controller = new AbortController()
  const onParent = () => controller.abort()
  parent?.addEventListener('abort', onParent, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ status: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ status: 'timeout' })
    }, ms)
  })
  const attempt = run(controller.signal).then(
    (value) => ({ status: 'ok' as const, value }),
    (err: unknown) => ({ status: 'err' as const, err }),
  )
  try {
    const winner = await Promise.race([attempt, timeout])
    if (winner.status === 'ok') return winner.value
    if (winner.status === 'timeout') throw new Error(`${label} timed out`)
    if (controller.signal.aborted) throw new Error(`${label} timed out`)
    throw winner.err
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    parent?.removeEventListener('abort', onParent)
  }
}
