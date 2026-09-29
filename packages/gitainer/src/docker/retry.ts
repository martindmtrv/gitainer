/**
 * Runs `fn` up to `attempts` times, waiting `delayMs` between attempts, and rethrows the last
 * error. Errors for which `shouldRetry` returns false are rethrown immediately. Used for
 * registry calls that can fail transiently, e.g. `EOF` when a reverse proxy in front of the
 * registry reloads its config mid-request.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts, delayMs, label, log = console.log, shouldRetry = () => true }: {
    attempts: number,
    delayMs: number,
    label: string,
    log?: (msg: string) => void,
    shouldRetry?: (e: unknown) => boolean,
  },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !shouldRetry(e)) {
        throw e;
      }
      log(`${label} failed (attempt ${attempt}/${attempts}), retrying in ${delayMs / 1000}s`);
      await Bun.sleep(delayMs);
    }
  }
}

// transient failures talking to a registry (or a reverse proxy in front of one)
const TRANSIENT_PULL_ERRORS = [
  /\bEOF\b/,
  /connection reset by peer/i,
  /connection refused/i,
  /TLS handshake timeout/i,
  /i\/o timeout/i,
  /Client\.Timeout exceeded/i,
  /\b(502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b/i,
];

/**
 * Whether a failed `docker compose pull` is worth retrying. Only transient registry errors are:
 * an invalid compose file, a missing or misspelled image, or an unreachable docker daemon
 * (`error during connect`, e.g. a remote host that's down) fail the same way every time.
 */
export function isTransientPullError(e: unknown): boolean {
  const shellError = e as { message?: string, stderr?: { toString(): string }, stdout?: { toString(): string } };
  const output = [shellError?.message, shellError?.stderr?.toString(), shellError?.stdout?.toString()].join("\n");

  if (/error during connect/i.test(output)) {
    return false;
  }
  return TRANSIENT_PULL_ERRORS.some(pattern => pattern.test(output));
}
