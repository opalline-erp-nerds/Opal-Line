/**
 * Shared outbound-fetch guard: every call gets an AbortSignal timeout and a
 * human-readable error instead of hanging forever on a stalled peer.
 */

export class FetchTimeoutError extends Error {
  readonly timeoutMs: number
  readonly label: string

  constructor(timeoutMs: number, label: string) {
    super(`${label} request timed out after ${timeoutMs / 1000}s`)
    this.name = 'FetchTimeoutError'
    this.timeoutMs = timeoutMs
    this.label = label
  }
}

export function isFetchTimeoutError(err: unknown): boolean {
  return err instanceof FetchTimeoutError
    || (err instanceof Error && (
      err.name === 'TimeoutError'
      || (err.name === 'AbortError' && /timeout|timed out/i.test(err.message))
    ))
}

type FetchInput = Parameters<typeof fetch>[0]

export async function fetchWithTimeout(
  input: FetchInput,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  try {
    return await globalThis.fetch(input, {
      ...init,
      // Respect a caller-provided signal (e.g. an outer abort) when present.
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if (isFetchTimeoutError(err)) throw new FetchTimeoutError(timeoutMs, label)
    throw err
  }
}
